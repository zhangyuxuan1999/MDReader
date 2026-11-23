// bench/verify/r4-int-perfserve.mjs — integrate (round 4): a static server for a BUILT dist that sends a request for
// "/" without perf=1 to "/?perf=1…" (fix2-int-p5.mjs's warm-up opens the bare origin and waits for the test hooks, which
// a production build installs only with ?perf=1). Serves files only from the given directory.
//   node bench/verify/r4-int-perfserve.mjs <dist-dir> <port>
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2]);
const port = Number(process.argv[3]);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.txt': 'text/plain' };
createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${port}`);
    if ((u.pathname === '/' || u.pathname === '/index.html') && !u.searchParams.has('perf')) {
      u.searchParams.set('perf', '1');
      res.writeHead(302, { Location: u.pathname + u.search }); res.end(); return;
    }
    let p = normalize(join(root, decodeURIComponent(u.pathname)));
    if (!p.startsWith(root)) { res.writeHead(403); res.end(); return; }
    if ((await stat(p).catch(() => null))?.isDirectory()) p = join(p, 'index.html');
    const body = await readFile(p);
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(port);
