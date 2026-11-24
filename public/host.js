// English Duel — the referee's browser is the game "server".
// Players connect straight to it with PeerJS (WebRTC); no database, no backend.
const PEER_PREFIX = 'english-duel-v1-';       // room code ABCD -> peer id "english-duel-v1-ABCD"
const COUNTDOWN_MS = 3000;
const CATEGORIES = [...new Set(QUESTIONS.map(q => q.c))];
const HOST_SAVE_KEY = 'duelHostRoom';

const randInt = (n) => Math.floor(Math.random() * n);
const otherSlot = (s) => (s === 'A' ? 'B' : 'A');

class Host {
  constructor(onChange) {
    this.onChange = onChange;   // called with the referee's view after every change
    this.room = null;
    this.peer = null;
    this.conns = { A: null, B: null };   // open data connection of each player
    this.endTimer = null;
  }

  // ---------- opening the room ----------
  // Registers the peer id for this code on the PeerJS broker. Fails if the id is taken.
  openPeer(code) {
    return new Promise((resolve, reject) => {
      const peer = new Peer(PEER_PREFIX + code);
      let settled = false;
      peer.on('open', () => { settled = true; resolve(peer); });
      peer.on('error', (e) => {
        if (!settled) { settled = true; peer.destroy(); reject(e); }
        else console.warn('Peer error', e);
      });
    });
  }

  attach(peer) {
    this.peer = peer;
    peer.on('connection', (conn) => this.handleConnection(conn));
    // lost the broker (network blip): keep existing player connections, just re-register
    peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1000); });
  }

  async create(seconds, categories) {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = Array.from({ length: 4 }, () => letters[randInt(letters.length)]).join('');
      try {
        this.attach(await this.openPeer(code));
      } catch (e) {
        if (e.type === 'unavailable-id') continue;    // code already used somewhere: pick another
        throw new Error(netError(e));
      }
      this.room = { code, status: 'lobby', duration: seconds * 1000, categories, startAt: 0, endAt: 0, players: { A: null, B: null } };
      this.changed();
      return code;
    }
    throw new Error('Could not create a room, try again');
  }

  // After a reload of the referee's page: reopen the same room (players reconnect by themselves)
  async restore() {
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(HOST_SAVE_KEY)); } catch {}
    if (!saved) return false;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        this.attach(await this.openPeer(saved.code));
        this.room = saved;
        this.scheduleEnd();
        this.changed();
        return true;
      } catch (e) {
        // the broker may still hold our old id for a few seconds after the reload
        if (e.type !== 'unavailable-id') break;
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    sessionStorage.removeItem(HOST_SAVE_KEY);
    return false;
  }

  // ---------- state ----------
  status(now = Date.now()) {
    const r = this.room;
    return r.status === 'running' && now >= r.endAt ? 'over' : r.status;
  }

  viewFor(role) {
    const r = this.room, status = this.status();
    const base = { code: r.code, role, status, duration: r.duration, startAt: r.startAt, endAt: r.endAt, hostNow: Date.now() };
    if (role === 'ref') {
      const players = {};
      for (const s of ['A', 'B']) {
        const p = r.players[s];
        players[s] = { name: p ? p.name : '', joined: !!p, online: !!(this.conns[s] && this.conns[s].open) };
        if (p && status === 'over') Object.assign(players[s], { score: p.score, answered: p.answered });
      }
      return { ...base, players, categories: r.categories, allCategories: CATEGORIES };
    }
    const p = r.players[role], opp = r.players[otherSlot(role)];
    return {
      ...base, me: { name: p.name, score: p.score, answered: p.answered },
      opponent: opp ? opp.name : null,
      question: status === 'running' && p.q ? { id: p.q.id, c: p.q.c, q: p.q.q, choices: p.q.choices } : null,
    };
  }

  changed() {
    try { sessionStorage.setItem(HOST_SAVE_KEY, JSON.stringify(this.room)); } catch {}
    for (const s of ['A', 'B']) {
      if (this.room.players[s]) this.send(s, { t: 'state', state: this.viewFor(s) });
    }
    this.onChange(this.viewFor('ref'));
  }

  send(slot, msg) {
    const c = this.conns[slot];
    if (c && c.open) { try { c.send(msg); } catch {} }
  }

  giveQuestion(p) {
    const all = QUESTIONS.map((q, i) => ({ q, i })).filter(x => this.room.categories.includes(x.q.c));
    let pool = all.filter(x => !p.used.includes(x.i));
    if (!pool.length) { p.used = []; pool = all; }
    const { q, i } = pool[randInt(pool.length)];
    p.used.push(i);
    const choices = [q.a, ...q.w];
    for (let k = choices.length - 1; k > 0; k--) { const j = randInt(k + 1); [choices[k], choices[j]] = [choices[j], choices[k]]; }
    p.q = { id: crypto.randomUUID(), c: q.c, q: q.q, choices, correct: choices.indexOf(q.a) };
  }

  scheduleEnd() {
    clearTimeout(this.endTimer);
    if (this.room.status === 'running') {
      this.endTimer = setTimeout(() => this.changed(), Math.max(0, this.room.endAt - Date.now()) + 50);
    }
  }

  // ---------- players ----------
  handleConnection(conn) {
    let slot = null;
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'hello') slot = this.onHello(conn, msg);
      else if (slot && msg.t === 'answer') this.onAnswer(slot, msg);
      else if (slot && msg.t === 'leave') this.onLeave(slot);
    });
    conn.on('close', () => {
      if (slot && this.conns[slot] === conn) { this.conns[slot] = null; this.changed(); }
    });
  }

  onHello(conn, msg) {
    const r = this.room;
    const token = String(msg.token || '');
    const reject = (error) => { try { conn.send({ t: 'error', error }); } catch {} setTimeout(() => conn.close(), 300); return null; };
    // coming back (reload, network blip)
    const known = ['A', 'B'].find(s => r.players[s] && r.players[s].token === token);
    if (known) {
      if (this.conns[known] && this.conns[known] !== conn) this.conns[known].close();
      this.conns[known] = conn;
      conn.send({ t: 'joined', slot: known });
      this.changed();
      return known;
    }
    if (msg.rejoin) return reject('You are no longer in this room');
    const name = String(msg.name || '').trim().slice(0, 20);
    if (!name) return reject('Enter your name');
    if (this.status() !== 'lobby') return reject('The duel has already started');
    const slot = !r.players.A ? 'A' : !r.players.B ? 'B' : null;
    if (!slot) return reject('This room is already full');
    const opp = r.players[otherSlot(slot)];
    if (opp && opp.name.toLowerCase() === name.toLowerCase()) return reject('This name is already taken in the room');
    r.players[slot] = { name, token, score: 0, answered: 0, q: null, used: [] };
    this.conns[slot] = conn;
    conn.send({ t: 'joined', slot });
    this.changed();
    return slot;
  }

  onAnswer(slot, msg) {
    const r = this.room, p = r.players[slot], now = Date.now();
    if (!p) return;
    if (this.status(now) !== 'running' || now < r.startAt) return this.send(slot, { t: 'result', id: msg.id, error: 'Not running' });
    if (!p.q || msg.id !== p.q.id) return this.send(slot, { t: 'result', id: msg.id, error: 'Question already answered' });
    const correct = p.q.correct, ok = Number(msg.choice) === correct;
    p.answered++;
    if (ok) p.score++;
    this.giveQuestion(p);
    this.send(slot, { t: 'result', id: msg.id, ok, correct, state: this.viewFor(slot) });
    try { sessionStorage.setItem(HOST_SAVE_KEY, JSON.stringify(this.room)); } catch {}
  }

  onLeave(slot) {
    if (this.status() === 'running') return;
    this.room.players[slot] = null;
    const c = this.conns[slot];
    this.conns[slot] = null;
    if (c) setTimeout(() => c.close(), 300);
    this.changed();
  }

  // ---------- referee actions ----------
  action(name, extra = {}) {
    const r = this.room, status = this.status();
    switch (name) {
      case 'start':
        if (status !== 'lobby') throw new Error('Already started');
        if (!r.players.A || !r.players.B) throw new Error('Both players must join first');
        r.status = 'running';
        r.startAt = Date.now() + COUNTDOWN_MS;
        r.endAt = r.startAt + r.duration;
        for (const s of ['A', 'B']) { Object.assign(r.players[s], { score: 0, answered: 0, used: [] }); this.giveQuestion(r.players[s]); }
        break;
      case 'cancel':
      case 'rematch':
        r.status = 'lobby'; r.startAt = r.endAt = 0;
        for (const s of ['A', 'B']) if (r.players[s]) Object.assign(r.players[s], { score: 0, answered: 0, q: null });
        break;
      case 'kick': {
        if (status === 'running') throw new Error('Not during a duel');
        const s = extra.slot === 'B' ? 'B' : 'A';
        this.send(s, { t: 'kicked' });
        const c = this.conns[s];
        if (c) setTimeout(() => c.close(), 300);
        this.conns[s] = null; r.players[s] = null;
        break;
      }
      default: throw new Error('Unknown action');
    }
    this.scheduleEnd();
    this.changed();
  }

  // Closes the room for everyone
  close() {
    clearTimeout(this.endTimer);
    for (const s of ['A', 'B']) this.send(s, { t: 'closed' });
    try { sessionStorage.removeItem(HOST_SAVE_KEY); } catch {}
    const peer = this.peer;
    this.peer = null; this.room = null;
    if (peer) setTimeout(() => peer.destroy(), 400);   // give the "closed" messages time to leave
  }
}

// Human-readable PeerJS errors
function netError(e) {
  switch (e && e.type) {
    case 'peer-unavailable': return 'Room not found — check the code';
    case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
      return 'Cannot reach the connection service — check your internet connection';
    case 'browser-incompatible': return 'This browser does not support direct connections (WebRTC)';
    default: return 'Connection problem' + (e && e.type ? ` (${e.type})` : '');
  }
}
