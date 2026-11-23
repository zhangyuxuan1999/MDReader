// v3-dec-inputs.mjs — the v3-dec differential inputs (same families, seeds and variants as
// bench/verify/v3-dec-diff.mjs) as a list, for runners that decode elsewhere (Electron main:
// bench/electron/v3-dec-diff-electron.mjs). Generated from v3-dec-diff.mjs. Uses iconv; writes nothing.
import * as neu from '../../electron/fileIO.mjs';
import * as C from './v3-dec-corpus.mjs';

export function buildInputs(SEEDS, FILTER = '') {
  const list = [];
  const bump = (fam, k) => { list.bumps ??= {}; list.bumps[fam + ' ' + k] = (list.bumps[fam + ' ' + k] || 0) + 1; };
  const emit = (fam, b, truth, label, bom) => list.push({ fam, hex: Buffer.from(b).toString('hex'), truth, label, bom });
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
          
          emit(fam, body, truth, label, false);
          if (label === 'utf-8' && r() < 0.5) { emit(fam, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]), truth, 'utf-8', true); }
          // no trailing newline
          if (body.length > 1 && body[body.length - 1] === 0x0a && r() < 0.3) {
            const cut = body.subarray(0, body.length - (body.length > 1 && body[body.length - 2] === 0x0d ? 2 : 1));
            let tr = null; try { tr = new TextDecoder(label, { fatal: true }).decode(cut); } catch {}
            if (tr !== null) { emit(fam, cut, tr, label, false); }
          }
          // cut inside the text at a random byte (a truncated file): truth only if still genuine
          if (r() < 0.3 && body.length > 2) {
            const cut = body.subarray(0, C.int(r, 1, body.length - 1));
            let tr = null; try { tr = new TextDecoder(label, { fatal: true }).decode(cut); } catch {}
            
            if (tr !== null) emit(fam, cut, tr, label, false);
            else emit(fam, cut, '\u0000never', label, false); // no truth: classes ii–v and the switch only
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
        
        emit('utf16-' + fam, b, t, label, bom);
      }
    }
  }
  function pick2(r) { return C.pick(r, ['lf', 'crlf', 'mixed']); }


  return list;
}
