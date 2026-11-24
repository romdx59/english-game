// English Duel — single-screen version. Everything runs in this page: no server, no connection needed.
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CATEGORIES = [...new Set(QUESTIONS.map(q => q.c))];
const COUNTDOWN_MS = 3000;

// Keys: physical key positions, so it works on AZERTY and QWERTY keyboards alike
const KEYS = [
  { codes: ['KeyQ', 'KeyW', 'KeyE', 'KeyR'], labels: ['A', 'Z', 'E', 'R'] },   // player 1 (left)
  { codes: ['KeyU', 'KeyI', 'KeyO', 'KeyP'], labels: ['U', 'I', 'O', 'P'] },   // player 2 (right)
];

// ---------- saved settings (this browser only) ----------
const saved = {
  get(k, d) { try { const v = localStorage.getItem('duel.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('duel.' + k, JSON.stringify(v)); } catch {} },
};
let history = saved.get('history', []);

let screen = 'waiting';   // waiting | alert | setup | play | over
let game = null;          // { players: [p1, p2], duration, startAt, endAt, categories, cancelled }

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show';
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = 'toast', 2500);
}

// ---------- sound (browsers only allow it after a first click on the page) ----------
let audio;
function unlockAudio() { try { audio = audio || new AudioContext(); audio.resume(); } catch {} }
document.addEventListener('pointerdown', unlockAudio);
document.addEventListener('keydown', unlockAudio);
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
  count: () => tone(660, .12),
  go: () => tone(1046, .35, 'triangle', .2),
  end: () => { tone(523, .2, 'triangle', .2); tone(659, .2, 'triangle', .2, .2); tone(784, .5, 'triangle', .2, .4); },
};

// ---------- the random "DUEL!" alert ----------
// Goes off at a random moment (1–10 min by default) while the waiting screen is shown.
// If the device was asleep at that moment (locked screen, background tab), it shows as soon as it wakes up.
// For testing: add ?alert=0.1-0.2 to the URL (minutes).
const [ALERT_MIN, ALERT_MAX] = (() => {
  const m = /^(\d*\.?\d+)-(\d*\.?\d+)$/.exec(new URLSearchParams(location.search).get('alert') || '');
  return m ? [Number(m[1]), Math.max(Number(m[1]), Number(m[2]))] : [1, 10];
})();
let alertAt = 0;
function scheduleAlert() { alertAt = Date.now() + (ALERT_MIN + Math.random() * (ALERT_MAX - ALERT_MIN)) * 60000; }
function checkAlert() { if (screen === 'waiting' && alertAt && Date.now() >= alertAt) showAlert(); }
setInterval(checkAlert, 250);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkAlert(); });

function showAlert() {
  alertAt = 0;
  go('alert'); sfx.siren();
  let on = false; clearInterval(showAlert.flash);
  showAlert.flash = setInterval(() => {
    if (screen !== 'alert') { clearInterval(showAlert.flash); document.title = 'English Duel'; return; }
    document.title = (on = !on) ? '⚔️ DUEL! ⚔️' : 'English Duel';
  }, 700);
}

// ---------- game ----------
function newQuestion(p) {
  const all = QUESTIONS.map((q, i) => ({ q, i })).filter(x => game.categories.includes(x.q.c));
  let pool = all.filter(x => !p.used.has(x.i) && x.i !== game.players.find(o => o !== p)?.q?.i);   // not the one the opponent has right now
  if (!pool.length) { p.used.clear(); pool = all; }
  const { q, i } = pool[Math.floor(Math.random() * pool.length)];
  p.used.add(i);
  const choices = [q.a, ...q.w];
  for (let k = choices.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [choices[k], choices[j]] = [choices[j], choices[k]]; }
  p.q = { i, c: q.c, q: q.q, choices, correct: choices.indexOf(q.a) };
}

function startGame(names, seconds, categories) {
  const players = names.map(name => ({ name, score: 0, answered: 0, used: new Set(), q: null, feedback: null }));
  game = { players, duration: seconds * 1000, categories, startAt: Date.now() + COUNTDOWN_MS, endAt: 0 };
  game.endAt = game.startAt + game.duration;
  players.forEach(newQuestion);
  go('play');
}

const phase = () => (!game ? null : Date.now() < game.startAt ? 'countdown' : Date.now() < game.endAt ? 'running' : 'ended');

function answer(pi, choice) {
  if (screen !== 'play' || phase() !== 'running') return;
  const p = game.players[pi];
  if (p.feedback || !p.q || choice >= p.q.choices.length) return;   // still showing the previous answer
  const ok = choice === p.q.correct;
  p.answered++;
  if (ok) p.score++;
  ok ? sfx.good() : sfx.bad();
  p.feedback = { q: p.q, choice, ok };
  newQuestion(p);
  renderSide(pi);
  setTimeout(() => { if (p.feedback && game && game.players[pi] === p) { p.feedback = null; renderSide(pi); } }, ok ? 450 : 900);
}

function finish() {
  const [a, b] = game.players;
  game.winner = a.score === b.score ? -1 : a.score > b.score ? 0 : 1;
  history.unshift({ a: a.name, b: b.name, sa: a.score, sb: b.score, w: game.winner, at: Date.now() });
  history = history.slice(0, 8);
  saved.set('history', history);
  sfx.end();
  go('over');
}

function backToWaiting() { game = null; scheduleAlert(); go('waiting'); }

// ---------- rendering ----------
function fmt(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return s.toFixed(1);
  const total = Math.ceil(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function go(s) { screen = s; render(); }

const screens = {
  waiting: () => `
    <div class="waiting">
      <div class="dice">🎲</div>
      <h1>Game in progress…</h1>
      <p class="muted">A duel can break out at any moment. Keep playing!</p>
      <button class="btn small ghost mt" id="duelNow">⚔️ Duel now</button>
    </div>
    ${history.length ? `<div class="panel narrowpanel"><h2>Last duels</h2><ul class="hist">${history.map(h => `
      <li><span class="${h.w === 0 ? 'w' : ''}">${esc(h.a)}</span> <b>${h.sa} – ${h.sb}</b> <span class="${h.w === 1 ? 'w' : ''}">${esc(h.b)}</span></li>`).join('')}</ul></div>` : ''}`,

  alert: () => `
    <div class="alert">
      <div class="alert-title">⚔️ DUEL! ⚔️</div>
      <p>The person who was playing must choose an opponent!</p>
      <button class="btn big light" id="accept">Accept the duel</button>
    </div>`,

  setup: () => {
    const last = saved.get('names', ['', '']);
    const cats = saved.get('categories', CATEGORIES);
    return `
    <div class="panel narrowpanel">
      <h2>🧑‍⚖️ New duel</h2>
      <div class="row">
        <div><label>Player 1</label><input type="text" id="n1" maxlength="20" placeholder="Name" autocomplete="off" value="${esc(last[0])}">
          <p class="muted small hint">Left side · keys <kbd>A</kbd> <kbd>Z</kbd> <kbd>E</kbd> <kbd>R</kbd></p></div>
        <div class="vs">VS</div>
        <div><label>Player 2</label><input type="text" id="n2" maxlength="20" placeholder="Name" autocomplete="off" value="${esc(last[1])}">
          <p class="muted small hint">Right side · keys <kbd>U</kbd> <kbd>I</kbd> <kbd>O</kbd> <kbd>P</kbd></p></div>
      </div>
      <label>Duel length (seconds)</label>
      <input type="number" id="dur" min="10" max="900" value="${saved.get('duration', 60)}">
      <label>Question categories</label>
      <div class="cats">${CATEGORIES.map(c => `<label><input type="checkbox" data-cat="${esc(c)}" ${cats.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('')}</div>
      <div class="row mt">
        <button class="btn" id="cancelSetup" style="flex:0 0 auto">← Back</button>
        <button class="btn ok big" id="start">⚔️ Start the duel</button>
      </div>
    </div>`;
  },

  play: () => {
    if (phase() === 'countdown') return `<div class="center"><div class="label">Get ready…</div><div class="countdown" id="countdown"></div>
      <p class="muted">${esc(game.players[0].name)} <b>VS</b> ${esc(game.players[1].name)}</p></div>`;
    return `
      <div class="duel">
        <div class="side p1" id="side0"></div>
        <div class="mid">
          <div class="label">Time left</div>
          <div class="bigtimer" id="timer"></div>
          <button class="btn small ghost" id="abort">✖ Cancel</button>
        </div>
        <div class="side p2" id="side1"></div>
      </div>`;
  },

  over: () => {
    const [a, b] = game.players, w = game.winner;
    return `
    <div class="panel center">
      <div class="label">Time's up!</div>
      <h1 class="result">${w === -1 ? '🤝 Draw!' : `🏆 ${esc(game.players[w].name)} wins!`}</h1>
      <div class="final">
        <div class="fp A ${w === 0 ? 'win' : ''}"><b>${esc(a.name)}</b><div class="pts">${a.score}</div><small>${a.score} / ${a.answered} correct</small></div>
        <div class="fp B ${w === 1 ? 'win' : ''}"><b>${esc(b.name)}</b><div class="pts">${b.score}</div><small>${b.score} / ${b.answered} correct</small></div>
      </div>
      <div class="row mt narrow">
        <button class="btn big" id="rematch">🔁 Rematch</button>
        <button class="btn primary big" id="back">🎲 Back to the game</button>
      </div>
    </div>`;
  },
};

// One player's half of the screen
function renderSide(pi) {
  const el = document.getElementById('side' + pi);
  if (!el) return;
  const p = game.players[pi], fb = p.feedback, q = fb ? fb.q : p.q;
  el.innerHTML = `
    <div class="sidehead"><span class="name">${esc(p.name)}</span><span class="pts"><b>${p.score}</b> pts</span></div>
    <div class="qcard"><span class="cat">${esc(q.c)}</span><div class="q">${esc(q.q)}</div></div>
    <div class="choices">${q.choices.map((c, i) => {
      const cls = fb ? (i === fb.q.correct ? 'right' : i === fb.choice ? 'wrong' : 'dim') : '';
      return `<button class="choice ${cls}" data-p="${pi}" data-c="${i}" ${fb ? 'disabled' : ''}><kbd>${KEYS[pi].labels[i]}</kbd> ${esc(c)}</button>`;
    }).join('')}</div>`;
  el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => answer(pi, Number(b.dataset.c)));
}

function render() {
  document.body.dataset.screen = screen;
  app.innerHTML = screens[screen]();
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('duelNow', showAlert);
  on('accept', () => go('setup'));
  on('cancelSetup', backToWaiting);
  on('back', backToWaiting);
  on('rematch', () => startGame(game.players.map(p => p.name), game.duration / 1000, game.categories));
  on('abort', () => { if (confirm('Cancel this duel? Nobody wins.')) backToWaiting(); });

  if (screen === 'setup') {
    const start = () => {
      const n1 = $('#n1').value.trim(), n2 = $('#n2').value.trim();
      if (!n1 || !n2) return toast('Enter both names');
      if (n1.toLowerCase() === n2.toLowerCase()) return toast('Two different players please!');
      const seconds = Math.round(Number($('#dur').value));
      if (!(seconds >= 10 && seconds <= 900)) return toast('Duration: 10 to 900 seconds');
      const categories = [...app.querySelectorAll('[data-cat]:checked')].map(c => c.dataset.cat);
      if (!categories.length) return toast('Pick at least one category');
      saved.set('names', [n1, n2]); saved.set('duration', seconds); saved.set('categories', categories);
      startGame([n1, n2], seconds, categories);
    };
    on('start', start);
    $('#n1').onkeydown = e => { if (e.key === 'Enter') $('#n2').focus(); };
    $('#n2').onkeydown = e => { if (e.key === 'Enter') start(); };
    $('#n1').focus();
  }
  if (screen === 'play' && phase() !== 'countdown') { renderSide(0); renderSide(1); }
  tick();
}

// keyboard: player 1 = A Z E R (left hand), player 2 = U I O P (right hand)
document.addEventListener('keydown', (e) => {
  if (screen !== 'play' || e.repeat || ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
  KEYS.forEach((k, pi) => { const i = k.codes.indexOf(e.code); if (i >= 0) { e.preventDefault(); answer(pi, i); } });
});

// ---------- timer loop ----------
let lastPhase = null, lastSec = null;
function tick() {
  if (screen !== 'play' || !game) { lastPhase = null; return; }
  const p = phase();
  if (p !== lastPhase) {
    const prev = lastPhase;
    lastPhase = p;
    if (p === 'ended') return finish();
    if (prev === 'countdown' && p === 'running') { sfx.go(); render(); return; }
  }
  if (p === 'countdown') {
    const sec = Math.ceil((game.startAt - Date.now()) / 1000);
    const el = $('#countdown'); if (el) el.textContent = sec;
    if (sec !== lastSec) { lastSec = sec; sfx.count(); }
  } else if (p === 'running') {
    const left = game.endAt - Date.now();
    const el = $('#timer');
    if (el) { el.textContent = fmt(left); el.classList.toggle('crit', left < 10000); }
    const sec = Math.ceil(left / 1000);
    if (left <= 5000 && sec !== lastSec) { lastSec = sec; sfx.tick(); }
  }
}
(function loop() { tick(); requestAnimationFrame(loop); })();
// the animation loop pauses in background tabs: make sure the duel still ends on time
setInterval(() => { if (screen === 'play' && phase() === 'ended') tick(); }, 500);

// ---------- boot ----------
scheduleAlert();
render();
