// Tiny key-value store.
// - On Vercel: Upstash Redis through its REST API (no dependency needed).
// - Locally without Redis credentials: an in-memory Map (fine for `npm start`).
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const useRedis = Boolean(REDIS_URL && REDIS_TOKEN);

class ConfigError extends Error {}

async function redis(...args) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const j = await r.json().catch(() => ({ error: `Redis HTTP ${r.status}` }));
  if (j.error) throw new Error(`Redis: ${j.error}`);
  return j.result;
}

// ---- in-memory fallback ----
const mem = new Map();
const memGet = (k) => {
  const e = mem.get(k);
  if (!e) return null;
  if (e.exp && e.exp < Date.now()) { mem.delete(k); return null; }
  return e.v;
};

function ensureConfigured() {
  // On Vercel every request may hit a different instance, so memory can't be shared.
  if (!useRedis && process.env.VERCEL) {
    throw new ConfigError('Database not configured: add Upstash Redis to this Vercel project (Storage tab), then redeploy.');
  }
}

const parse = (s) => (s == null ? null : JSON.parse(s));

module.exports = {
  ConfigError,

  async get(key) {
    ensureConfigured();
    return parse(useRedis ? await redis('GET', key) : memGet(key));
  },

  async mget(keys) {
    ensureConfigured();
    const raw = useRedis ? await redis('MGET', ...keys) : keys.map(memGet);
    return raw.map(parse);
  },

  // Returns true if the value was written (false when nx is set and the key already exists)
  async set(key, value, { ttl, nx } = {}) {
    ensureConfigured();
    const s = JSON.stringify(value);
    if (useRedis) {
      const args = ['SET', key, s];
      if (ttl) args.push('EX', String(ttl));
      if (nx) args.push('NX');
      return (await redis(...args)) === 'OK';
    }
    if (nx && memGet(key) != null) return false;
    mem.set(key, { v: s, exp: ttl ? Date.now() + ttl * 1000 : 0 });
    return true;
  },

  async del(key) {
    ensureConfigured();
    if (useRedis) await redis('DEL', key);
    else mem.delete(key);
  },
};
