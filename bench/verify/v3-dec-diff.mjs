// v3-dec-diff.mjs — decoder differential, candidate electron/fileIO.mjs vs the frozen 0.1.0 decoder
// (test/fixtures/fileIO-0.1.0.mjs), over the v3-dec corpora (verify-decoder, stage 2c).
// Writes NOTHING into the tree. Output: a summary on stdout; examples to $V3_OUT (default: none).
//   node bench/verify/v3-dec-diff.mjs [seeds=200] [familyFilter]
// Classes (per input with a KNOWN true text and label):
//   i    0.1.0 returns the true text + label (+ BOM flag), the candidate does not
//   ii   the candidate refuses what 0.1.0 opened (binary rule excluded and counted apart)
//   iii  an unmodified save through the candidate changes bytes where 0.1.0's save did not (no U+FFFD)
//   iv   a label other than 0.1.0's whose encoding does not give the bytes back (no U+FFFD)
//   v    U+FFFD in a reading that is not UTF-8
//   off  decodeBuffer(buf, false) differs from the fixture (text / label / BOM / throw), or its save
//        (meta as readFileInfo stores it, incl. meta.table) differs from 0.1.0's save — unmodified, +x
//   lenientOverGood  (subset of i) the candidate's lenient UTF-8 over a correct 0.1.0 legacy answer
// Gains (genuine Big5 / Shift_JIS / EUC-KR): read right by 0.1.0 / candidate / candidate without the
// language-shape rule (scratch copy, MDR_NOSHAPE=<path>).
import fs from 'node:fs';
import * as neu from '../../electron/fileIO.mjs';
import * as old from '../../test/fixtures/fileIO-0.1.0.mjs';
import * as C from './v3-dec-corpus.mjs';

const T0 = Date.now();
const FFFD = String.fromCharCode(0xfffd);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 30 * 60_000);
killer.unref();

const SEEDS = Number(process.argv[2] || 200);
const FILTER = process.argv[3] || '';
const noshape = process.env.MDR_NOSHAPE ? await import(process.env.MDR_NOSHAPE) : null;

const HARD = /[\u0000-\u0006\u000E-\u001A\u001C-\u001F\u007F]/g;
const hardShare = (t) => { const s = t.slice(0, 400000); if (!s.length) return 0; const m = s.match(HARD); return m ? m.length / s.length : 0; };

function dec(f, b, ...a) { try { return f(b, ...a); } catch (e) { return { refused: true, msg: e.message }; } }
const same = (a, b) => (a.refused && b.refused) || (!a.refused && !b.refused && a.text === b.text && a.encoding === b.encoding && a.bom === b.bom);
function metaOf(d, b) {
  const table = d.replaced ? undefined : neu.saveTableOf(d.text, d.encoding, b);
  return { encoding: d.encoding, bom: d.bom, eol: neu.eolOf(d.text), ...(table ? { table } : {}) };
}
function encNew(text, meta) { try { return neu.encodeText(text, meta); } catch (e) { return null; } }
function encOld(text, meta) { try { return old.encodeText(text, meta); } catch (e) { return null; } }
/** encodeText piece by piece, line separators kept as they are. */
function rawEncode(text, meta) {
  const out = [];
  if (meta.bom) out.push(neu.encodeText('', meta));
  for (const p of text.split(/(\r\n|\r|\n)/)) {
    if (p === '') continue;
    const piece = p === '\r' ? rawCr(meta) : p === '\r\n' ? encNew('\n', { ...meta, bom: false, eol: 'crlf' }) : encNew(p, { ...meta, bom: false, eol: 'lf' });
    if (piece === null) return null;
    out.push(piece);
  }
  return Buffer.concat(out);
}
function rawCr(meta) { return meta.encoding === 'utf-16le' ? Buffer.from([13, 0]) : meta.encoding === 'utf-16be' ? Buffer.from([0, 13]) : Buffer.from([13]); }
const eq = (a, b) => a === null ? b === null : b !== null && a.equals(b);

// ------------------------------------------------------------------ families
const WH = (label) => neu.legacyEncoderTable(label);
const FAM = [
  // name, generator, [encoder specs: [trueLabel, how]]
  ['zh-md', (r) => C.zhMarkdown(r), [['gbk', 'GBK'], ['gbk', 'CP936'], ['gbk', 'GB18030'], ['utf-8']]],
  ['zh-classical', (r) => C.zhClassical(r), [['gbk', 'GBK'], ['utf-8'], ['big5', 'BIG5']]],
  ['zh-names', (r) => C.zhNamesCsv(r), [['gbk', 'GBK'], ['utf-8']]],
  ['zh-songs', (r) => C.zhSongs(r), [['gbk', 'GBK']]],
  ['zh-subs', (r) => C.zhSubtitles(r), [['gbk', 'GBK'], ['utf-8']]],
  ['zh-log', (r) => C.zhLog(r), [['gbk', 'GBK']]],
  ['zh-sheet', (r) => C.zhSheet(r), [['gbk', 'GBK'], ['gbk', 'GB18030']]],
  ['hant-gbk', (r) => C.hantText(r), [['gbk', 'GBK'], ['big5', 'BIG5'], ['big5', 'CP950'], ['big5', 'wh']]],
  ['ja-kanji', (r) => C.jaKanji(r), [['shift_jis', 'SHIFT_JIS'], ['shift_jis', 'CP932'], ['gbk', 'GBK'], ['euc-jp?', 'skip']]],
  ['ja-mixed', (r) => C.jaMixed(r), [['shift_jis', 'CP932']]],
  ['ja-kata', (r) => C.jaKata(r), [['shift_jis', 'CP932']]],
  ['ja-hw', (r) => C.jaHalfwidth(r), [['shift_jis', 'CP932'], ['shift_jis', 'SHIFT_JIS']]],
  ['ko', (r) => C.koText(r, 0), [['euc-kr', 'EUC-KR'], ['euc-kr', 'CP949']]],
  ['ko-hanja', (r) => C.koText(r, 0.7), [['euc-kr', 'CP949']]],
  ['vi', (r) => C.sbText(r, C.VI).normalize('NFC'), [['windows-1258', 'CP1258']]],
  ['th', (r) => C.sbText(r, C.TH), [['windows-874', 'CP874']]],
  ['he', (r) => C.sbText(r, C.HE), [['windows-1255', 'CP1255']]],
  ['ar', (r) => C.sbText(r, C.AR), [['windows-1256', 'CP1256']]],
  ['latin-md', (r) => C.sbText(r, C.LATIN_MD), [['windows-1252', 'CP1252'], ['utf-8']]],
].filter(([n]) => n.includes(FILTER));

function encodeAs(text, label, how) {
  if (how === 'skip') return null;
  if (label === 'utf-8') return Buffer.from(text, 'utf8');
  if (how === 'wh') return C.tableEncode(text, WH(label));
  return C.iconvEncode(text, how);
}

const stats = {};
const examples = {};
const gains = {};
const bump = (fam, k) => { stats[fam] ??= {}; stats[fam][k] = (stats[fam][k] || 0) + 1; };
function note(fam, k, info) {
  bump(fam, k);
  examples[k] ??= [];
  if (examples[k].length < 12) examples[k].push({ fam, ...info });
}

function check(fam, b, truth, trueLabel, bom) {
  bump(fam, 'n');
  const o = dec(old.decodeBuffer, b);
  const n = dec(neu.decodeBuffer, b);
  const off = dec(neu.decodeBuffer, b, false);
  const hex = b.length <= 400 ? b.toString('hex') : undefined;
  const brief = (d) => d.refused ? 'REFUSED' : `${d.encoding}${d.bom ? '+bom' : ''}${d.replaced ? ` repl=${d.replaced}` : ''}`;
  // step 2: the switch
  if (!same(o, off)) note(fam, 'off', { hex, o: brief(o), off: brief(off) });
  else if (!o.refused) {
    const mOld = { encoding: o.encoding, bom: o.bom, eol: old.eolOf(o.text) };
    const mOff = metaOf(off, b);
    // untouched bytes: a save of (text + add) must start with the original bytes whenever the
    // unmodified save of that reading is exact (uniform line endings only)
    const uniform = !/\r(?!\n)/.test(o.text) && !(/\r\n/.test(o.text) && /(^|[^\r])\n/.test(o.text));
    const so0 = encOld(o.text, mOld), sf0 = encNew(off.text, mOff);
    const oldExact = !!so0 && so0.equals(b), offExact = !!sf0 && sf0.equals(b);
    if (!eq(so0, sf0)) note(fam, oldExact && !offExact ? 'offSaveWorse' : !oldExact && offExact ? 'offSaveBetter' : 'offSaveBothInexact', { hex, enc: o.encoding, table: mOff.table });
    for (const add of ['x', '\n十', '\n卅', '═', 'ⅰ', '≒', '∵', '¬', '①', '㈱']) {
      if (!uniform) break;
      const so = encOld(o.text + add, mOld);
      const sf = encNew(off.text + add, mOff);
      const oldKeeps = oldExact && !!so && so.subarray(0, b.length).equals(b);
      const offKeeps = offExact && !!sf && sf.subarray(0, b.length).equals(b);
      if (oldKeeps && !offKeeps) note(fam, 'offEditBreaksUntouched', { hex, enc: o.encoding, add, table: mOff.table });
      if (!eq(so, sf)) bump(fam, 'offEditNewCharBytesDiffer ' + o.encoding + ' ' + add.trim());
    }
  }
  if (!n.refused && !n.replaced) {
    const uniformN = !/\r(?!\n)/.test(n.text) && !(/\r\n/.test(n.text) && /(^|[^\r])\n/.test(n.text));
    const mN = metaOf(n, b);
    const sn0 = encNew(n.text, mN);
    if (uniformN && sn0 && sn0.equals(b)) for (const add of ['x', '\n十', '═', 'ⅰ', '≒', '①']) {
      const sn = encNew(n.text + add, mN);
      if (sn && !sn.subarray(0, b.length).equals(b)) note(fam, 'candEditBreaksUntouched', { hex, enc: n.encoding, add, table: mN.table });
    }
  }
  const oRight = !o.refused && o.text === truth && o.encoding === trueLabel && o.bom === bom;
  const nRight = !n.refused && n.text === truth && n.encoding === trueLabel && n.bom === bom;
  if (oRight && !nRight) {
    note(fam, 'i', { hex: b.length <= 4000 ? b.toString('hex') : undefined, len: b.length, o: brief(o), n: brief(n), nText: n.text?.slice(0, 80) });
    if (n.replaced) bump(fam, 'lenientOverGood');
  }
  if (n.refused && !o.refused) {
    if (o.encoding === 'utf-8' && hardShare(o.text) > 0.5) bump(fam, 'binaryRule');
    else note(fam, 'ii', { hex, o: brief(o) });
  }
  if (!n.refused && !n.replaced && !o.refused) {
    const so = encOld(o.text, { encoding: o.encoding, bom: o.bom, eol: old.eolOf(o.text) });
    const sn = encNew(n.text, metaOf(n, b));
    const oldExact = so !== null && so.equals(b);
    const newExact = sn !== null && sn.equals(b);
    if (oldExact && !newExact) note(fam, 'iii', { hex, o: brief(o), n: brief(n) });
  }
  if (!n.refused && !n.replaced && (o.refused || n.encoding !== o.encoding)) {
    // line endings as they are (K10 normalisation is not an encoding question)
    const sn = rawEncode(n.text, metaOf(n, b));
    if (!(sn && sn.equals(b))) note(fam, 'iv', { hex, o: brief(o), n: brief(n) });
  }
  if (!n.refused && n.encoding !== 'utf-8' && n.text.includes(FFFD) && !(o.text || '').includes(FFFD)) note(fam, 'v', { hex, n: brief(n) });
  if (['big5', 'shift_jis', 'euc-kr'].includes(trueLabel)) {
    gains[fam + ' ' + trueLabel] ??= { n: 0, old: 0, cand: 0, noshape: 0 };
    const g = gains[fam + ' ' + trueLabel];
    g.n++;
    if (oRight) g.old++;
    if (nRight) g.cand++;
    if (noshape) {
      const x = dec(noshape.decodeBuffer, b);
      if (!x.refused && x.text === truth && x.encoding === trueLabel) g.noshape++;
    }
  }
  return { o, n };
}

let inputs = 0;
for (const [fam, gen, specs] of FAM) {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = C.rng(seed * 7919 + fam.length * 131 + fam.charCodeAt(0));
    let text = gen(r);
    // window: a prefix of a random number of characters (1 .. all), sometimes the whole text
    const chars = Array.from(text);
    if (r() < 0.5) text = chars.slice(0, C.int(r, 1, chars.length)).join('');
    for (const [label, how] of specs) {
      if (how === 'skip') continue;
      for (const eol of ['lf', 'crlf', 'mixed', 'cr']) {
        if (eol === 'cr' && r() < 0.7) continue;
        const t = C.withEol(text, eol);
        const body = encodeAs(t, label, how);
        if (!body) { bump(fam, 'unencodable'); continue; }
        // truth: what a decoder of the true label makes of these bytes
        let truth = null;
        try { truth = new TextDecoder(label === 'utf-8' ? 'utf-8' : label, { fatal: true }).decode(body); } catch { truth = null; }
        if (truth === null) { bump(fam, 'notGenuine'); continue; }
        if (truth !== t) bump(fam, 'encoderRespelled');
        inputs++;
        check(fam, body, truth, label, false);
        if (label === 'utf-8' && r() < 0.5) { inputs++; check(fam, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]), truth, 'utf-8', true); }
        // no trailing newline
        if (body.length > 1 && body[body.length - 1] === 0x0a && r() < 0.3) {
          const cut = body.subarray(0, body.length - (body.length > 1 && body[body.length - 2] === 0x0d ? 2 : 1));
          let tr = null; try { tr = new TextDecoder(label, { fatal: true }).decode(cut); } catch {}
          if (tr !== null) { inputs++; check(fam, cut, tr, label, false); }
        }
        // cut inside the text at a random byte (a truncated file): truth only if still genuine
        if (r() < 0.3 && body.length > 2) {
          const cut = body.subarray(0, C.int(r, 1, body.length - 1));
          let tr = null; try { tr = new TextDecoder(label, { fatal: true }).decode(cut); } catch {}
          inputs++;
          if (tr !== null) check(fam, cut, tr, label, false);
          else check(fam, cut, '\u0000never', label, false); // no truth: classes ii–v and the switch only
        }
      }
    }
  }
}
// UTF-16 variants of a few families
for (const fam of ['zh-md', 'ja-mixed', 'ko', 'latin-md'].filter((x) => x.includes(FILTER) || !FILTER)) {
  const g = FAM.find((f) => f[0] === fam) || [null, fam === 'zh-md' ? C.zhMarkdown : fam === 'ja-mixed' ? C.jaMixed : fam === 'ko' ? (r) => C.koText(r, 0) : (r) => C.sbText(r, C.LATIN_MD)];
  for (let seed = 1; seed <= Math.ceil(SEEDS / 4); seed++) {
    const r = C.rng(seed * 104729);
    const t = C.withEol(g[1](r), pick2(r));
    const le = Buffer.from(t, 'utf16le');
    const be = Buffer.from(le).swap16();
    for (const [b, label, bom] of [[le, 'utf-16le', false], [be, 'utf-16be', false], [Buffer.concat([Buffer.from([0xff, 0xfe]), le]), 'utf-16le', true], [Buffer.concat([Buffer.from([0xfe, 0xff]), be]), 'utf-16be', true]]) {
      inputs++;
      check('utf16-' + fam, b, t, label, bom);
    }
  }
}
function pick2(r) { return C.pick(r, ['lf', 'crlf', 'mixed']); }

const out = { seeds: SEEDS, inputs, ms: Date.now() - T0, stats, gains };
console.log(JSON.stringify(out, null, 1));
if (process.env.V3_OUT) fs.writeFileSync(process.env.V3_OUT, JSON.stringify({ ...out, examples }, null, 1));
clearTimeout(killer);
