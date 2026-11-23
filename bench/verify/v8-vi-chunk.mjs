// v8-vi-chunk.mjs — verify-installed (0.2.0 release, stage 3), read-only.
// Checks, in a dist/ directory (e.g. one extracted from the installed app.asar):
//   1. index.html names no inlineEdit chunk (no <script src>, no modulepreload, no mention at all);
//   2. the main entry script(s) referenced by index.html mention the inlineEdit chunk only inside
//      a dynamic import(...) (directly, or through Vite's __vitePreload / deps map);
//   3. the chunk file assets/inlineEdit-*.js exists.
// Run: node bench/verify/v8-vi-chunk.mjs <path-to-dist>
// Prints a JSON summary; exit code 0 when all three hold, 1 otherwise. Changes nothing.
import fs from 'node:fs';
import path from 'node:path';

const dist = process.argv[2];
if (!dist) { console.error('usage: node v8-vi-chunk.mjs <dist-dir>'); process.exit(2); }
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const assets = fs.readdirSync(path.join(dist, 'assets'));
const chunks = assets.filter((f) => /^inlineEdit-.*\.js$/.test(f));
const htmlMentions = (html.match(/inlineEdit/g) || []).length;
const scriptSrcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
const preloads = [...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
const out = { dist, chunks, htmlMentions, scriptSrcs, preloads, mains: [] };
let ok = chunks.length === 1 && htmlMentions === 0;
for (const src of scriptSrcs) {
  const p = path.join(dist, src.replace(/^\.?\//, ''));
  if (!fs.existsSync(p)) { out.mains.push({ src, missing: true }); ok = false; continue; }
  const js = fs.readFileSync(p, 'utf8');
  const occ = [];
  let i = -1;
  while ((i = js.indexOf('inlineEdit-', i + 1)) !== -1) {
    const ctx = js.slice(Math.max(0, i - 160), i + 60);
    const dyn = /import\(/.test(ctx) || /__vitePreload|__vite__mapDeps|m\.f\|\|/.test(ctx);
    // a static import would look like: import ... from "./inlineEdit-xxx.js"  or  import "./inlineEdit-xxx.js"
    const stat = /(^|[;\n}])\s*import\s*(?:[\w*{}\s,$]+from\s*)?["'][^"']*$/.test(js.slice(Math.max(0, i - 160), i));
    occ.push({ at: i, dynamicContext: dyn, staticImport: stat, context: ctx.replace(/\s+/g, ' ') });
    if (!dyn || stat) ok = false;
  }
  out.mains.push({ src, occurrences: occ.length, occ });
}
// the chunk must be named somewhere in the entry scripts (as a dynamic import), at least once in total
if (out.mains.reduce((n, m) => n + (m.occurrences || 0), 0) === 0) ok = false;
// modulepreloaded files must not name the chunk statically either
out.preloadMentions = preloads.map((h) => {
  const p = path.join(dist, h.replace(/^\.?\//, ''));
  const n = fs.existsSync(p) ? (fs.readFileSync(p, 'utf8').match(/inlineEdit-/g) || []).length : -1;
  if (n !== 0) ok = false;
  return { href: h, mentions: n };
});
out.ok = ok;
console.log(JSON.stringify(out, null, 1));
process.exit(ok ? 0 : 1);
