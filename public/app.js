// English Duel — client
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// One identity per browser tab (survives a reload)
let token;
try { token = sessionStorage.getItem('duelToken'); } catch {}
if (!token) { token = crypto.randomUUID(); try { sessionStorage.setItem('duelToken', token); } catch {} }

let screen = 'waiting';   // waiting | alert | role | create | join | room
let state = null;         // room state from the server
let offset = 0;           // server clock - local clock
let feedback = null;      // { id, choice, correct, ok, until } — shown briefly after answering
let sending = false;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show';
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = 'toast', 2500);
}
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Error');
  return j;
}
const act = (action, extra = {}) => post('/api/action', { code: state.code, action, ...extra })
  .then(j => { if (j.state) onRoomState(j.state); })
  .catch(e => toast(e.message));
const now = () => Date.now() + offset;

// ---------- sound (browsers only allow it after a first click on the page) ----------
let audio;
function unlockAudio() { try { audio = audio || new AudioContext(); audio.resume(); } catch {} }
document.addEventListener('pointerdown', unlockAudio);
function tone(freq, dur, type = 'sine', vol = 0.15, at = 0) {
  if (!audio) return;
  try {
    const t0 = audio.currentTime + at, o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(audio.destination); o.start(t0); o.stop(t0 + dur);
  } catch {}
}
const sfx = {
  siren: () => { for (let i = 0; i < 6; i++) { tone(660, .22, 'sawtooth', .12, i * .5); tone(990, .22, 'sawtooth', .12, i * .5 + .25); } },
  good: () => { tone(880, .1); tone(1320, .15, 'sine', .15, .1); },
  bad: () => tone(180, .25, 'square', .08),
  tick: () => tone(1200, .05, 'square', .05),
  go: () => tone(1046, .35, 'triangle', .2),
  end: () => { tone(523, .2, 'triangle', .2); tone(659, .2, 'triangle', .2, .2); tone(784, .5, 'triangle', .2, .4); },
};

// ---------- polling (works on serverless hosting like Vercel) ----------
// Outside a room: ask every 4 s when the next global "DUEL!" alert is due, then fire it at that exact time.
// Inside a room: fetch the room state every 0.7 s during a duel, 1.5 s otherwise.
let alertNext = 0, lastFired = 0, dbError = '';
let pollCode = null, pollTimer = null, lastPing = 0;

async function getJson(url) {
  const t0 = Date.now();
  const r = await fetch(url, { cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (j.serverNow) offset = j.serverNow - (t0 + Date.now()) / 2;   // keep clocks in sync
  return { r, j };
}

async function pollOnce() {
  const code = pollCode;
  try {
    if (code) {
      const ping = Date.now() - lastPing > 3000;
      const { r, j } = await getJson(`/api/state?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}${ping ? '&ping=1' : ''}`);
      if (code !== pollCode) return;               // left the room meanwhile
      if (r.ok) { if (ping) lastPing = Date.now(); onRoomState(j); }
      else if (r.status === 403 || r.status === 404) { toast(j.error || 'Room closed'); leaveRoom(); }
    } else {
      const { r, j } = await getJson('/api/alert');
      const err = r.ok ? '' : (j.error || 'Server unavailable');
      if (r.ok) alertNext = j.next;
      if (err !== dbError) { dbError = err; if (screen === 'waiting') render(); }
    }
  } catch { /* network hiccup: try again next time */ }
}
function schedulePoll() {
  clearTimeout(pollTimer);
  const delay = pollCode ? (state?.status === 'running' ? 700 : 1500) : 4000;
  pollTimer = setTimeout(() => pollOnce().then(schedulePoll), delay);
}
function startPolling(code) {
  pollCode = code; lastPing = 0;
  clearTimeout(pollTimer);
  pollOnce().then(schedulePoll);
}

function showAlert() {
  go('alert'); sfx.siren();
  let on = false; clearInterval(showAlert.flash);
  showAlert.flash = setInterval(() => {
    if (screen !== 'alert') { clearInterval(showAlert.flash); document.title = 'English Duel'; return; }
    document.title = (on = !on) ? '⚔️ DUEL! ⚔️' : 'English Duel';
  }, 700);
}

// ---------- room connection ----------
function enterRoom(code) {
  history.replaceState(null, '', `?room=${code}`);
  startPolling(code);
}
const sameState = (a, b) => a && b && JSON.stringify({ ...a, serverNow: 0 }) === JSON.stringify({ ...b, serverNow: 0 });
function onRoomState(s) {
  const prev = state;
  state = s;
  if (prev && prev.status === 'running' && state.status === 'over') sfx.end();
  if (screen === 'room' && sameState(prev, s)) return;   // nothing new: don't rebuild the page
  screen = 'room'; render();
}
function leaveRoom() {
  state = null; feedback = null;
  history.replaceState(null, '', location.pathname);
  startPolling(null);
  go('waiting');
}

function go(s) { screen = s; render(); }

// ---------- formatting ----------
function fmt(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return s.toFixed(1);
  const total = Math.ceil(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
const phase = () => {
  if (!state || state.status !== 'running') return state?.status;
  return now() < state.startAt ? 'countdown' : 'running';
};

// ---------- screens ----------
const screens = {
  waiting: () => `
    <div class="waiting">
      <div class="dice">🎲</div>
      <h1>Game in progress…</h1>
      <p class="muted">A duel can break out at any moment. Keep playing!</p>
      ${dbError ? `<p class="error">⚠️ ${esc(dbError)}</p>` : ''}
      <button class="btn small ghost mt" id="duelNow" title="Trigger the alert on every screen in a few seconds">⚔️ Duel now</button>
    </div>`,

  alert: () => `
    <div class="alert">
      <div class="alert-title">⚔️ DUEL! ⚔️</div>
      <p>The person who was playing must choose an opponent!</p>
      <button class="btn big light" id="accept">Accept the duel</button>
    </div>`,

  role: () => `
    <h1 class="title">Who are you?</h1>
    <div class="roles">
      <button class="rolecard" id="asRef"><span>🧑‍⚖️</span><b>Referee</b><small>Create the room and start the duel</small></button>
      <button class="rolecard" id="asPlayer"><span>🎮</span><b>Player</b><small>Join the room with its code</small></button>
    </div>
    <p class="center mt"><button class="btn ghost" id="backWait">← Back to the game</button></p>`,

  create: () => `
    <div class="panel narrowpanel">
      <h2>🧑‍⚖️ Create the duel room</h2>
      <label>Duel length (seconds)</label>
      <input type="number" id="dur" min="10" max="900" value="60">
      <label>Question categories</label>
      <div class="cats" id="cats"><span class="muted">Loading…</span></div>
      <div class="row mt">
        <button class="btn" id="backRole" style="flex:0 0 auto">← Back</button>
        <button class="btn ok big" id="create">Create the room</button>
      </div>
    </div>`,

  join: () => `
    <div class="panel narrowpanel">
      <h2>🎮 Join the duel</h2>
      <label>Room code (given by the referee)</label>
      <input type="text" id="code" maxlength="4" placeholder="ABCD" autocomplete="off" class="codeinput">
      <label>Your name</label>
      <input type="text" id="name" maxlength="20" placeholder="Your name" autocomplete="off">
      <div class="row mt">
        <button class="btn" id="backRole" style="flex:0 0 auto">← Back</button>
        <button class="btn primary big" id="join">Enter the room</button>
      </div>
    </div>`,

  room: () => state.role === 'ref' ? refView() : playerView(),
};

// ----- referee -----
function refView() {
  const s = state, [A, B] = [s.players.A, s.players.B];
  const slot = (p, k) => `
    <div class="pslot ${p.joined ? 'in' : ''} ${k}">
      ${p.joined ? `<b>${esc(p.name)}</b><span class="dot ${p.online ? '' : 'off'}"></span>` : '<span class="muted">Waiting for a player…</span>'}
      ${p.joined && s.status === 'lobby' ? `<button class="btn small ghost" data-kick="${k}">Kick</button>` : ''}
    </div>`;
  if (s.status === 'lobby') {
    const ready = A.joined && B.joined;
    return `
      <div class="panel center">
        <p class="muted">Room code — give it to both players</p>
        <div class="bigcode">${s.code}</div>
        <div class="slots">${slot(A, 'A')}<span class="vs">VS</span>${slot(B, 'B')}</div>
        <p class="muted">${s.duration / 1000} s · ${s.categories.length === s.allCategories.length ? 'all categories' : s.categories.map(esc).join(', ')}</p>
        <button class="btn ok big" id="start" ${ready ? '' : 'disabled'}>⚔️ Start the duel</button>
        ${ready ? '' : '<p class="muted">The duel can start once both players have joined.</p>'}
      </div>
      <p class="center"><button class="btn ghost" id="leave">Close the room</button></p>`;
  }
  if (s.status === 'running') {
    return `
      <div class="panel center">
        <div class="slots">${slot(A, 'A')}<span class="vs">VS</span>${slot(B, 'B')}</div>
        <div class="label">${phase() === 'countdown' ? 'Get ready…' : 'Time left'}</div>
        <div class="bigtimer" id="timer"></div>
        <p class="muted">The players are answering on their screens. Scores will be revealed at the end!</p>
        <button class="btn ghost" id="cancel">✖ Cancel the duel</button>
      </div>`;
  }
  // over
  const w = A.score === B.score ? null : A.score > B.score ? A : B;
  return `
    <div class="panel center">
      <div class="label">Time's up!</div>
      <h1 class="result">${w ? `🏆 ${esc(w.name)} wins!` : '🤝 Draw!'}</h1>
      <div class="final">
        <div class="fp A ${w === A ? 'win' : ''}"><b>${esc(A.name)}</b><div class="pts">${A.score}</div><small>${A.score} / ${A.answered} correct</small></div>
        <div class="fp B ${w === B ? 'win' : ''}"><b>${esc(B.name)}</b><div class="pts">${B.score}</div><small>${B.score} / ${B.answered} correct</small></div>
      </div>
      <div class="row mt narrow">
        <button class="btn big" id="rematch">🔁 Rematch</button>
        <button class="btn primary big" id="leave">🎲 Back to the game</button>
      </div>
    </div>`;
}

// ----- player -----
function playerView() {
  const s = state, me = s.me;
  if (s.status === 'lobby') {
    return `
      <div class="panel center">
        <p class="muted">Room <span class="code">${s.code}</span></p>
        <h1>👋 ${esc(me.name)}</h1>
        <p>${s.opponent ? `Your opponent: <b>${esc(s.opponent)}</b>` : 'Waiting for your opponent…'}</p>
        <div class="spinner"></div>
        <p class="muted">Waiting for the referee to start the duel…</p>
      </div>`;
  }
  if (s.status === 'over') {
    return `
      <div class="panel center">
        <div class="label">Time's up!</div>
        <p class="muted">Your score</p>
        <div class="mypoints">${me.score}</div>
        <p class="muted">${me.score} correct out of ${me.answered} answered</p>
        <p>The referee will announce the winner! 👀</p>
        <button class="btn primary big narrow" id="leave">🎲 Back to the game</button>
      </div>`;
  }
  // running
  if (phase() === 'countdown') {
    return `<div class="center"><div class="label">Get ready…</div><div class="countdown" id="timer"></div></div>`;
  }
  const q = feedback ? feedback.q : s.question;
  const choices = q ? q.choices.map((c, i) => {
    let cls = '';
    if (feedback) cls = i === feedback.correct ? 'right' : i === feedback.choice ? 'wrong' : 'dim';
    return `<button class="choice ${cls}" data-choice="${i}" ${feedback ? 'disabled' : ''}><kbd>${i + 1}</kbd> ${esc(c)}</button>`;
  }).join('') : '';
  return `
    <div class="pbar">
      <div class="pscore"><small>${esc(me.name)}</small><b id="myscore">${me.score}</b><small>points</small></div>
      <div class="ptimer" id="timer"></div>
    </div>
    ${q ? `<div class="qcard">
      <span class="cat">${esc(q.c)}</span>
      <div class="q">${esc(q.q)}</div>
    </div>
    <div class="choices">${choices}</div>` : ''}`;
}

async function answer(i) {
  const q = state?.question;
  if (!q || feedback || sending || phase() !== 'running') return;
  sending = true;
  try {
    const r = await post('/api/answer', { code: state.code, id: q.id, choice: i });
    feedback = { q, choice: i, correct: r.correct, ok: r.ok };
    r.ok ? sfx.good() : sfx.bad();
    state = r.state;   // contains the next question and the new score
    render();
    setTimeout(() => { feedback = null; render(); }, r.ok ? 450 : 900);
  } catch (e) { if (e.message !== 'Not running') toast(e.message); }
  finally { sending = false; }
}

// ---------- render + events ----------
function render() {
  document.body.dataset.screen = screen;
  app.innerHTML = screens[screen]();
  const info = $('#topInfo');
  info.innerHTML = screen === 'room' && state
    ? `<span class="muted">${state.role === 'ref' ? '🧑‍⚖️ Referee' : '🎮 Player'} · Room</span> <span class="code">${state.code}</span>` : '';
  tickTimer();

  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('duelNow', () => post('/api/duel-now', {})
    .then(j => { alertNext = j.next; toast('⚔️ Duel in a few seconds on every screen…'); })
    .catch(e => toast(e.message)));
  on('accept', () => go('role'));
  on('backWait', () => go('waiting'));
  on('asRef', () => go('create'));
  on('asPlayer', () => { go('join'); $('#code').focus(); });
  on('backRole', () => go('role'));

  if (screen === 'create') {
    renderCategories();
    on('create', async () => {
      const seconds = Math.round(Number($('#dur').value));
      if (!(seconds >= 10 && seconds <= 900)) return toast('Duration: 10 to 900 seconds');
      const categories = [...app.querySelectorAll('[data-cat]:checked')].map(c => c.dataset.cat);
      if (!categories.length) return toast('Pick at least one category');
      try {
        const { code } = await post('/api/create', { seconds, categories });
        enterRoom(code);
      } catch (e) { toast(e.message); }
    });
  }
  if (screen === 'join') {
    try { $('#name').value = localStorage.getItem('duelName') || ''; } catch {}
    const join = async () => {
      const code = $('#code').value.trim().toUpperCase(), name = $('#name').value.trim();
      if (code.length !== 4) return toast('The room code has 4 letters');
      if (!name) return toast('Enter your name');
      try { localStorage.setItem('duelName', name); } catch {}
      try { const r = await post('/api/join', { code, name }); enterRoom(r.code); } catch (e) { toast(e.message); }
    };
    on('join', join);
    $('#code').onkeydown = e => { if (e.key === 'Enter') $('#name').focus(); };
    $('#name').onkeydown = e => { if (e.key === 'Enter') join(); };
  }
  if (screen === 'room') {
    on('start', () => act('start'));
    on('cancel', () => { if (confirm('Cancel this duel? Scores will be lost.')) act('cancel'); });
    on('rematch', () => act('rematch'));
    on('leave', leaveRoom);
    app.querySelectorAll('[data-kick]').forEach(b => b.onclick = () => act('kick', { slot: b.dataset.kick }));
    app.querySelectorAll('[data-choice]').forEach(b => b.onclick = () => answer(Number(b.dataset.choice)));
  }
}

// categories come from the question bank on the server
let allCategories = null;
async function renderCategories() {
  if (!allCategories) {
    try { allCategories = (await (await fetch('/api/categories')).json()).categories; } catch { allCategories = []; }
  }
  const box = $('#cats'); if (!box) return;
  box.innerHTML = allCategories.map(c => `<label><input type="checkbox" data-cat="${esc(c)}" checked> ${esc(c)}</label>`).join('');
}

document.addEventListener('keydown', (e) => {
  if (screen === 'room' && state?.role !== 'ref' && ['1', '2', '3', '4', '&', 'é', '"', "'"].includes(e.key)) {
    answer({ '1': 0, '2': 1, '3': 2, '4': 3, '&': 0, 'é': 1, '"': 2, "'": 3 }[e.key]);
  }
});

// ---------- timer loop ----------
let lastPhase = null, lastSec = null;
function tickTimer() {
  if (screen !== 'room' || !state || state.status !== 'running') { lastPhase = null; return; }
  const p = phase();
  if (p !== lastPhase) {
    if (lastPhase === 'countdown' && p === 'running') sfx.go();
    lastPhase = p;
    if (lastPhase !== null) render();   // switch countdown → questions
    return;
  }
  const el = $('#timer');
  if (!el) return;
  if (p === 'countdown') {
    const sec = Math.ceil((state.startAt - now()) / 1000);
    el.textContent = sec;
    if (sec !== lastSec) { lastSec = sec; tone(660, .12); }
  } else {
    const left = Math.max(0, state.endAt - now());
    el.textContent = fmt(left);
    el.classList.toggle('crit', left < 10000);
    const sec = Math.ceil(left / 1000);
    if (left > 0 && left <= 5000 && sec !== lastSec) { lastSec = sec; sfx.tick(); }
    if (left === 0 && !tickTimer.ended) { tickTimer.ended = true; setTimeout(() => pollOnce(), 150); }  // fetch the results right away
    if (left > 0) tickTimer.ended = false;
  }
}
(function loop() { tickTimer(); requestAnimationFrame(loop); })();

// fire the global alert at the exact time the server announced (setInterval keeps running in background tabs)
setInterval(() => {
  if (screen !== 'waiting' || !alertNext || alertNext === lastFired) return;
  const t = now();
  if (t >= alertNext && t < alertNext + 10000) { lastFired = alertNext; showAlert(); }
}, 200);

// ---------- boot ----------
const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) {
  // reload while in a room → reconnect if we were part of it
  post('/api/join', { code: roomParam, check: true }).then(r => enterRoom(r.code)).catch(() => leaveRoom());
} else { startPolling(null); render(); }
