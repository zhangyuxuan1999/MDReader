// bench/verify/scan-invisible.mjs — source hygiene (CONTRACT section 11, "Source hygiene").
// Lists literal invisible / control characters in source files. They must be written as escapes:
// some editing tools turn a typed backslash-u escape into the character itself, and a file with a
// raw NUL byte is treated as binary by grep and by the editing tools.
//   node bench/verify/scan-invisible.mjs            → exit 1 when src/ or electron/ has a hit
//   node bench/verify/scan-invisible.mjs --all      → also lists test/, bench/, scripts/ (never gated)
// The frozen fixture test/fixtures/fileIO-0.1.0.mjs holds raw control bytes on purpose.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALL = process.argv.includes('--all');
const GATED = ['src', 'electron'];
const INFO = ['test', 'bench', 'scripts'];
const EXTS = new Set(['.ts', '.mjs', '.cjs', '.js', '.css', '.html', '.json']);
const invisible = (c) =>
  (c < 0x20 && c !== 0x09 && c !== 0x0a) || c === 0x7f || (c >= 0x80 && c <= 0x9f) || c === 0xa0 || c === 0xad ||
  (c >= 0x200b && c <= 0x200f) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x2060 && c <= 0x2069) || c === 0xfeff || (c >= 0xe000 && c <= 0xf8ff) || (c >= 0xfdd0 && c <= 0xfdef);

function scan(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'out' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { scan(p, out); continue; }
    if (!EXTS.has(path.extname(e.name)) || fs.statSync(p).size > 3_000_000) continue;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(p)); }
    catch { out.push({ file: path.relative(ROOT, p), hits: { 'not valid UTF-8': [] } }); continue; }
    const hits = {};
    text.split('\n').forEach((line, i) => {
      for (const ch of line) {
        const c = ch.codePointAt(0);
        if (!invisible(c)) continue;
        const k = 'U+' + c.toString(16).toUpperCase().padStart(4, '0');
        (hits[k] ||= []).length < 8 && hits[k].push(i + 1);
      }
    });
    if (Object.keys(hits).length) out.push({ file: path.relative(ROOT, p), hits });
  }
}

const gated = [];
for (const d of GATED) if (fs.existsSync(path.join(ROOT, d))) scan(path.join(ROOT, d), gated);
for (const h of gated) console.log('GATED', JSON.stringify(h));
if (ALL) {
  const info = [];
  for (const d of INFO) if (fs.existsSync(path.join(ROOT, d))) scan(path.join(ROOT, d), info);
  for (const h of info) console.log('info ', JSON.stringify(h));
}
console.log(gated.length ? `FAIL: ${gated.length} file(s) in src/ or electron/ hold literal invisible characters` : 'OK: src/ and electron/ hold no literal invisible characters');
process.exit(gated.length ? 1 : 0);
