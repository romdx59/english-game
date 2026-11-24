// Adapts a game handler to a Node (req, res) function — works on Vercel and in server.js.
const { run } = require('./game');

async function readJson(req) {
  // Vercel parses JSON bodies for us (req.body); the plain Node server does not.
  try {
    if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch { return {}; }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

module.exports = (method, name) => async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== method) {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }
  const query = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const body = method === 'POST' ? await readJson(req) : {};
  const result = await run(`${method} ${name}`, { query, body });
  res.statusCode = result.status;
  res.end(JSON.stringify(result.body));
};
