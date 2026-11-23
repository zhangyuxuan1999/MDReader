// bench/verify/v8-vw-files.mjs — verify-web (0.2.0 stage 3, post-release check of the deployed page).
// Checks: every file under dist/ is served by the deployed page at the same path with the same bytes (sha1);
// / serves index.html as text/html; scripts carry a JavaScript type; fonts a font type; prints cache-control of
// index.html and of one hashed asset. One GET per file (plus / ), sequential, nothing else.
// Run: cd /Users/zyx/LocalDocuments/MDReader && node bench/verify/v8-vw-files.mjs [baseUrl] > out.json
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const BASE = process.argv[2] ?? 'https://mdreader.cashbook2026.workers.dev';
const DIST = new URL('../../dist/', import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const sha1 = (b) => createHash('sha1').update(b).digest('hex');
const files = walk(DIST).map((p) => relative(DIST, p)).sort();
const out = { base: BASE, count: files.length, ok: 0, mismatches: [], typeProblems: [], types: {}, headers: {} };
const isScript = (f) => /\.m?js$/.test(f), isFont = (f) => /\.(woff2?|ttf|otf)$/.test(f);
async function get(path) {
  const r = await fetch(BASE + '/' + path, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const b = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get('content-type'), cc: r.headers.get('cache-control'), h: r.headers, b };
}
for (const f of files) {
  let r;
  try { r = await get(f.split('/').map(encodeURIComponent).join('/')); } catch (e) { out.mismatches.push({ f, err: String(e) }); continue; }
  const local = readFileSync(join(DIST, f));
  if (r.status !== 200 || sha1(r.b) !== sha1(local)) out.mismatches.push({ f, status: r.status, served: sha1(r.b), local: sha1(local), servedLen: r.b.length, localLen: local.length });
  else out.ok++;
  const ext = f.split('.').pop();
  (out.types[ext] ??= new Set()).add(r.type);
  if (isScript(f) && !/javascript/i.test(r.type ?? '')) out.typeProblems.push({ f, type: r.type });
  if (isFont(f) && !/^font\//i.test(r.type ?? '')) out.typeProblems.push({ f, type: r.type });
  if (f === 'index.html') out.headers['index.html'] = { cc: r.cc, type: r.type };
  if (f.startsWith('assets/index-') && f.endsWith('.js')) out.headers[f] = { cc: r.cc, type: r.type, etag: r.h.get('etag') ? 'present' : null };
}
const root = await get('');
out.root = { status: root.status, type: root.type, cc: root.cc, sameAsIndexHtml: sha1(root.b) === sha1(readFileSync(join(DIST, 'index.html'))) };
if (!/^text\/html/i.test(root.type ?? '')) out.typeProblems.push({ f: '/', type: root.type });
for (const k of Object.keys(out.types)) out.types[k] = [...out.types[k]];
console.log(JSON.stringify(out, null, 1));
