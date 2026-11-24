// English Duel — game logic, stateless (all state lives in the store).
// Used by the Vercel functions in /api and by the local scripts/dev-server.js.
const crypto = require('crypto');
const store = require('./store');
const QUESTIONS = require('../questions');

const CATEGORIES = [...new Set(QUESTIONS.map(q => q.c))];
const TTL = 6 * 3600;                 // rooms expire 6 h after their last change
const COUNTDOWN_MS = 3000;
const ALERT_MIN = Number(process.env.DUEL_MIN_MINUTES || 1);
const ALERT_MAX = Math.max(ALERT_MIN, Number(process.env.DUEL_MAX_MINUTES || 10));
const ALERT_GRACE = 10000;            // an alert stays "current" for 10 s before the next one is drawn
const DUEL_NOW_DELAY = 5000;          // > client polling interval, so every page hears about it in time

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

const key = {
  meta: (code) => `room:${code}`,
  player: (code, slot) => `room:${code}:${slot}`,
  seen: (code, slot) => `room:${code}:seen:${slot}`,
};
const cleanCode = (c) => String(c || '').trim().toUpperCase();
const other = (slot) => (slot === 'A' ? 'B' : 'A');

// ---------- global random "DUEL!" alert ----------
// The server stores the time of the next alert; every page fetches it and fires at that exact time.
async function getNextAlert() {
  const now = Date.now();
  let next = await store.get('alert:next');
  if (!next || now > next + ALERT_GRACE) {
    // draw the next one — the lock makes sure two requests don't draw different times
    const lock = await store.set(`alert:lock:${next || 0}`, 1, { ttl: 120, nx: true });
    if (lock) {
      next = now + (ALERT_MIN + Math.random() * (ALERT_MAX - ALERT_MIN)) * 60000;
      await store.set('alert:next', next);
    } else {
      next = await store.get('alert:next');
    }
  }
  return next;
}

// ---------- rooms ----------
async function loadRoom(code) {
  const [meta, A, B, seenA, seenB] = await store.mget([
    key.meta(code), key.player(code, 'A'), key.player(code, 'B'), key.seen(code, 'A'), key.seen(code, 'B'),
  ]);
  if (!meta) return null;
  return { meta, players: { A, B }, seen: { A: !!seenA, B: !!seenB } };
}
const saveMeta = (meta) => store.set(key.meta(meta.code), meta, { ttl: TTL });
const savePlayer = (code, slot, p) => store.set(key.player(code, slot), p, { ttl: TTL });

function roleOf(room, token) {
  if (!token) return null;
  if (room.meta.refToken === token) return 'ref';
  for (const s of ['A', 'B']) if (room.players[s] && room.players[s].token === token) return s;
  return null;
}

function statusOf(meta, now = Date.now()) {
  return meta.status === 'running' && now >= meta.endAt ? 'over' : meta.status;
}

function giveQuestion(meta, p) {
  const all = QUESTIONS.map((q, i) => ({ q, i })).filter(x => meta.categories.includes(x.q.c));
  let pool = all.filter(x => !p.used.includes(x.i));
  if (!pool.length) { p.used = []; pool = all; }
  const { q, i } = pool[crypto.randomInt(pool.length)];
  p.used.push(i);
  const choices = [q.a, ...q.w];
  for (let k = choices.length - 1; k > 0; k--) { const j = crypto.randomInt(k + 1); [choices[k], choices[j]] = [choices[j], choices[k]]; }
  p.q = { id: crypto.randomUUID(), c: q.c, q: q.q, choices, correct: choices.indexOf(q.a) };
}

function viewFor(room, role) {
  const { meta } = room;
  const status = statusOf(meta);
  const base = { code: meta.code, role, status, duration: meta.duration, startAt: meta.startAt, endAt: meta.endAt, serverNow: Date.now() };
  if (role === 'ref') {
    const players = {};
    for (const s of ['A', 'B']) {
      const p = room.players[s];
      players[s] = { name: p ? p.name : '', joined: !!p, online: room.seen[s] };
      if (p && status === 'over') Object.assign(players[s], { score: p.score, answered: p.answered });
    }
    return { ...base, players, categories: meta.categories, allCategories: CATEGORIES };
  }
  const p = room.players[role], opp = room.players[other(role)];
  return {
    ...base, me: { name: p.name, score: p.score, answered: p.answered },
    opponent: opp ? opp.name : null,
    question: status === 'running' && p.q ? { id: p.q.id, c: p.q.c, q: p.q.q, choices: p.q.choices } : null,
  };
}

async function loadAs(code, token) {
  const room = await loadRoom(cleanCode(code));
  if (!room) fail(404, 'Room not found — check the code');
  const role = roleOf(room, token);
  return { room, role };
}

// ---------- API handlers ----------
const handlers = {
  'GET alert': async () => ({ next: await getNextAlert(), serverNow: Date.now() }),

  // "Duel now" button: every page fires the alert a few seconds from now, all at the same moment
  'POST duel-now': async () => {
    const next = Date.now() + DUEL_NOW_DELAY;
    await store.set('alert:next', next);
    return { next, serverNow: Date.now() };
  },

  'GET categories': async () => ({ categories: CATEGORIES }),

  'POST create': async ({ body }) => {
    const token = String(body.token || '');
    if (!token) fail(400, 'Missing token');
    const seconds = Math.round(Number(body.seconds ?? 60));
    if (!(seconds >= 10 && seconds <= 900)) fail(400, 'Duration must be 10–900 seconds');
    const categories = (Array.isArray(body.categories) ? body.categories : CATEGORIES).filter(c => CATEGORIES.includes(c));
    if (!categories.length) fail(400, 'Pick at least one category');
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
      const meta = { code, refToken: token, status: 'lobby', duration: seconds * 1000, categories, startAt: 0, endAt: 0 };
      if (await store.set(key.meta(code), meta, { ttl: TTL, nx: true })) return { code };
    }
    fail(500, 'Could not create a room, try again');
  },

  'POST join': async ({ body }) => {
    const token = String(body.token || '');
    if (!token) fail(400, 'Missing token');
    const { room, role } = await loadAs(body.code, token);
    if (role) return { code: room.meta.code, role };
    if (body.check) fail(403, 'Not in this room');
    const name = String(body.name || '').trim().slice(0, 20);
    if (!name) fail(400, 'Enter your name');
    if (statusOf(room.meta) !== 'lobby') fail(409, 'The duel has already started');
    for (const slot of ['A', 'B']) {
      const opp = room.players[other(slot)];
      if (opp && opp.name.toLowerCase() === name.toLowerCase()) fail(400, 'This name is already taken in the room');
      const player = { name, token, score: 0, answered: 0, q: null, used: [] };
      if (await store.set(key.player(room.meta.code, slot), player, { ttl: TTL, nx: true })) {
        return { code: room.meta.code, role: slot };
      }
    }
    fail(409, 'This room is already full');
  },

  // Polled by every page in a room. `ping` marks a player as online for a few seconds.
  'GET state': async ({ query }) => {
    const { room, role } = await loadAs(query.code, query.token);
    if (!role) fail(403, 'You are not in this room');
    if (query.ping && role !== 'ref') {
      await store.set(key.seen(room.meta.code, role), 1, { ttl: 8 });
      room.seen[role] = true;
    }
    return viewFor(room, role);
  },

  'POST answer': async ({ body }) => {
    const { room, role } = await loadAs(body.code, body.token);
    if (role !== 'A' && role !== 'B') fail(403, 'Not a player');
    const now = Date.now();
    if (statusOf(room.meta, now) !== 'running' || now < room.meta.startAt) fail(400, 'Not running');
    const p = room.players[role];
    if (!p.q || body.id !== p.q.id) fail(409, 'Question already answered');
    const correct = p.q.correct;
    const ok = Number(body.choice) === correct;
    p.answered++;
    if (ok) p.score++;
    giveQuestion(room.meta, p);
    await savePlayer(room.meta.code, role, p);
    return { ok, correct, state: viewFor(room, role) };
  },

  'POST action': async ({ body }) => {
    const { room, role } = await loadAs(body.code, body.token);
    if (role !== 'ref') fail(403, 'Only the referee can do that');
    const { meta, players } = room;
    const status = statusOf(meta);
    switch (body.action) {
      case 'start': {
        if (status !== 'lobby') fail(400, 'Already started');
        if (!players.A || !players.B) fail(400, 'Both players must join first');
        meta.status = 'running';
        meta.startAt = Date.now() + COUNTDOWN_MS;
        meta.endAt = meta.startAt + meta.duration;
        for (const s of ['A', 'B']) {
          Object.assign(players[s], { score: 0, answered: 0, used: [] });
          giveQuestion(meta, players[s]);
        }
        await Promise.all([savePlayer(meta.code, 'A', players.A), savePlayer(meta.code, 'B', players.B)]);
        await saveMeta(meta);
        break;
      }
      case 'cancel':   // stop a duel in progress
      case 'rematch': { // after a duel: same players, back to the lobby
        meta.status = 'lobby'; meta.startAt = meta.endAt = 0;
        await saveMeta(meta);
        await Promise.all(['A', 'B'].filter(s => players[s]).map(s =>
          savePlayer(meta.code, s, Object.assign(players[s], { score: 0, answered: 0, q: null }))));
        break;
      }
      case 'kick': {
        if (status === 'running') fail(400, 'Not during a duel');
        await store.del(key.player(meta.code, body.slot === 'B' ? 'B' : 'A'));
        break;
      }
      default: fail(400, 'Unknown action');
    }
    return { ok: true, state: viewFor(await loadRoom(meta.code), 'ref') };
  },
};

// Runs a handler and turns errors into { status, body }
async function run(name, { query = {}, body = {} } = {}) {
  const h = handlers[name];
  if (!h) return { status: 404, body: { error: 'Not found' } };
  try {
    return { status: 200, body: await h({ query, body }) };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
    if (e instanceof store.ConfigError) return { status: 503, body: { error: e.message } };
    console.error(e);
    return { status: 500, body: { error: 'Server error' } };
  }
}

module.exports = { run, handlers };
