/* LazNote — Import files
 * Word (.docx), OpenDocument (.odt), text, Markdown, HTML, CSV/TSV and LazNote JSON backups.
 * Loaded after app.js. Everything is parsed on-device (no libraries, works offline).
 * Uses app.js globals: state, idbPut, idbAll, uid, toast, extractHashtags, escapeHtml,
 * aiSortNote, saveStacks, renderBlade, renderActiveList, renderSettings.
 */
(function () {
  'use strict';

  const ACCEPT = '.docx,.odt,.txt,.text,.md,.markdown,.html,.htm,.csv,.tsv,.json,text/plain';
  const MAX_FILE_BYTES = 30 * 1024 * 1024;
  const AI_TEXT_LIMIT = 4000;   // characters of each note sent to Groq when sorting

  let items = [];
  let dest = null;              // stack id | '__ai' | '__air'
  let busy = false;
  let reading = false;
  let _picker = null;

  // ─── small helpers ─────────────────────────────────────────
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const extOf = n => ((String(n).match(/\.([^.]+)$/) || [])[1] || '').toLowerCase();
  const baseName = n => (String(n || '').replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim()) || 'Untitled';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(s) :
    String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  function tidy(lines) {
    return lines.join('\n').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ─── text decoding ─────────────────────────────────────────
  function decodeText(buf) {
    let u8 = new Uint8Array(buf);
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8.subarray(2));
    if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8.subarray(2));
    if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) u8 = u8.subarray(3);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
    catch (e) { return new TextDecoder('windows-1252').decode(u8); }   // old Word/Notepad exports
  }
  function looksBinary(u8) {
    if ((u8[0] === 0xFF && u8[1] === 0xFE) || (u8[0] === 0xFE && u8[1] === 0xFF)) return false; // UTF-16 text
    const n = Math.min(u8.length, 4000);
    for (let i = 0; i < n; i++) if (u8[i] === 0) return true;
    return false;
  }

  // ─── minimal ZIP reader (docx / odt are zips) ──────────────
  async function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser is too old to open zipped documents — update it and retry');
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // Returns the bytes of one entry, or null if it isn't in the archive.
  async function zipRead(buf, wanted) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid zip');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true);
      const elen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      if (name === wanted) {
        const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
        const data = u8.subarray(start, start + csize);
        if (method === 0) return data;
        if (method === 8) return inflateRaw(data);
        throw new Error('Unsupported zip compression');
      }
      p += 46 + nlen + elen + clen;
    }
    return null;
  }

  // ─── XML helpers (namespace-agnostic) ──────────────────────
  const kids = el => Array.from(el.childNodes).filter(n => n.nodeType === 1);
  const ln = el => el.localName || String(el.nodeName).replace(/^.*:/, '');
  const attr = (el, name) => {
    for (const a of Array.from(el.attributes || [])) {
      if ((a.localName || String(a.name).replace(/^.*:/, '')) === name) return a.value;
    }
    return null;
  };
  function parseXml(bytes) {
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Document XML is damaged');
    return doc;
  }

  // ─── .docx ─────────────────────────────────────────────────
  function wRuns(node) {
    const n = ln(node);
    if (n === 't') return node.textContent;
    if (n === 'tab') return '\t';
    if (n === 'br' || n === 'cr') return '\n';
    if (n === 'noBreakHyphen') return '-';
    if (n === 'softHyphen' || n === 'del' || n === 'delText' || n === 'instrText' ||
        n === 'Fallback' || n === 'pPr' || n === 'rPr') return '';
    let s = '';
    for (const c of kids(node)) s += wRuns(c);
    return n === 'p' ? '\n' + s : s;          // paragraphs nested in text boxes
  }
  function wPara(p) {
    let text = '', style = '', list = -1;
    for (const c of kids(p)) {
      if (ln(c) === 'pPr') {
        for (const x of kids(c)) {
          const xn = ln(x);
          if (xn === 'pStyle') style = attr(x, 'val') || '';
          if (xn === 'numPr') {
            list = 0;
            for (const y of kids(x)) if (ln(y) === 'ilvl') list = parseInt(attr(y, 'val'), 10) || 0;
          }
        }
      } else text += wRuns(c);
    }
    return { text, style, list };
  }
  function wBlocks(parent, out) {
    for (const c of kids(parent)) {
      const n = ln(c);
      if (n === 'p') {
        const { text, style, list } = wPara(c);
        const head = /^(title|subtitle|heading\d*)$/i.test(style.replace(/\s/g, ''));
        const li = list >= 0 ? list : (/^list(bullet|number|paragraph|continue)/i.test(style.replace(/\s/g, '')) ? 0 : -1);
        let line = text.replace(/\u00a0/g, ' ');
        if (li >= 0 && line.trim()) line = '  '.repeat(Math.min(li, 4)) + '- ' + line.trim();
        out.push({ line, head });
      } else if (n === 'tbl') {
        for (const tr of kids(c)) {
          if (ln(tr) !== 'tr') continue;
          const cells = [];
          for (const tc of kids(tr)) {
            if (ln(tc) !== 'tc') continue;
            const sub = [];
            wBlocks(tc, sub);
            cells.push(sub.map(x => x.line.trim()).filter(Boolean).join(' / '));
          }
          out.push({ line: cells.join(' | ') });
        }
        out.push({ line: '' });
      } else if (n === 'sdt') {
        for (const x of kids(c)) if (ln(x) === 'sdtContent') wBlocks(x, out);
      }
    }
  }
  function docxFromXml(bytes) {
    const doc = parseXml(bytes);
    const body = kids(doc.documentElement).find(e => ln(e) === 'body');
    if (!body) throw new Error('Not a Word document');
    const out = [];
    wBlocks(body, out);
    const first = out.find(x => x.line.trim());
    return { title: first && first.head ? first.line.trim() : '', text: tidy(out.map(x => x.line)) };
  }

  // ─── .odt ──────────────────────────────────────────────────
  function oText(node) {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return '';
    const n = ln(node);
    if (n === 's') return ' '.repeat(parseInt(attr(node, 'c'), 10) || 1);
    if (n === 'tab') return '\t';
    if (n === 'line-break') return '\n';
    if (n === 'note' || n === 'annotation') return '';
    let s = '';
    for (const c of Array.from(node.childNodes)) s += oText(c);
    return s;
  }
  function oList(list, out, lvl) {
    for (const li of kids(list)) {
      const ln0 = ln(li);
      if (ln0 !== 'list-item' && ln0 !== 'list-header') continue;
      for (const x of kids(li)) {
        const xn = ln(x);
        if (xn === 'p' || xn === 'h') {
          const t = oText(x).trim();
          if (t) out.push({ line: '  '.repeat(Math.min(lvl, 4)) + '- ' + t });
        } else if (xn === 'list') oList(x, out, lvl + 1);
      }
    }
  }
  function oTable(tbl, out) {
    const walk = el => {
      for (const r of kids(el)) {
        const rn = ln(r);
        if (rn === 'table-row') {
          const cells = [];
          for (const tc of kids(r)) {
            if (ln(tc) !== 'table-cell') continue;
            const sub = [];
            oBlocks(tc, sub);
            cells.push(sub.map(x => x.line.trim()).filter(Boolean).join(' / '));
          }
          out.push({ line: cells.join(' | ') });
        } else if (rn === 'table-header-rows' || rn === 'table-rows' || rn === 'table-row-group') walk(r);
      }
    };
    walk(tbl);
    out.push({ line: '' });
  }
  function oBlocks(parent, out) {
    for (const c of kids(parent)) {
      const n = ln(c);
      if (n === 'h') out.push({ line: oText(c), head: true });
      else if (n === 'p') out.push({ line: oText(c) });
      else if (n === 'list') oList(c, out, 0);
      else if (n === 'table') oTable(c, out);
      else if (n === 'section') oBlocks(c, out);
    }
  }
  function odtFromXml(bytes) {
    const doc = parseXml(bytes);
    const body = kids(doc.documentElement).find(e => ln(e) === 'body');
    const text = body && kids(body).find(e => ln(e) === 'text');
    if (!text) throw new Error('Not an OpenDocument text file');
    const out = [];
    oBlocks(text, out);
    const first = out.find(x => x.line.trim());
    return { title: first && first.head ? first.line.trim() : '', text: tidy(out.map(x => x.line)) };
  }

  // ─── HTML ──────────────────────────────────────────────────
  const H_PARA = /^(P|H[1-6]|BLOCKQUOTE|PRE|TABLE|UL|OL)$/;
  const H_BLOCK = /^(DIV|SECTION|ARTICLE|HEADER|FOOTER|MAIN|ASIDE|NAV|LI|TR|FIGURE|FIGCAPTION|DL|DT|DD|HR|FORM|FIELDSET|ADDRESS)$/;
  function hWalk(node, st) {
    if (node.nodeType === 3) { st.buf += st.pre ? node.nodeValue : node.nodeValue.replace(/\s+/g, ' '); return; }
    if (node.nodeType !== 1) return;
    const t = node.tagName.toUpperCase();
    if (t === 'BR') { st.buf += '\n'; return; }
    if (H_PARA.test(t)) brk(st, 2); else if (H_BLOCK.test(t)) brk(st, 1);
    if ((t === 'TD' || t === 'TH') && st.buf && !/\n$/.test(st.buf)) st.buf += ' | ';
    if (t === 'LI') st.buf += '- ';
    const was = st.pre;
    if (t === 'PRE') st.pre = true;
    for (const c of Array.from(node.childNodes)) hWalk(c, st);
    st.pre = was;
    if (H_PARA.test(t)) brk(st, 2); else if (H_BLOCK.test(t)) brk(st, 1);
  }
  function brk(st, n) {           // make sure the buffer ends with at least n newlines
    if (!st.buf) return;
    const have = st.buf.match(/\n*$/)[0].length;
    if (have < n) st.buf += '\n'.repeat(n - have);
  }
  function htmlToText(src) {
    const doc = new DOMParser().parseFromString(src, 'text/html');
    const title = (doc.title || '').trim();
    doc.querySelectorAll('script,style,noscript,template,head').forEach(e => e.remove());
    const st = { buf: '', pre: false };
    hWalk(doc.body || doc.documentElement, st);
    const h1 = doc.querySelector('h1');
    return {
      title: title || (h1 ? h1.textContent.trim() : ''),
      text: tidy(st.buf.split('\n').map(l => l.trim()))
    };
  }

  // ─── dispatcher ────────────────────────────────────────────
  async function parseFile(file) {
    const e = extOf(file.name);
    if (file.size > MAX_FILE_BYTES) throw new Error('File is over 30 MB');
    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf);
    const isZip = u8[0] === 0x50 && u8[1] === 0x4b;
    const isOle = u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0;
    const isPdf = u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46;

    if (isOle) throw new Error(e === 'doc'
      ? 'Old .doc format — open it in Word, Save As .docx, then import that'
      : 'Legacy Office format — save it as .docx first');
    if (isPdf || e === 'pdf') throw new Error('PDF import isn’t supported yet');

    let res;
    if (isZip) {
      let bytes;
      try { bytes = await zipRead(buf, 'word/document.xml'); }
      catch (err) { throw new Error('Can’t open this file (damaged or password-protected)'); }
      if (bytes) res = docxFromXml(bytes);
      else {
        const c = await zipRead(buf, 'content.xml');
        if (!c) throw new Error('Unsupported archive — expected .docx or .odt');
        res = odtFromXml(c);
      }
    } else if (['docx', 'dotx', 'docm', 'odt'].includes(e)) {
      throw new Error('Can’t open this file (damaged or password-protected)');
    } else {
      if (looksBinary(u8)) throw new Error('Unsupported file type');
      const text = decodeText(buf);
      const head = text.slice(0, 400).trim().toLowerCase();
      if (e === 'json') {
        let data = null;
        try { data = JSON.parse(text); } catch (err) { /* plain text */ }
        if (data && Array.isArray(data.notes)) {
          const notes = data.notes.filter(n => n && n.id && typeof n.text === 'string');
          if (!notes.length) throw new Error('Backup has no notes');
          return { backup: { notes, stacks: Array.isArray(data.stacks) ? data.stacks : [] }, title: '', text: '' };
        }
        res = { title: '', text: data ? JSON.stringify(data, null, 2) : text.trim() };
      } else if (e === 'html' || e === 'htm' || head.startsWith('<!doctype html') || head.startsWith('<html')) {
        res = htmlToText(text);
      } else {
        const t = text.replace(/\r\n?/g, '\n').trim();
        const h = (e === 'md' || e === 'markdown') ? t.match(/^#{1,2}\s+(.+)$/m) : null;
        res = { title: h ? h[1].trim() : '', text: t };
      }
    }
    if (!res.text) throw new Error('No text found in this file');
    return res;
  }

  // ─── building notes ────────────────────────────────────────
  function newNote(it) {
    const t = it.modified || Date.now();
    return {
      id: uid(), text: it.text, title: it.title, stack: 'per', due: 'idle', status: 'active',
      createdAt: t, updatedAt: t, why: '',
      hashtags: extractHashtags(it.text),
      done: false, isRecurring: false, recurCycle: null, ghostUntil: null,
      urgency: 'low', urgencyReason: '', tags: [], links: [],
      pendingApproval: false, confidence: 100, aiReasoning: '', mergedInto: null,
      importedFrom: it.name
    };
  }
  async function applyAI(note) {
    const r = await aiSortNote(note.text.slice(0, AI_TEXT_LIMIT));
    if (r.stack && state.stacks.find(s => s.id === r.stack)) note.stack = r.stack;
    else if ((r.confidence ?? 1) < 0.5) note.status = 'airlock';
    if (r.due) note.due = r.due;
    note.why = r.why || '';
    note.urgency = r.urgency || 'low';
    note.urgencyReason = r.urgencyReason || '';
    note.tags = r.tags || [];
    note.links = r.links || [];
    note.isRecurring = r.isRecurring || false;
    note.recurCycle = r.recurCycle || null;
    note.confidence = r.confidence ?? 100;
    note.aiReasoning = r.aiReasoning || r.why || '';
    note.pendingApproval = (r.confidence ?? 1) < 0.7;
  }
  async function importBackup(b) {
    for (const n of b.notes) await idbPut('notes', n);
    if (b.stacks.length) {
      let changed = false;
      for (const s of b.stacks) {
        if (s && s.id && s.name && !state.stacks.find(x => x.id === s.id)) { state.stacks.push(s); changed = true; }
      }
      if (changed) await saveStacks();
    }
    state.notes = await idbAll('notes');
  }

  // ─── reading files into the list ───────────────────────────
  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    reading = true; render();
    const seen = new Set(items.filter(i => !i.error).map(i => norm(i.text)));
    const existing = new Set((state.notes || []).map(n => norm(n.text)));
    for (const f of files) {
      const it = { name: f.name, modified: f.lastModified || Date.now(), checked: true, error: '', dup: false,
                   title: '', text: '', chars: 0, backup: null };
      try {
        const r = await parseFile(f);
        if (r.backup) {
          it.backup = r.backup;
        } else {
          it.text = r.text;
          it.chars = r.text.length;
          it.title = (r.title || baseName(f.name)).replace(/\s+/g, ' ').slice(0, 80);
          const key = norm(r.text);
          it.dup = existing.has(key) || seen.has(key);
          seen.add(key);
          it.checked = !it.dup;
        }
      } catch (err) {
        it.error = (err && err.message) || 'Could not read this file';
        it.checked = false;
      }
      items.push(it);
    }
    reading = false; render();
  }

  // ─── UI ────────────────────────────────────────────────────
  function injectStyle() {
    if (document.getElementById('import-style')) return;
    const css = `
#import-modal .imp-pad{padding:14px 18px 20px}
.imp-drop{border:1.5px dashed var(--line-2);border-radius:14px;padding:26px 18px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:10px;transition:border-color .15s,background .15s}
.imp-drop.over{border-color:var(--lime);background:rgba(197,236,58,.06)}
.imp-drop-t{font-size:15px;font-weight:600}
.imp-drop-s{font-size:12px;color:var(--ink-70);line-height:1.55;max-width:36ch}
.imp-note{font-size:11.5px;color:var(--ink-50);line-height:1.55;margin-top:12px}
.imp-row{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--line-2)}
.imp-row input[type=checkbox]{margin-top:2px;accent-color:var(--lime);width:17px;height:17px;flex:none}
.imp-t{font-size:13.5px;font-weight:600;line-height:1.3;word-break:break-word}
.imp-m{font-family:var(--mono);font-size:10.5px;color:var(--ink-50);margin-top:3px;word-break:break-all}
.imp-m.err{color:var(--red)}
.imp-badge{display:inline-block;font-family:var(--mono);font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding:1px 6px;border-radius:4px;border:1px solid var(--line-2);color:var(--ink-50);margin-left:6px;vertical-align:1px}
.imp-label{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-50);margin:16px 0 8px}
.imp-foot{display:flex;gap:8px;margin-top:16px}
.imp-foot .primary{flex:1}`;
    const st = document.createElement('style');
    st.id = 'import-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  const ICON_IN = '<svg width="26" height="26" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v10M6 9l4 4 4-4M4 16h12"/></svg>';

  function destOptions() {
    const hasKey = !!(state.settings && state.settings.groqKey);
    let o = '';
    if (hasKey) o += `<option value="__ai">Sort with AI (one request per file)</option>`;
    o += `<option value="__air">Airlock — I’ll review each one</option>`;
    o += state.stacks.map(s => `<option value="${esc(s.id)}">Put all in ${esc(s.name)}</option>`).join('');
    return o;
  }
  function destHint() {
    if (dest === '__ai') return 'Each note’s text (first ~4,000 characters) goes to Groq to pick a stack, same as a normal capture. Large batches can hit rate limits — anything it can’t sort lands in the Airlock.';
    if (dest === '__air') return 'Notes wait in the Airlock until you confirm a stack for each.';
    return 'Everything lands in one stack; you can move notes later.';
  }

  function render() {
    const body = document.getElementById('import-body');
    if (!body) return;
    if (!items.length) {
      body.innerHTML = `
        <div class="imp-pad">
          <div class="imp-drop" id="imp-drop">
            ${ICON_IN}
            <div class="imp-drop-t">${reading ? 'Reading files…' : 'Choose files to import'}</div>
            <div class="imp-drop-s">Word (.docx), OpenDocument (.odt), text, Markdown, HTML, CSV, or a LazNote backup (.json). Pick as many as you like — each file becomes one note.</div>
            <button class="btn primary" data-act="pick" ${reading ? 'disabled' : ''}>Choose files</button>
          </div>
          <div class="imp-note">Files are read on this device and never uploaded. Only if you choose “Sort with AI” does a note’s text go to Groq.</div>
          <div class="imp-note">Old .doc files and PDFs can’t be read yet. Open a .doc in Word and Save As .docx first.</div>
        </div>`;
      return;
    }
    if (!dest || !(dest === '__ai' || dest === '__air' || state.stacks.find(s => s.id === dest))) {
      dest = (state.settings && state.settings.groqKey) ? '__ai' : '__air';
    }
    const ready = items.filter(i => i.checked && !i.error);
    const noteCount = ready.reduce((n, i) => n + (i.backup ? i.backup.notes.length : 1), 0);
    const hasPlain = ready.some(i => !i.backup);
    const rows = items.map((it, i) => {
      const meta = it.error
        ? `<div class="imp-m err">${esc(it.error)}</div>`
        : it.backup
          ? `<div class="imp-m">${esc(it.name)} · ${it.backup.notes.length} notes</div>`
          : `<div class="imp-m">${esc(it.name)} · ${it.chars.toLocaleString()} characters</div>`;
      const label = it.error ? esc(it.name) : esc(it.backup ? 'LazNote backup' : it.title);
      return `<label class="imp-row">
        <input type="checkbox" data-act="toggle" data-i="${i}" ${it.checked ? 'checked' : ''} ${it.error || busy ? 'disabled' : ''}>
        <div style="min-width:0;flex:1;"><div class="imp-t">${label}${it.dup ? '<span class="imp-badge">Already in LazNote</span>' : ''}${it.backup ? '<span class="imp-badge">Restore</span>' : ''}</div>${meta}</div>
      </label>`;
    }).join('');
    body.innerHTML = `
      <div class="imp-pad">
        <div style="font-size:12.5px;color:var(--ink-70);">${items.length} file${items.length === 1 ? '' : 's'} · ${ready.length} selected${reading ? ' · reading…' : ''}</div>
        <div>${rows}</div>
        ${hasPlain ? `<div class="imp-label">Where should they go?</div>
        <select class="input" id="imp-dest" ${busy ? 'disabled' : ''} style="width:100%;">${destOptions()}</select>
        <div class="imp-note" id="imp-hint" style="margin-top:8px;">${esc(destHint())}</div>` : ''}
        <div class="imp-foot">
          <button class="btn ghost" data-act="pick" ${busy || reading ? 'disabled' : ''}>Add files</button>
          <button class="btn primary" data-act="run" id="imp-run" ${busy || reading || !ready.length ? 'disabled' : ''}>Import ${noteCount} note${noteCount === 1 ? '' : 's'}</button>
        </div>
      </div>`;
    const sel = document.getElementById('imp-dest');
    if (sel) sel.value = dest;
  }

  function pick() {
    if (busy || reading) return;
    const i = document.createElement('input');
    i.type = 'file'; i.multiple = true; i.accept = ACCEPT;
    i.onchange = () => { if (i.files && i.files.length) addFiles(i.files); _picker = null; };
    _picker = i;   // keep a reference so the picker isn't collected mid-dialog
    i.click();
  }

  function refreshViews() {
    try {
      if (typeof renderActiveList === 'function') renderActiveList(); else renderBlade();
      if (state.view === 'settings') renderSettings();
    } catch (e) { /* views refresh on next navigation */ }
  }

  async function run() {
    if (busy) return;
    const sel = items.filter(i => i.checked && !i.error);
    if (!sel.length) { toast('Nothing selected'); return; }
    busy = true; render();
    const btn = () => document.getElementById('imp-run');
    let aiOn = dest === '__ai' && !!(state.settings && state.settings.groqKey);
    let made = 0, air = 0, failed = 0;
    for (let k = 0; k < sel.length; k++) {
      const it = sel[k];
      if (btn()) btn().textContent = `Importing ${k + 1}/${sel.length}…`;
      try {
        if (it.backup) { await importBackup(it.backup); made += it.backup.notes.length; continue; }
        const note = newNote(it);
        if (dest === '__air') note.status = 'airlock';
        else if (dest === '__ai') {
          if (aiOn) {
            try { await applyAI(note); }
            catch (e) {
              note.status = 'airlock';
              if (e && (e.status === 429 || e.status === 401 || /429|rate|key/i.test(e.message || ''))) aiOn = false;
            }
            if (aiOn && k < sel.length - 1) await sleep(1200);   // stay under Groq's per-minute limits
          } else note.status = 'airlock';
        } else note.stack = dest;
        await idbPut('notes', note);
        state.notes.push(note);
        made++;
        if (note.status === 'airlock') air++;
      } catch (e) { failed++; }
    }
    busy = false;
    closeImport();
    refreshViews();
    toast(`Imported ${made} note${made === 1 ? '' : 's'}` + (air ? ` · ${air} in Airlock` : '') + (failed ? ` · ${failed} failed` : ''), failed ? 'red' : 'lime');
  }

  function openImport(files) {
    const cap = document.getElementById('capture');
    if (cap && cap.classList.contains('open') && window.LazNote.closeCapture) window.LazNote.closeCapture();
    injectStyle();
    items = []; busy = false; reading = false; dest = null;
    render();
    const m = document.getElementById('import-modal');
    if (m) m.style.display = 'flex';
    if (files && files.length) addFiles(files);
  }
  function closeImport() {
    if (busy) return;
    const m = document.getElementById('import-modal');
    if (m) m.style.display = 'none';
    items = [];
  }

  // ─── wiring ────────────────────────────────────────────────
  function init() {
    const m = document.getElementById('import-modal');
    if (!m) return;
    m.addEventListener('click', ev => {
      const t = ev.target.closest('[data-act]');
      if (!t) return;
      if (t.dataset.act === 'pick') pick();
      else if (t.dataset.act === 'run') run();
    });
    m.addEventListener('change', ev => {
      const t = ev.target;
      if (t.dataset && t.dataset.act === 'toggle') {
        const it = items[+t.dataset.i];
        if (it && !it.error) { it.checked = t.checked; render(); }
      } else if (t.id === 'imp-dest') {
        dest = t.value;
        const h = document.getElementById('imp-hint');
        if (h) h.textContent = destHint();
      }
    });
    // Drag & drop (desktop): onto the dialog, or anywhere on the app to open it
    const isFiles = ev => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
    m.addEventListener('dragover', ev => { if (isFiles(ev)) { ev.preventDefault(); const d = document.getElementById('imp-drop'); if (d) d.classList.add('over'); } });
    m.addEventListener('dragleave', () => { const d = document.getElementById('imp-drop'); if (d) d.classList.remove('over'); });
    m.addEventListener('drop', ev => {
      if (!isFiles(ev)) return;
      ev.preventDefault();
      const d = document.getElementById('imp-drop'); if (d) d.classList.remove('over');
      if (!busy) addFiles(ev.dataTransfer.files);
    });
    document.addEventListener('dragover', ev => { if (isFiles(ev)) ev.preventDefault(); });
    document.addEventListener('drop', ev => {
      if (!isFiles(ev) || m.contains(ev.target)) return;
      ev.preventDefault();
      openImport(ev.dataTransfer.files);
    });
  }

  if (window.LazNote) {
    window.LazNote.openImport = openImport;
    window.LazNote.closeImport = closeImport;
  }
  // Exposed for testing / reuse
  window.LazNoteImport = { parseFile, docxFromXml, odtFromXml, htmlToText, zipRead, decodeText };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
