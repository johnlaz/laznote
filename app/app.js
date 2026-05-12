/* LazNote · app logic (PWA, vanilla JS, no build) */
(function () {
'use strict';

// ─── Constants ─────────────────────────────────────────────
const STACKS_DEFAULT = [
  { id: 'biz',  name: 'Biz',     desc: 'Business · taxes · invoices · clients' },
  { id: 'diy',  name: 'DIY',     desc: 'Physical projects · parts · maintenance' },
  { id: 'dev',  name: 'Dev',     desc: 'Code · features · bugs · ideas' },
  { id: 'per',  name: 'Personal', desc: 'Health · errands · life admin' }
];
const MODELS = {
  sort:  'llama-3.1-8b-instant',
  logic: 'llama-3.3-70b-versatile'
};

// ─── State ─────────────────────────────────────────────────
const state = {
  view: 'onb',
  stack: 'all',           // current blade filter
  notes: [],              // loaded from IDB
  stacks: STACKS_DEFAULT,
  settings: {
    style: 'hifi',        // hifi | industrial
    theme: 'dark',        // dark | light
    groqKey: '',
    autoFile: true,
    showWhy: true,
    onboarded: false
  },
  currentNoteId: null,
  navStack: ['blade']     // for back nav
};

// ─── IndexedDB wrapper ────────────────────────────────────
const DB_NAME = 'laznote', DB_VER = 1;
let _db;
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('notes')) {
        const s = db.createObjectStore('notes', { keyPath: 'id' });
        s.createIndex('stack', 'stack');
        s.createIndex('status', 'status');
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = () => { _db = req.result; res(_db); };
    req.onerror = () => rej(req.error);
  });
}
function tx(store, mode = 'readonly') { return _db.transaction(store, mode).objectStore(store); }
function idbAll(store) { return new Promise((res, rej) => { const r = tx(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function idbPut(store, val) { return new Promise((res, rej) => { const r = tx(store, 'readwrite').put(val); r.onsuccess = () => res(val); r.onerror = () => rej(r.error); }); }
function idbDel(store, key) { return new Promise((res, rej) => { const r = tx(store, 'readwrite').delete(key); r.onsuccess = res; r.onerror = () => rej(r.error); }); }
function idbGet(store, key) { return new Promise((res, rej) => { const r = tx(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

// settings + stacks live in kv
async function loadSettings() {
  const row = await idbGet('kv', 'settings');
  if (row) Object.assign(state.settings, row.v);
  const stk = await idbGet('kv', 'stacks');
  if (stk) state.stacks = stk.v;
}
async function saveSettings() { return idbPut('kv', { k: 'settings', v: state.settings }); }
async function saveStacks() { return idbPut('kv', { k: 'stacks', v: state.stacks }); }

// ─── Groq client ───────────────────────────────────────────
async function groqChat({ model, messages, json = false, temperature = 0.2 }) {
  const key = state.settings.groqKey;
  if (!key) throw new Error('No Groq API key. Set in Settings → Groq.');
  const body = { model, messages, temperature };
  if (json) body.response_format = { type: 'json_object' };
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Groq ${resp.status}: ${t.slice(0, 120)}`);
  }
  const data = await resp.json();
  return data.choices[0].message.content;
}

async function aiSortNote(text) {
  const stackList = state.stacks.map(s => `- ${s.id}: ${s.name} — ${s.desc}`).join('\n');
  const sys = `You sort a single user note into one stack. Reply ONLY with valid JSON, no prose.
Stacks available:
${stackList}

JSON schema:
{ "stack": "<id from the list, or null if truly ambiguous>",
  "title": "<6-word title for the note>",
  "due": "<one of: today | overdue | soon | idle>",
  "confidence": <0.0-1.0>,
  "why": "<one short sentence on why this stack>" }`;
  const out = await groqChat({
    model: MODELS.sort,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: text }],
    json: true
  });
  try { return JSON.parse(out); }
  catch { return { stack: null, title: text.slice(0, 50), due: 'idle', confidence: 0, why: 'Parse error' }; }
}

// ─── Utilities ─────────────────────────────────────────────
function uid() { return Math.random().toString(36).slice(2, 11); }
function $(s) { return document.querySelector(s); }
function $$(s) { return [...document.querySelectorAll(s)]; }
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.className = 'toast', 2200);
}
function fmtDue(due) {
  if (due === 'overdue') return { label: '-2D', cls: 'now' };
  if (due === 'today')   return { label: 'TODAY', cls: 'now' };
  if (due === 'soon')    return { label: 'SOON', cls: 'soon' };
  return { label: '—', cls: 'idle' };
}
function stackById(id) { return state.stacks.find(s => s.id === id) || { id, name: id.toUpperCase(), desc: '' }; }

// ─── Routing ──────────────────────────────────────────────
function nav(view, push = true) {
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
  state.view = view;
  if (push && state.navStack[state.navStack.length - 1] !== view) state.navStack.push(view);
  if (view === 'blade')    renderBlade();
  if (view === 'stacks')   renderStacks();
  if (view === 'airlock')  renderAirlock();
  if (view === 'settings') renderSettings();
  if (view === 'groq')     renderGroq();
  if (view === 'note')     renderNote();
  // botnav active state
  $$('.botnav .nav').forEach(n => n.classList.toggle('active', n.dataset.go === view));
}
function back() {
  if (state.navStack.length > 1) state.navStack.pop();
  nav(state.navStack[state.navStack.length - 1] || 'blade', false);
}

// ─── Onboarding ───────────────────────────────────────────
const ONB = [
  {
    step: '01 / 03',
    h: 'One button.<br>Empty your head.',
    p: 'Speak it. Type it. <span style="color:var(--lime);">LazNote</span> sorts everything into the right stack for you.',
    art: `<div style="position:relative;">
      <div style="position:absolute;inset:-30px;border:1px solid var(--line-2);border-radius:50%;"></div>
      <div style="position:absolute;inset:-58px;border:1px dashed var(--line-2);border-radius:50%;"></div>
      <div style="width:96px;height:96px;border-radius:50%;background:var(--lime);display:grid;place-items:center;box-shadow:0 0 40px var(--lime-glow);">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#0b0d0a" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0"/><path d="M12 18v3"/></svg>
      </div>
    </div>`
  },
  {
    step: '02 / 03',
    h: 'Zero manual<br>filing.',
    p: 'Your note lands in the right stack automatically. Unsure ones go to the <span style="color:var(--lime);">Airlock</span> for a yes/no.',
    art: `<div style="display:flex;flex-direction:column;align-items:center;gap:14px;">
      <div style="background:var(--surface);border:1px solid var(--line-2);border-radius:var(--r-md);padding:10px 12px;font-size:13px;">"M12 bolts for the trailer"</div>
      <svg width="20" height="36" viewBox="0 0 20 36" fill="none" stroke="var(--lime)" stroke-width="1.5" stroke-linecap="round"><path d="M10 4v26M4 24l6 6 6-6"/></svg>
      <div style="display:flex;gap:8px;">
        <span class="pill">BIZ</span>
        <span class="pill lime" style="background:var(--lime-soft);">DIY ✓</span>
        <span class="pill">DEV</span>
      </div>
    </div>`
  },
  {
    step: '03 / 03',
    h: 'Local-first.<br>Your brain on Groq.',
    p: 'Notes live on this device. Only what you Pulse goes to Groq. Bring your own key — get one free at <span style="color:var(--lime);">console.groq.com</span>.',
    body: `<div style="display:flex;flex-direction:column;gap:10px;margin-top:8px;">
      <div style="font-family:var(--mono);font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:var(--ink-50);">Groq API key (optional)</div>
      <input class="input" id="onb-key" placeholder="gsk_... (or skip and add later)" />
      <div style="display:flex;align-items:center;gap:8px;margin-top:4px;color:var(--ink-50);">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="4" y="9" width="12" height="8" rx="1.5"/><path d="M7 9V6a3 3 0 016 0v3"/></svg>
        <span style="font-size:11.5px;">Stored only in this device's storage.</span>
      </div>
    </div>`,
    cta: 'Enter LazNote →',
    last: true
  }
];
let onbIdx = 0;
function renderOnb() {
  const o = ONB[onbIdx];
  $('#onb-step').textContent = o.step;
  $('#onb-h').innerHTML = o.h;
  $('#onb-p').innerHTML = o.p;
  $('#onb-art').innerHTML = o.art || '';
  $('#onb-body').innerHTML = o.body || '';
  $('#onb-dots').innerHTML = ONB.map((_, i) => `<span class="${i === onbIdx ? 'on' : ''}"></span>`).join('');
  $('#onb-next').textContent = o.cta || 'Next →';
}
$('#onb-next').addEventListener('click', async () => {
  if (onbIdx === ONB.length - 1) {
    // capture optional key
    const key = $('#onb-key')?.value.trim();
    if (key) state.settings.groqKey = key;
    state.settings.onboarded = true;
    await saveSettings();
    nav('blade');
  } else {
    onbIdx++;
    renderOnb();
  }
});

// ─── Blade view ────────────────────────────────────────────
function renderBlade() {
  $('#blade-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const active = state.notes.filter(n => n.status !== 'done' && n.status !== 'airlock');
  $('#blade-count').textContent = active.length;
  $('#blade-now-count').textContent = active.filter(n => n.due === 'today' || n.due === 'overdue').length;

  // stack tabs
  const counts = { all: active.length };
  state.stacks.forEach(s => counts[s.id] = active.filter(n => n.stack === s.id).length);
  const tabs = [{ id: 'all', name: 'All' }, ...state.stacks];
  $('#stack-tabs').innerHTML = tabs.map(t => `
    <div data-stack="${t.id}" style="font-family:var(--mono);font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${state.stack === t.id ? 'var(--ink)' : 'var(--ink-50)'};padding:4px 0;border-bottom:2px solid ${state.stack === t.id ? 'var(--lime)' : 'transparent'};cursor:pointer;">
      ${t.name} <span style="color:${state.stack === t.id ? 'var(--lime)' : 'var(--ink-30)'};">${counts[t.id] || 0}</span>
    </div>`).join('');
  $$('#stack-tabs > div').forEach(el => el.addEventListener('click', () => { state.stack = el.dataset.stack; renderBlade(); }));

  const filtered = state.stack === 'all' ? active : active.filter(n => n.stack === state.stack);
  filtered.sort((a, b) => {
    const order = { overdue: 0, today: 1, soon: 2, idle: 3 };
    return (order[a.due] ?? 3) - (order[b.due] ?? 3) || b.createdAt - a.createdAt;
  });

  if (!filtered.length) {
    $('#blade-list').innerHTML = `
      <div class="empty">
        <div class="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0"/><path d="M12 18v3"/></svg></div>
        <h3>No blades yet</h3>
        <p>Tap the Pulse button to capture your first note.</p>
      </div>`;
    return;
  }
  $('#blade-list').innerHTML = filtered.map(n => {
    const d = fmtDue(n.due);
    const stk = stackById(n.stack);
    return `<div class="blade ${d.cls}" data-id="${n.id}">
      <div>
        <span class="stack-tag">${stk.name.toUpperCase()}</span>
        <div class="t">${escapeHtml(n.title || n.text.slice(0, 60))}</div>
        ${n.text && n.text !== n.title ? `<div class="m">${escapeHtml(n.text.slice(0, 70))}${n.text.length > 70 ? '…' : ''}</div>` : ''}
      </div>
      <div class="due">${d.label}</div>
    </div>`;
  }).join('');
  $$('#blade-list .blade').forEach(el => el.addEventListener('click', () => openNote(el.dataset.id)));
}

function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ─── Capture ──────────────────────────────────────────────
function openCapture() {
  $('#capture-text').value = '';
  $('#capture-stack-hint').style.display = 'none';
  $('#capture-due-hint').style.display = 'none';
  renderCaptureChips();
  $('#capture-ai-label').textContent = state.settings.groqKey ? 'Sort with AI' : 'Connect Groq first';
  $('#capture-ai').disabled = !state.settings.groqKey;
  $('#capture-ai').style.opacity = state.settings.groqKey ? 1 : 0.6;
  $('#capture').classList.add('open');
  setTimeout(() => $('#capture-text').focus(), 250);
}
function closeCapture() {
  if (cameraStream) LazNote.stopCamera();
  if (voiceRecognition && isVoiceRecording) {
    voiceRecognition.stop();
    isVoiceRecording = false;
  }
  $('#capture').classList.remove('open');
  $('#capture-text').value = '';
  const voiceTranscript = document.getElementById('voice-transcript');
  if (voiceTranscript) voiceTranscript.textContent = 'Ready to record...';
  const ocrResult = document.getElementById('ocr-result');
  if (ocrResult) ocrResult.textContent = 'Scanned text will appear here...';
}
let manualStack = null;
function renderCaptureChips() {
  manualStack = null;
  $('#capture-stack-chips').innerHTML = state.stacks.map(s => `<span class="chip" data-id="${s.id}">${s.name}</span>`).join('') +
    `<span class="chip" data-id="__air">Airlock</span>`;
  $$('#capture-stack-chips .chip').forEach(c => c.addEventListener('click', () => {
    manualStack = c.dataset.id;
    $$('#capture-stack-chips .chip').forEach(x => x.classList.toggle('lime', x === c));
  }));
}
async function saveCapture(mode) {
  let text = '';
  
  if (currentCaptureMode === 'text' || currentCaptureMode === 'camera') {
    text = $('#capture-text').value.trim();
  } else if (currentCaptureMode === 'voice') {
    const transcript = document.getElementById('voice-transcript');
    text = transcript ? transcript.textContent.trim() : '';
  }
  
  if (!text || text === 'Ready to record...' || text === 'Scanned text will appear here...') {
    toast('Type or capture something first');
    return;
  }
  
  const now = Date.now();
  let note = { id: uid(), text, title: text.split('\n')[0].slice(0, 80), stack: manualStack || 'per', due: 'idle', status: 'active', createdAt: now, updatedAt: now, why: '' };
  if (manualStack === '__air') { note.stack = 'per'; note.status = 'airlock'; }

  if (mode === 'ai' && state.settings.groqKey && !manualStack) {
    toast('AI is sorting…', 'lime');
    try {
      const r = await aiSortNote(text);
      if (r.stack && state.stacks.find(s => s.id === r.stack)) {
        note.stack = r.stack;
      } else if (r.confidence < 0.5) {
        note.status = 'airlock';
      }
      if (r.title) note.title = r.title;
      if (r.due) note.due = r.due;
      note.why = r.why || '';
      note.confidence = r.confidence ?? null;
      if ((r.confidence ?? 1) < 0.5) note.status = 'airlock';
    } catch (e) {
      toast(e.message.slice(0, 40), 'red');
    }
  }

  await idbPut('notes', note);
  state.notes.push(note);
  closeCapture();
  toast(note.status === 'airlock' ? 'Saved to Airlock' : `Saved → ${stackById(note.stack).name}`, 'lime');
  renderBlade();
}

// ─── Note detail ──────────────────────────────────────────
function openNote(id) {
  state.currentNoteId = id;
  nav('note');
}
function renderNote() {
  const n = state.notes.find(x => x.id === state.currentNoteId);
  if (!n) { back(); return; }
  const stk = stackById(n.stack);
  $('#note-stack').textContent = stk.name + (n.status === 'airlock' ? ' · Airlock' : '');
  const d = fmtDue(n.due);
  const stackChips = state.stacks.map(s => `<span class="chip ${s.id === n.stack ? 'lime' : ''}" data-stack="${s.id}">${s.name}</span>`).join('');
  $('#note-body').innerHTML = `
    <div style="font-family:var(--mono);font-size:10px;letter-spacing:0.14em;color:var(--lime);text-transform:uppercase;">${stk.name} · ${d.label}</div>
    <div style="font-size:26px;font-weight:700;letter-spacing:-0.02em;margin-top:6px;line-height:1.15;">${escapeHtml(n.title)}</div>
    <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap;">
      <span class="chip ${d.cls === 'now' ? 'lime' : ''}">${d.label}</span>
      <span class="chip">${new Date(n.createdAt).toLocaleDateString()}</span>
    </div>
    <textarea class="input" id="note-text" style="margin-top:14px;min-height:200px;">${escapeHtml(n.text)}</textarea>
    ${n.why ? `<div style="margin-top:14px;background:var(--surface);border:1px solid rgba(197,236,58,0.2);border-radius:var(--r-md);padding:12px;">
      <div style="font-family:var(--mono);font-size:9.5px;letter-spacing:0.16em;color:var(--lime);display:flex;align-items:center;gap:6px;">
        <svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M7 4a3 3 0 00-3 3v1a2 2 0 00-1 3.5A2 2 0 005 15h2v2h6v-2h2a2 2 0 002-3.5A2 2 0 0016 8V7a3 3 0 00-3-3 3 3 0 00-3 0 3 3 0 00-3 0z"/></svg>
        WHY THIS STACK?</div>
      <div style="font-size:13px;color:var(--ink-70);margin-top:6px;line-height:1.5;">${escapeHtml(n.why)}</div>
    </div>` : ''}
    <div style="margin-top:16px;font-family:var(--mono);font-size:9.5px;letter-spacing:0.16em;color:var(--ink-50);">MOVE TO</div>
    <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;" id="move-chips">${stackChips}</div>
    <div style="margin-top:18px;display:flex;gap:8px;">
      ${n.status === 'airlock'
        ? `<button class="btn primary block" onclick="LazNote.confirmAirlock()">Confirm → ${stk.name}</button>`
        : `<button class="btn primary block" onclick="LazNote.markDone()">✓ Done</button>`}
    </div>
  `;
  // wire move chips
  $$('#move-chips .chip').forEach(c => c.addEventListener('click', () => LazNote.moveNote(c.dataset.stack)));
  // autosave text on blur
  $('#note-text').addEventListener('blur', () => LazNote.saveNoteText());
}

// ─── Stacks ───────────────────────────────────────────────
function renderStacks() {
  $('#stacks-list').innerHTML = `<div class="section-group">${state.stacks.map(s => {
    const c = state.notes.filter(n => n.stack === s.id && n.status !== 'done').length;
    return `<div class="row" data-stack="${s.id}">
      <div class="r-label">${escapeHtml(s.name)}<div style="font-family:var(--mono);font-size:10px;color:var(--ink-50);margin-top:2px;">${escapeHtml(s.desc)}</div></div>
      <span class="r-value">${c}</span>
      <svg class="r-chev" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 5l5 5-5 5"/></svg>
    </div>`;
  }).join('')}</div>`;
  $$('#stacks-list .row').forEach(r => r.addEventListener('click', () => {
    state.stack = r.dataset.stack; nav('blade');
  }));
}

// ─── Airlock ──────────────────────────────────────────────
function renderAirlock() {
  const items = state.notes.filter(n => n.status === 'airlock');
  if (!items.length) {
    $('#airlock-list').innerHTML = `<div class="empty">
      <div class="ic"><svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 4a3 3 0 00-3 3v1a2 2 0 00-1 3.5A2 2 0 005 15h2v2h6v-2h2a2 2 0 002-3.5A2 2 0 0016 8V7a3 3 0 00-3-3 3 3 0 00-3 0 3 3 0 00-3 0z"/></svg></div>
      <h3>All clear</h3><p>Nothing in the Airlock. The AI is confident about everything.</p></div>`;
    return;
  }
  $('#airlock-list').innerHTML = `<div style="font-family:var(--mono);font-size:10px;letter-spacing:0.14em;color:var(--ink-50);padding:6px 4px 12px;text-transform:uppercase;">${items.length} unsure · tap to file</div>` +
    items.map(n => {
      const stk = stackById(n.stack);
      return `<div class="blade soon" data-id="${n.id}" style="margin-bottom:6px;">
        <div>
          <span class="stack-tag">~ ${stk.name.toUpperCase()}</span>
          <div class="t">${escapeHtml(n.title)}</div>
          ${n.why ? `<div class="m">${escapeHtml(n.why)}</div>` : ''}
        </div>
        <div class="due">${n.confidence ? Math.round(n.confidence * 100) + '%' : '?'}</div>
      </div>`;
    }).join('');
  $$('#airlock-list .blade').forEach(el => el.addEventListener('click', () => openNote(el.dataset.id)));
}

// ─── Settings ──────────────────────────────────────────────
function renderSettings() {
  const s = state.settings;
  $('#settings-body').innerHTML = `
    <div class="section-label">Appearance</div>
    <div class="section-group">
      <div class="row"><span class="r-label">Style</span>
        <div class="seg" id="seg-style">
          <button data-v="hifi" class="${s.style === 'hifi' ? 'on' : ''}">HiFi</button>
          <button data-v="industrial" class="${s.style === 'industrial' ? 'on' : ''}">Industrial</button>
        </div>
      </div>
      <div class="row"><span class="r-label">Theme</span>
        <div class="seg" id="seg-theme">
          <button data-v="dark" class="${s.theme === 'dark' ? 'on' : ''}">Dark</button>
          <button data-v="light" class="${s.theme === 'light' ? 'on' : ''}">Light</button>
        </div>
      </div>
    </div>

    <div class="section-label">Groq · the brain</div>
    <div class="section-group">
      <div class="row" onclick="LazNote.go('groq')">
        <span class="r-label">API key${s.groqKey ? '' : ' <span style="color:var(--amber);">· not set</span>'}</span>
        <span class="r-value">${s.groqKey ? '••• ' + s.groqKey.slice(-4) : 'add'}</span>
        <svg class="r-chev" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 5l5 5-5 5"/></svg>
      </div>
    </div>

    <div class="section-label">AI behavior</div>
    <div class="section-group">
      <div class="row" data-tog="autoFile"><span class="r-label">Auto-file to stacks</span><div class="toggle ${s.autoFile ? 'on' : ''}"></div></div>
      <div class="row" data-tog="showWhy"><span class="r-label">Show "why" suggestions</span><div class="toggle ${s.showWhy ? 'on' : ''}"></div></div>
    </div>

    <div class="section-label">Data</div>
    <div class="section-group">
      <div class="row" onclick="LazNote.exportJSON()"><span class="r-label">Export JSON</span><span class="r-value">${state.notes.length} notes</span></div>
      <div class="row" onclick="LazNote.importJSON()"><span class="r-label">Import JSON</span><span class="r-value">restore</span></div>
      <div class="row" onclick="LazNote.wipe()"><span class="r-label" style="color:var(--red);">Delete all notes</span></div>
    </div>

    <div class="section-label">About</div>
    <div class="section-group">
      <div class="row"><span class="r-label">Version</span><span class="r-value">1.0 · Phase 2</span></div>
      <div class="row"><span class="r-label">Storage</span><span class="r-value">Local · IndexedDB</span></div>
    </div>
  `;
  // wire toggles
  $$('#settings-body [data-tog]').forEach(r => r.addEventListener('click', async () => {
    const k = r.dataset.tog; state.settings[k] = !state.settings[k]; await saveSettings(); renderSettings();
  }));
  $$('#seg-style button').forEach(b => b.addEventListener('click', async () => {
    state.settings.style = b.dataset.v; applyTheme(); await saveSettings(); renderSettings();
  }));
  $$('#seg-theme button').forEach(b => b.addEventListener('click', async () => {
    state.settings.theme = b.dataset.v; applyTheme(); await saveSettings(); renderSettings();
  }));
}

// ─── Groq detail ──────────────────────────────────────────
function renderGroq() {
  const s = state.settings;
  const connected = !!s.groqKey;
  $('#groq-body').innerHTML = `
    <div style="background:var(--surface);border:1px solid ${connected ? 'rgba(197,236,58,0.25)' : 'var(--line-2)'};border-radius:var(--r-md);padding:14px;margin:10px 0 16px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="width:7px;height:7px;border-radius:50%;background:${connected ? 'var(--lime)' : 'var(--ink-30)'};box-shadow:${connected ? '0 0 12px var(--lime-glow)' : 'none'};animation:${connected ? 'pulse 1.6s infinite' : 'none'};"></span>
        <span style="font-family:var(--mono);font-size:10px;letter-spacing:0.16em;color:${connected ? 'var(--lime)' : 'var(--ink-50)'};">${connected ? 'CONNECTED' : 'NOT CONNECTED'}</span>
      </div>
      <div style="font-size:12px;color:var(--ink-70);margin-top:8px;line-height:1.5;">
        ${connected ? 'Your key is stored locally on this device.' : 'Get a free Groq key at <span style="color:var(--lime);">console.groq.com/keys</span> and paste it below.'}
      </div>
    </div>

    <div class="section-label">API key</div>
    <div style="display:flex;gap:6px;">
      <input class="input" id="groq-key-input" placeholder="gsk_..." value="${s.groqKey ? '••••••••••••' + s.groqKey.slice(-4) : ''}" />
    </div>
    <div style="display:flex;gap:6px;margin-top:8px;">
      <button class="btn" style="flex:1;" onclick="LazNote.editKey()">${s.groqKey ? 'Replace' : 'Save'}</button>
      <button class="btn" style="flex:1;" onclick="LazNote.testKey()" ${s.groqKey ? '' : 'disabled'}>Test</button>
    </div>

    <div class="section-label">Models per task</div>
    <div class="section-group">
      <div class="row"><span class="r-label">Sorting</span><span class="r-value">${MODELS.sort}</span></div>
      <div class="row"><span class="r-label">Logic / why</span><span class="r-value">${MODELS.logic}</span></div>
    </div>

    <div style="margin-top:18px;font-size:12px;color:var(--ink-50);line-height:1.5;">
      <strong style="color:var(--ink-70);">Privacy:</strong> Your key never leaves this device except in direct HTTPS calls to api.groq.com. No backend, no logging.
    </div>
  `;
}

// ─── Public methods (window.LazNote) ──────────────────────
const LazNote = {
  go: nav,
  back,
  closeCapture,
  saveCapture,
  search() { toast('Search coming in Phase 3'); },
  addStack() { toast('Custom stacks coming soon'); },
  async editKey() {
    const v = $('#groq-key-input').value.trim();
    if (!v || v.startsWith('•')) { toast('Paste a fresh key'); return; }
    state.settings.groqKey = v;
    await saveSettings();
    toast('Key saved', 'lime');
    renderGroq();
  },
  async testKey() {
    toast('Testing…', 'lime');
    try {
      const out = await groqChat({ model: MODELS.sort, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] });
      toast(out.toLowerCase().includes('ok') ? 'Connected ✓' : 'Got response · ' + out.slice(0, 30), 'lime');
    } catch (e) { toast(e.message.slice(0, 60)); }
  },
  async confirmAirlock() {
    const n = state.notes.find(x => x.id === state.currentNoteId); if (!n) return;
    n.status = 'active'; await idbPut('notes', n); back(); renderBlade(); toast('Filed', 'lime');
  },
  async markDone() {
    const n = state.notes.find(x => x.id === state.currentNoteId); if (!n) return;
    n.status = 'done'; await idbPut('notes', n); back(); renderBlade(); toast('Done ✓', 'lime');
  },
  async moveNote(stackId) {
    const n = state.notes.find(x => x.id === state.currentNoteId); if (!n) return;
    n.stack = stackId; n.status = 'active'; await idbPut('notes', n); renderNote(); renderBlade();
  },
  async saveNoteText() {
    const n = state.notes.find(x => x.id === state.currentNoteId); if (!n) return;
    const text = $('#note-text').value;
    if (text !== n.text) { n.text = text; n.updatedAt = Date.now(); await idbPut('notes', n); }
  },
  async deleteCurrentNote() {
    const id = state.currentNoteId; if (!id) return;
    await idbDel('notes', id);
    state.notes = state.notes.filter(n => n.id !== id);
    back(); renderBlade(); toast('Deleted');
  },
  exportJSON() {
    const blob = new Blob([JSON.stringify({ notes: state.notes, stacks: state.stacks, exportedAt: Date.now() }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `laznote-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 100);
  },
  importJSON() {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = 'application/json';
    i.onchange = async () => {
      const f = i.files[0]; if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (Array.isArray(data.notes)) {
          for (const n of data.notes) await idbPut('notes', n);
          state.notes = await idbAll('notes');
          toast(`Imported ${data.notes.length} notes`, 'lime');
          renderBlade(); renderSettings();
        }
      } catch (e) { toast('Bad file'); }
    };
    i.click();
  },
  async wipe() {
    if (!confirm('Delete all notes? This cannot be undone.')) return;
    for (const n of state.notes) await idbDel('notes', n.id);
    state.notes = []; renderSettings(); renderBlade(); toast('Wiped');
  }
};
window.LazNote = LazNote;

// ─── Theme ───────────────────────────────────────────────
function applyTheme() {
  document.body.classList.toggle('industrial', state.settings.style === 'industrial');
  document.body.classList.toggle('light', state.settings.theme === 'light');
}

// ─── Wiring ──────────────────────────────────────────────
$('#fab-pulse').addEventListener('click', openCapture);
$$('[data-back]').forEach(el => el.addEventListener('click', back));
$$('.botnav .nav[data-go]').forEach(n => n.addEventListener('click', () => nav(n.dataset.go)));

// ─── Boot ────────────────────────────────────────────────
(async function boot() {
  try {
    await openDB();
    await loadSettings();
    state.notes = await idbAll('notes');
    applyTheme();
    if (!state.settings.onboarded) {
      onbIdx = 0; renderOnb(); nav('onb', false);
    } else {
      nav('blade', false);
    }
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;color:var(--ink-70);font-family:var(--mono);">Boot error: ${e.message}</div>`;
  }
})();

// ─── Camera and Voice Capture Modes ──────────────────────
let cameraStream = null;
let voiceRecognition = null;
let isVoiceRecording = false;
let currentCaptureMode = 'text';

function initializeVoiceRecognition() {
  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    voiceRecognition = new SpeechRecognition();
    voiceRecognition.continuous = true;
    voiceRecognition.interimResults = true;
    voiceRecognition.lang = 'en-US';

    voiceRecognition.onstart = () => {
      isVoiceRecording = true;
      updateVoiceButton();
    };

    voiceRecognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript + ' ';
        } else {
          interim += transcript;
        }
      }
      const transcript = document.getElementById('voice-transcript');
      if (transcript) transcript.textContent = (final || interim) || 'Listening...';
    };

    voiceRecognition.onend = () => {
      isVoiceRecording = false;
      updateVoiceButton();
    };

    voiceRecognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      const transcript = document.getElementById('voice-transcript');
      if (transcript) transcript.textContent = 'Error: ' + event.error;
    };
  }
}

function updateVoiceButton() {
  const btn = document.getElementById('voice-record-btn');
  if (!btn) return;
  if (isVoiceRecording) {
    btn.textContent = '⏹️ Stop recording';
    btn.style.background = 'rgba(226, 75, 74, 0.2)';
  } else {
    btn.textContent = '🎙️ Start recording';
    btn.style.background = 'transparent';
  }
}

// Expose capture mode functions on LazNote object
window.LazNote.switchCaptureMode = function(mode) {
  currentCaptureMode = mode;
  
  document.querySelectorAll('.input-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  
  document.querySelectorAll('.capture-mode-section').forEach(section => {
    section.classList.remove('active');
    section.style.display = 'none';
  });
  
  const activeSection = document.getElementById('capture-mode-' + mode);
  if (activeSection) {
    activeSection.classList.add('active');
    activeSection.style.display = 'block';
  }
  
  if (mode === 'voice' && voiceRecognition === null) {
    initializeVoiceRecognition();
  }
  if (mode === 'camera') {
    const info = document.getElementById('camera-info');
    if (info) info.textContent = '✓ Ready. Tap "Start" to begin.';
  }
};

window.LazNote.toggleVoiceRecord = function() {
  if (!voiceRecognition) {
    initializeVoiceRecognition();
  }
  
  if (isVoiceRecording) {
    voiceRecognition.stop();
  } else {
    const transcript = document.getElementById('voice-transcript');
    if (transcript) transcript.textContent = 'Listening...';
    voiceRecognition.start();
  }
};

window.LazNote.clearVoiceTranscript = function() {
  if (voiceRecognition && isVoiceRecording) {
    voiceRecognition.stop();
  }
  const transcript = document.getElementById('voice-transcript');
  if (transcript) transcript.textContent = 'Ready to record...';
  isVoiceRecording = false;
  updateVoiceButton();
};

// ─── Camera Implementation (Proven Working) ──────────────────────────────
window.LazNote.startCamera = async function() {
  const status = document.getElementById('camera-status');
  const video = document.getElementById('camera-video');
  
  try {
    if (status) status.textContent = '⏳ Requesting camera...';
    
    // Request camera stream
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false
    });
    
    if (!video) return;
    
    // Attach stream to video
    video.srcObject = cameraStream;
    
    // Wait for video to be ready
    return new Promise((resolve) => {
      video.onloadedmetadata = () => {
        video.play().catch(() => {});
        
        // Update UI
        document.getElementById('camera-start-btn').style.display = 'none';
        document.getElementById('camera-snap-btn').style.display = 'flex';
        document.getElementById('camera-stop-btn').style.display = 'flex';
        
        if (status) status.textContent = '✓ Camera ready. Frame text and tap Capture.';
        resolve();
      };
      
      // Timeout safety
      setTimeout(resolve, 3000);
    });
  } catch (err) {
    if (status) {
      if (err.name === 'NotAllowedError') status.textContent = '✗ Permission denied';
      else if (err.name === 'NotFoundError') status.textContent = '✗ No camera found';
      else status.textContent = `✗ Error: ${err.message}`;
    }
    console.error('Camera error:', err);
  }
};

window.LazNote.capturePhoto = async function() {
  const video = document.getElementById('camera-video');
  const canvas = document.getElementById('camera-canvas');
  const result = document.getElementById('ocr-result');
  const status = document.getElementById('camera-status');
  
  if (!video || !canvas || !result) return;
  
  // Check video is playing
  if (video.readyState !== video.HAVE_ENOUGH_DATA) {
    if (result) result.innerHTML = '⚠️ Video not ready. Wait a moment.';
    return;
  }
  
  try {
    // Capture frame
    const ctx = canvas.getContext('2d');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    if (canvas.width === 0 || canvas.height === 0) {
      if (result) result.innerHTML = '⚠️ Could not get video dimensions. Ensure camera is loaded.';
      return;
    }
    
    ctx.drawImage(video, 0, 0);
    
    // Get image data
    const imageData = canvas.toDataURL('image/jpeg', 0.85);
    
    if (result) result.innerHTML = '<span style="color:var(--lime);">⏳ Scanning text...</span>';
    
    // Run OCR
    const ocrResult = await Tesseract.recognize(imageData, 'eng', {
      logger: (m) => {
        if (m.status === 'recognizing' && result) {
          result.innerHTML = `<span style="color:var(--lime);">⏳ Processing ${Math.round(m.progress * 100)}%...</span>`;
        }
      }
    });
    
    const text = ocrResult.data.text.trim();
    
    if (!text) {
      if (result) result.innerHTML = '⚠️ No text found. Try better lighting.';
      return;
    }
    
    // Put text in textarea
    const textarea = document.getElementById('capture-text');
    if (textarea) textarea.value = text;
    
    // Show result
    const preview = text.substring(0, 100) + (text.length > 100 ? '...' : '');
    if (result) result.innerHTML = `<strong style="color:var(--lime);">✓ Success!</strong><br/><br/><code>${preview}</code>`;
    
  } catch (err) {
    if (result) result.innerHTML = `✗ OCR failed: ${err.message}`;
    console.error('OCR error:', err);
  }
};

window.LazNote.stopCamera = function() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  
  const video = document.getElementById('camera-video');
  if (video) video.srcObject = null;
  
  document.getElementById('camera-start-btn').style.display = 'flex';
  document.getElementById('camera-snap-btn').style.display = 'none';
  document.getElementById('camera-stop-btn').style.display = 'none';
  
  const status = document.getElementById('camera-status');
  if (status) status.textContent = 'Camera stopped. Tap Start to reopen.';
};

window.LazNote.uploadPhoto = async function(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const canvas = document.getElementById('camera-canvas');
  const result = document.getElementById('ocr-result');
  const status = document.getElementById('camera-status');
  
  if (!canvas || !result) return;
  
  try {
    if (status) status.textContent = '⏳ Loading image...';
    
    // Read file
    const reader = new FileReader();
    
    reader.onload = async (e) => {
      try {
        const img = new Image();
        img.onload = async () => {
          try {
            // Draw to canvas
            const ctx = canvas.getContext('2d');
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);
            
            if (status) status.textContent = '⏳ Scanning text...';
            
            // Run OCR
            const imageData = canvas.toDataURL('image/jpeg', 0.85);
            
            const ocrResult = await Tesseract.recognize(imageData, 'eng', {
              logger: (m) => {
                if (m.status === 'recognizing' && status) {
                  status.textContent = `⏳ Processing ${Math.round(m.progress * 100)}%...`;
                }
              }
            });
            
            const text = ocrResult.data.text.trim();
            
            if (!text) {
              if (result) result.innerHTML = '⚠️ No text found in image. Try a different photo.';
              return;
            }
            
            // Put text in textarea
            const textarea = document.getElementById('capture-text');
            if (textarea) textarea.value = text;
            
            // Show result
            const preview = text.substring(0, 100) + (text.length > 100 ? '...' : '');
            if (result) result.innerHTML = `<strong style="color:var(--lime);">✓ Success!</strong><br/><br/><code>${preview}</code>`;
            if (status) status.textContent = '✓ Photo scanned. Edit text below if needed.';
            
            // Reset file input
            event.target.value = '';
            
          } catch (err) {
            if (result) result.innerHTML = `✗ OCR failed: ${err.message}`;
            if (status) status.textContent = `✗ Error: ${err.message}`;
            console.error('OCR error:', err);
          }
        };
        
        img.onerror = () => {
          if (result) result.innerHTML = '✗ Failed to load image. Try a different file.';
          if (status) status.textContent = '✗ Invalid image file.';
        };
        
        img.src = e.target.result;
        
      } catch (err) {
        if (result) result.innerHTML = `✗ Error: ${err.message}`;
        if (status) status.textContent = `✗ Error: ${err.message}`;
        console.error('Upload error:', err);
      }
    };
    
    reader.onerror = () => {
      if (result) result.innerHTML = '✗ Failed to read file.';
      if (status) status.textContent = '✗ File read error.';
    };
    
    reader.readAsDataURL(file);
    
  } catch (err) {
    if (result) result.innerHTML = `✗ Error: ${err.message}`;
    if (status) status.textContent = `✗ Error: ${err.message}`;
    console.error('Upload error:', err);
  }
};

initializeVoiceRecognition();

})();
