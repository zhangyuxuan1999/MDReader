// v3-dec-inputs2.mjs — a second input set for the v3-dec differential, aimed at where the Electron
// decoders (Chromium ICU: euc-kr = windows-949 / UHC, big5 with HKSCS) differ from the system Node:
// GBK-extension names (G24), random GBK/3 + GBK/4 strings, Cyrillic / Greek / Turkish / Baltic single-byte
// text, Korean with UHC-only syllables, random high-byte noise. Used by
// bench/electron/v3-dec-diff-electron.mjs (INPUTS=2) and runnable in Node the same way. Writes nothing.
import * as neu from '../../electron/fileIO.mjs';
import * as C from './v3-dec-corpus.mjs';

const EXT = '堃喆昇犇淼玥珺婕甯赟镕滢祎昕晞翀珏琰瑄瑀璟曌燊鑫頔骐骞靓炜煜熠桦槿筱羿翊蕾薇芃芮茜荻莘菁萱蓁蔚濛灏';
const RU = ['Москва — столица России.', 'Сегодня хорошая погода, пойдём гулять.', 'Совещание начнётся в три часа дня.', 'Пожалуйста, сохраните файл перед закрытием программы.', 'Съешь же ещё этих мягких французских булок.'];
const EL = ['Η Αθήνα είναι η πρωτεύουσα της Ελλάδας.', 'Σήμερα ο καιρός είναι καλός.', 'Παρακαλώ αποθηκεύστε το αρχείο.'];
const TR = ['Türkçe öğrenmek güzeldir, değil mi?', 'Bugün hava çok güzel, dışarı çıkalım.', 'Lütfen dosyayı kaydedin; şimdi kapatıyoruz.'];
const LT = ['Lietuvių kalba yra gražiausia.', 'Šiandien gražus oras, eikime pasivaikščioti.', 'Latviešu valoda: ūdens, ķēķis, ļoti.'];
// UHC-only syllables (not in KS X 1001): written by Windows (CP949), readable only with windows-949
const KO_UHC = ['똠방각하 뷁 쀍 햏', '갂 갃 갅 갆 갋', '쌰 썅 쓩 똥꼬', '뚫훑 얽힌 붉은'];

export function buildInputs2(SEEDS, FILTER = '') {
  const list = [];
  const gbkT = neu.legacyEncoderTable('gbk');
  const emit = (fam, b, truth, label, bom = false) => { if (b && (!FILTER || fam.includes(FILTER))) list.push({ fam, hex: Buffer.from(b).toString('hex'), truth, label, bom }); };
  // GBK/3 (lead 81–A0) and GBK/4 (lead AA–FE, trail 40–A0) characters, as the decoder sees them
  const ext = [];
  for (const [ch, b] of gbkT) if (b.length === 2 && ((b[0] >= 0x81 && b[0] <= 0xa0) || (b[0] >= 0xaa && b[1] <= 0xa0))) ext.push(ch);
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = C.rng(seed * 2654435761);
    // G24: names of rare characters, with and without surnames / separators
    {
      let s = '';
      for (let i = 0, n = C.int(r, 4, 60); i < n; i++) s += (i % 3 === 0 ? C.pick(r, C.SURNAMES) : EXT[C.int(r, 0, EXT.length - 1)]) + (r() < 0.3 ? '、' : '');
      s += r() < 0.7 ? '\n' : '';
      emit('g24-names', C.tableEncode(s, gbkT), s, 'gbk');
    }
    {
      let s = '';
      for (let i = 0, n = C.int(r, 12, 60); i < n; i++) s += C.pick(r, ext);
      emit('g24-random-ext', C.tableEncode(s, gbkT), s, 'gbk');
      const s2 = '# ' + s.slice(0, 10) + '\n\n- ' + s.slice(10) + '\n';
      emit('g24-random-ext-md', C.tableEncode(s2, gbkT), s2, 'gbk');
    }
    for (const [pool, labels, fam] of [[RU, ['CP1251', 'KOI8-R', 'CP866', 'ISO-8859-5'], 'cyr'], [EL, ['CP1253', 'ISO-8859-7'], 'greek'], [TR, ['CP1254', 'ISO-8859-9'], 'turkish'], [LT, ['CP1257', 'ISO-8859-13'], 'baltic']]) {
      const s = C.sbText(r, pool);
      const l = C.pick(r, labels);
      const b = C.iconvEncode(s, l);
      const wl = { CP1251: 'windows-1251', 'KOI8-R': 'koi8-r', CP866: 'ibm866', 'ISO-8859-5': 'iso-8859-5', CP1253: 'windows-1253', 'ISO-8859-7': 'iso-8859-7', CP1254: 'windows-1254', 'ISO-8859-9': 'windows-1254', CP1257: 'windows-1257', 'ISO-8859-13': 'iso-8859-13' }[l];
      emit(`${fam}-${l}`, b, s, wl);
    }
    {
      let s = '';
      for (let i = 0, n = C.int(r, 1, 6); i < n; i++) s += C.pick(r, r() < 0.5 ? KO_UHC : C.KO_SENT) + '\n';
      emit('ko-uhc', C.iconvEncode(s, 'CP949'), s, 'euc-kr');
    }
    {
      // random noise: high bytes mixed with ASCII, lengths 1–400 (no truth)
      const n = C.int(r, 1, 400);
      const b = Buffer.alloc(n);
      const hi = r();
      for (let i = 0; i < n; i++) b[i] = r() < hi ? C.int(r, 0x80, 0xff) : C.int(r, 0x20, 0x7e);
      emit('noise', b, String.fromCharCode(0) + 'no truth', 'none');
    }
  }
  return list;
}
