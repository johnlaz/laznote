/* LazNote v3 · app logic (PWA, vanilla JS, no build) */
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
  const sys = `You classify notes with AI reasoning. Reply ONLY with valid JSON, no prose.
Stacks available:
${stackList}

For each note, extract:
- stack: which stack best fits (or null if truly ambiguous)
- title: 6-word max title
- due: today | soon | idle (based on urgency signals)
- urgency: high | med | low (based on language: "urgent", "ASAP", "before", dates, etc.)
- urgencyReason: one sentence explaining urgency level
- tags: 2-3 relevant tags as string array
- links: related topics/keywords as string array
- isRecurring: true if task repeats (check for: daily, weekly, monthly, every X)
- recurCycle: daily | weekly | monthly | annual | null
- confidence: 0.0-1.0 (how certain about the classification)
- aiReasoning: 1-2 sentences on why this stack and urgency
- why: legacy field (same as aiReasoning for now)

JSON schema:
{ "stack": "<id or null>",
  "title": "<max 6 words>",
  "due": "<today|soon|idle>",
  "urgency": "<high|med|low>",
  "urgencyReason": "<reason>",
  "tags": ["tag1", "tag2"],
  "links": ["topic1", "topic2"],
  "isRecurring": <bool>,
  "recurCycle": "<daily|weekly|monthly|annual|null>",
  "confidence": <0.0-1.0>,
  "aiReasoning": "<2 sentences>",
  "why": "<reason>" }`;
  const out = await groqChat({
    model: MODELS.sort,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: text }],
    json: true
  });
  try { return JSON.parse(out); }
  catch { return { stack: null, title: text.slice(0, 50), due: 'idle', urgency: 'low', urgencyReason: '', tags: [], links: [], isRecurring: false, recurCycle: null, confidence: 0, aiReasoning: 'Parse error', why: 'Parse error' }; }
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
const HIDE_NAV_VIEWS = new Set(['onb', 'note', 'groq']);

function nav(view, push = true) {
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
  state.view = view;
  if (push && state.navStack[state.navStack.length - 1] !== view) state.navStack.push(view);
  if (view === 'blade')    renderBlade();
  if (view === 'cards')    renderCards();
  if (view === 'stacks')   renderStacks();
  if (view === 'airlock')  renderAirlock();
  if (view === 'archive')  renderArchive();
  if (view === 'settings') renderSettings();
  if (view === 'groq')     renderGroq();
  if (view === 'note')     renderNote();
  // botnav active state + visibility
  $$('.botnav .nav').forEach(n => n.classList.toggle('active', n.dataset.go === view));
  const botnav = document.getElementById('botnav');
  if (botnav) botnav.style.display = HIDE_NAV_VIEWS.has(view) ? 'none' : '';
  // push history for hardware back
  if (push && view !== 'onb') {
    try { history.pushState({ view }, '', location.href.split('?')[0]); } catch(e) {}
  }
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
  const allActive = state.notes.filter(n => n.status !== 'done' && n.status !== 'airlock' && n.status !== 'trash' && n.status !== 'merged');
  const active = state._searchQuery ? searchNotes(state._searchQuery).filter(n => n.status === 'active') : allActive;
  $('#blade-count').textContent = state._searchQuery ? active.length : allActive.length;
  $('#blade-now-count').textContent = allActive.filter(n => n.due === 'today' || n.due === 'overdue').length;

  // Search banner
  const existingBanner = document.getElementById('search-banner');
  if (existingBanner) existingBanner.remove();
  if (state._searchQuery) {
    const banner = document.createElement('div');
    banner.id = 'search-banner';
    banner.style.cssText = 'padding:8px 18px;background:rgba(197,236,58,0.08);border-bottom:1px solid rgba(197,236,58,0.2);display:flex;align-items:center;justify-content:space-between;font-size:12px;';
    banner.innerHTML = `<span style="color:var(--lime);">🔍 "${escapeHtml(state._searchQuery)}" · ${active.length} result(s)</span><button onclick="LazNote.clearSearch()" style="background:none;border:none;color:var(--ink-50);cursor:pointer;font-size:11px;padding:2px 6px;">✕ Clear</button>`;
    document.getElementById('blade-list').before(banner);
  }

  // Archived badge on archive nav
  const doneCount = state.notes.filter(n => n.status === 'done').length;
  const archiveNavs = document.querySelectorAll('.nav[data-go="archive"]');
  archiveNavs.forEach(el => {
    el.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="14" height="4" rx="1"/><path d="M5 7v9a1 1 0 001 1h8a1 1 0 001-1V7"/><path d="M8 11h4"/></svg>Archive${doneCount ? `<span style="position:absolute;top:2px;right:8px;width:14px;height:14px;background:var(--lime);border-radius:50%;font-size:8px;color:#0b0d0a;display:flex;align-items:center;justify-content:center;font-weight:700;">${doneCount}</span>` : ''}`;
    el.style.position = 'relative';
  });

  // stack tabs
  const counts = { all: active.length };
  state.stacks.forEach(s => counts[s.id] = active.filter(n => n.stack === s.id).length);
  const tabs = [{ id: 'all', name: 'All' }, ...state.stacks];
  $('#stack-tabs').innerHTML = tabs.map(t => `
    <div data-stack="${t.id}" style="font-family:var(--mono);font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${state.stack === t.id ? 'var(--ink)' : 'var(--ink-50)'};padding:4px 0;border-bottom:2px solid ${state.stack === t.id ? 'var(--lime)' : 'transparent'};cursor:pointer;">
      ${t.name} <span style="color:${state.stack === t.id ? 'var(--lime)' : 'var(--ink-30)'};">${counts[t.id] || 0}</span>
    </div>`).join('');
  $$('#stack-tabs > div').forEach(el => el.addEventListener('click', () => { state.stack = el.dataset.stack; renderBlade(); }));

  const filtered = (state._searchQuery
    ? searchNotes(state._searchQuery).filter(n => n.status === 'active')
    : allActive
  ).filter(n => state.stack === 'all' || n.stack === state.stack);
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
    const urgencyColor = n.urgency === 'high' ? '#c5ec3a' : n.urgency === 'med' ? '#ff9900' : '#666';
    const allCardTags = [...new Set([...(n.hashtags||[]), ...(n.tags||[])])];
    const tagsHtml = allCardTags.length ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin:6px 0;">${allCardTags.map(t => `<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(197,236,58,0.1);color:#c5ec3a;border:1px solid rgba(197,236,58,0.3);">#${t}</span>`).join('')}</div>` : '';
    return `<div class="blade ${d.cls}" data-id="${n.id}" style="${n.done ? 'opacity:0.6;' : ''}">
      <div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <div style="width:2px;height:20px;background:${urgencyColor};border-radius:1px;"></div>
          <span class="stack-tag">${stk.name.toUpperCase()}</span>
          ${n.done ? '<span style="color:#888;font-size:11px;">✓ DONE</span>' : ''}
        </div>
        <div class="t">${escapeHtml(n.title || n.text.slice(0, 60))}</div>
        ${n.text && n.text !== n.title ? `<div class="m">${escapeHtml(n.text.slice(0, 70))}${n.text.length > 70 ? '…' : ''}</div>` : ''}
        ${tagsHtml}
      </div>
      <div class="due">${d.label}</div>
      <div style="position:absolute;top:0;right:0;width:0;height:0;border-style:solid;border-width:0 30px 30px 0;border-color:transparent ${n.done ? '#888' : d.cls === 'now' ? 'var(--lime)' : '#666'} transparent transparent;"></div>
    </div>
    <div style="padding:12px;background:var(--bg-2);border-bottom:1px solid var(--line);display:none;" id="note-actions-${n.id}">
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn-sm" onclick="event.stopPropagation();LazNote.showReasoning('${n.id}')" style="flex:1;">✦ Logic</button>
        <button class="btn-sm" onclick="event.stopPropagation();LazNote.toggleDone('${n.id}')" style="flex:1;">${n.done ? '↺ Redo' : '✓ Done'}</button>
        <button class="btn-sm" onclick="event.stopPropagation();LazNote.editNote('${n.id}')" style="flex:1;">✎ Edit</button>
        <button class="btn-sm" onclick="event.stopPropagation();LazNote.moveNote('${n.id}')" style="flex:1;">⇄ Move</button>
        <button class="btn-sm" onclick="event.stopPropagation();LazNote.deleteNote('${n.id}')" style="flex:1;color:#ff6b6b;">✕ Delete</button>
      </div>
      <div id="reasoning-${n.id}" style="margin-top:10px;padding:10px;background:var(--bg);border-radius:6px;border-left:2px solid var(--lime);font-size:11px;line-height:1.5;display:none;max-height:0;overflow:hidden;transition:max-height 0.3s;">
        <strong style="color:var(--lime);">AI Reasoning</strong>
        <div style="margin-top:6px;color:var(--ink-70);">${escapeHtml(n.aiReasoning || n.why || 'No reasoning recorded.')}</div>
        ${n.urgencyReason ? `<div style="margin-top:6px;color:var(--ink-50);"><strong>Urgency:</strong> ${escapeHtml(n.urgencyReason)}</div>` : ''}
      </div>
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
  // Stop MediaRecorder cleanly without transcribing
  if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
    _mediaRecorder.onstop = null; // skip transcription on close
    _mediaRecorder.stop();
  }
  if (_micStream) { _micStream.getTracks().forEach(t => t.stop()); _micStream = null; }
  _mediaRecorder = null;
  _audioChunks = [];
  isVoiceRecording = false;
  stopWaveform();
  setVoiceDot('idle');
  voiceFinalTranscript = '';
  $('#capture').classList.remove('open');
  $('#capture-text').value = '';
  const voiceTranscript = document.getElementById('voice-transcript');
  if (voiceTranscript) voiceTranscript.textContent = 'Ready to record. Tap "Start recording" to begin.';
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
  let note = {
    id: uid(),
    text,
    title: text.split('\n')[0].slice(0, 80),
    stack: manualStack || 'per',
    due: 'idle',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    why: '',
    
    // Hashtag extraction from content
    hashtags: extractHashtags(text),
    
    // V1 Features
    done: false,
    isRecurring: false,
    recurCycle: null,
    ghostUntil: null,
    urgency: 'low',
    urgencyReason: '',
    tags: [],
    links: [],
    pendingApproval: false,
    confidence: 100,
    aiReasoning: '',
    mergedInto: null
  };
  if (manualStack === '__air') { note.stack = 'per'; note.status = 'airlock'; }

  if (mode === 'ai' && state.settings.groqKey && !manualStack) {
    toast('AI is sorting…', 'lime');
    try {
      const r = await aiSortNote(text);
      
      // Stack classification
      if (r.stack && state.stacks.find(s => s.id === r.stack)) {
        note.stack = r.stack;
      } else if ((r.confidence ?? 1) < 0.5) {
        note.status = 'airlock';  // Low confidence → review in airlock
      }
      
      // Metadata
      if (r.title) note.title = r.title;
      if (r.due) note.due = r.due;
      note.why = r.why || '';
      
      // V1 Features from AI
      note.urgency = r.urgency || 'low';
      note.urgencyReason = r.urgencyReason || '';
      note.tags = r.tags || [];
      note.links = r.links || [];
      note.isRecurring = r.isRecurring || false;
      note.recurCycle = r.recurCycle || null;
      note.confidence = r.confidence ?? 100;
      note.aiReasoning = r.aiReasoning || r.why || '';
      note.pendingApproval = (r.confidence ?? 1) < 0.7;  // Approval if low confidence
      
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
  const d = fmtDue(n.due);
  const isDone = n.status === 'done';

  // Update done button appearance
  const doneBtn = document.getElementById('note-done-btn');
  if (doneBtn) {
    if (isDone) {
      doneBtn.title = 'Revive note';
      doneBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" width="14" height="14"><path d="M4 10l5 5 8-8"/></svg>';
      doneBtn.style.color = 'var(--lime)';
      doneBtn.onclick = () => LazNote.reviveNote(n.id);
    } else {
      doneBtn.title = 'Mark Done';
      doneBtn.onclick = () => LazNote.markDone();
    }
  }

  $('#note-stack').textContent = stk.name + (n.status === 'airlock' ? ' · Airlock' : isDone ? ' · Done' : '');
  const stackChips = state.stacks.map(s => `<span class="chip ${s.id === n.stack ? 'lime' : ''}" data-stack="${s.id}">${s.name}</span>`).join('');

  // Build hashtags display
  const allHashtags = [...new Set([...(n.hashtags||[]), ...(n.tags||[])])];
  const hashtagsHtml = allHashtags.length
    ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:10px;">${allHashtags.map(t => `<span style="font-size:11px;padding:3px 8px;border-radius:5px;background:rgba(197,236,58,0.12);color:#c5ec3a;border:1px solid rgba(197,236,58,0.25);cursor:pointer;" onclick="LazNote.searchTag('${t}')">#${t}</span>`).join('')}</div>`
    : '';

  // Build linked topics
  const linkedHtml = (n.links||[]).length
    ? `<div style="margin-top:14px;"><div style="font-family:var(--mono);font-size:9.5px;letter-spacing:0.16em;color:var(--ink-50);margin-bottom:6px;">LINKED TOPICS</div>
       <div style="display:flex;gap:5px;flex-wrap:wrap;">${(n.links||[]).map(l => `<span style="font-size:11px;padding:3px 8px;border-radius:5px;background:var(--surface);color:var(--ink-70);border:1px solid var(--line-2);">${escapeHtml(l)}</span>`).join('')}</div></div>`
    : '';

  $('#note-body').innerHTML = `
    <div style="font-family:var(--mono);font-size:10px;letter-spacing:0.14em;color:var(--lime);text-transform:uppercase;">${stk.name} · ${d.label}</div>
    <div style="font-size:24px;font-weight:700;letter-spacing:-0.02em;margin-top:6px;line-height:1.2;">${escapeHtml(n.title)}</div>
    <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
      <span class="chip ${d.cls === 'now' ? 'lime' : ''}">${d.label}</span>
      <span class="chip">${new Date(n.createdAt).toLocaleDateString()}</span>
      ${n.urgency && n.urgency !== 'low' ? `<span class="chip" style="color:${n.urgency==='high'?'#c5ec3a':'#ff9900'};">${n.urgency.toUpperCase()}</span>` : ''}
    </div>

    <textarea class="input" id="note-text" style="margin-top:14px;min-height:180px;${isDone ? 'opacity:0.7;' : ''}" ${isDone ? 'readonly' : ''}>${escapeHtml(n.text)}</textarea>

    ${hashtagsHtml}
    ${linkedHtml}

    <!-- Logic section (expandable) -->
    <div style="margin-top:14px;">
      <button class="btn-sm" id="logic-toggle-btn" onclick="LazNote.toggleLogicSection()" style="width:100%;justify-content:space-between;display:flex;align-items:center;padding:10px 12px;">
        <span style="display:flex;align-items:center;gap:6px;"><svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7 4a3 3 0 00-3 3v1a2 2 0 00-1 3.5A2 2 0 005 15h2v2h6v-2h2a2 2 0 002-3.5A2 2 0 0016 8V7a3 3 0 00-3-3 3 3 0 00-3 0 3 3 0 00-3 0z"/></svg>Logic</span>
        <span id="logic-toggle-icon" style="color:var(--ink-50);">▸</span>
      </button>
      <div id="logic-section" style="display:none;margin-top:2px;padding:12px;background:var(--surface);border:1px solid rgba(197,236,58,0.2);border-radius:8px;">
        ${n.aiReasoning || n.why ? `<div style="margin-bottom:10px;"><div style="font-family:var(--mono);font-size:9.5px;letter-spacing:0.14em;color:var(--lime);margin-bottom:6px;">AI REASONING</div><div style="font-size:12px;color:var(--ink-70);line-height:1.6;">${escapeHtml(n.aiReasoning || n.why)}</div></div>` : ''}
        ${n.urgencyReason ? `<div style="margin-bottom:10px;"><div style="font-family:var(--mono);font-size:9.5px;letter-spacing:0.14em;color:#ff9900;margin-bottom:6px;">URGENCY</div><div style="font-size:12px;color:var(--ink-70);line-height:1.6;">${escapeHtml(n.urgencyReason)}</div></div>` : ''}
        ${(n.hashtags||[]).length ? `<div style="margin-bottom:10px;"><div style="font-family:var(--mono);font-size:9.5px;letter-spacing:0.14em;color:var(--ink-50);margin-bottom:6px;">AUTO-HASHTAGS</div><div style="display:flex;gap:4px;flex-wrap:wrap;">${(n.hashtags||[]).map(h=>`<span style="font-size:11px;padding:2px 7px;border-radius:4px;background:rgba(197,236,58,0.1);color:#c5ec3a;border:1px solid rgba(197,236,58,0.2);">#${h}</span>`).join('')}</div></div>` : ''}
        ${(n.links||[]).length ? `<div style="margin-bottom:10px;"><div style="font-family:var(--mono);font-size:9.5px;letter-spacing:0.14em;color:var(--ink-50);margin-bottom:6px;">LINKED TOPICS</div><div style="display:flex;gap:4px;flex-wrap:wrap;">${(n.links||[]).map(l=>`<span style="font-size:11px;padding:2px 7px;border-radius:4px;background:var(--surface-2);color:var(--ink-70);border:1px solid var(--line-2);">${escapeHtml(l)}</span>`).join('')}</div></div>` : ''}
        ${!n.aiReasoning && !n.why && !(n.hashtags||[]).length && !(n.links||[]).length ? `<div style="font-size:12px;color:var(--ink-50);margin-bottom:8px;">No AI logic recorded.${state.settings.groqKey ? ' Tap Re-sort to analyse this note.' : ' Connect Groq in Settings to enable AI analysis.'}</div>` : ''}
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line-2);font-family:var(--mono);font-size:10px;color:var(--ink-30);">Confidence: ${n.confidence ? Math.round(n.confidence * (n.confidence > 1 ? 1 : 100)) + '%' : '—'}</div>

        ${state.settings.groqKey ? `
        <!-- AI Actions -->
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line-2);">
          <div style="font-family:var(--mono);font-size:9.5px;letter-spacing:0.14em;color:var(--ink-50);margin-bottom:8px;">AI ACTIONS</div>
          <div style="display:flex;gap:6px;margin-bottom:6px;">
            <button class="btn-sm" style="flex:1;" onclick="LazNote.resortNote('${n.id}')">
              <svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="vertical-align:-1px;margin-right:4px;"><path d="M4 4l12 12M16 4L4 16"/><circle cx="10" cy="10" r="7"/></svg>Re-sort
            </button>
            <button class="btn-sm" style="flex:1;" onclick="LazNote.summarizeNote('${n.id}')">
              <svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="vertical-align:-1px;margin-right:4px;"><path d="M4 6h12M4 10h8M4 14h10"/></svg>Summarize
            </button>
            <button class="btn-sm" style="flex:1;" onclick="LazNote.adviceNote('${n.id}')">
              <svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="vertical-align:-1px;margin-right:4px;"><path d="M10 2a7 7 0 100 14A7 7 0 0010 2z"/><path d="M10 11v1m0-5a1.5 1.5 0 010 3"/></svg>Advice
            </button>
          </div>
          <div id="ai-action-result" style="display:none;margin-top:10px;padding:10px;background:var(--bg);border:1px solid rgba(197,236,58,0.2);border-radius:6px;">
            <div style="font-family:var(--mono);font-size:9px;letter-spacing:0.14em;color:var(--lime);margin-bottom:6px;" id="ai-action-label">RESULT</div>
            <div style="font-size:12px;color:var(--ink-70);line-height:1.6;" id="ai-action-text"></div>
            <div style="margin-top:8px;display:flex;gap:6px;">
              <button class="btn-sm" style="flex:1;font-size:10px;" onclick="LazNote.pinAiResult('${n.id}')">📌 Pin to note</button>
              <button class="btn-sm" style="flex:1;font-size:10px;color:var(--ink-50);" onclick="document.getElementById('ai-action-result').style.display='none'">✕ Dismiss</button>
            </div>
          </div>
        </div>` : ''}
      </div>
    </div>

    ${!isDone ? `<div style="margin-top:16px;font-family:var(--mono);font-size:9.5px;letter-spacing:0.16em;color:var(--ink-50);">MOVE TO</div>
    <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;" id="move-chips">${stackChips}</div>` : ''}

    ${n.status === 'airlock'
      ? `<div style="margin-top:16px;"><button class="btn primary block" onclick="LazNote.confirmAirlock()">Confirm → ${stk.name}</button></div>`
      : ''}
  `;

  // wire move chips
  $$('#move-chips .chip').forEach(c => c.addEventListener('click', () => LazNote.moveNote(c.dataset.stack)));
  // autosave on blur
  const ta = $('#note-text');
  if (ta && !isDone) ta.addEventListener('blur', () => LazNote.saveNoteText());
}

function toggleLogicSection() {
  const el = document.getElementById('logic-section');
  const icon = document.getElementById('logic-toggle-icon');
  if (!el) return;
  const open = el.style.display === 'none';
  el.style.display = open ? 'block' : 'none';
  if (icon) icon.textContent = open ? '▾' : '▸';
}
// ─── Stacks ───────────────────────────────────────────────
function renderStacks() {
  const defaults = ['biz','diy','dev','per'];
  $('#stacks-list').innerHTML = `
    <div class="section-label" style="margin-top:6px;">Your Stacks</div>
    <div class="section-group">${state.stacks.map(s => {
      const c = state.notes.filter(n => n.stack === s.id && n.status === 'active').length;
      const isDefault = defaults.includes(s.id);
      return `<div class="row" data-stack="${s.id}" style="cursor:pointer;">
        <div class="r-label" style="flex:1;cursor:pointer;" onclick="LazNote.goStack('${s.id}')">${escapeHtml(s.name)}<div style="font-family:var(--mono);font-size:10px;color:var(--ink-50);margin-top:2px;">${escapeHtml(s.desc)}</div></div>
        <span class="r-value">${c}</span>
        ${!isDefault ? `<div class="icon-btn" style="width:28px;height:28px;color:var(--red);margin-left:6px;" onclick="event.stopPropagation();LazNote.deleteStack('${s.id}')"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" width="12" height="12"><path d="M5 6h10M8 9v6M12 9v6M6 6l1 10h6l1-10M8 6V4h4v2"/></svg></div>` : `<svg class="r-chev" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 5l5 5-5 5"/></svg>`}
      </div>`;
    }).join('')}</div>
    <div style="margin-top:16px;">
      <button class="btn primary block" onclick="LazNote.addStack()">+ Add New Stack</button>
    </div>
    <div style="margin-top:8px;font-size:11px;color:var(--ink-50);text-align:center;">New stacks appear in the blade tabs and capture sheet</div>
  `;
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

// ─── Archive (Done + Trash) ────────────────────────────
function renderArchive() {
  const done  = state.notes.filter(n => n.status === 'done');
  const trash = state.notes.filter(n => n.status === 'trash');
  const list  = document.getElementById('archive-list');
  if (!list) return;

  // Show empty-trash button only when there's trash
  const trashBtn = document.getElementById('archive-trash-btn');
  if (trashBtn) trashBtn.style.display = trash.length ? '' : 'none';

  if (!done.length && !trash.length) {
    list.innerHTML = `<div class="empty">
      <div class="ic"><svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="14" height="4" rx="1"/><path d="M5 7v9a1 1 0 001 1h8a1 1 0 001-1V7"/><path d="M8 11h4"/></svg></div>
      <h3>Archive is empty</h3><p>Mark notes as done or move them here.</p></div>`;
    return;
  }

  let html = '';

  if (done.length) {
    html += `<div style="font-family:var(--mono);font-size:10px;letter-spacing:0.14em;color:var(--lime);padding:12px 4px 8px;text-transform:uppercase;">✓ Completed · ${done.length}</div>`;
    done.sort((a,b) => (b.doneAt||b.updatedAt) - (a.doneAt||a.updatedAt));
    done.forEach(n => {
      const stk = stackById(n.stack);
      const doneDate = n.doneAt ? new Date(n.doneAt).toLocaleDateString() : '';
      const tagsHtml = (n.hashtags||[]).length
        ? (n.hashtags||[]).slice(0,3).map(t=>`<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(197,236,58,0.1);color:#c5ec3a;border:1px solid rgba(197,236,58,0.2);">#${t}</span>`).join(' ')
        : '';
      html += `<div style="background:var(--surface);border:1px solid var(--line-2);border-radius:10px;padding:12px 14px;margin-bottom:8px;opacity:0.85;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
          <div style="flex:1;">
            <span style="font-size:10px;font-family:var(--mono);color:var(--lime);text-transform:uppercase;">${stk.name}</span>
            <div style="font-weight:600;font-size:13px;margin-top:2px;">${escapeHtml(n.title)}</div>
          </div>
          <span style="font-size:10px;color:var(--ink-50);white-space:nowrap;margin-left:8px;">${doneDate}</span>
        </div>
        ${tagsHtml ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px;">${tagsHtml}</div>` : ''}
        <div style="display:flex;gap:6px;margin-top:8px;">
          <button class="btn-sm" style="flex:1;" onclick="LazNote.reviveNote('${n.id}')">↺ Revive</button>
          <button class="btn-sm" onclick="LazNote.printSelected(JSON.stringify(['${n.id}']))" title="Export">📤</button>
          <button class="btn-sm" onclick="LazNote.trashFromArchive('${n.id}')" style="color:var(--red);">🗑 Trash</button>
        </div>
      </div>`;
    });
  }

  if (trash.length) {
    html += `<div style="font-family:var(--mono);font-size:10px;letter-spacing:0.14em;color:#ff6b6b;padding:16px 4px 8px;text-transform:uppercase;">🗑 Trash · ${trash.length}</div>`;
    trash.sort((a,b) => (b.trashedAt||0) - (a.trashedAt||0));
    trash.forEach(n => {
      const stk = stackById(n.stack);
      html += `<div style="background:var(--surface);border:1px solid rgba(255,80,80,0.2);border-radius:10px;padding:12px 14px;margin-bottom:8px;opacity:0.7;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <div>
            <span style="font-size:10px;font-family:var(--mono);color:#ff6b6b;text-transform:uppercase;">${stk.name}</span>
            <div style="font-weight:600;font-size:13px;margin-top:2px;">${escapeHtml(n.title)}</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn-sm" style="flex:1;" onclick="LazNote.restoreFromTrash('${n.id}')">↺ Restore</button>
          <button class="btn-sm" onclick="LazNote.permanentDelete('${n.id}')" style="color:#ff6b6b;flex:1;">✕ Delete forever</button>
        </div>
      </div>`;
    });
  }

  list.innerHTML = html;
}

// ─── Print Modal ─────────────────────────────────────────
function openPrintModal(notes) {
  if (!notes || !notes.length) { toast('No notes to export'); return; }
  // Store IDs on window to avoid JSON double-quotes breaking inline onclick HTML
  window._pendingExportIds = notes.map(n => n.id);
  document.getElementById('print-body').innerHTML = `
    <div style="margin-bottom:16px;font-size:13px;color:var(--ink-70);">Exporting <strong style="color:var(--ink);">${notes.length}</strong> note${notes.length !== 1 ? 's' : ''}.</div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <button class="btn primary block" onclick="LazNote.exportTXT()">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" style="vertical-align:-2px;margin-right:6px;"><rect x="3" y="2" width="14" height="16" rx="2"/><path d="M7 7h6M7 10h6M7 13h4"/></svg>
        Export as TXT
        <div style="font-size:10px;opacity:0.7;margin-top:2px;">Plain text · paste anywhere · good for messaging</div>
      </button>
      <button class="btn block" style="border:1px solid var(--line-2);" onclick="LazNote.exportPNG()">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" style="vertical-align:-2px;margin-right:6px;"><rect x="2" y="4" width="16" height="12" rx="2"/><circle cx="7" cy="9" r="1.5"/><path d="M2 14l4-4 3 3 3-4 6 5"/></svg>
        Export as PNG Cards
        <div style="font-size:10px;opacity:0.7;margin-top:2px;">Professional card images · great for texting</div>
      </button>
    </div>
    <div style="margin-top:14px;font-size:11px;color:var(--ink-50);">Files download to your device. Nothing is uploaded.</div>
  `;
  document.getElementById('print-modal').style.display = 'block';
}

// ─── Canvas helpers for PNG export ───────────────────────
function fillRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function truncCtx(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  while (text.length > 0 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
  return text + '…';
}
function wrapCtx(ctx, text, x, y, maxW, lineH, maxLines) {
  const words = text.split(' '); let line = ''; let lines = 0;
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxW) {
      if (lines >= maxLines) { ctx.fillText(line + '…', x, y); return; }
      ctx.fillText(line, x, y); y += lineH; line = word; lines++;
    } else { line = test; }
  }
  if (line && lines < maxLines) ctx.fillText(line, x, y);
}


function renderCards() {
  const active = state.notes.filter(n => n.status !== 'done' && n.status !== 'airlock');
  active.sort((a, b) => {
    const order = { overdue: 0, today: 1, soon: 2, idle: 3 };
    return (order[a.due] ?? 3) - (order[b.due] ?? 3) || b.createdAt - a.createdAt;
  });

  $('#cards-grid').innerHTML = active.map(n => {
    const stk = stackById(n.stack);
    const dateStr = new Date(n.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `
      <div class="card" data-id="${n.id}" data-card-id="${n.id}">
        <div class="card-checkbox" onclick="event.stopPropagation();LazNote.toggleCardSelect('${n.id}')"></div>
        <div class="card-header">
          <span class="card-stack">${stk.name}</span>
          <div class="card-urgency ${n.urgency || 'low'}"></div>
        </div>
        <div class="card-title">${escapeHtml(n.title || n.text.slice(0, 60))}</div>
        <div class="card-content">${escapeHtml(n.text.slice(0, 100))}</div>
        <div class="card-meta">
          ${n.tags && n.tags.length ? n.tags.slice(0, 2).map(t => `<span class="card-tag">#${t}</span>`).join('') : ''}
          <span class="card-date">${dateStr}</span>
        </div>
      </div>`;
  }).join('');

  $$('.card').forEach(el => {
    el.addEventListener('click', (e) => {
      if (!e.target.closest('.card-checkbox')) {
        openNote(el.dataset.id);
      }
    });
  });
}

// ─── PDF Export (moved into LazNote object below) ───────
function _exportPDF() {
  const selected = $$('.card.selected');
  const toExport = selected.length > 0 
    ? selected.map(c => state.notes.find(n => n.id === c.dataset.id))
    : state.notes.filter(n => n.status !== 'done' && n.status !== 'airlock');

  if (!toExport.length) {
    toast('No notes to export. Select cards or create notes.');
    return;
  }

  const element = document.createElement('div');
  element.style.padding = '20px';
  element.style.fontFamily = 'Inter, sans-serif';
  element.style.lineHeight = '1.6';
  element.style.color = '#f0f0f0';

  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  element.innerHTML = `
    <div style="text-align: center; margin-bottom: 30px; border-bottom: 2px solid #c5ec3a; padding-bottom: 20px;">
      <h1 style="margin: 0; font-size: 28px; color: #c5ec3a;">LazNote Export</h1>
      <p style="margin: 5px 0 0; font-size: 12px; color: #999;">${now}</p>
      <p style="margin: 5px 0 0; font-size: 12px; color: #999;">${toExport.length} note${toExport.length !== 1 ? 's' : ''}</p>
    </div>
    ${toExport.map((n, idx) => {
      const stk = stackById(n.stack);
      const dateStr = new Date(n.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      return `
        <div style="margin-bottom: 25px; padding-bottom: 20px; border-bottom: 1px solid #333;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <h2 style="margin: 0; font-size: 16px; color: #c5ec3a;">${escapeHtml(n.title || n.text.slice(0, 60))}</h2>
            <span style="font-size: 11px; color: #999; text-transform: uppercase; letter-spacing: 0.05em;">${stk.name}</span>
          </div>
          <p style="margin: 8px 0; font-size: 13px; color: #999; font-family: 'JetBrains Mono', monospace;">
            ${dateStr} • Urgency: ${n.urgency || 'Low'}${n.isRecurring ? ' • Recurring: ' + (n.recurCycle || 'Custom') : ''}
          </p>
          <div style="margin: 12px 0; font-size: 13px; line-height: 1.6; color: #e0e0e0;">
            ${n.text.split('\n').map(line => line ? `<p style="margin: 6px 0;">${escapeHtml(line)}</p>` : '').join('')}
          </div>
          ${n.tags && n.tags.length ? `
            <div style="margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap;">
              ${n.tags.map(t => `<span style="font-size: 11px; padding: 3px 8px; background: rgba(197,236,58,0.15); color: #c5ec3a; border-radius: 3px;">#${t}</span>`).join('')}
            </div>
          ` : ''}
          ${n.aiReasoning ? `
            <div style="margin-top: 12px; padding: 10px; background: rgba(197,236,58,0.08); border-left: 3px solid #c5ec3a; border-radius: 4px; font-size: 12px; color: #b0b0b0;">
              <strong style="color: #c5ec3a;">AI Reasoning:</strong> ${escapeHtml(n.aiReasoning)}
            </div>
          ` : ''}
        </div>
      `;
    }).join('')}
    <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #333; text-align: center; font-size: 11px; color: #666;">
      <p>Generated by LazNote • 100% Private • Local-First</p>
    </div>
  `;

  const opt = {
    margin: 10,
    filename: `laznote-export-${new Date().toISOString().slice(0, 10)}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, backgroundColor: '#0b0d0a' },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
    pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
  };

  html2pdf().set(opt).from(element).save().then(() => {
    toast(`✓ Exported ${toExport.length} note${toExport.length !== 1 ? 's' : ''}`, 'lime');
    $$('.card').forEach(c => c.classList.remove('selected'));
    renderCards();
  }).catch(err => {
    toast('PDF export failed: ' + err.message, 'red');
    console.error('PDF export error:', err);
  });
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
      <div class="row" onclick="document.getElementById('about-modal').style.display='flex'"><span class="r-label">About LazNote</span><svg class="r-chev" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 5l5 5-5 5"/></svg></div>
      <div class="row" onclick="document.getElementById('help-modal').style.display='flex'"><span class="r-label">Help &amp; FAQ</span><svg class="r-chev" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 5l5 5-5 5"/></svg></div>
      <div class="row"><span class="r-label">Version</span><span class="r-value">3.0</span></div>
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
  // ── SEARCH ──────────────────────────────────────────
  search() {
    const modal = document.getElementById('search-modal');
    const input = document.getElementById('search-input');
    if (modal) {
      input.value = state._searchQuery || '';
      modal.style.display = 'flex';
      setTimeout(() => input.focus(), 100);
    }
  },
  closeSearchModal() {
    document.getElementById('search-modal').style.display = 'none';
  },
  doSearch() {
    const q = document.getElementById('search-input').value.trim();
    document.getElementById('search-modal').style.display = 'none';
    if (!q) { state._searchQuery = null; renderBlade(); return; }
    state._searchQuery = q;
    if (state.view !== 'blade') nav('blade');
    else renderBlade();
    const count = searchNotes(q).filter(n => n.status === 'active').length;
    toast(count ? `${count} result(s) for "${q}"` : 'No results');
  },
  clearSearch() { state._searchQuery = null; renderBlade(); },
  searchTag(tag) { state._searchQuery = tag; nav('blade'); },
  goStack(id) { state.stack = id; nav('blade'); },
  // ── Input modal helpers ──────────────────────────────
  closeInputModal() {
    document.getElementById('input-modal').style.display = 'none';
  },
  // ── STACK MANAGEMENT ─────────────────────────────────
  addStack() {
    const m = document.getElementById('stack-modal');
    document.getElementById('stack-modal-title').textContent = 'New Stack';
    document.getElementById('stack-name-input').value = '';
    document.getElementById('stack-desc-input').value = '';
    m.style.display = 'flex'; m.style.alignItems = 'flex-start'; m.style.justifyContent = 'center';
    setTimeout(() => document.getElementById('stack-name-input').focus(), 120);
  },
  async confirmAddStack() {
    const name = document.getElementById('stack-name-input').value.trim();
    const desc = document.getElementById('stack-desc-input').value.trim();
    if (!name) { toast('Stack name is required'); return; }
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) + '_' + Date.now().toString(36).slice(-4);
    state.stacks.push({ id, name, desc: desc || name + ' notes' });
    await saveStacks();
    document.getElementById('stack-modal').style.display = 'none';
    renderStacks(); renderCaptureChips(); renderBlade();
    toast('"' + name + '" stack added', 'lime');
  },
  async deleteStack(id) {
    const stk = state.stacks.find(s => s.id === id);
    if (!stk) return;
    const defaults = ['biz','diy','dev','per'];
    if (defaults.includes(id)) { toast('Cannot delete default stacks'); return; }
    const count = state.notes.filter(n => n.stack === id && n.status === 'active').length;
    if (!confirm('Delete stack "' + stk.name + '"?' + (count ? '\n' + count + ' note(s) move to Personal.' : ''))) return;
    state.notes.filter(n => n.stack === id).forEach(n => { n.stack = 'per'; idbPut('notes', n).catch(() => {}); });
    state.stacks = state.stacks.filter(s => s.id !== id);
    await saveStacks();
    renderStacks(); renderBlade(); renderCaptureChips();
    toast('Stack deleted', 'lime');
  },
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
  // ── NOTE LIFECYCLE ──────────────────────────────────
  async confirmAirlock() {
    const n = state.notes.find(x => x.id === state.currentNoteId); if (!n) return;
    n.status = 'active'; await idbPut('notes', n); back(); renderBlade(); toast('Filed', 'lime');
  },
  async markDone() {
    const n = state.notes.find(x => x.id === state.currentNoteId); if (!n) return;
    if (n.isRecurring && n.recurCycle) {
      const days = { daily:1, weekly:7, monthly:30, annual:365 }[n.recurCycle] || 1;
      n.ghostUntil = Date.now() + days * 86400000;
      toast('Done ✓ · resets in ' + days + ' day(s)', 'lime');
    } else {
      toast('Done ✓ · moved to Archive', 'lime');
    }
    n.status = 'done'; n.done = true; n.doneAt = Date.now();
    await idbPut('notes', n); back(); renderBlade();
  },
  async reviveNote(id) {
    const n = state.notes.find(x => x.id === id); if (!n) return;
    n.status = 'active'; n.done = false; n.doneAt = null;
    await idbPut('notes', n); renderArchive(); renderBlade();
    toast('↺ Revived to ' + stackById(n.stack).name, 'lime');
  },
  async trashCurrentNote() {
    const n = state.notes.find(x => x.id === state.currentNoteId); if (!n) return;
    if (!confirm('Move to trash?')) return;
    n.status = 'trash'; n.trashedAt = Date.now();
    await idbPut('notes', n); back(); renderBlade(); toast('Moved to trash');
  },
  async trashFromArchive(id) {
    const n = state.notes.find(x => x.id === id); if (!n) return;
    if (!confirm('Move to trash?')) return;
    n.status = 'trash'; n.trashedAt = Date.now();
    await idbPut('notes', n); renderArchive(); toast('Moved to trash');
  },
  async restoreFromTrash(id) {
    const n = state.notes.find(x => x.id === id); if (!n) return;
    n.status = 'active'; n.done = false; n.doneAt = null; n.trashedAt = null;
    await idbPut('notes', n); renderArchive(); renderBlade(); toast('↺ Restored', 'lime');
  },
  async permanentDelete(id) {
    if (!confirm('Permanently delete? Cannot be undone.')) return;
    state.notes = state.notes.filter(n => n.id !== id);
    await idbDel('notes', id); renderArchive(); toast('Permanently deleted');
  },
  async emptyTrash() {
    const trash = state.notes.filter(n => n.status === 'trash');
    if (!trash.length) { toast('Trash is empty'); return; }
    if (!confirm('Permanently delete ' + trash.length + ' trashed note(s)?')) return;
    for (const n of trash) await idbDel('notes', n.id);
    state.notes = state.notes.filter(n => n.status !== 'trash');
    renderArchive(); toast('Trash emptied (' + trash.length + ' notes)');
  },
  async moveNote(stackId) {
    const n = state.notes.find(x => x.id === state.currentNoteId); if (!n) return;
    n.stack = stackId; n.status = 'active'; await idbPut('notes', n); renderNote(); renderBlade();
  },
  async saveNoteText() {
    const n = state.notes.find(x => x.id === state.currentNoteId); if (!n) return;
    const el = $('#note-text'); if (!el) return;
    const text = el.value.trim();
    if (text !== n.text) {
      n.text = text; n.updatedAt = Date.now();
      n.hashtags = extractHashtags(text);
      await idbPut('notes', n); toast('Saved', 'lime');
    }
  },
  // kept for backward compat — now routes to trash
  async deleteCurrentNote() { return LazNote.trashCurrentNote(); },
  // ── SCAN NOTES ──────────────────────────────────────
  scanNotes() {
    const active = state.notes.filter(n => n.status === 'active');
    if (active.length < 2) { toast('Need 2+ notes to scan'); return; }
    const seen = new Set(); const groups = [];
    active.forEach(note => {
      if (seen.has(note.id)) return;
      const similar = findSimilarNotes(note.id);
      if (similar.length) { groups.push({ anchor: note, matches: similar }); similar.forEach(s => seen.add(s.note.id)); seen.add(note.id); }
    });
    const body = document.getElementById('scan-body');
    if (!groups.length) {
      body.innerHTML = '<div style="text-align:center;padding:30px 0;"><div style="font-size:36px;margin-bottom:10px;">✓</div><div style="color:var(--ink-70);">No similar notes found. All notes are unique!</div></div>';
    } else {
      body.innerHTML = '<div style="font-family:var(--mono);font-size:10px;color:var(--lime);letter-spacing:0.12em;margin-bottom:14px;">' + groups.length + ' GROUP(S) — CLICK MERGE TO COMBINE</div>' +
        groups.map(g => '<div style="border:1px solid var(--line-2);border-radius:10px;overflow:hidden;margin-bottom:12px;">' +
          '<div style="padding:12px 14px;background:var(--surface);border-bottom:1px solid var(--line-2);">' +
          '<div style="font-size:12px;font-weight:600;">ANCHOR: ' + escapeHtml(g.anchor.title) + '</div>' +
          '<div style="font-size:11px;color:var(--ink-50);margin-top:2px;">' + stackById(g.anchor.stack).name + ' · ' + new Date(g.anchor.createdAt).toLocaleDateString() + '</div>' +
          '</div>' +
          g.matches.slice(0,3).map(m => '<div style="padding:10px 14px;border-top:1px solid var(--line-2);">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
            '<span style="font-size:12px;font-weight:500;">' + escapeHtml(m.note.title) + '</span>' +
            '<span style="background:rgba(197,236,58,0.15);color:var(--lime);padding:2px 8px;border-radius:10px;font-size:10px;font-family:var(--mono);">' + m.score + '%</span>' +
            '</div><div style="font-size:11px;color:var(--ink-50);margin-bottom:8px;">' + m.reasons.join(' · ') + '</div>' +
            '<div style="display:flex;gap:6px;">' +
            '<button class="btn-sm" style="flex:1;" onclick="LazNote.mergeNotes(\'' + g.anchor.id + '\',\'' + m.note.id + '\')">Merge into anchor</button>' +
            '<button class="btn-sm" onclick="document.getElementById(\'scan-modal\').style.display=\'none\';openNote(\'' + m.note.id + '\')">Open</button>' +
            '</div></div>').join('') +
          '</div>').join('') +
        '<div style="font-size:11px;color:var(--ink-50);margin-top:4px;">Merge combines metadata and archives the duplicate.</div>';
    }
    document.getElementById('scan-modal').style.display = 'block';
  },
  async mergeNotes(keepId, archiveId) {
    const keep    = state.notes.find(n => n.id === keepId);
    const dup     = state.notes.find(n => n.id === archiveId);
    if (!keep || !dup) return;

    // ── Merge metadata into anchor ──────────────────────
    keep.tags     = [...new Set([...(keep.tags||[]),    ...(dup.tags||[])])];
    keep.hashtags = [...new Set([...(keep.hashtags||[]),...(dup.hashtags||[])])];
    keep.links    = [...new Set([...(keep.links||[]),   ...(dup.links||[])])];

    // Append duplicate's text as a pinned block in the anchor
    const dupDate = new Date(dup.createdAt).toLocaleDateString();
    keep.text = keep.text.trimEnd() +
      `\n\n── Merged from "${dup.title}" (${dupDate}) ──\n${dup.text.trim()}`;
    keep.updatedAt = Date.now();
    // Re-extract hashtags from combined text
    keep.hashtags = [...new Set([...extractHashtags(keep.text), ...(keep.hashtags||[])])];

    // ── Archive duplicate with merge metadata ────────────
    dup.status     = 'done';
    dup.done       = true;
    dup.doneAt     = Date.now();
    dup.mergedInto = keepId;
    // Tag it so it's findable
    dup.tags       = [...new Set([...(dup.tags||[]), 'merged'])];
    dup.hashtags   = [...new Set([...(dup.hashtags||[]), 'merged'])];
    // Append reference so user knows where it went
    dup.text       = dup.text.trimEnd() +
      `\n\n── Merged into: "${keep.title}" on ${new Date().toLocaleDateString()} ──`;

    await idbPut('notes', keep);
    await idbPut('notes', dup);

    // Close scan modal and open the anchor note
    document.getElementById('scan-modal').style.display = 'none';
    renderBlade();
    toast('✓ Merged — opening anchor note', 'lime');
    openNote(keepId);
  },
  // ── PRINT / EXPORT ──────────────────────────────────
  printNote() {
    const n = state.notes.find(x => x.id === state.currentNoteId);
    if (n) openPrintModal([n]);
  },
  printSelected(ids) {
    openPrintModal(ids.map(id => state.notes.find(n => n.id === id)).filter(Boolean));
  },
  exportTXT(idsJSON) {
    const ids = window._pendingExportIds || (idsJSON ? JSON.parse(idsJSON) : null);
    const notes = ids ? ids.map(id => state.notes.find(n => n.id === id)).filter(Boolean)
      : state.notes.filter(n => n.status === 'active');
    const lines = notes.map(n => {
      const stk = stackById(n.stack);
      const tags = [...(n.hashtags||[]).map(h=>'#'+h), ...(n.tags||[]).map(t=>'#'+t)].join(' ');
      return '[' + stk.name.toUpperCase() + '] ' + n.title + '\n' +
        new Date(n.createdAt).toLocaleDateString() + (tags ? ' · ' + tags : '') + '\n\n' +
        n.text + '\n' + (n.why ? '\nWHY: ' + n.why : '') + '\n' + '─'.repeat(50);
    }).join('\n\n');
    const blob = new Blob(['LazNote Export — ' + new Date().toLocaleDateString() + '\n' + '═'.repeat(50) + '\n\n' + lines], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'laznote-' + new Date().toISOString().slice(0,10) + '.txt'; a.click();
    document.getElementById('print-modal').style.display = 'none';
    toast('✓ Exported as TXT', 'lime');
  },
  exportPNG(idsJSON) {
    const ids = window._pendingExportIds || (idsJSON ? JSON.parse(idsJSON) : null);
    const notes = ids ? ids.map(id => state.notes.find(n => n.id === id)).filter(Boolean)
      : state.notes.filter(n => n.status === 'active');
    if (!notes.length) { toast('No notes to export'); return; }
    const CARD_W = 480, CARD_H = 220, PAD = 20, COLS = Math.min(2, notes.length);
    const ROWS = Math.ceil(notes.length / COLS);
    const canvas = document.createElement('canvas');
    canvas.width = COLS * CARD_W + (COLS+1) * PAD;
    canvas.height = ROWS * CARD_H + (ROWS+1) * PAD + 70;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b0d0a'; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = '#c5ec3a'; ctx.font = 'bold 18px sans-serif';
    ctx.fillText('LazNote', PAD, 40);
    ctx.fillStyle = '#555'; ctx.font = '11px sans-serif';
    ctx.fillText(new Date().toLocaleDateString() + ' · ' + notes.length + ' note(s)', PAD + 85, 40);
    notes.forEach((n, i) => {
      const col = i % COLS, row = Math.floor(i / COLS);
      const x = PAD + col * (CARD_W + PAD), y = 60 + row * (CARD_H + PAD);
      const uc = n.urgency === 'high' ? '#c5ec3a' : n.urgency === 'med' ? '#ff9900' : '#444';
      ctx.fillStyle = '#161816'; fillRoundRect(ctx,x,y,CARD_W,CARD_H,10); ctx.fill();
      ctx.fillStyle = uc; fillRoundRect(ctx,x,y,4,CARD_H,2); ctx.fill();
      ctx.fillStyle = 'rgba(197,236,58,0.15)'; fillRoundRect(ctx,x+12,y+12,52,18,4); ctx.fill();
      ctx.fillStyle = '#c5ec3a'; ctx.font = 'bold 9px sans-serif';
      ctx.fillText(stackById(n.stack).name.toUpperCase(), x+16, y+25);
      ctx.fillStyle = '#eee'; ctx.font = 'bold 13px sans-serif';
      ctx.fillText(truncCtx(ctx, n.title||n.text.slice(0,40), CARD_W-28), x+12, y+50);
      ctx.fillStyle = '#999'; ctx.font = '11px sans-serif';
      wrapCtx(ctx, n.text, x+12, y+68, CARD_W-24, 15, 4);
      const tags = (n.hashtags||[]).slice(0,4);
      let tx = x+12;
      tags.forEach(tag => {
        const tw = ctx.measureText('#'+tag).width + 10;
        ctx.fillStyle = 'rgba(197,236,58,0.1)'; fillRoundRect(ctx,tx,y+CARD_H-34,tw,18,3); ctx.fill();
        ctx.fillStyle = '#c5ec3a'; ctx.font = '9px sans-serif';
        ctx.fillText('#'+tag, tx+5, y+CARD_H-21); tx += tw + 4;
      });
      ctx.fillStyle = '#444'; ctx.font = '9px sans-serif';
      ctx.fillText(new Date(n.createdAt).toLocaleDateString(), x+CARD_W-70, y+CARD_H-12);
    });
    canvas.toBlob(blob => {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'laznote-cards-' + new Date().toISOString().slice(0,10) + '.png'; a.click();
      document.getElementById('print-modal').style.display = 'none';
      toast('✓ Exported as PNG', 'lime');
    }, 'image/png');
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
  },
  toggleCardSelect(id) {
    const card = document.querySelector(`.card[data-card-id="${id}"]`);
    if (card) card.classList.toggle('selected');
  },
  exportPDF() { _exportPDF(); },
  // ── NOTE EDIT MODAL ─────────────────────────────────
  openNoteEdit() {
    const n = state.notes.find(x => x.id === state.currentNoteId); if (!n) return;
    const stk = stackById(n.stack);
    const allTags  = [...new Set([...(n.hashtags||[]), ...(n.tags||[])])];
    const allLinks = [...(n.links||[])];

    document.getElementById('note-edit-body').innerHTML = `
      <!-- Title -->
      <div>
        <div class="edit-field-label">Title</div>
        <input class="input" id="edit-title" value="${escapeHtml(n.title)}" placeholder="Note title" style="margin-top:6px;" />
      </div>

      <!-- Stack -->
      <div>
        <div class="edit-field-label">Stack</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;" id="edit-stack-chips">
          ${state.stacks.map(s => `<span class="chip edit-stack-chip ${s.id === n.stack ? 'lime' : ''}" data-id="${s.id}" onclick="LazNote._editSelectStack('${s.id}')">${s.name}</span>`).join('')}
        </div>
      </div>

      <!-- Due -->
      <div>
        <div class="edit-field-label">Due</div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          ${['today','soon','idle'].map(d => `<span class="chip edit-due-chip ${n.due===d?'lime':''}" data-due="${d}" onclick="LazNote._editSelectDue('${d}')" style="cursor:pointer;">${d.charAt(0).toUpperCase()+d.slice(1)}</span>`).join('')}
        </div>
      </div>

      <!-- Urgency -->
      <div>
        <div class="edit-field-label">Urgency</div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          ${[['high','#c5ec3a'],['med','#ff9900'],['low','var(--ink-50)']].map(([u,c]) => `<span class="chip edit-urg-chip ${n.urgency===u?'lime':''}" data-urg="${u}" onclick="LazNote._editSelectUrgency('${u}')" style="cursor:pointer;${n.urgency===u?'':''}color:${n.urgency===u?'':c};">${u.charAt(0).toUpperCase()+u.slice(1)}</span>`).join('')}
        </div>
      </div>

      <!-- Tags -->
      <div>
        <div class="edit-field-label">Tags <span style="color:var(--ink-50);font-weight:400;">— tap × to remove</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;min-height:28px;" id="edit-tags-list">
          ${allTags.map(t => `<span class="chip" style="cursor:pointer;" onclick="LazNote._editRemoveTag('${t.replace(/'/g,"\\'")}')"><span style="color:var(--lime);">#${escapeHtml(t)}</span> <span style="color:var(--ink-30);font-size:10px;">×</span></span>`).join('')}
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <input class="input" id="edit-tag-input" placeholder="Add tag…" style="flex:1;padding:8px 10px;font-size:13px;" onkeydown="if(event.key==='Enter'){event.preventDefault();LazNote._editAddTag();}" />
          <button class="btn-sm" onclick="LazNote._editAddTag()" style="white-space:nowrap;">+ Add</button>
        </div>
      </div>

      <!-- Linked topics -->
      <div>
        <div class="edit-field-label">Linked Topics <span style="color:var(--ink-50);font-weight:400;">— tap × to remove</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;min-height:28px;" id="edit-links-list">
          ${allLinks.map(l => `<span class="chip" style="cursor:pointer;" onclick="LazNote._editRemoveLink('${l.replace(/'/g,"\\'")}')"><span style="color:var(--ink-70);">${escapeHtml(l)}</span> <span style="color:var(--ink-30);font-size:10px;">×</span></span>`).join('')}
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <input class="input" id="edit-link-input" placeholder="Add linked topic…" style="flex:1;padding:8px 10px;font-size:13px;" onkeydown="if(event.key==='Enter'){event.preventDefault();LazNote._editAddLink();}" />
          <button class="btn-sm" onclick="LazNote._editAddLink()" style="white-space:nowrap;">+ Add</button>
        </div>
      </div>

      <!-- Urgency reason -->
      <div>
        <div class="edit-field-label">Urgency note <span style="color:var(--ink-50);font-weight:400;">— optional</span></div>
        <input class="input" id="edit-urgency-reason" value="${escapeHtml(n.urgencyReason||'')}" placeholder="Why is this urgent?" style="margin-top:6px;" />
      </div>
    `;

    // Store working copies of tags/links so add/remove updates them live
    window._editTags  = allTags.slice();
    window._editLinks = allLinks.slice();
    window._editStack = n.stack;
    window._editDue   = n.due;
    window._editUrg   = n.urgency || 'low';

    document.getElementById('note-edit-modal').style.display = 'flex';
    setTimeout(() => document.getElementById('edit-title')?.focus(), 100);
  },
  closeNoteEdit() {
    document.getElementById('note-edit-modal').style.display = 'none';
  },
  async saveNoteEdit() {
    const n = state.notes.find(x => x.id === state.currentNoteId); if (!n) return;
    const title = document.getElementById('edit-title')?.value.trim();
    const urgReason = document.getElementById('edit-urgency-reason')?.value.trim();

    if (title) n.title = title;
    n.stack         = window._editStack || n.stack;
    n.due           = window._editDue   || n.due;
    n.urgency       = window._editUrg   || n.urgency;
    n.urgencyReason = urgReason !== undefined ? urgReason : (n.urgencyReason || '');
    n.tags          = (window._editTags  || []).filter(Boolean);
    n.hashtags      = [...new Set([...extractHashtags(n.text), ...n.tags.map(t => t.toLowerCase().replace(/\s+/g,'-'))])];
    n.links         = (window._editLinks || []).filter(Boolean);
    n.updatedAt     = Date.now();

    await idbPut('notes', n);
    document.getElementById('note-edit-modal').style.display = 'none';
    toast('✓ Note updated', 'lime');
    renderNote();
    renderBlade();
  },
  // ── Edit modal helpers (called from inline onclick) ──
  _editSelectStack(id) {
    window._editStack = id;
    document.querySelectorAll('.edit-stack-chip').forEach(c => {
      c.classList.toggle('lime', c.dataset.id === id);
    });
  },
  _editSelectDue(due) {
    window._editDue = due;
    document.querySelectorAll('.edit-due-chip').forEach(c => {
      c.classList.toggle('lime', c.dataset.due === due);
    });
  },
  _editSelectUrgency(urg) {
    window._editUrg = urg;
    document.querySelectorAll('.edit-urg-chip').forEach(c => {
      c.classList.toggle('lime', c.dataset.urg === urg);
    });
  },
  _editAddTag() {
    const input = document.getElementById('edit-tag-input'); if (!input) return;
    const raw = input.value.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g,'-');
    if (!raw || window._editTags.includes(raw)) { input.value = ''; return; }
    window._editTags.push(raw);
    input.value = '';
    LazNote._editRenderTags();
  },
  _editRemoveTag(tag) {
    window._editTags = window._editTags.filter(t => t !== tag);
    LazNote._editRenderTags();
  },
  _editRenderTags() {
    const el = document.getElementById('edit-tags-list'); if (!el) return;
    el.innerHTML = window._editTags.map(t =>
      `<span class="chip" style="cursor:pointer;" onclick="LazNote._editRemoveTag('${t.replace(/'/g,"\\'")}')"><span style="color:var(--lime);">#${escapeHtml(t)}</span> <span style="color:var(--ink-30);font-size:10px;">×</span></span>`
    ).join('');
  },
  _editAddLink() {
    const input = document.getElementById('edit-link-input'); if (!input) return;
    const raw = input.value.trim();
    if (!raw || window._editLinks.includes(raw)) { input.value = ''; return; }
    window._editLinks.push(raw);
    input.value = '';
    LazNote._editRenderLinks();
  },
  _editRemoveLink(link) {
    window._editLinks = window._editLinks.filter(l => l !== link);
    LazNote._editRenderLinks();
  },
  _editRenderLinks() {
    const el = document.getElementById('edit-links-list'); if (!el) return;
    el.innerHTML = window._editLinks.map(l =>
      `<span class="chip" style="cursor:pointer;" onclick="LazNote._editRemoveLink('${l.replace(/'/g,"\\'")}')"><span style="color:var(--ink-70);">${escapeHtml(l)}</span> <span style="color:var(--ink-30);font-size:10px;">×</span></span>`
    ).join('');
  },
  async resortNote(id) {
    const n = state.notes.find(x => x.id === id); if (!n) return;
    if (!state.settings.groqKey) { toast('Connect Groq in Settings first'); return; }
    const resultEl = document.getElementById('ai-action-result');
    const labelEl  = document.getElementById('ai-action-label');
    const textEl   = document.getElementById('ai-action-text');
    if (resultEl) { resultEl.style.display = 'block'; labelEl.textContent = 'RE-SORTING…'; textEl.textContent = ''; }
    toast('Re-sorting with AI…', 'lime');
    try {
      const r = await aiSortNote(n.text);
      if (r.stack && state.stacks.find(s => s.id === r.stack)) n.stack = r.stack;
      if (r.title) n.title = r.title;
      if (r.due)   n.due   = r.due;
      n.why           = r.why           || '';
      n.urgency       = r.urgency       || 'low';
      n.urgencyReason = r.urgencyReason || '';
      n.tags          = r.tags          || [];
      n.links         = r.links         || [];
      n.isRecurring   = r.isRecurring   || false;
      n.recurCycle    = r.recurCycle    || null;
      n.confidence    = r.confidence    ?? 100;
      n.aiReasoning   = r.aiReasoning   || r.why || '';
      n.updatedAt     = Date.now();
      // Re-extract #hashtags from text and merge with AI tags
      const textTags = extractHashtags(n.text);
      const aiTags   = (r.tags||[]).map(t => t.toLowerCase().replace(/\s+/g,'-'));
      n.hashtags = [...new Set([...textTags, ...aiTags])];
      await idbPut('notes', n);
      // Show results in the action panel before re-rendering
      const allTags = [...new Set([...(n.tags||[]), ...(n.hashtags||[])])];
      if (resultEl && labelEl && textEl) {
        labelEl.textContent = 'RE-SORTED ✓';
        textEl.textContent  = `Stack: ${stackById(n.stack).name}  ·  Urgency: ${n.urgency}\nTags: ${allTags.length ? allTags.map(t=>'#'+t).join(', ') : 'none'}\n\n${n.aiReasoning}`;
      }
      toast('✓ Re-sorted', 'lime');
      renderNote();
    } catch(e) {
      toast(e.message.slice(0, 50), 'red');
      if (resultEl && labelEl && textEl) { labelEl.textContent = 'ERROR'; textEl.textContent = e.message; }
    }
  },
  async summarizeNote(id) {
    const n = state.notes.find(x => x.id === id); if (!n) return;
    if (!state.settings.groqKey) { toast('Connect Groq first'); return; }
    const resultEl = document.getElementById('ai-action-result');
    const labelEl  = document.getElementById('ai-action-label');
    const textEl   = document.getElementById('ai-action-text');
    if (!resultEl) return;
    resultEl.style.display = 'block';
    labelEl.textContent = 'SUMMARIZING…';
    textEl.textContent = '';
    try {
      const out = await groqChat({
        model: MODELS.logic,
        messages: [
          { role: 'system', content: 'You are a concise note summarizer. Write 2-3 punchy sentences that capture the core of the note, what needs to happen, and when. No preamble.' },
          { role: 'user', content: `Note title: ${n.title}\n\nNote text:\n${n.text}` }
        ]
      });
      labelEl.textContent = 'SUMMARY';
      textEl.textContent = out.trim();
      window._lastAiResult = { type: 'summary', text: out.trim() };
    } catch(e) { labelEl.textContent = 'ERROR'; textEl.textContent = e.message; }
  },
  async adviceNote(id) {
    const n = state.notes.find(x => x.id === id); if (!n) return;
    if (!state.settings.groqKey) { toast('Connect Groq first'); return; }
    const resultEl = document.getElementById('ai-action-result');
    const labelEl  = document.getElementById('ai-action-label');
    const textEl   = document.getElementById('ai-action-text');
    if (!resultEl) return;
    resultEl.style.display = 'block';
    labelEl.textContent = 'THINKING…';
    textEl.textContent = '';
    const stk = stackById(n.stack);
    try {
      const out = await groqChat({
        model: MODELS.logic,
        messages: [
          { role: 'system', content: `You are a practical life advisor. The note is in the "${stk.name}" stack (${stk.desc}). Give 2-4 concrete, actionable steps the person can take right now. Be specific and direct — no fluff, no "consider" or "you might want to". Format as a short numbered list.` },
          { role: 'user', content: `Note: ${n.title}\n\n${n.text}` }
        ]
      });
      labelEl.textContent = 'ADVICE';
      textEl.textContent = out.trim();
      window._lastAiResult = { type: 'advice', text: out.trim() };
    } catch(e) { labelEl.textContent = 'ERROR'; textEl.textContent = e.message; }
  },
  async pinAiResult(id) {
    const n = state.notes.find(x => x.id === id); if (!n) return;
    const r = window._lastAiResult; if (!r) return;
    const prefix = r.type === 'summary' ? '\n\n── AI Summary ──\n' : '\n\n── AI Advice ──\n';
    n.text = n.text + prefix + r.text;
    n.updatedAt = Date.now();
    n.hashtags = extractHashtags(n.text);
    await idbPut('notes', n);
    toast('📌 Pinned to note', 'lime');
    // refresh textarea
    const ta = document.getElementById('note-text');
    if (ta) ta.value = n.text;
    document.getElementById('ai-action-result').style.display = 'none';
  },
};
window.LazNote = LazNote;
// Expose private helpers that inline onclick strings need to reach
window.LazNote.toggleLogicSection = toggleLogicSection;

// ─── Theme ───────────────────────────────────────────────
function applyTheme() {
  document.body.classList.toggle('industrial', state.settings.style === 'industrial');
  document.body.classList.toggle('light', state.settings.theme === 'light');
}

// ─── Wiring ──────────────────────────────────────────────
$('#fab-pulse').addEventListener('click', openCapture);
$$('[data-back]').forEach(el => el.addEventListener('click', back));
$$('.botnav .nav[data-go]').forEach(n => n.addEventListener('click', () => nav(n.dataset.go)));

// Search modal — submit on Enter
document.getElementById('search-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') LazNote.doSearch();
});

// Hardware back button (Android / browser history)
window.addEventListener('popstate', () => back());

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
let voiceUserStopped = false;
let voiceFinalTranscript = '';
let currentCaptureMode = 'text';

// ─── Waveform visualizer ─────────────────────────────────
let _waveAudioCtx = null;
let _waveAnalyser = null;
let _waveMicStream = null;
let _waveRafId = null;
let _waveIdle = true;

function startWaveform(existingStream) {
  const canvas = document.getElementById('voice-waveform');
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width  = rect.width  * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;

  function boot(stream) {
    _waveMicStream = stream;
    _waveAudioCtx  = new (window.AudioContext || window.webkitAudioContext)();
    _waveAnalyser  = _waveAudioCtx.createAnalyser();
    _waveAnalyser.fftSize = 128;
    _waveAnalyser.smoothingTimeConstant = 0.7;
    const src = _waveAudioCtx.createMediaStreamSource(stream);
    src.connect(_waveAnalyser);
    _waveIdle = false;
    drawWave();
  }

  if (existingStream) {
    boot(existingStream);
  } else {
    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(boot)
      .catch(() => drawWaveFlatline(ctx, W, H));
  }

  function drawWave() {
    _waveRafId = requestAnimationFrame(drawWave);
    const data = new Uint8Array(_waveAnalyser.frequencyBinCount);
    _waveAnalyser.getByteFrequencyData(data);

    ctx.clearRect(0, 0, W, H);

    const paused  = !isVoiceRecording;
    const barCount = Math.min(data.length, 36);
    const barW  = 2.5;
    const gap   = (W - barCount * barW) / (barCount + 1);
    const lime  = '#c5ec3a';
    const dim   = 'rgba(197,236,58,0.25)';

    for (let i = 0; i < barCount; i++) {
      // smooth low-frequency bins look best for voice
      const v = data[Math.floor(i * data.length / barCount)] / 255;
      const barH = Math.max(3, v * H * 0.82);
      const x = gap + i * (barW + gap);
      const y = (H - barH) / 2;

      ctx.fillStyle = paused ? dim : lime;
      if (!paused) {
        // glow on active bars
        ctx.shadowColor = lime;
        ctx.shadowBlur  = v > 0.3 ? 6 : 2;
      } else {
        ctx.shadowBlur = 0;
      }
      roundRect(ctx, x, y, barW, barH, 1.5);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  function drawWaveFlatline(ctx, W, H) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(197,236,58,0.15)';
    ctx.fillRect(12, H/2 - 1, W - 24, 2);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

function stopWaveform() {
  if (_waveRafId) { cancelAnimationFrame(_waveRafId); _waveRafId = null; }
  if (_waveMicStream) { _waveMicStream.getTracks().forEach(t => t.stop()); _waveMicStream = null; }
  if (_waveAudioCtx)  { _waveAudioCtx.close().catch(()=>{}); _waveAudioCtx = null; }
  _waveAnalyser = null;
  _waveIdle = true;
  // draw flatline
  const canvas = document.getElementById('voice-waveform');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function setVoiceDot(state) { // 'idle' | 'listening' | 'paused'
  const dot   = document.getElementById('voice-dot');
  const label = document.getElementById('voice-status-label');
  if (!dot) return;
  const map = {
    idle:      { bg: 'var(--ink-30)',                 anim: 'none',              text: 'idle' },
    listening: { bg: 'var(--lime)',                   anim: 'pulse 1.2s infinite', text: 'listening' },
    paused:    { bg: 'rgba(197,236,58,0.4)',           anim: 'none',              text: 'paused' }
  };
  const s = map[state] || map.idle;
  dot.style.background  = s.bg;
  dot.style.animation   = s.anim;
  if (label) { label.textContent = s.text; label.style.color = state === 'listening' ? 'var(--lime)' : 'var(--ink-30)'; }
}

function initializeVoiceRecognition() {
  // No-op — voice now uses MediaRecorder → Groq Whisper.
  // webkitSpeechRecognition was unreliable in PWA standalone mode.
  // Actual recording is started directly in toggleVoiceRecord.
}

// MediaRecorder state
let _mediaRecorder = null;
let _audioChunks   = [];
let _micStream     = null;

function updateVoiceUI() {
  const recordBtn = document.getElementById('voice-record-btn');
  const stopBtn   = document.getElementById('voice-stop-btn');
  if (!recordBtn) return;
  if (isVoiceRecording) {
    recordBtn.textContent = '⏸ Pause';
    recordBtn.style.background = 'rgba(197,236,58,0.12)';
    recordBtn.style.color = 'var(--lime)';
    recordBtn.style.borderColor = 'rgba(197,236,58,0.4)';
    if (stopBtn) stopBtn.style.display = '';
  } else {
    recordBtn.textContent = voiceFinalTranscript ? '▶ Resume' : '🎙️ Start recording';
    recordBtn.style.background = 'transparent';
    recordBtn.style.color = 'var(--ink-70)';
    recordBtn.style.borderColor = '';
    if (stopBtn) stopBtn.style.display = voiceFinalTranscript ? '' : 'none';
  }
}

function updateVoiceButton() { updateVoiceUI(); }

async function _startMicRecording() {
  try {
    _micStream  = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    _audioChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
                   : MediaRecorder.isTypeSupported('audio/mp4')  ? 'audio/mp4'
                   : '';
    _mediaRecorder = mimeType ? new MediaRecorder(_micStream, { mimeType }) : new MediaRecorder(_micStream);
    _mediaRecorder.ondataavailable = e => { if (e.data.size > 0) _audioChunks.push(e.data); };
    _mediaRecorder.start(100); // collect chunks every 100ms
    isVoiceRecording = true;
    voiceUserStopped = false;
    startWaveform(_micStream);  // reuse same stream — no second getUserMedia call
    setVoiceDot('listening');
    updateVoiceUI();
  } catch(err) {
    toast('Mic access denied: ' + err.message, 'red');
  }
}

function _pauseMicRecording() {
  if (_mediaRecorder && _mediaRecorder.state === 'recording') {
    _mediaRecorder.pause();
  }
  isVoiceRecording = false;
  setVoiceDot('paused');
  updateVoiceUI();
}

function _resumeMicRecording() {
  if (_mediaRecorder && _mediaRecorder.state === 'paused') {
    _mediaRecorder.resume();
    isVoiceRecording = true;
    setVoiceDot('listening');
    updateVoiceUI();
  } else {
    // Recognizer was fully stopped — start fresh session appending to existing transcript
    _startMicRecording();
  }
}

async function _stopAndTranscribe() {
  return new Promise(resolve => {
    if (!_mediaRecorder || _mediaRecorder.state === 'inactive') { resolve(''); return; }
    _mediaRecorder.onstop = async () => {
      if (_micStream) { _micStream.getTracks().forEach(t => t.stop()); _micStream = null; }
      if (!_audioChunks.length) { resolve(''); return; }

      const mimeType = _mediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(_audioChunks, { type: mimeType });
      const ext  = mimeType.includes('mp4') ? 'mp4' : 'webm';

      // Try Groq Whisper if key available
      if (state.settings.groqKey) {
        const el = document.getElementById('voice-transcript');
        if (el) el.textContent = (voiceFinalTranscript || '') + ' ⏳ Transcribing…';
        try {
          const fd = new FormData();
          fd.append('file', blob, `audio.${ext}`);
          fd.append('model', 'whisper-large-v3');
          fd.append('response_format', 'text');
          const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${state.settings.groqKey}` },
            body: fd
          });
          if (resp.ok) {
            const text = (await resp.text()).trim();
            resolve(text);
          } else {
            const err = await resp.text();
            toast('Whisper error: ' + err.slice(0, 60), 'red');
            resolve('');
          }
        } catch(e) {
          toast('Transcription failed: ' + e.message, 'red');
          resolve('');
        }
      } else {
        // No Groq key — prompt user to connect Groq or switch to text
        toast('Connect Groq for voice transcription, or use text mode', '');
        resolve('');
      }
    };
    _mediaRecorder.stop();
  });
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

  if (mode === 'voice') {
    if (voiceRecognition === null) initializeVoiceRecognition();
    // Size canvas now that it's visible, draw idle flatline
    requestAnimationFrame(() => {
      const canvas = document.getElementById('voice-waveform');
      if (canvas) {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width  = rect.width  * dpr;
        canvas.height = rect.height * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, rect.width, rect.height);
        ctx.fillStyle = 'rgba(197,236,58,0.15)';
        ctx.fillRect(12, rect.height / 2 - 1, rect.width - 24, 2);
      }
    });
  } else {
    // Leaving voice mode — stop waveform if running, but keep transcript
    if (!isVoiceRecording && _waveIdle === false) stopWaveform();
  }

  if (mode === 'camera') {
    const info = document.getElementById('camera-info');
    if (info) info.textContent = '✓ Ready. Tap "Start" to begin.';
  }
};

window.LazNote.toggleVoiceRecord = function() {
  if (isVoiceRecording) {
    _pauseMicRecording();
  } else if (_mediaRecorder && _mediaRecorder.state === 'paused') {
    _resumeMicRecording();
  } else {
    // Fresh start
    const el = document.getElementById('voice-transcript');
    if (el && !voiceFinalTranscript) el.textContent = 'Listening…';
    _startMicRecording();
  }
};

window.LazNote.stopVoiceRecord = async function() {
  isVoiceRecording = false;
  stopWaveform();
  setVoiceDot('idle');
  updateVoiceUI();

  const transcribed = await _stopAndTranscribe();
  if (transcribed) {
    voiceFinalTranscript = (voiceFinalTranscript + ' ' + transcribed).trim();
  }

  const el = document.getElementById('voice-transcript');
  if (el) el.textContent = voiceFinalTranscript || 'Ready to record. Tap "Start recording" to begin.';

  if (voiceFinalTranscript) {
    const ta = document.getElementById('capture-text');
    if (ta) ta.value = voiceFinalTranscript;
    toast('✓ Transcribed — tap Sort with AI', 'lime');
    LazNote.switchCaptureMode('text');
  }
};

window.LazNote.clearVoiceTranscript = function() {
  if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
    _mediaRecorder.stop();
  }
  if (_micStream) { _micStream.getTracks().forEach(t => t.stop()); _micStream = null; }
  _mediaRecorder = null;
  _audioChunks = [];
  voiceFinalTranscript = '';
  isVoiceRecording = false;
  stopWaveform();
  setVoiceDot('idle');
  const el = document.getElementById('voice-transcript');
  if (el) el.textContent = 'Ready to record. Tap "Start recording" to begin.';
  updateVoiceUI();
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
  const video  = document.getElementById('camera-video');
  const canvas = document.getElementById('camera-canvas');
  const result = document.getElementById('ocr-result');
  const status = document.getElementById('camera-status');

  if (!video || !canvas || !result) return;
  if (video.readyState !== video.HAVE_ENOUGH_DATA) {
    if (result) result.innerHTML = '⚠️ Video not ready. Wait a moment.';
    return;
  }

  const ctx = canvas.getContext('2d');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  if (!canvas.width || !canvas.height) {
    if (result) result.innerHTML = '⚠️ Could not get video dimensions.';
    return;
  }
  ctx.drawImage(video, 0, 0);
  const imageData = canvas.toDataURL('image/jpeg', 0.85);

  await _analyzeImageForNote(imageData, result, status);
};

async function _analyzeImageForNote(imageDataUrl, resultEl, statusEl) {
  if (resultEl) resultEl.innerHTML = '<span style="color:var(--lime);">⏳ Reading image…</span>';

  if (state.settings.groqKey) {
    // ── Groq vision (fast, understands context) ──
    try {
      const base64 = imageDataUrl.split(',')[1];
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.settings.groqKey}` },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          max_tokens: 512,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
              { type: 'text', text: 'Extract all text, tasks, notes, items, or information visible in this image. Return as plain text, one item per line. Be thorough and accurate.' }
            ]
          }]
        })
      });
      if (!resp.ok) throw new Error(`Groq ${resp.status}`);
      const data = await resp.json();
      const text = (data.choices?.[0]?.message?.content || '').trim();
      if (text) {
        const ta = document.getElementById('capture-text');
        if (ta) ta.value = text;
        const preview = text.substring(0, 120) + (text.length > 120 ? '…' : '');
        if (resultEl) resultEl.innerHTML = `<strong style="color:var(--lime);">✓ Groq scanned!</strong><br/><br/><code style="font-size:11px;">${escapeHtml(preview)}</code>`;
        if (statusEl) statusEl.textContent = '✓ Done — review text above then save.';
      } else {
        if (resultEl) resultEl.innerHTML = '⚠️ No text found in image.';
      }
    } catch(err) {
      if (resultEl) resultEl.innerHTML = `✗ Vision error: ${err.message}`;
    }
  } else {
    // ── Tesseract fallback (no key needed) ──
    if (resultEl) resultEl.innerHTML = '<span style="color:var(--lime);">⏳ Running local OCR…</span>';
    try {
      const ocrResult = await Tesseract.recognize(imageDataUrl, 'eng', {
        logger: m => {
          if (m.status === 'recognizing' && resultEl) {
            resultEl.innerHTML = `<span style="color:var(--lime);">⏳ Processing ${Math.round(m.progress * 100)}%…</span>`;
          }
        }
      });
      const text = ocrResult.data.text.trim();
      if (!text) { if (resultEl) resultEl.innerHTML = '⚠️ No text found. Try better lighting.'; return; }
      const ta = document.getElementById('capture-text');
      if (ta) ta.value = text;
      const preview = text.substring(0, 120) + (text.length > 120 ? '…' : '');
      if (resultEl) resultEl.innerHTML = `<strong style="color:var(--lime);">✓ Scanned!</strong><br/><small style="color:var(--ink-50);">Tip: connect Groq for smarter scanning</small><br/><br/><code style="font-size:11px;">${escapeHtml(preview)}</code>`;
    } catch(err) {
      if (resultEl) resultEl.innerHTML = `✗ OCR failed: ${err.message}`;
    }
  }
}

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
  const result = document.getElementById('ocr-result');
  const status = document.getElementById('camera-status');
  if (status) status.textContent = '⏳ Loading image…';
  const reader = new FileReader();
  reader.onload = async e => {
    event.target.value = '';
    await _analyzeImageForNote(e.target.result, result, status);
    if (status) status.textContent = '✓ Done. Edit text above then save.';
  };
  reader.onerror = () => { if (result) result.innerHTML = '✗ Failed to read file.'; };
  reader.readAsDataURL(file);
};

initializeVoiceRecognition();

// ─── V1 Action Functions ──────────────────────────────────
window.LazNote.showReasoning = function(id) {
  const el = document.getElementById('reasoning-' + id);
  if (el) {
    el.classList.toggle('visible');
    if (el.classList.contains('visible')) {
      el.style.display = 'block';
      el.style.maxHeight = '200px';
    } else {
      el.style.maxHeight = '0';
      setTimeout(() => el.style.display = 'none', 300);
    }
  }
};

window.LazNote.toggleDone = function(id) {
  const note = state.notes.find(n => n.id === id);
  if (!note) return;
  
  if (!note.done) {
    note.done = true;
    if (note.isRecurring && note.recurCycle) {
      const cycles = { daily: 1, weekly: 7, monthly: 30, annual: 365 };
      const days = cycles[note.recurCycle] || 1;
      note.ghostUntil = Date.now() + (days * 24 * 60 * 60 * 1000);
      toast(`✓ Done! Resets in ${days} day(s).`, 'lime');
    } else {
      toast('✓ Marked done', 'lime');
    }
  } else {
    note.done = false;
    note.ghostUntil = null;
    toast('↺ Reopened', 'lime');
  }
  idbPut('notes', note).catch(e => toast('Save failed: ' + e.message, 'red'));
  renderBlade();
};

window.LazNote.editNote = function(id) {
  const note = state.notes.find(n => n.id === id);
  if (!note) return;
  const modal = document.getElementById('input-modal');
  document.getElementById('input-modal-title').textContent = 'Edit Note';
  document.getElementById('input-modal-body').innerHTML = `
    <textarea class="input" id="edit-note-text" style="min-height:140px;margin-bottom:12px;">${escapeHtml(note.text)}</textarea>
    <button class="btn primary block" onclick="LazNote._confirmEditNote('${id}')">Save</button>
  `;
  modal.style.display = 'flex';
  setTimeout(() => document.getElementById('edit-note-text')?.focus(), 100);
};

window.LazNote._confirmEditNote = async function(id) {
  const note = state.notes.find(n => n.id === id); if (!note) return;
  const newText = document.getElementById('edit-note-text')?.value.trim();
  if (newText && newText !== note.text) {
    note.text = newText;
    note.title = newText.substring(0, 80);
    note.updatedAt = Date.now();
    note.hashtags = extractHashtags(newText);
    await idbPut('notes', note);
    toast('✓ Note updated', 'lime');
    renderBlade();
  }
  document.getElementById('input-modal').style.display = 'none';
};

window.LazNote.moveNote = function(id) {
  const note = state.notes.find(n => n.id === id);
  if (!note) return;
  const available = state.stacks.filter(s => s.id !== note.stack);
  const modal = document.getElementById('input-modal');
  document.getElementById('input-modal-title').textContent = 'Move to Stack';
  document.getElementById('input-modal-body').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${available.map(s => `
        <button class="btn block" style="text-align:left;justify-content:flex-start;gap:10px;" onclick="LazNote._confirmMoveNote('${id}','${s.id}')">
          <span style="font-family:var(--mono);font-size:10px;color:var(--lime);">${s.name.toUpperCase()}</span>
          <span style="font-size:11px;color:var(--ink-50);">${escapeHtml(s.desc)}</span>
        </button>`).join('')}
    </div>
  `;
  modal.style.display = 'flex';
};

window.LazNote._confirmMoveNote = async function(noteId, stackId) {
  const note = state.notes.find(n => n.id === noteId); if (!note) return;
  const stk = stackById(stackId);
  note.stack = stackId; note.updatedAt = Date.now();
  await idbPut('notes', note);
  toast(`→ Moved to ${stk.name}`, 'lime');
  renderBlade();
  document.getElementById('input-modal').style.display = 'none';
};

window.LazNote.deleteNote = function(id) {
  if (!confirm('Delete this note?')) return;
  state.notes = state.notes.filter(n => n.id !== id);
  idbDel('notes', id);
  toast('✗ Note deleted', 'lime');
  renderBlade();
};

// ─── V5 Features: Search, Hashtags, Duplicate Detection ─────

function extractHashtags(text) {
  const matches = text.match(/#[\w_-]+/g) || [];
  return matches.map(h => h.slice(1).toLowerCase());
}

function calculateTextSimilarity(text1, text2) {
  const s1 = text1.toLowerCase().split(/\s+/);
  const s2 = text2.toLowerCase().split(/\s+/);
  const common = s1.filter(w => s2.includes(w)).length;
  return common / Math.max(s1.length, s2.length);
}

function findSimilarNotes(noteId) {
  const note = state.notes.find(n => n.id === noteId);
  if (!note) return [];
  
  const similar = [];
  state.notes.forEach(n => {
    if (n.id === noteId || n.status === 'done' || n.status === 'merged') return;
    
    let score = 0;
    let reasons = [];
    
    // Same stack: +25 points
    if (n.stack === note.stack) { score += 25; reasons.push('Same stack'); }
    
    // Shared hashtags: +10 per tag
    const sharedTags = (note.hashtags || []).filter(t => (n.hashtags || []).includes(t));
    if (sharedTags.length) { score += sharedTags.length * 10; reasons.push(`${sharedTags.length} shared #tags`); }
    
    // Shared AI tags: +5 per tag
    const sharedAiTags = (note.tags || []).filter(t => (n.tags || []).includes(t));
    if (sharedAiTags.length) { score += sharedAiTags.length * 5; reasons.push(`${sharedAiTags.length} shared tags`); }
    
    // Text similarity: +50 if >70% match
    const textSim = calculateTextSimilarity(note.text, n.text);
    if (textSim > 0.7) { score += Math.round(textSim * 50); reasons.push(`${Math.round(textSim * 100)}% similar`); }
    
    if (score >= 10) {
      similar.push({ note: n, score: Math.min(100, score), reasons });
    }
  });
  
  return similar.sort((a, b) => b.score - a.score);
}

function searchNotes(query) {
  if (!query.trim()) return state.notes.filter(n => n.status !== 'done');
  
  const q = query.toLowerCase();
  return state.notes.filter(n => {
    if (n.status === 'done') return false;
    return (
      n.title.toLowerCase().includes(q) ||
      n.text.toLowerCase().includes(q) ||
      (n.hashtags || []).some(h => h.includes(q)) ||
      (n.tags || []).some(t => t.includes(q)) ||
      (n.links || []).some(l => l.includes(q))
    );
  });
}

window.LazNote.showSimilarNotes = function(id) {
  const similar = findSimilarNotes(id);
  if (!similar.length) {
    toast('No similar notes found', 'info');
    return;
  }
  
  let html = `<div style="padding:14px;"><h3 style="margin:0 0 12px;color:var(--lime);">Similar Notes (${similar.length})</h3>`;
  html += similar.map(s => `
    <div style="padding:10px;border:1px solid var(--line-2);border-radius:6px;margin-bottom:8px;cursor:pointer;" onclick="LazNote.mergeSuggestion('${id}','${s.note.id}')">
      <div style="display:flex;gap:8px;margin-bottom:4px;">
        <span style="background:var(--lime-dim);color:var(--lime);padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;">${s.score}%</span>
        <span style="flex:1;font-weight:500;">${escapeHtml(s.note.title || s.note.text.slice(0, 40))}</span>
        <span style="font-size:11px;color:var(--ink-50);">${new Date(s.note.createdAt).toLocaleDateString()}</span>
      </div>
      <div style="font-size:11px;color:var(--ink-50);">${s.reasons.join(' • ')}</div>
    </div>
  `).join('');
  html += '</div>';
  
  toast(`Found ${similar.length} similar note(s)`, 'info');
};

window.LazNote.mergeSuggestion = function(noteId1, noteId2) {
  const note1 = state.notes.find(n => n.id === noteId1);
  const note2 = state.notes.find(n => n.id === noteId2);
  if (!note1 || !note2) return;
  
  if (!confirm(`Merge notes?\n\n"${note1.title}"\nvs\n"${note2.title}"`)) return;
  
  // Merge metadata
  note1.tags = [...new Set([...(note1.tags || []), ...(note2.tags || [])])];
  note1.hashtags = [...new Set([...(note1.hashtags || []), ...(note2.hashtags || [])])];
  note1.links = [...new Set([...(note1.links || []), ...(note2.links || [])])];
  note1.updatedAt = Date.now();
  
  // Mark note2 as merged
  note2.status = 'merged';
  note2.mergedInto = noteId1;
  
  idbPut('notes', note1).catch(e => toast('Save error', 'red'));
  idbPut('notes', note2).catch(e => toast('Save error', 'red'));
  
  toast(`✓ Merged into "${note1.title}"`, 'lime');
  renderBlade();
};

})();
