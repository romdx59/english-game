// English Duel — zero-dependency Node server (HTTP + Server-Sent Events)
//  - a "DUEL!" alert is sent to every open page at the same random moment
//  - the referee creates a room, two players join with its code
//  - shared timer, each player answers their own multiple-choice questions
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QUESTIONS = require('./questions');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
// Random "DUEL!" alert window, in minutes (override with env vars)
const ALERT_MIN = Number(process.env.DUEL_MIN_MINUTES || 1);
const ALERT_MAX = Math.max(ALERT_MIN, Number(process.env.DUEL_MAX_MINUTES || 10));
const COUNTDOWN_MS = 3000;

const CATEGORIES = [...new Set(QUESTIONS.map(q => q.c))];
const rooms = new Map();
const watchers = new Set();   // pages listening for the global "DUEL!" alert
let nextAlertAt = 0, alertTimer = null;

// ---------- global random alert ----------
function scheduleAlert() {
  clearTimeout(alertTimer);
  const delay = (ALERT_MIN + Math.random() * (ALERT_MAX - ALERT_MIN)) * 60000;
  nextAlertAt = Date.now() + delay;
  alertTimer = setTimeout(fireAlert, delay);
}
function fireAlert() {
  const msg = `data: ${JSON.stringify({ type: 'duel', at: Date.now() })}\n\n`;
  for (const res of watchers) res.write(msg);
  scheduleAlert();
}
scheduleAlert();

// ---------- helpers ----------
const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  while (rooms.has(code));
  return code;
}

function newPlayer() { return { name: '', token: null, score: 0, answered: 0, conns: 0, q: null, used: new Set() }; }

function giveQuestion(room, p) {
  const all = QUESTIONS.map((q, i) => ({ q, i })).filter(x => room.categories.includes(x.q.c));
  let pool = all.filter(x => !p.used.has(x.i));
  if (!pool.length) { p.used.clear(); pool = all; }
  const { q, i } = pool[crypto.randomInt(pool.length)];
  p.used.add(i);
  const choices = shuffle([q.a, ...q.w]);
  p.q = { id: crypto.randomUUID(), c: q.c, q: q.q, choices, correct: choices.indexOf(q.a) };
}

function roleOf(room, token) {
  if (room.refToken === token) return 'ref';
  if (room.players.A.token === token) return 'A';
  if (room.players.B.token === token) return 'B';
  return null;
}

function viewFor(room, token) {
  const role = roleOf(room, token);
  const base = {
    code: room.code, role, status: room.status, duration: room.duration,
    startAt: room.startAt, endAt: room.endAt, serverNow: Date.now(),
  };
  if (role === 'ref') {
    const players = {};
    for (const s of ['A', 'B']) {
      const p = room.players[s];
      players[s] = { name: p.name, joined: !!p.token, online: p.conns > 0 };
      if (room.status === 'over') Object.assign(players[s], { score: p.score, answered: p.answered });
    }
    return { ...base, players, categories: room.categories, allCategories: CATEGORIES };
  }
  if (role === 'A' || role === 'B') {
    const p = room.players[role];
    const opp = room.players[role === 'A' ? 'B' : 'A'];
    return {
      ...base, me: { name: p.name, score: p.score, answered: p.answered },
      opponent: opp.token ? opp.name : null,
      question: room.status === 'running' && p.q ? { id: p.q.id, c: p.q.c, q: p.q.q, choices: p.q.choices } : null,
    };
  }
  return { ...base, role: null };
}

function broadcast(room) {
  room.touched = Date.now();
  for (const c of room.clients) c.res.write(`data: ${JSON.stringify({ type: 'room', state: viewFor(room, c.token) })}\n\n`);
}

// ---------- HTTP ----------
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}
const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const sse = (res) => res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const routes = {
  // One stream per page: always receives the global "DUEL!" alert,
  // and the room state too when `code` is given (keeps browsers under their connection limit).
  'GET /api/stream': (req, res, url) => {
    sse(res); watchers.add(res);
    const token = url.searchParams.get('token') || '';
    const code = String(url.searchParams.get('code') || '').toUpperCase();
    const room = code ? rooms.get(code) : null;
    let client = null;
    if (code && (!room || !roleOf(room, token))) {
      res.write(`data: ${JSON.stringify({ type: 'noroom' })}\n\n`);
    } else if (room) {
      client = { res, token };
      room.clients.add(client);
      const role = roleOf(room, token);
      if (role !== 'ref') room.players[role].conns++;
      broadcast(room);
    }
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping); watchers.delete(res);
      if (!client) return;
      room.clients.delete(client);
      const r = roleOf(room, token);
      if (r === 'A' || r === 'B') room.players[r].conns = Math.max(0, room.players[r].conns - 1);
      broadcast(room);
    });
  },

  // Manual trigger ("Duel now" button) — fires the alert on every page
  'POST /api/duel-now': (req, res) => { fireAlert(); json(res, 200, { ok: true }); },

  'GET /api/categories': (req, res) => json(res, 200, { categories: CATEGORIES }),

  'POST /api/create': async (req, res) => {
    const body = await readBody(req);
    if (!body.token) return json(res, 400, { error: 'Missing token' });
    const code = newCode();
    rooms.set(code, {
      code, refToken: String(body.token), status: 'lobby', duration: 60000, startAt: 0, endAt: 0,
      categories: [...CATEGORIES], clients: new Set(), touched: Date.now(),
      players: { A: newPlayer(), B: newPlayer() },
    });
    json(res, 200, { code });
  },

  'POST /api/join': async (req, res) => {
    const body = await readBody(req);
    const room = rooms.get(String(body.code || '').trim().toUpperCase());
    if (!room) return json(res, 404, { error: 'Room not found — check the code' });
    const token = String(body.token || '');
    if (!token) return json(res, 400, { error: 'Missing token' });
    if (roleOf(room, token)) return json(res, 200, { code: room.code, role: roleOf(room, token) });
    if (body.check) return json(res, 403, { error: 'Not in this room' });
    const name = String(body.name || '').trim().slice(0, 20);
    if (!name) return json(res, 400, { error: 'Enter your name' });
    const slot = !room.players.A.token ? 'A' : !room.players.B.token ? 'B' : null;
    if (!slot) return json(res, 409, { error: 'This room is already full' });
    const other = room.players[slot === 'A' ? 'B' : 'A'];
    if (other.token && other.name.toLowerCase() === name.toLowerCase()) return json(res, 400, { error: 'This name is already taken in the room' });
    Object.assign(room.players[slot], { token, name });
    broadcast(room);
    json(res, 200, { code: room.code, role: slot });
  },

  // Player answers their current question
  'POST /api/answer': async (req, res) => {
    const body = await readBody(req);
    const room = rooms.get(String(body.code || '').toUpperCase());
    if (!room) return json(res, 404, { error: 'Room not found' });
    const role = roleOf(room, body.token);
    if (role !== 'A' && role !== 'B') return json(res, 403, { error: 'Not a player' });
    const now = Date.now();
    if (room.status !== 'running' || now < room.startAt || now >= room.endAt) return json(res, 400, { error: 'Not running' });
    const p = room.players[role];
    if (!p.q || body.id !== p.q.id) return json(res, 409, { error: 'Question already answered' });
    const correctIndex = p.q.correct;
    const ok = Number(body.choice) === correctIndex;
    p.answered++;
    if (ok) p.score++;
    giveQuestion(room, p);
    broadcast(room);
    json(res, 200, { ok, correct: correctIndex, score: p.score });
  },

  // Referee actions
  'POST /api/action': async (req, res) => {
    const body = await readBody(req);
    const room = rooms.get(String(body.code || '').toUpperCase());
    if (!room) return json(res, 404, { error: 'Room not found' });
    if (room.refToken !== body.token) return json(res, 403, { error: 'Only the referee can do that' });
    const err = refAction(room, body);
    broadcast(room);
    err ? json(res, 400, { error: err }) : json(res, 200, { ok: true });
  },
};

function refAction(room, body) {
  switch (body.action) {
    case 'settings': {
      if (room.status !== 'lobby') return 'Only before the duel';
      if (body.seconds !== undefined) {
        const sec = Math.round(Number(body.seconds));
        if (!(sec >= 10 && sec <= 900)) return 'Duration must be 10–900 seconds';
        room.duration = sec * 1000;
      }
      if (body.categories !== undefined) {
        const cats = (Array.isArray(body.categories) ? body.categories : []).filter(c => CATEGORIES.includes(c));
        if (!cats.length) return 'Pick at least one category';
        room.categories = cats;
      }
      return;
    }
    case 'start': {
      if (room.status !== 'lobby') return 'Already started';
      if (!room.players.A.token || !room.players.B.token) return 'Both players must join first';
      room.startAt = Date.now() + COUNTDOWN_MS;
      room.endAt = room.startAt + room.duration;
      room.status = 'running';
      for (const s of ['A', 'B']) {
        const p = room.players[s];
        p.score = 0; p.answered = 0; p.used.clear();
        giveQuestion(room, p);
      }
      return;
    }
    case 'cancel':   // stop a duel in progress, back to the lobby
    case 'rematch':  // after a duel: same players, back to the lobby
      room.status = 'lobby'; room.startAt = room.endAt = 0;
      for (const s of ['A', 'B']) { room.players[s].score = 0; room.players[s].answered = 0; room.players[s].q = null; }
      return;
    case 'kick': {
      if (room.status === 'running') return 'Not during a duel';
      const s = body.slot === 'B' ? 'B' : 'A';
      room.players[s] = newPlayer();
      return;
    }
    default: return 'Unknown action';
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = routes[`${req.method} ${url.pathname}`];
  if (route) return route(req, res, url);

  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const full = path.resolve(PUBLIC, file);
  if (!full.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

// End duels when the shared timer runs out + clean up old rooms
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.status === 'running' && now >= room.endAt) {
      room.status = 'over';
      for (const s of ['A', 'B']) room.players[s].q = null;
      broadcast(room);
    }
    if (room.clients.size === 0 && now - room.touched > 3 * 3600 * 1000) rooms.delete(room.code);
  }
}, 100);

server.listen(PORT, () => console.log(`English Duel running on http://localhost:${PORT} (random duel alert every ${ALERT_MIN}–${ALERT_MAX} min)`));
