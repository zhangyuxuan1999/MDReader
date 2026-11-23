// bench/verify/v5-cfm-perfserve.mjs — confirm (0.2.0 r4): r4-int-perfserve.mjs plus an optional switch-OFF prelude.
// A static server for a BUILT dist: a request for "/" without perf=1 is sent to "/?perf=1…" (fix2-int-p5.mjs opens
// the bare origin and waits for the test hooks). With "off" as third argument, index.html gets one extra classic
// script, served by this server as /__cfm_off.js, that stores mdr.previewEdit = "0" before the app starts (the
// shipped configuration measured with the hooks installed). Serves files only from the given directory.
//   node bench/verify/v5-cfm-perfserve.mjs <dist-dir> <port> [off]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2]);
const port = Number(process.argv[3]);
const off = process.argv[4] === 'off';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.txt': 'text/plain' };
createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${port}`);
    if ((u.pathname === '/' || u.pathname === '/index.html') && !u.searchParams.has('perf')) {
      u.searchParams.set('perf', '1');
      res.writeHead(302, { Location: u.pathname + u.search }); res.end(); return;
    }
    if (u.pathname === '/__cfm_off.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end("try { localStorage.setItem('mdr.previewEdit', '0'); } catch (e) { /* private mode */ }\n");
      return;
    }
    let p = normalize(join(root, decodeURIComponent(u.pathname)));
    if (!p.startsWith(root)) { res.writeHead(403); res.end(); return; }
    if ((await stat(p).catch(() => null))?.isDirectory()) p = join(p, 'index.html');
    let body = await readFile(p);
    if (off && p.endsWith('index.html')) body = Buffer.from(body.toString('utf8').replace('<head>', '<head>\n    <script src="./__cfm_off.js"></script>'));
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(port);
