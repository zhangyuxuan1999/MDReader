// v2-dec-large.mjs — the large-file (> 96 KB) sampling path of electron/fileIO.mjs decodeBuffer against
// the frozen 0.1.0 decoder. verify-decoder, 0.2.0 stage 2a. Writes nothing.
// Run: node bench/verify/v2-dec-large.mjs          (SPEED=1 adds a 50 MB timing, reported not gated)
import * as neu from '../../electron/fileIO.mjs';
import * as old from '../../test/fixtures/fileIO-0.1.0.mjs';
import { rng, pick, int, encode, ZH, HANT, LATIN } from './v2-dec-corpus.mjs';

setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000).unref();
const dec = (f, b) => { try { return f(b); } catch (e) { return { error: e.message, encoding: 'REFUSED' }; } };
const show = (x) => x.error ? 'REFUSED' : x.encoding + (x.replaced ? '+R' + x.replaced : '');
let fails = 0;
function row(name, buf, truth, label) {
  const o = dec(old.decodeBuffer, buf), c = dec(neu.decodeBuffer, buf);
  const oOk = o.text === truth, cOk = c.text === truth;
  const verdict = oOk && !cOk ? 'REGRESSION' : !oOk && cOk ? 'improved' : oOk ? 'both right' : 'both wrong';
  if (verdict === 'REGRESSION') fails++;
  console.log(`${name.padEnd(46)} ${String(buf.length).padStart(8)} B  truth=${label.padEnd(12)} 0.1.0=${show(o).padEnd(14)} cand=${show(c).padEnd(16)} ${verdict}`);
}
const r = rng(4242);
const gbText = (len) => { let s = ''; while (s.length < len) s += `## ${pick(r, ZH).slice(0, 6)}\n\n${pick(r, ZH)}${pick(r, ZH)}\n\n- ${pick(r, ZH)}\n`; return s; };
const hantText = (len) => { let s = ''; while (s.length < len) s += pick(r, HANT) + (r() < 0.3 ? '\n' : ''); return s; };
const ascii = (len) => { let s = ''; while (s.length < len) s += 'Plain ASCII line number ' + s.length + ' with words.\n'; return s.slice(0, len); };
const K = 1024;
const LIMIT = 96 * K;

// 1. just below / at / above the 96 KB limit, GBK and Big5 and UTF-8-with-one-stray-byte
for (const d of [-2, -1, 0, 1, 2, 4097]) {
  const t = gbText(60 * K);
  let b = encode(t, 'gbk');
  // trim/pad with ASCII to an exact size
  const target = LIMIT + d;
  const fit = (txt, label) => { let lo = 0, hi = txt.length; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (encode(txt.slice(0, m), label).length <= target) lo = m; else hi = m - 1; } const c = txt.slice(0, lo); return c + 'x'.repeat(target - encode(c, label).length); };
  let s = fit(t, 'gbk');
  b = encode(s, 'gbk');
  row(`gbk size LIMIT${d >= 0 ? '+' : ''}${d}`, b, s, 'gbk');
  const h = fit(hantText(60 * K), 'big5');
  row(`big5 size LIMIT${d >= 0 ? '+' : ''}${d}`, encode(h, 'big5'), h, 'big5');
}
// 2. three samples ASCII, the rest legacy
{
  const n = 300 * K;
  const head = ascii(30 * K), mid = ascii(30 * K), tail = ascii(30 * K);
  for (const [label, filler] of [['gbk', () => gbText(50 * K)], ['big5', () => hantText(50 * K)], ['windows-1252', () => (LATIN.de.join(' ') + '\n').repeat(500)], ['shift_jis', () => ('カタカナとひらがなの文章です。東京駅で待ち合わせ。\n').repeat(1500)]]) {
    const f1 = filler(), f2 = filler();
    const s = head + f1 + mid + f2 + tail;
    const b = encode(s, label);
    if (!b) { console.log('skip', label); continue; }
    row(`ascii samples, rest ${label}`, b, s, label);
  }
  void n;
}
// 3. a multi-byte character / CRLF across every possible cut: GBK text without any byte < 0x30 for 6 KB
//    around the cut points (no newline, no ASCII), CRLF elsewhere
{
  const block = gbText(200 * K).replace(/\n/g, '\r\n');
  const noAscii = (len) => { let s = ''; while (s.length < len) s += pick(r, ZH).replace(/[\x00-\x7f]/g, ''); return s; };
  for (const at of [24 * K - 3, 24 * K, 24 * K + 1]) {
    const s = block.slice(0, at) + noAscii(6 * K) + block.slice(at);
    row(`gbk with 12 KB high-byte run near ${at}`, encode(s, 'gbk'), s, 'gbk');
  }
  const s2 = noAscii(2 * K * K / 2); // ~2 MB of GBK without one byte below 0x30
  row('gbk 2 MB single line, no byte < 0x30', encode(s2, 'gbk'), s2, 'gbk');
  const s3 = hantText(1000 * K).replace(/\n/g, '');
  row('big5 ~2 MB single line', encode(s3, 'big5'), s3, 'big5');
}
// 4. samples GBK, the rest UTF-8 (and the reverse): mixed — no right answer; show what happens
{
  const g = gbText(40 * K), u = gbText(60 * K);
  const b = Buffer.concat([encode(g, 'gbk'), Buffer.from(u, 'utf8'), encode(g, 'gbk')]);
  row('gbk | utf-8 middle | gbk (mixed)', b, '(mixed)', 'mixed');
  const b2 = Buffer.concat([Buffer.from(u, 'utf8'), encode(g, 'gbk'), Buffer.from(u, 'utf8')]);
  row('utf-8 | gbk middle | utf-8 (mixed)', b2, '(mixed)', 'mixed');
  // UTF-8 file with one stray byte outside all three samples
  const big = gbText(200 * K);
  const ub = Buffer.from(big, 'utf8');
  const pos = Math.floor(ub.length * 0.3);
  let p = pos; while ((ub[p] & 0xc0) === 0x80) p++;
  const stray = Buffer.concat([ub.subarray(0, p), Buffer.from([0xff]), ub.subarray(p)]);
  const c = dec(neu.decodeBuffer, stray);
  console.log(`utf-8 + 1 stray byte outside the samples (${stray.length} B): cand=${show(c)} text==original-with-U+FFFD: ${c.text === big.slice(0, Buffer.from(ub.subarray(0, p)).toString('utf8').length) + '�' + big.slice(Buffer.from(ub.subarray(0, p)).toString('utf8').length)}`);
  // GBK file with one stray byte outside all samples
  const gb = encode(big, 'gbk');
  const gp = Math.floor(gb.length * 0.3); let q = gp; while (gb[q - 1] >= 0x80) q++;
  const gstray = Buffer.concat([gb.subarray(0, q), Buffer.from([0xff]), gb.subarray(q)]);
  console.log(`gbk + 1 stray 0xFF outside the samples: 0.1.0=${show(dec(old.decodeBuffer, gstray))} cand=${show(dec(neu.decodeBuffer, gstray))}`);
  // Portuguese windows-1252 large file
  const pt = (LATIN.pt.join(' ') + '\n').repeat(3000);
  row('windows-1252 Portuguese 300 KB', encode(pt, 'windows-1252'), pt, 'windows-1252');
}
if (process.env.SPEED) {
  const s = gbText(17 * K * K); // ~50 MB GBK
  const b = encode(s, 'gbk');
  let t = Date.now(); dec(old.decodeBuffer, b); const to = Date.now() - t;
  t = Date.now(); const c = dec(neu.decodeBuffer, b); const tn = Date.now() - t;
  console.log(`speed ${b.length} B GBK: 0.1.0 ${to} ms, candidate ${tn} ms (${show(c)}, ${c.text === s ? 'right' : 'WRONG'})`);
  const u = Buffer.from(s, 'utf8');
  u[Math.floor(u.length / 3)] = 0xff;
  t = Date.now(); dec(old.decodeBuffer, u); const uo = Date.now() - t;
  t = Date.now(); const cu = dec(neu.decodeBuffer, u); const un = Date.now() - t;
  console.log(`speed ${u.length} B UTF-8 + 1 stray: 0.1.0 ${uo} ms, candidate ${un} ms (${show(cu)})`);
}
console.log(fails ? `REGRESSIONS: ${fails}` : 'no regressions');
