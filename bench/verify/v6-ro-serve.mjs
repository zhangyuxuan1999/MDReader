// bench/verify/v6-ro-serve.mjs — regress-off (stage 2f, round 5): a static server for a BUILT dist that logs every
// request for the lazy editing chunk (inlineEdit-*.js), so that a whole run of switch-off scripts on the production
// build can be checked for "the editing chunk is never requested" (rule L6).
//   node bench/verify/v6-ro-serve.mjs <dist-dir> <port> <log-file> [--perf]
// --perf: a request for "/" or "/index.html" without a perf parameter is redirected to the same URL with perf=1
// (as bench/verify/r4-int-perfserve.mjs does), for scripts that open the candidate without adding it.
// Without --perf the build is served as a real user gets it. Unknown paths without an extension get index.html
// (as vite preview does). Each chunk request appends one JSON line {t, iso, path, referer, ua} to <log-file>.
// Serves files only from <dist-dir>; writes only <log-file>.
import { createServer } from 'node:http';
import { readFile, stat, appendFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2]);
const port = Number(process.argv[3]);
const logFile = process.argv[4];
const perf = process.argv.includes('--perf');
if (!root || !port || !logFile) { console.error('usage: v6-ro-serve.mjs <dist> <port> <log> [--perf]'); process.exit(2); }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.txt': 'text/plain', '.md': 'text/markdown; charset=utf-8', '.webmanifest': 'application/manifest+json' };
let total = 0;
createServer(async (req, res) => {
  total++;
  try {
    const u = new URL(req.url, `http://localhost:${port}`);
    if (/inlineEdit-[^/]*\.js$/.test(u.pathname)) {
      const now = Date.now();
      await appendFile(logFile, JSON.stringify({ t: now, iso: new Date(now).toISOString(), path: u.pathname, referer: req.headers.referer || '', ua: (req.headers['user-agent'] || '').slice(0, 40) }) + '\n');
    }
    if (perf && (u.pathname === '/' || u.pathname === '/index.html') && !u.searchParams.has('perf')) {
      u.searchParams.set('perf', '1');
      res.writeHead(302, { Location: u.pathname + u.search }); res.end(); return;
    }
    let p = normalize(join(root, decodeURIComponent(u.pathname)));
    if (!p.startsWith(root)) { res.writeHead(403); res.end(); return; }
    let st = await stat(p).catch(() => null);
    if (st?.isDirectory()) { p = join(p, 'index.html'); st = await stat(p).catch(() => null); }
    if (!st && !extname(p)) p = join(root, 'index.html');
    const body = await readFile(p);
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(port, () => console.log(`v6-ro-serve ${root} on ${port}${perf ? ' (perf redirect)' : ''}, log ${logFile}`));
