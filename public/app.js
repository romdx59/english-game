// English Duel — client (UI + peer-to-peer connection)
// The referee's page runs the game (host.js); players connect to it directly with PeerJS.
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
  del(k) { try { sessionStorage.removeItem(k); } catch {} },
};

// One identity per browser tab (survives a reload, so a player can come back to their seat)
let token = store.get('duelToken');
if (!token) { token = crypto.randomUUID(); store.set('duelToken', token); }

let screen = 'waiting';   // waiting | alert | role | create | join | connecting | room
let state = null;         // room state (computed locally for the referee, received from the referee for players)
let offset = 0;           // referee clock - local clock (players only)
let feedback = null;      // shown briefly after answering
let sending = false;
let host = null;          // referee only: the game engine (host.js)
let link = null;          // player only: { peer, conn, code, joined }

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show';
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = 'toast', 2800);
}
const now = () => Date.now() + offset;
const peerReady = () => {
  if (typeof Peer === 'undefined') { toast('Could not load the connection library — check your internet connection'); return false; }
  return true;
};

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

// ---------- the random "DUEL!" alert, without a server ----------
// Every page computes the same pseudo-random alert times from the date, so all screens go off together
// (phones and computers keep their clocks in sync over the internet).
// For testing: add ?alert=0.2-0.5 to the URL (minutes) on every screen.
const [ALERT_MIN, ALERT_MAX] = (() => {
  const m = /^(\d*\.?\d+)-(\d*\.?\d+)$/.exec(new URLSearchParams(location.search).get('alert') || '');
  return m ? [Number(m[1]), Math.max(Number(m[1]), Number(m[2]))] : [1, 10];
})();
function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function nextAlertAfter(time) {
  const DAY = 86400000;
  for (let day = Math.floor(time / DAY); ; day++) {
    const rng = mulberry32(day ^ 0x5eed1e5 ^ Math.round(ALERT_MIN * 1000) ^ (Math.round(ALERT_MAX * 1000) << 12));
    for (let t = day * DAY; t < (day + 1) * DAY;) {
      t += (ALERT_MIN + rng() * (ALERT_MAX - ALERT_MIN)) * 60000;
      if (t > time) return t;
    }
  }
}
// Phones with a locked screen and background tabs are put to sleep by the browser:
// an alert that went off while asleep is still shown when the page wakes up (up to 2 min late).
const ALERT_GRACE = 2 * 60000;
const pageOpenedAt = Date.now();
let alertNext = nextAlertAfter(Date.now());
let lastAlertDue = 0;
function checkAlert() {
  const t = Date.now();
  if (t < alertNext) return;
  let due = alertNext;
  while ((alertNext = nextAlertAfter(due)) <= t) due = alertNext;   // most recent alert time that has passed
  if (due === lastAlertDue || t > due + ALERT_GRACE || due < pageOpenedAt) return;
  lastAlertDue = due;
  if (screen === 'waiting') showAlert();
}
setInterval(checkAlert, 200);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkAlert(); });

// ---------- shared waiting room: "Duel now" rings on every screen ----------
// The first open page claims the PeerJS id "english-duel-v1-lobby" and becomes the hub;
// the other pages connect to it. When the hub page closes, the others elect a new hub.
// pages opened on localhost get their own waiting room, so local tests never ring the real site
const LOBBY_ID = PEER_PREFIX + (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? 'lobby-dev' : 'lobby');
const lobby = { peer: null, isHub: false, conns: new Set(), hubConn: null, count: 0, retry: null, awaiting: 0, pendingDuel: null };
// Heartbeat: every 3 s each screen asks the hub "are you there?" and the hub answers right away
// (answers are event-driven, so they work even if the hub's tab is in the background).
// No answer within 10 s → the hub is gone → elect a new one.
const LOBBY_BEAT = 3000, LOBBY_HUB_TIMEOUT = 10000, LOBBY_CLIENT_TIMEOUT = 120000;

function lobbyStart() {
  if (typeof Peer === 'undefined') return;
  lobbyStop();
  const peer = new Peer(LOBBY_ID);   // try to become the hub
  lobby.peer = peer;
  peer.on('open', () => { if (lobby.peer !== peer) return; lobby.isHub = true; lobbyCountChanged(); });
  peer.on('connection', (conn) => {
    conn.seen = Date.now();
    conn.on('open', () => { lobby.conns.add(conn); lobbyCountChanged(); });
    conn.on('data', (msg) => {
      conn.seen = Date.now();
      if (msg && msg.t === 'duel') lobbyDuel();
      else if (msg && msg.t === 'beat') { try { conn.send({ t: 'count', n: lobby.count }); } catch {} }
      else if (msg && msg.t === 'bye') { lobby.conns.delete(conn); lobbyCountChanged(); }
    });
    conn.on('close', () => { lobby.conns.delete(conn); lobbyCountChanged(); });
  });
  peer.on('error', (e) => {
    if (lobby.peer !== peer) return;
    if (e.type === 'unavailable-id' && !lobby.isHub) { peer.destroy(); lobbyJoin(); }   // someone else is the hub
    else if (!lobby.isHub) lobbyRetry();
  });
  peer.on('disconnected', () => { if (lobby.peer === peer && !peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1000); });
}
function lobbyJoin() {
  const peer = new Peer();
  lobby.peer = peer; lobby.isHub = false;
  peer.on('open', () => {
    if (lobby.peer !== peer) return;
    const conn = peer.connect(LOBBY_ID, { reliable: true });
    lobby.hubConn = conn;
    conn.on('open', () => { lobby.awaiting = 0; });
    setTimeout(() => { if (lobby.peer === peer && !conn.open) lobbyRetry(); }, 8000);   // never connected: try again
    conn.on('data', (msg) => {
      if (!msg || lobby.peer !== peer) return;
      lobby.awaiting = 0;   // the hub is alive
      if (msg.t === 'duel') onLobbyDuel();
      else if (msg.t === 'count') { lobby.count = msg.n; showLobbyCount(); }
      else if (msg.t === 'bye') lobbyRetry();   // the hub page is closing: elect a new one
    });
    conn.on('close', () => { if (lobby.peer === peer) lobbyRetry(); });   // the hub left: elect a new one
  });
  peer.on('error', () => { if (lobby.peer === peer) lobbyRetry(); });
}
function lobbyRetry() {
  if (lobby.retry) return;
  lobby.count = 0; showLobbyCount();
  // random delay so that the remaining pages don't all try to become the hub at the same instant
  lobby.retry = setTimeout(() => { lobby.retry = null; lobbyStart(); }, 800 + Math.random() * 2000);
}
function lobbyStop() {
  const peer = lobby.peer;
  lobby.peer = null; lobby.isHub = false; lobby.hubConn = null; lobby.conns.clear();
  if (peer) try { peer.destroy(); } catch {}
}
function lobbyCountChanged() {
  lobby.count = lobby.conns.size + 1;
  for (const c of lobby.conns) try { c.send({ t: 'count', n: lobby.count }); } catch {}
  showLobbyCount();
}
function lobbyDuel() {   // hub: ring everyone, including itself
  for (const c of lobby.conns) try { c.send({ t: 'duel' }); } catch {}
  onLobbyDuel();
}
function onLobbyDuel() {
  clearTimeout(lobby.pendingDuel); lobby.pendingDuel = null;
  if (screen === 'waiting') showAlert();
}
function duelNowForEveryone() {
  if (lobby.isHub) return lobbyDuel();
  const ringHereOnly = () => {
    lobby.pendingDuel = null;
    showAlert(); toast('Not connected to the other screens: the alert only shows here');
    lobbyRetry();
  };
  if (!(lobby.hubConn && lobby.hubConn.open)) return ringHereOnly();
  lobby.hubConn.send({ t: 'duel' });
  // the hub sends the alert back to us too; if it doesn't within 1.5 s, the hub is gone
  clearTimeout(lobby.pendingDuel);
  lobby.pendingDuel = setTimeout(ringHereOnly, 1500);
}
setInterval(() => {
  const t = Date.now();
  if (lobby.isHub) {
    // forget screens that stopped talking (closed without saying bye)
    let removed = false;
    for (const c of lobby.conns) if (t - c.seen > LOBBY_CLIENT_TIMEOUT) { lobby.conns.delete(c); removed = true; try { c.close(); } catch {} }
    if (removed) lobbyCountChanged();
  } else if (lobby.hubConn && lobby.hubConn.open) {
    if (lobby.awaiting && t - lobby.awaiting > LOBBY_HUB_TIMEOUT) lobbyRetry();   // no answer: the hub is gone
    else if (!lobby.awaiting) { lobby.awaiting = t; try { lobby.hubConn.send({ t: 'beat' }); } catch {} }
  }
}, LOBBY_BEAT);
// closing or leaving the page: tell the others right away
window.addEventListener('pagehide', () => {
  try {
    if (lobby.isHub) for (const c of lobby.conns) c.send({ t: 'bye' });
    else if (lobby.hubConn && lobby.hubConn.open) lobby.hubConn.send({ t: 'bye' });
  } catch {}
});
function showLobbyCount() {
  const el = document.getElementById('lobbyCount');
  if (!el) return;
  el.textContent = lobby.count > 1 ? `📡 ${lobby.count} screens connected` : lobby.count === 1 ? '📡 Only this screen is connected' : '📡 Connecting to the other screens…';
}
// when the phone wakes up, make sure we're still in the waiting room
document.addEventListener('visibilitychange', () => {
  if (document.hidden || lobby.isHub || lobby.retry) return;
  if (!(lobby.hubConn && lobby.hubConn.open)) return lobbyRetry();
  lobby.awaiting = Date.now();   // just woke up: check right away that the hub is still there
  try { lobby.hubConn.send({ t: 'beat' }); } catch {}
});

function showAlert() {
  go('alert'); sfx.siren();
  let on = false; clearInterval(showAlert.flash);
  showAlert.flash = setInterval(() => {
    if (screen !== 'alert') { clearInterval(showAlert.flash); document.title = 'English Duel'; return; }
    document.title = (on = !on) ? '⚔️ DUEL! ⚔️' : 'English Duel';
  }, 700);
}

// ---------- room state ----------
const sameState = (a, b) => a && b && JSON.stringify({ ...a, hostNow: 0 }) === JSON.stringify({ ...b, hostNow: 0 });
function onRoomState(s) {
  const prev = state;
  state = s;
  if (prev && prev.status === 'running' && state.status === 'over') sfx.end();
  if (screen === 'room' && sameState(prev, s)) return;   // nothing new: don't rebuild the page
  screen = 'room'; render();
}

// ---------- referee ----------
async function createRoom(seconds, categories) {
  if (!peerReady()) return;
  go('connecting');
  host = new Host(onRoomState);
  try {
    const code = await host.create(seconds, categories);
    history.replaceState(null, '', `?room=${code}`);
  } catch (e) {
    host = null; toast(e.message); go('create');
  }
}
function act(name, extra) {
  try { host.action(name, extra); } catch (e) { toast(e.message); }
}

// ---------- player ----------
function dropLink(l = link) {
  if (!l) return;
  l.dead = true;
  try { l.peer.destroy(); } catch {}
  if (link === l) link = null;
}

function joinRoom(code, { name, rejoin = false } = {}) {
  return new Promise((resolve, reject) => {
    dropLink();
    const peer = new Peer();
    const l = link = { peer, conn: null, code, joined: false };
    const fail = (msg) => {
      if (l.joined || l.dead) return;
      clearTimeout(timer); dropLink(l); reject(new Error(msg));
    };
    const timer = setTimeout(() => fail("Could not reach the room — check the code, or the referee's connection"), 12000);
    peer.on('error', (e) => fail(netError(e)));
    peer.on('open', () => {
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      l.conn = conn;
      conn.on('open', () => conn.send({ t: 'hello', token, name, rejoin }));
      conn.on('data', (msg) => {
        if (link !== l || !msg) return;
        if (msg.t === 'joined') {
          l.joined = true; clearTimeout(timer);
          store.set('duelPlayerRoom', code);
          history.replaceState(null, '', `?room=${code}`);
          resolve(msg.slot);
        } else if (msg.t === 'error') fail(msg.error);
        else onHostMessage(msg);
      });
      conn.on('close', () => { if (link === l && l.joined) onHostLost(); });
    });
  });
}

let pendingAnswer = null;
function onHostMessage(msg) {
  if (msg.t === 'state') {
    offset = msg.state.hostNow - Date.now();
    onRoomState(msg.state);
  } else if (msg.t === 'result') {
    if (pendingAnswer && pendingAnswer.id === msg.id) { pendingAnswer.resolve(msg); pendingAnswer = null; }
  } else if (msg.t === 'closed') {
    roomGone('The referee closed the room');
  } else if (msg.t === 'kicked') {
    roomGone('The referee removed you from the room');
  }
}

// The connection to the referee dropped (their page reloaded, network blip…): try to get back in
async function onHostLost() {
  const code = link && link.code;
  dropLink();
  if (!code) return;
  if (state && state.status === 'over') return;   // keep the final score on screen
  toast('Connection to the referee lost — reconnecting…');
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise(r => setTimeout(r, 2500));
    if (screen !== 'room' && screen !== 'connecting') return;   // the player left meanwhile
    try { await joinRoom(code, { rejoin: true }); toast('Reconnected!'); return; } catch {}
  }
  toast('The room is no longer reachable');
  backToWaiting();
}

async function answer(i) {
  const q = state?.question;
  if (!q || feedback || sending || phase() !== 'running' || !link?.conn?.open) return;
  sending = true;
  try {
    const r = await new Promise((resolve) => {
      pendingAnswer = { id: q.id, resolve };
      link.conn.send({ t: 'answer', id: q.id, choice: i });
      setTimeout(() => resolve({ error: 'The referee is not answering' }), 4000);
    });
    if (r.error) { if (r.error !== 'Not running') toast(r.error); return; }
    feedback = { q, choice: i, correct: r.correct, ok: r.ok };
    r.ok ? sfx.good() : sfx.bad();
    offset = r.state.hostNow - Date.now();
    state = r.state;   // contains the next question and the new score
    render();
    setTimeout(() => { feedback = null; render(); }, r.ok ? 450 : 900);
  } finally { sending = false; pendingAnswer = null; }
}

// ---------- leaving ----------
// Referee: closes the room for everyone. Player: frees their seat.
function leaveRoom() {
  if (host) { host.close(); host = null; }
  else if (link) {
    const l = link;
    try { l.conn.send({ t: 'leave' }); } catch {}
    l.dead = true; link = null;
    setTimeout(() => { try { l.peer.destroy(); } catch {} }, 300);
  }
  backToWaiting();
}
function backToWaiting() {
  state = null; feedback = null; offset = 0;
  store.del('duelPlayerRoom');
  history.replaceState(null, '', location.pathname + (new URLSearchParams(location.search).get('alert') ? `?alert=${new URLSearchParams(location.search).get('alert')}` : ''));
  go('waiting');
}
// The room disappeared (referee closed it, or we were kicked)
function roomGone(msg) {
  dropLink();
  if (state && state.status === 'over') return;   // keep showing the final score
  toast(msg);
  backToWaiting();
}
// Closing the referee's tab would end the room for everyone
window.addEventListener('beforeunload', (e) => {
  if (host && host.room) { e.preventDefault(); e.returnValue = ''; }
});

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
      <button class="btn small ghost mt" id="duelNow" title="Rings the duel alert on every connected screen">⚔️ Duel now</button>
      <p class="muted small" id="lobbyCount"></p>
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
      <div class="cats">${CATEGORIES.map(c => `<label><input type="checkbox" data-cat="${esc(c)}" checked> ${esc(c)}</label>`).join('')}</div>
      <p class="muted small">Keep this page open during the duel: your device runs the game.</p>
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

  connecting: () => `
    <div class="panel center narrowpanel">
      <div class="spinner"></div>
      <p>Connecting…</p>
      <button class="btn ghost" id="cancelConnect">Cancel</button>
    </div>`,

  room: () => state.role === 'ref' ? refView() : playerView(),
};

// ----- referee -----
function refView() {
  const s = state, [A, B] = [s.players.A, s.players.B];
  const slot = (p, k) => `
    <div class="pslot ${p.joined ? 'in' : ''} ${k}">
      ${p.joined ? `<b>${esc(p.name)}</b><span class="dot ${p.online ? '' : 'off'}" title="${p.online ? 'connected' : 'disconnected'}"></span>` : '<span class="muted">Waiting for a player…</span>'}
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
        <p class="muted small">Keep this page open: your device runs the game.</p>
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
        <button class="btn ghost mt" id="leave">Leave the room</button>
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

// ---------- render + events ----------
function render() {
  document.body.dataset.screen = screen;
  app.innerHTML = screens[screen]();
  const info = $('#topInfo');
  info.innerHTML = screen === 'room' && state
    ? `<span class="muted">${state.role === 'ref' ? '🧑‍⚖️ Referee' : '🎮 Player'} · Room</span> <span class="code">${state.code}</span>` : '';
  tickTimer();

  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('duelNow', duelNowForEveryone);
  showLobbyCount();
  on('accept', () => go('role'));
  on('backWait', () => go('waiting'));
  on('asRef', () => go('create'));
  on('asPlayer', () => { go('join'); $('#code').focus(); });
  on('backRole', () => go('role'));
  on('cancelConnect', () => { if (host) { host.close(); host = null; } dropLink(); backToWaiting(); });

  if (screen === 'create') {
    on('create', () => {
      const seconds = Math.round(Number($('#dur').value));
      if (!(seconds >= 10 && seconds <= 900)) return toast('Duration: 10 to 900 seconds');
      const categories = [...app.querySelectorAll('[data-cat]:checked')].map(c => c.dataset.cat);
      if (!categories.length) return toast('Pick at least one category');
      createRoom(seconds, categories);
    });
  }
  if (screen === 'join') {
    try { $('#name').value = localStorage.getItem('duelName') || ''; } catch {}
    const join = async () => {
      const code = $('#code').value.trim().toUpperCase(), name = $('#name').value.trim();
      if (!/^[A-Z]{4}$/.test(code)) return toast('The room code has 4 letters');
      if (!name) return toast('Enter your name');
      if (!peerReady()) return;
      try { localStorage.setItem('duelName', name); } catch {}
      go('connecting');
      try { await joinRoom(code, { name }); }
      catch (e) { toast(e.message); go('join'); $('#code').value = code; }
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
  }
}
(function loop() { tickTimer(); requestAnimationFrame(loop); })();

// ---------- boot ----------
(async function boot() {
  lobbyStart();
  const roomParam = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  let saved = null;
  try { saved = JSON.parse(store.get(HOST_SAVE_KEY)); } catch {}
  if (roomParam && saved && saved.code === roomParam && peerReady()) {
    // the referee reloaded the page: reopen the same room
    go('connecting');
    host = new Host(onRoomState);
    if (!(await host.restore())) { host = null; toast('The room could not be reopened'); backToWaiting(); }
  } else if (roomParam && store.get('duelPlayerRoom') === roomParam && peerReady()) {
    // a player reloaded the page: take their seat back
    go('connecting');
    try { await joinRoom(roomParam, { rejoin: true }); } catch (e) { toast(e.message); backToWaiting(); }
  } else {
    if (roomParam) backToWaiting(); else render();
  }
})();
