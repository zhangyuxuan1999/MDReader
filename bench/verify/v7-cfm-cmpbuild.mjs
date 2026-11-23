// bench/verify/v7-cfm-cmpbuild.mjs — confirm (0.2.0 round 6): compares two built dist directories file by file.
// Pairs files by path; the rest by their name with the Vite hash masked ("-<8 chars>." -> "-#."), and where several
// share a masked name, by content with every hashed asset name inside it masked. Prints: identical, identical after
// masking (with the name pairs), different in content, only on one side. Reads only; writes nothing.
//   node bench/verify/v7-cfm-cmpbuild.mjs <distA> <distB>
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const [A, B] = process.argv.slice(2);
if (!A || !B) { console.log('usage: v7-cfm-cmpbuild.mjs <distA> <distB>'); process.exit(2); }
const walk = (d, root = d, out = []) => {
  for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p, root, out); else out.push(relative(root, p)); }
  return out;
};
const HASH = /-[A-Za-z0-9_-]{8}\.(js|css|woff2?|ttf|svg|png|wasm)/g;
const mask = (s) => s.replace(HASH, '-#.$1');
const fa = walk(A).sort(), fb = walk(B).sort();
const sb = new Set(fb);
let same = 0; const sameMasked = [], differ = [], onlyA = [], onlyB = [];
const restA = [], restB = new Set();
for (const f of fa) {
  if (sb.has(f)) {
    const x = readFileSync(join(A, f)), y = readFileSync(join(B, f));
    if (x.equals(y)) { same++; sb.delete(f); continue; }
    if (mask(x.toString('latin1')) === mask(y.toString('latin1'))) { sameMasked.push(`${f} (names inside only)`); sb.delete(f); continue; }
    differ.push(`${f} (${x.length} -> ${y.length})`); sb.delete(f); continue;
  }
  restA.push(f);
}
for (const f of sb) restB.add(f);
for (const f of restA) {
  const cands = [...restB].filter((g) => mask(g) === mask(f));
  if (cands.length === 0) { onlyA.push(f); continue; }
  const x = mask(readFileSync(join(A, f)).toString('latin1'));
  const hit = cands.find((g) => mask(readFileSync(join(B, g)).toString('latin1')) === x);
  if (hit) { sameMasked.push(`${f} -> ${hit}`); restB.delete(hit); continue; }
  if (cands.length === 1) { const g = cands[0]; differ.push(`${f} -> ${g} (${statSync(join(A, f)).size} -> ${statSync(join(B, g)).size})`); restB.delete(g); continue; }
  onlyA.push(f);
}
onlyB.push(...restB);
console.log(`files A=${fa.length} B=${fb.length}`);
console.log(`identical: ${same}`);
console.log(`identical after masking hashed names: ${sameMasked.length}`); for (const s of sameMasked) console.log('  ' + s);
console.log(`different in content: ${differ.length}`); for (const s of differ) console.log('  ' + s);
console.log(`only in A: ${onlyA.length}`); for (const s of onlyA) console.log('  ' + s);
console.log(`only in B: ${onlyB.length}`); for (const s of onlyB) console.log('  ' + s);
