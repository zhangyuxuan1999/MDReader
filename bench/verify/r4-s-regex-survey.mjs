// bench/verify/r4-s-regex-survey.mjs — fix-serial (stage 2e, fix round 4), J20: times EVERY regular expression literal
// of src/preview/serialize.ts and src/preview/fidelity.ts (and the one built with new RegExp, by hand below) on runs of
// N identical characters of each kind that occurs in its pattern, on such runs with a foreign character before / after
// them, and on alternating pairs of those characters. A quadratic expression is detected at n = 3000 / 12000 and its
// time at N is extrapolated instead of measured (so the run stays bounded). Writes nothing into the tree.
//   node bench/verify/r4-s-regex-survey.mjs [N=60000] [limitMs=50]   (global timeout 100 s)
import fs from 'node:fs';
import { parseAst } from 'rolldown/parseAst';

const N = Number(process.argv[2] ?? 60000);
const LIMIT = Number(process.argv[3] ?? 50);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000);
const Z = String.fromCharCode(1);   // a character no pattern names
const FILES = ['src/preview/serialize.ts', 'src/preview/fidelity.ts'];

function literals(file) {
  const src = fs.readFileSync(file, 'utf8');
  const lineOf = (pos) => src.slice(0, pos).split('\n').length;
  const out = [];
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { for (const y of x) walk(y); return; }
    if (x.type === 'Literal' && x.regex) out.push({ file, line: lineOf(x.start), pattern: x.regex.pattern, flags: x.regex.flags });
    for (const k of Object.keys(x)) if (k !== 'parent') walk(x[k]);
  };
  walk(parseAst(src, { lang: 'ts' }));
  return out;
}

const CLASS_REP = { s: [' ', String.fromCharCode(0x3000)], S: ['a'], d: ['1'], D: ['a'], w: ['a'], W: [' '], t: ['\t'], n: ['\n'], r: ['\r'], f: ['\f'], v: ['\v'] };
const PROP_REP = { L: 'a', N: '1', P: '.', S: '+', Cc: String.fromCharCode(1), Zs: ' ' };
function charsOf(p) {
  const set = new Set();
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      const d = p[++i];
      if (d === 'u' && p[i + 1] !== '{') { set.add(String.fromCharCode(parseInt(p.slice(i + 1, i + 5), 16))); i += 4; continue; }
      if (d === 'x') { set.add(String.fromCharCode(parseInt(p.slice(i + 1, i + 3), 16))); i += 2; continue; }
      if (d === 'p' || d === 'P') { const e = p.indexOf('}', i); for (const nm of p.slice(i + 2, e).split(/[=,]/)) if (PROP_REP[nm]) set.add(PROP_REP[nm]); i = e; continue; }
      if (CLASS_REP[d]) { for (const r of CLASS_REP[d]) set.add(r); continue; }
      if (/[bB0-9k]/.test(d)) continue;
      set.add(d);
      continue;
    }
    if ('^$*+?()[]{}|'.includes(c)) continue;
    if (c === '.') { set.add('a'); continue; }
    set.add(c);
  }
  set.add('a');
  set.add(' ');
  return [...set].slice(0, 18);
}

/** Runs of two or more literal characters in the pattern (`:\/\/` gives `://`): repeated as a unit too. */
function unitsOf(p) {
  const units = [];
  let cur = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && /[^A-Za-z0-9]/.test(p[i + 1] ?? '')) { cur += p[++i]; continue; }
    if (/[A-Za-z0-9 :\/<>!#&;,=@%"'-]/.test(c) && c !== '\\') { cur += c; continue; }
    if (cur.length >= 2) units.push(cur);
    cur = '';
    if (c === '\\') i++;
  }
  if (cur.length >= 2) units.push(cur);
  return [...new Set(units)].slice(0, 8);
}

function inputs(cs, units = []) {
  const out = [];
  for (const u of units) out.push([`unit ${JSON.stringify(u)}`, (n) => u.repeat(Math.ceil(n / u.length))], [`unit ${JSON.stringify(u)}+Z`, (n) => u.repeat(Math.ceil(n / u.length)) + Z]);
  for (const c of cs) {
    out.push([`run ${JSON.stringify(c)}`, (n) => c.repeat(n)], [`run ${JSON.stringify(c)}+Z`, (n) => c.repeat(n) + Z], [`Z+run ${JSON.stringify(c)}`, (n) => Z + c.repeat(n)]);
  }
  for (let a = 0; a < cs.length; a++) for (let b = a + 1; b < cs.length; b++) {
    const u = cs[a] + cs[b];
    out.push([`pairs ${JSON.stringify(u)}`, (n) => u.repeat(n >> 1)], [`pairs ${JSON.stringify(u)}+Z`, (n) => u.repeat(n >> 1) + Z]);
  }
  return out;
}

function timeOne(re, s) {
  const t0 = performance.now();
  if (re.global || re.sticky) { re.lastIndex = 0; s.replace(re, ''); } else re.exec(s);
  return performance.now() - t0;
}

const all = [];
for (const f of FILES) all.push(...literals(f));
// the one expression built at run time (serialize.ts fencedCode: the closing fence of the source's own fence)
all.push({ file: 'src/preview/serialize.ts', line: 0, pattern: '^ {0,3}`{3,}[ \\t]*$', flags: 'm', note: 'new RegExp in fencedCode (backtick form)' });
all.push({ file: 'src/preview/serialize.ts', line: 0, pattern: '^ {0,3}~{3,}[ \\t]*$', flags: 'm', note: 'new RegExp in fencedCode (tilde form)' });
console.log(`${all.length} expressions, N = ${N}`);
const rows = [];
for (const x of all) {
  let re;
  try { re = new RegExp(x.pattern, x.flags); } catch (e) { console.log('SKIP', x.file, x.line, e.message); continue; }
  const cs = charsOf(x.pattern);
  let worst = { ms: 0, what: '' };
  for (const [what, gen] of inputs(cs, unitsOf(x.pattern))) {
    const t3 = timeOne(re, gen(3000));
    let est;
    if (t3 > 1) {
      const t12 = timeOne(re, gen(12000));
      const exp = Math.log(Math.max(t12, 0.01) / Math.max(t3, 0.01)) / Math.log(4);
      est = { ms: t12 * Math.pow(N / 12000, Math.max(1, exp)), what: `${what} (extrapolated, exponent ${exp.toFixed(2)}, ${t12.toFixed(1)} ms at 12000)` };
    } else {
      const big = gen(N);
      est = { ms: Math.min(timeOne(re, big), timeOne(re, big)), what };
    }
    if (est.ms > worst.ms) worst = est;
  }
  rows.push({ ...x, worst });
}
rows.sort((a, b) => b.worst.ms - a.worst.ms);
let over = 0;
for (const r of rows) {
  const bad = r.worst.ms > LIMIT;
  if (bad) over++;
  console.log(`${bad ? 'OVER' : 'ok  '} ${r.worst.ms.toFixed(1).padStart(9)} ms  ${r.file}:${r.line}  /${r.pattern}/${r.flags}  worst: ${r.worst.what}${r.note ? '  [' + r.note + ']' : ''}`);
}
console.log(`${over} over ${LIMIT} ms of ${rows.length}`);
clearTimeout(killer);
