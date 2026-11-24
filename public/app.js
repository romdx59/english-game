// English Duel — chess-clock duel on one screen, played with one mouse (or keys 1–4).
// Everything runs in this page: no server, no connection needed.
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CATEGORIES = [...new Set(QUESTIONS.map(q => q.c))];
const COUNTDOWN_MS = 3000;
const SWITCH_MS = 1000;        // after a correct answer: both clocks stopped while the mouse changes hands
const WRONG_MS = 900;          // after a wrong answer: the right answer is shown, the clock keeps running
const ANSWER_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];   // physical keys, so 1–4 also work on AZERTY (& é " ')
const NUMPAD_KEYS = ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4'];

// ---------- saved settings (this browser only) ----------
const saved = {
  get(k, d) { try { const v = localStorage.getItem('duel.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('duel.' + k, JSON.stringify(v)); } catch {} },
};
let history = saved.get('history', []);

let screen = 'waiting';   // waiting | alert | setup | play | over
let game = null;

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

// ---------- the chess-clock duel ----------
// game.phase: countdown → running ⇄ switching (after a correct answer) / paused → over
// Only the player whose turn it is has their clock running.
function timeLeft(i) {
  const p = game.players[i];
  return Math.max(0, p.left - (i === game.turn && game.since ? Date.now() - game.since : 0));
}
function stopClock() {   // freeze the current player's clock
  if (!game.since) return;
  const p = game.players[game.turn];
  p.left = Math.max(0, p.left - (Date.now() - game.since));
  game.since = 0;
}
function startClock() { game.since = Date.now(); }

function newQuestion() {
  const all = QUESTIONS.map((q, i) => ({ q, i })).filter(x => game.categories.includes(x.q.c));
  let pool = all.filter(x => !game.used.has(x.i));   // no question twice in a duel (both players see the screen)
  if (!pool.length) { game.used.clear(); pool = all; }
  const { q, i } = pool[Math.floor(Math.random() * pool.length)];
  game.used.add(i);
  const choices = [q.a, ...q.w];
  for (let k = choices.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [choices[k], choices[j]] = [choices[j], choices[k]]; }
  game.q = { c: q.c, q: q.q, choices, correct: choices.indexOf(q.a) };
  game.feedback = null;
}

function startGame(names, seconds, categories, first) {
  const turn = first === 'random' ? Math.floor(Math.random() * 2) : Number(first) || 0;
  game = {
    players: names.map(name => ({ name, left: seconds * 1000, score: 0, answered: 0 })),
    settings: { names, seconds, categories, first },
    categories, used: new Set(), turn, since: 0, q: null, feedback: null,
    phase: 'countdown', phaseUntil: Date.now() + COUNTDOWN_MS, winner: null,
  };
  newQuestion();
  go('play');
}

function answer(choice) {
  if (screen !== 'play' || game.phase !== 'running' || game.feedback) return;
  const p = game.players[game.turn];
  const ok = choice === game.q.correct;
  p.answered++;
  game.feedback = { choice, ok };
  if (ok) {
    // correct: +1, my clock stops, short pause, then it's the opponent's turn
    p.score++;
    stopClock();
    sfx.good();
    game.phase = 'switching';
    game.phaseUntil = Date.now() + SWITCH_MS;
  } else {
    // wrong: my clock keeps running, I get a new question once the right answer has been shown
    sfx.bad();
    const q = game.q;
    setTimeout(() => { if (game && game.q === q && game.phase === 'running') { newQuestion(); render(); } }, WRONG_MS);
  }
  render();
}

function togglePause() {
  if (!game) return;
  if (game.phase === 'running' && !game.feedback) { stopClock(); game.phase = 'paused'; }
  else if (game.phase === 'paused') { game.phase = 'running'; startClock(); }
  render();
}

function finish(loser) {
  stopClock();
  game.players[loser].left = 0;
  game.phase = 'over';
  game.winner = 1 - loser;
  const [a, b] = game.players;
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
      <li><span class="${h.w === 0 ? 'w' : ''}">${esc(h.a)}</span> <b>vs</b> <span class="${h.w === 1 ? 'w' : ''}">${esc(h.b)}</span>
      <span class="muted small">· ${h.sa} – ${h.sb} correct</span></li>`).join('')}</ul></div>` : ''}`,

  alert: () => `
    <div class="alert">
      <div class="alert-title">⚔️ DUEL! ⚔️</div>
      <p>The person who was playing must choose an opponent!</p>
      <button class="btn big light" id="accept">Accept the duel</button>
    </div>`,

  setup: () => {
    const s = saved.get('settings', {});
    const names = s.names || ['', ''], cats = s.categories || CATEGORIES;
    return `
    <div class="panel narrowpanel">
      <h2>🧑‍⚖️ New duel</h2>
      <div class="row">
        <div><label>Player 1</label><input type="text" id="n1" maxlength="20" placeholder="Name" autocomplete="off" value="${esc(names[0])}"></div>
        <div class="vs">VS</div>
        <div><label>Player 2</label><input type="text" id="n2" maxlength="20" placeholder="Name" autocomplete="off" value="${esc(names[1])}"></div>
      </div>
      <div class="row">
        <div><label>Time per player (seconds)</label><input type="number" id="dur" min="10" max="900" value="${s.seconds || 60}"></div>
        <div><label>Who starts?</label>
          <select id="first">
            <option value="random" ${!s.first || s.first === 'random' ? 'selected' : ''}>Random</option>
            <option value="0" ${s.first === '0' ? 'selected' : ''}>Player 1</option>
            <option value="1" ${s.first === '1' ? 'selected' : ''}>Player 2</option>
          </select></div>
      </div>
      <label>Question categories</label>
      <div class="cats">${CATEGORIES.map(c => `<label><input type="checkbox" data-cat="${esc(c)}" ${cats.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('')}</div>
      <div class="rules-box">
        <b>Rules:</b> only the player whose turn it is answers, and their clock is running.
        <b>Correct</b> → +1, their clock stops and the opponent's starts.
        <b>Wrong</b> → new question, the clock keeps running. <b>First to 0:00 loses.</b>
      </div>
      <div class="row mt">
        <button class="btn" id="cancelSetup" style="flex:0 0 auto">← Back</button>
        <button class="btn ok big" id="start">⚔️ Start the duel</button>
      </div>
    </div>`;
  },

  play: () => {
    const g = game, me = g.players[g.turn];
    const clock = (i) => {
      const active = i === g.turn && g.phase !== 'countdown';
      return `<div class="clock p${i + 1} ${active ? 'active' : 'idle'}" id="clock${i}">
        ${active ? '<span class="turnflag">▼ playing</span>' : ''}
        <div class="name">${esc(g.players[i].name)}</div>
        <div class="time" id="time${i}">${fmt(timeLeft(i))}</div>
        <div class="score">✔ ${g.players[i].score} correct</div>
      </div>`;
    };
    let middle;
    if (g.phase === 'countdown') {
      middle = `<div class="center"><div class="label">${esc(me.name)} starts — get ready…</div><div class="countdown" id="countdown"></div></div>`;
    } else if (g.phase === 'switching') {
      const next = g.players[1 - g.turn];
      middle = `<div class="handover">✔ Correct! <span>${esc(next.name)}, your turn!</span></div>`;
    } else if (g.phase === 'paused') {
      middle = `<div class="handover paused">⏸ Paused <button class="btn primary" id="resume">▶ Resume</button></div>`;
    } else {
      const fb = g.feedback;
      middle = `
        <div class="qcard turn-p${g.turn + 1}">
          <div class="whose">${esc(me.name)}, your question:</div>
          <span class="cat">${esc(g.q.c)}</span>
          <div class="q">${esc(g.q.q)}</div>
        </div>
        <div class="choices">${g.q.choices.map((c, i) => {
          const cls = fb ? (i === g.q.correct ? 'right' : i === fb.choice ? 'wrong' : 'dim') : '';
          return `<button class="choice ${cls}" data-c="${i}" ${fb ? 'disabled' : ''}><kbd>${i + 1}</kbd> ${esc(c)}</button>`;
        }).join('')}</div>`;
    }
    return `
      <div class="clocks">${clock(0)}${clock(1)}</div>
      ${middle}
      <div class="row small-actions mt">
        ${g.phase === 'running' || g.phase === 'paused' ? `<button class="btn ghost" id="pause">${g.phase === 'paused' ? '▶ Resume' : '⏸ Pause'} <kbd>Space</kbd></button>` : ''}
        <button class="btn ghost" id="abort">✖ Cancel duel</button>
      </div>`;
  },

  over: () => {
    const w = game.players[game.winner], l = game.players[1 - game.winner];
    return `
    <div class="panel center">
      <div class="label">${esc(l.name)} ran out of time!</div>
      <h1 class="result">🏆 ${esc(w.name)} wins!</h1>
      <div class="final">
        ${game.players.map((p, i) => `<div class="fp ${i ? 'B' : 'A'} ${i === game.winner ? 'win' : ''}">
          <b>${esc(p.name)}</b><div class="pts">${fmt(p.left)}</div>
          <small>${p.score} correct out of ${p.answered} answered</small></div>`).join('')}
      </div>
      <div class="row mt narrow">
        <button class="btn big" id="rematch">🔁 Rematch</button>
        <button class="btn primary big" id="back">🎲 Back to the game</button>
      </div>
    </div>`;
  },
};

function render() {
  document.body.dataset.screen = screen;
  app.innerHTML = screens[screen]();
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('duelNow', showAlert);
  on('accept', () => go('setup'));
  on('cancelSetup', backToWaiting);
  on('back', backToWaiting);
  on('rematch', () => {
    const s = game.settings;
    // the loser starts the rematch when "who starts" was random
    startGame(s.names, s.seconds, s.categories, s.first === 'random' ? String(1 - game.winner) : s.first);
  });
  on('abort', () => {
    const wasRunning = game.phase === 'running';
    if (wasRunning) togglePause();
    if (confirm('Cancel this duel? Nobody wins.')) backToWaiting();
    else if (wasRunning) togglePause();
  });
  on('pause', togglePause);
  on('resume', togglePause);
  app.querySelectorAll('[data-c]').forEach(b => b.onclick = () => answer(Number(b.dataset.c)));

  if (screen === 'setup') {
    const start = () => {
      const n1 = $('#n1').value.trim(), n2 = $('#n2').value.trim();
      if (!n1 || !n2) return toast('Enter both names');
      if (n1.toLowerCase() === n2.toLowerCase()) return toast('Two different players please!');
      const seconds = Math.round(Number($('#dur').value));
      if (!(seconds >= 10 && seconds <= 900)) return toast('Time per player: 10 to 900 seconds');
      const categories = [...app.querySelectorAll('[data-cat]:checked')].map(c => c.dataset.cat);
      if (!categories.length) return toast('Pick at least one category');
      const first = $('#first').value;
      saved.set('settings', { names: [n1, n2], seconds, categories, first });
      startGame([n1, n2], seconds, categories, first);
    };
    on('start', start);
    $('#n1').onkeydown = e => { if (e.key === 'Enter') $('#n2').focus(); };
    $('#n2').onkeydown = e => { if (e.key === 'Enter') start(); };
    $('#n1').focus();
  }
  tick();
}

// keyboard: 1 2 3 4 to answer, Space to pause
document.addEventListener('keydown', (e) => {
  if (screen !== 'play' || e.repeat || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  let i = ANSWER_KEYS.indexOf(e.code);
  if (i < 0) i = NUMPAD_KEYS.indexOf(e.code);
  if (i >= 0) { e.preventDefault(); answer(i); }
  else if (e.code === 'Space') { e.preventDefault(); togglePause(); }
});

// ---------- timer loop ----------
let lastSec = null;
function tick() {
  if (screen !== 'play' || !game) return;
  const now = Date.now();
  if (game.phase === 'countdown') {
    if (now >= game.phaseUntil) { game.phase = 'running'; startClock(); sfx.go(); render(); return; }
    const sec = Math.ceil((game.phaseUntil - now) / 1000);
    const el = $('#countdown'); if (el) el.textContent = sec;
    if (sec !== lastSec) { lastSec = sec; sfx.count(); }
    return;
  }
  if (game.phase === 'switching') {
    if (now >= game.phaseUntil) { game.turn = 1 - game.turn; newQuestion(); game.phase = 'running'; startClock(); render(); }
    return;
  }
  if (game.phase !== 'running') return;
  const left = timeLeft(game.turn);
  if (left <= 0) return finish(game.turn);
  const el = $('#time' + game.turn);
  if (el) { el.textContent = fmt(left); el.parentElement.classList.toggle('crit', left < 10000); }
  const sec = Math.ceil(left / 1000);
  if (left <= 5000 && sec !== lastSec) { lastSec = sec; sfx.tick(); }
}
(function loop() { tick(); requestAnimationFrame(loop); })();
// the animation loop pauses in background tabs: make sure clocks still run out on time
setInterval(tick, 500);

// ---------- boot ----------
scheduleAlert();
render();
