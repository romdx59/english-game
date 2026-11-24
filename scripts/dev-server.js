// English Duel — local dev server (npm start). Not used on Vercel.
// Serves /public and the same /api functions that Vercel runs.
// Without Redis credentials, game state is kept in memory (fine for local play).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const API = path.join(ROOT, 'api');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// /api/<name> -> api/<name>.js
const api = Object.fromEntries(fs.readdirSync(API).filter(f => f.endsWith('.js'))
  .map(f => [path.basename(f, '.js'), require(path.join(API, f))]));

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/api\/([\w-]+)$/);
  if (m) {
    if (api[m[1]]) return api[m[1]](req, res);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end('{"error":"Not found"}');
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const full = path.resolve(PUBLIC, file);
  if (!full.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  const redis = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  console.log(`English Duel running on http://localhost:${PORT} (state: ${redis ? 'Upstash Redis' : 'in memory'})`);
});
