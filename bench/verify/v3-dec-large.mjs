// v3-dec-large.mjs — large-file sampling (SAMPLE_CHUNK_BYTES 24 KB × start / middle / end) against the
// 0.1.0 decoder: files of 90 KB – 3 MB assembled from the v3-dec families, plus adversarial layouts
// (UTF-8-shaped GBK only in the sampled chunks, a different encoding outside the sample).
// Writes nothing. node bench/verify/v3-dec-large.mjs
import * as neu from '../../electron/fileIO.mjs';
import * as old from '../../test/fixtures/fileIO-0.1.0.mjs';
import * as C from './v3-dec-corpus.mjs';

const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
const dec = (f, b, ...a) => { try { return f(b, ...a); } catch { return { refused: true }; } };
const brief = (d) => d.refused ? 'REFUSED' : `${d.encoding}${d.replaced ? ` repl=${d.replaced}` : ''}`;
const gbkT = neu.legacyEncoderTable('gbk');
let bad = 0;
function check(name, b, truth, label) {
  const o = dec(old.decodeBuffer, b), n = dec(neu.decodeBuffer, b), off = dec(neu.decodeBuffer, b, false);
  const oR = !o.refused && o.text === truth && o.encoding === label;
  const nR = !n.refused && n.text === truth && n.encoding === label;
  const offSame = (o.refused && off.refused) || (!o.refused && !off.refused && o.text === off.text && o.encoding === off.encoding);
  let v = 'ok';
  if (oR && !nR) v = 'REGRESSION(i)';
  else if (n.refused && !o.refused) v = 'REGRESSION(ii)';
  else if (!o.refused && !n.refused && !n.replaced) {
    const so = old.encodeText(o.text, { encoding: o.encoding, eol: old.eolOf(o.text) });
    const t = neu.saveTableOf(n.text, n.encoding, b);
    let sn = null; try { sn = neu.encodeText(n.text, { encoding: n.encoding, eol: neu.eolOf(n.text), ...(t ? { table: t } : {}) }); } catch {}
    if (so.equals(b) && !(sn && sn.equals(b))) v = 'REGRESSION(iii)';
  }
  if (!offSame) v += ' OFF-DIFFERS';
  if (v !== 'ok') bad++;
  console.log(`${name} (${(b.length / 1024).toFixed(0)} KB) | 0.1.0 ${brief(o)}${oR ? ' right' : ''} | cand ${brief(n)}${nR ? ' right' : ''} | ${v}`);
}
const build = (gen, seed, bytes, enc) => {
  const r = C.rng(seed);
  let s = '';
  while (Buffer.byteLength(s) < bytes) s += gen(r);
  return { s, b: enc(s) };
};
const G = (s) => C.tableEncode(s, gbkT);
for (const size of [90_000, 100_000, 400_000, 3_000_000]) {
  for (const [fam, gen] of [['zh-md', C.zhMarkdown], ['zh-log', C.zhLog], ['zh-names', C.zhNamesCsv], ['zh-sheet', C.zhSheet], ['hant', C.hantText]]) {
    const { s, b } = build(gen, size + fam.length, size, G);
    check(`gbk ${fam}`, b, s, 'gbk');
  }
  { const { s, b } = build(C.jaHalfwidth, size, size, (t) => C.iconvEncode(t, 'CP932')); check('sjis ja-hw', b, new TextDecoder('shift_jis').decode(b), 'shift_jis'); void s; }
  { const { s, b } = build((r) => C.sbText(r, C.LATIN_MD), size, size, (t) => C.iconvEncode(t, 'CP1252')); check('cp1252 latin', b, s, 'windows-1252'); }
  { const { s, b } = build(C.jaMixed, size + 1, size, (t) => C.iconvEncode(t, 'CP932')); check('sjis ja-mixed (gain)', b, s, 'shift_jis'); }
  { const { s, b } = build(C.hantText, size + 2, size, (t) => C.iconvEncode(t, 'CP950')); check('big5 hant (gain)', b, s, 'big5'); }
  { const { s, b } = build((r) => C.koText(r, 0), size + 3, size, (t) => C.iconvEncode(t, 'CP949')); check('euc-kr ko (gain)', b, s, 'euc-kr'); }
}
// adversarial: GBK timesheet in the three sampled chunks, ordinary GBK prose elsewhere (1 MB)
{
  const sheet = (n) => Array.from({ length: n }, (_, i) => `| 11-${String(i % 28 + 1).padStart(2, '0')} | ${i % 9 + 1}小时 |`).join('\n') + '\n';
  const prose = (bytes) => { const r = C.rng(5); let s = ''; while (Buffer.byteLength(s) < bytes) s += C.zhMarkdown(r); return s; };
  const t = sheet(1500) + prose(400_000) + sheet(1500) + prose(400_000) + sheet(1500);
  check('gbk sheet-in-sample-only', G(t), t, 'gbk');
  const t2 = sheet(30000);
  check('gbk sheet 30000 lines (whole file UTF-8-shaped)', G('# 工时\n\n' + t2), '# 工时\n\n' + t2, 'gbk');
}
console.log(`\nproblems: ${bad}`);
clearTimeout(killer);
