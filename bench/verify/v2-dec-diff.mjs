// v2-dec-diff.mjs — differential of electron/fileIO.mjs decodeBuffer against the frozen 0.1.0 decoder
// (test/fixtures/fileIO-0.1.0.mjs) over corpora the fixer did not use (bench/verify/v2-dec-corpus.mjs).
// verify-decoder, 0.2.0 stage 2a. Read-only: writes only to stdout and, if given, to $OUT (a JSON file
// outside the tree).
// Run: N=2000 SEED=1 node bench/verify/v2-dec-diff.mjs      (N = inputs per case family; global timeout 110 s
// unless TIMEOUT_S is set; run large N in the background).
// A regression = 0.1.0 returns the true text (and label, BOM flag) and the candidate does not.
import fs from 'node:fs';
import * as neu from '../../electron/fileIO.mjs';
import * as old from '../../test/fixtures/fileIO-0.1.0.mjs';
import { rng, pick, int, encode, GEN, withEol } from './v2-dec-corpus.mjs';

const N = Number(process.env.N || 2000);
const SEED = Number(process.env.SEED || 1);
const ONLY = process.env.ONLY || '';
const TIMEOUT_S = Number(process.env.TIMEOUT_S || 110);
setTimeout(() => { console.log('GLOBAL TIMEOUT'); finish(); process.exit(3); }, TIMEOUT_S * 1000).unref();

const FAMILY = { 'gb18030': 'gbk', 'iso-8859-1': 'windows-1252' };
const fam = (e) => FAMILY[e] || e;
function run(dec, buf) {
  try { return dec(buf); } catch (e) { return { error: e.message }; }
}
const stats = new Map(); // case → {n, oldOk, newOk, regress, refusedNew, ...}
const regressions = [];
const refusals = [];
const bothWrong = new Map(); // case|oldEnc→newEnc → {n, ex}
const lenientWhereOldOk = [];
function st(name) { let s = stats.get(name); if (!s) stats.set(name, s = { n: 0, oldOk: 0, newOk: 0, regress: 0, improve: 0, newRefuse: 0, oldRefuse: 0, newLenient: 0 }); return s; }
const hex = (b, n = 120) => b.subarray(0, n).toString('hex');

function check(name, buf, truth, label, bom = false) {
  const s = st(name);
  s.n++;
  const o = run(old.decodeBuffer, buf);
  const c = run(neu.decodeBuffer, buf);
  const ascii = !/[^\x00-\x7f]/.test(truth);
  const ok = (x) => !x.error && x.text === truth && (ascii || fam(x.encoding) === fam(label)) && !!x.bom === !!bom;
  const oOk = ok(o), cOk = ok(c);
  if (oOk) s.oldOk++;
  if (cOk) s.newOk++;
  if (o.error) s.oldRefuse++;
  if (c.error) s.newRefuse++;
  if (c.replaced) s.newLenient++;
  if (oOk && !cOk) {
    s.regress++;
    if (regressions.length < 60) regressions.push({ name, label, truth: truth.slice(0, 80), got: c.error || `${c.encoding}${c.replaced ? '+R' + c.replaced : ''}: ${c.text.slice(0, 80)}`, hex: hex(buf) });
  } else if (!oOk && cOk) s.improve++;
  if (!o.error && c.error && refusals.length < 60) refusals.push({ name, label, old: o.encoding, err: c.error, hex: hex(buf), truth: truth.slice(0, 60) });
  if (!oOk && !cOk) {
    const k = `${name}|${o.error ? 'REFUSE' : o.encoding}→${c.error ? 'REFUSE' : c.encoding + (c.replaced ? '+lenient' : '')}`;
    let b = bothWrong.get(k);
    if (!b) bothWrong.set(k, b = { n: 0, ex: [] });
    b.n++;
    if (b.ex.length < 2) b.ex.push({ truth: truth.slice(0, 50), old: o.error ? '' : o.text.slice(0, 50), neu: c.error ? '' : c.text.slice(0, 50), hex: hex(buf, 60) });
  }
  return { o, c };
}

const SIMPLE_GB = ['zhMarkdown', 'zhShort', 'zhInEnglish', 'names', 'srt', 'log', 'hant', 'hantShort', 'zhWithKana'];
const cases = [];
// clean, per encoding
for (const g of SIMPLE_GB) {
  cases.push([`gbk:${g}`, (r) => GEN[g](r, 0.15), 'gbk']);
  cases.push([`utf8:${g}`, (r) => GEN[g](r, 0.15), 'utf-8']);
}
cases.push(['gb18030:rare4', (r) => GEN.zhShort(r) + pick(r, ['㐀', '𠀀', '😀', '䶮', '𪚥', '€']) + GEN.zhShort(r), 'gb18030']);
cases.push(['big5:hant', (r) => GEN.hant(r), 'big5']);
cases.push(['big5:hantShort', (r) => GEN.hantShort(r), 'big5']);
cases.push(['sjis:ja', (r) => GEN.ja(r), 'shift_jis']);
cases.push(['euckr:ko', (r) => GEN.ko(r), 'euc-kr']);
for (const lang of ['fr', 'de', 'es', 'pt', 'is']) cases.push([`cp1252:${lang}`, (r) => GEN.latin(r, lang), 'windows-1252']);
cases.push(['iso15:fr', (r) => GEN.latin(r, 'fr').replace(/Œ/g, 'OE').replace(/œ/g, 'oe').replace(/[’«»—]/g, "'"), 'iso-8859-15', 'windows-1252']);
cases.push(['utf8:mixed', (r) => GEN.mixedUtf8(r), 'utf-8']);
for (const lang of ['fr', 'de', 'pl', 'ru', 'el', 'tr']) cases.push([`utf8:${lang}`, (r) => GEN.latin(r, lang), 'utf-8']);
// encodings neither version supports: truth is unreachable for both — measure what happens instead
cases.push(['cp1250:pl', (r) => GEN.latin(r, 'pl'), 'windows-1250']);
cases.push(['cp1251:ru', (r) => GEN.latin(r, 'ru'), 'windows-1251']);
cases.push(['koi8r:ru', (r) => GEN.latin(r, 'ru'), 'koi8-r']);
cases.push(['iso7:el', (r) => GEN.latin(r, 'el'), 'iso-8859-7']);
cases.push(['cp1254:tr', (r) => GEN.latin(r, 'tr'), 'windows-1254']);
cases.push(['utf16le:zh', (r) => GEN.zhMarkdown(r), 'utf-16le']);
cases.push(['utf16be:zh', (r) => GEN.zhMarkdown(r), 'utf-16be']);
cases.push(['utf16le:en', (r) => pick(r, ['# Title\n\n', '']) + GEN.zhInEnglish(r).replace(/[^\x00-\x7f]/g, 'x'), 'utf-16le']);

const EOLS = ['lf', 'crlf', 'cr', 'mixed'];
let total = 0;
function family(name, make, label, decodeAs = label) {
  if (ONLY && !name.includes(ONLY)) return;
  const r = rng(SEED * 1000003 + name.length * 7919 + [...name].reduce((a, ch) => a + ch.charCodeAt(0), 0));
  let made = 0, tries = 0;
  while (made < N && tries < N * 5) {
    tries++;
    let text = make(r);
    // lengths: mostly as generated, sometimes repeated up to ~150 KB, sometimes cut short
    const lr = r();
    if (lr < 0.05) { const k = int(r, 20, 400); text = Array.from({ length: k }, () => make(r)).join('\n'); }
    else if (lr < 0.15) text = text.slice(0, int(r, 1, 6));
    text = withEol(text, pick(r, EOLS), r);
    const enc = encode(text, label);
    if (!enc) continue;
    let truth = text;
    if (label !== decodeAs || ['windows-1250', 'windows-1251', 'koi8-r', 'iso-8859-7', 'windows-1254'].includes(label)) truth = text; // unreachable label: compare to the text anyway
    // BOM variants for the Unicode encodings
    let buf = enc, bom = false;
    if (label === 'utf-8' && r() < 0.25) { buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), enc]); bom = true; }
    if (label === 'utf-16le' && r() < 0.5) { buf = Buffer.concat([Buffer.from([0xff, 0xfe]), enc]); bom = true; }
    if (label === 'utf-16be' && r() < 0.5) { buf = Buffer.concat([Buffer.from([0xfe, 0xff]), enc]); bom = true; }
    check(name, buf, truth, decodeAs === label ? label : decodeAs, bom);
    made++; total++;
  }
}
const t0 = Date.now();
for (const [name, make, label, decodeAs] of cases) family(name, make, label, decodeAs);
finish();

function finish() {
  console.log(`inputs=${total} seed=${SEED} N=${N} ms=${Date.now() - t0}`);
  console.log('case'.padEnd(22), 'n'.padStart(6), 'oldOk'.padStart(6), 'newOk'.padStart(6), 'REGR'.padStart(5), 'impr'.padStart(5), 'newRef'.padStart(6), 'oldRef'.padStart(6), 'lenient'.padStart(7));
  for (const [k, s] of stats) console.log(k.padEnd(22), String(s.n).padStart(6), String(s.oldOk).padStart(6), String(s.newOk).padStart(6), String(s.regress).padStart(5), String(s.improve).padStart(5), String(s.newRefuse).padStart(6), String(s.oldRefuse).padStart(6), String(s.newLenient).padStart(7));
  console.log('REGRESSIONS', regressions.length);
  for (const x of regressions.slice(0, 25)) console.log(JSON.stringify(x));
  console.log('NEW REFUSALS (0.1.0 opened)', refusals.length);
  for (const x of refusals.slice(0, 15)) console.log(JSON.stringify(x));
  console.log('BOTH WRONG (case|old→new: n)');
  for (const [k, b] of [...bothWrong].sort((a, b) => b[1].n - a[1].n).slice(0, 60)) console.log(k, b.n, JSON.stringify(b.ex[0]));
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ stats: [...stats], regressions, refusals, bothWrong: [...bothWrong] }, null, 1));
}
