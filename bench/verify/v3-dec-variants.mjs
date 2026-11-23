// v3-dec-variants.mjs — r1 variations G22 / G24 / G25 and threshold probes for the S4 decoder
// (verify-decoder, stage 2c). Writes nothing. node bench/verify/v3-dec-variants.mjs
// Each line: case | 0.1.0 reading | candidate reading | verdict (OK / REGRESSION / note).
// S4 (f) (fix-decoder, stage 2d): 0.2.0 ships with DECODER_OVERRIDES off, so by default the candidate is
// the default decodeBuffer and every "expected" below is the 0.1.0 reading. MDR_DECODER_OVERRIDES=1
// decodes with the dormant overrides (decodeBuffer(buf, true)) against the old expectations.
import * as neu from '../../electron/fileIO.mjs';
import * as old from '../../test/fixtures/fileIO-0.1.0.mjs';
import * as C from './v3-dec-corpus.mjs';

const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000);
const FFFD = String.fromCharCode(0xfffd);
const NUL = String.fromCharCode(0);
const dec = (f, b, ...a) => { try { return f(b, ...a); } catch (e) { return { refused: true }; } };
const OV = process.env.MDR_DECODER_OVERRIDES === '1';
const ovArgs = OV ? [true] : [];
const brief = (d) => d.refused ? 'REFUSED' : `${d.encoding}${d.bom ? '+bom' : ''}${d.replaced ? ` repl=${d.replaced}` : ''}`;
let regressions = 0;
const rows = [];
function run(name, b, truth, label, opts = {}) {
  const o = dec(old.decodeBuffer, b);
  const n = dec(neu.decodeBuffer, b, ...ovArgs);
  const oRight = !o.refused && o.text === truth && o.encoding === label;
  const nRight = !n.refused && n.text === truth && n.encoding === label;
  let v = 'OK';
  if (oRight && !nRight) { v = 'REGRESSION(i)'; regressions++; }
  else if (n.refused && !o.refused) { v = 'REGRESSION(ii)'; regressions++; }
  else if (!o.refused && !n.refused && !n.replaced) {
    const so = old.encodeText(o.text, { encoding: o.encoding, bom: o.bom, eol: old.eolOf(o.text) });
    const t = n.replaced ? undefined : neu.saveTableOf(n.text, n.encoding, b);
    let sn = null; try { sn = neu.encodeText(n.text, { encoding: n.encoding, bom: n.bom, eol: neu.eolOf(n.text), ...(t ? { table: t } : {}) }); } catch {}
    if (so.equals(b) && !(sn && sn.equals(b))) { v = 'REGRESSION(iii)'; regressions++; }
  }
  if (opts.expect && v === 'OK' && opts.expect !== brief(n)) v = `note: expected ${opts.expect}`;
  rows.push(`${name} | ${brief(o)}${oRight ? ' (right)' : ''} | ${brief(n)}${nRight ? ' (right)' : ''} | ${v}`);
  return { o, n };
}
const gbk = (s) => C.tableEncode(s, neu.legacyEncoderTable('gbk'));
const cp = (s, l) => C.iconvEncode(s, l);

// ---- G22 variations: lenient readings need evidence (Latin text; NUL-padded GBK)
for (const s of ['Ação e atenção às 9h. Não é fácil!', 'Größe: 3 Maße, Übung', 'Þórsmörk: ferð í dag', 'Ça coûte 12,50 € — très cher…', 'Æble, ø og å på dansk']) {
  run(`G22 cp1252 «${s.slice(0, 18)}»`, cp(s + '\n', 'CP1252'), s + '\n', 'windows-1252');
}
// CP1252 that holds UTF-8-looking pairs (Â + symbol): Latin text quoting prices / degrees
run('G22 cp1252 with Â/Ã pairs x9', cp('Temp 20Â° ' + 'Ã© '.repeat(9) + 'ÿ\n', 'CP1252'), 'Temp 20Â° ' + 'Ã© '.repeat(9) + 'ÿ\n', 'windows-1252');
for (const pad of [1, 16, 100, 4000]) {
  const body = gbk('# 标题\n\n这是一段中文。\n');
  run(`G22 GBK + ${pad} NUL`, Buffer.concat([body, Buffer.alloc(pad)]), null, 'none');
}
// GBK whose characters are UTF-8-shaped (lead C2–DF, trail A1–BF): repeated 小时 / 元 / 千元
const sheet = (rows, unit, head) => `# ${head}\n\n| 日期 | 时长 |\n|---|---|\n` + Array.from({ length: rows }, (_, i) => `| 11-${String(i + 1).padStart(2, '0')} | ${8 + (i % 3)}${unit} |`).join('\n') + '\n';
for (const [rowsN, unit, head] of [[5, '小时', '工时'], [10, '小时', '工时'], [20, '小时', '工时'], [20, '元', '支出'], [30, '千元', '预算'], [12, '小时', '加班记录'], [40, '小时', '十一月工时统计表']]) {
  const t = sheet(rowsN, unit, head);
  run(`G22/i GBK sheet ${rowsN}×${unit} head=${head}`, gbk(t), t, 'gbk');
}
// a GBK note: a few lines of prose plus a 20-line log of durations
{
  const t = '# 跑步记录\n\n每天晚上跑步，记录用时。\n\n' + Array.from({ length: 20 }, (_, i) => `- 11/${i + 1} 1小时`).join('\n') + '\n';
  run('G22/i GBK run log 20 lines + prose', gbk(t), t, 'gbk');
  const t2 = '# 跑步记录\n\n' + Array.from({ length: 20 }, (_, i) => `- 11/${i + 1} 1小时`).join('\n') + '\n';
  run('G22/i GBK run log 20 lines', gbk(t2), t2, 'gbk');
}

// ---- G24 variations: clean GBK of GBK-extension characters (names, traditional forms) stays GBK
const EXT = '堃 喆 昇 犇 淼 玥 珺 婕 甯 赟 镕 滢 祎 昕 晞 翀 珏 琰 瑄 瑀 璟 曌 燊 鑫 頔 骐 骞 靓 炜 煜 熠 桦 槿 筱 羿 翊 蕾 薇 芃 芮 茜 荻 莘 菁 萱 蓁 蔚 濛 灏'.split(' ');
const r = C.rng(424242);
for (let k = 0; k < 400; k++) {
  const n = C.int(r, 4, 60);
  let s = '';
  for (let i = 0; i < n; i++) s += (i % 3 === 0 ? C.pick(r, C.SURNAMES) : C.pick(r, EXT)) + (r() < 0.3 ? '、' : '');
  const b = gbk(s + '\n');
  if (!b) continue;
  const { n: nn } = run(`G24 GBK ext names #${k} (${n})`, b, s + '\n', 'gbk');
  if (nn.encoding === 'gbk' && !nn.refused) rows.pop(); // keep the output short: only failures
}
{
  const s = '這個軟體的說明書寫得很清楚。臺灣颱風季節，請做好準備。';
  run('G24 traditional written in GBK', gbk(s + '\n'), s + '\n', 'gbk');
}

// ---- G25 variations: windows-1252 readings with 81 / 8D / 8F / 90 / 9D (Czech, Slovak, plus raw)
for (const [s, l] of [['Příliš žluťoučký kůň úpěl ďábelské ódy.', 'CP1250'], ['Ťažký úťah, ďalší môj kôň.', 'CP1250'], ['Źródło: Łódź, żółw.', 'CP1250']]) {
  const b = cp(s + '\n', l);
  const o = dec(old.decodeBuffer, b);
  run(`G25 ${l} «${s.slice(0, 16)}» bytes ${[...b].filter((x) => [0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(x)).length}`, b, o.refused ? null : o.text, o.encoding || 'none');
}
for (const byte of [0x81, 0x8d, 0x8f, 0x90, 0x9d]) {
  const b = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9, 0x20, byte]), Buffer.from(' ok\n')]);
  const o = dec(old.decodeBuffer, b);
  run(`G25 raw 0x${byte.toString(16)} after é`, b, o.refused ? null : o.text, o.encoding || 'none');
}

// ---- lenient UTF-8 thresholds (8 valid multi-byte characters, 90 %)
const u = (s) => Buffer.from(s, 'utf8');
for (const valid of [7, 8, 9]) {
  const b = Buffer.concat([u('# ' + '中'.repeat(valid) + '\n'), Buffer.from([0xff]), u('\n')]);
  const { o, n } = run(`lenient ${valid} valid + 1 bad`, b, null, 'none');
  rows.push(`   -> candidate ${brief(n)}; expected ${!OV ? `${brief(o)} (0.1.0, S4 (f))` : valid >= 8 ? 'utf-8 repl=1' : 'not lenient'}`);
}
for (const [valid, runs] of [[9, 1], [18, 2], [17, 2], [90, 10], [89, 10]]) {
  const parts = [];
  for (let i = 0; i < valid; i++) parts.push(u('文'));
  for (let i = 0; i < runs; i++) parts.splice(Math.floor((i + 1) * parts.length / (runs + 1)), 0, Buffer.from([0x20, 0xff, 0x20]));
  const { o, n } = run(`lenient ${valid} valid / ${runs} damage runs (score ${(valid / (valid + runs)).toFixed(3)})`, Buffer.concat(parts), null, 'none');
  rows.push(`   -> candidate ${brief(n)}; expected ${!OV ? `${brief(o)} (0.1.0, S4 (f))` : valid / (valid + runs) >= 0.9 ? 'lenient' : 'not lenient'}`);
}
// one damage RUN of many bytes counts once: 10 valid characters + 60 invalid bytes in a row
{
  const b = Buffer.concat([u('# 一二三四五六七八九十\n'), Buffer.alloc(60, 0xff), u('\n')]);
  const { n } = run('lenient 10 valid + one 60-byte run', b, null, 'none');
  rows.push(`   -> candidate ${brief(n)} (valid share by character ${(10 / 70).toFixed(2)})`);
}
// control density in a strict UTF-8 file (binary rule: > 50 % hard controls)
for (const share of [0.3, 0.49, 0.5, 0.51, 0.8]) {
  const len = 400;
  const k = Math.round(len * share);
  const s = NUL.repeat(k) + 'a'.repeat(len - k);
  const { o, n } = run(`binary rule ${share * 100}% NUL (strict UTF-8)`, Buffer.from(s, 'latin1'), s, 'utf-8');
  rows.push(`   -> ${brief(o)} / ${brief(n)}`);
}
for (const share of [0.02, 0.1, 0.3]) {
  const len = 400; const k = Math.round(len * share);
  const s = String.fromCharCode(0x1b).repeat(k) + 'a'.repeat(len - k);
  run(`ESC ${share * 100}% (ANSI log)`, Buffer.from(s, 'latin1'), s, 'utf-8');
}

console.log(rows.join('\n'));
console.log(`\nregressions: ${regressions}`);
clearTimeout(killer);
void FFFD;
