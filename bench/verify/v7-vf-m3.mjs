// bench/verify/v7-vf-m3.mjs — verify-refs (round 6): M3 and the neighbourhood of P-G (c). The session's bold / italic
// commands on documents with inline-styled raw HTML (spans with font-weight / font-style / color / the font shorthand,
// nested spans, a styled span in a list item and in a quote), then: type, undo, a join from the paragraph below.
// Checks per case: (1) what the screen showed at Esc (per character: computed font-weight, font-style, color) is what
// the source renders after Esc; (2) no style declaration appears in the source that neither the source nor the
// command could have put there (a style attribute with a property the source did not have); (3) where the case undoes
// the command, the source is the original byte for byte; (4) the guard's console lines.
// Run: MDR_PORT=<server with hooks> node bench/verify/v7-vf-m3.mjs [filter]   (T_MS, default 110000)
import { launch, openApp, load, source, toasts, clickAt, caret, esc, strDiff, show, globalTimeout, sleep } from './v7-vf-lib.mjs';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = new RegExp(process.argv[2] ?? '.');
const T_MS = Number(process.env.T_MS ?? 110000);
const key = (k, ms = 150) => async (A) => { await A.page.keyboard.press(k); await sleep(ms); };
const type = (t) => async (A) => { await A.page.keyboard.type(t, { delay: 10 }); await sleep(80); };
const sel = (n, o, l) => async (A) => { if (!(await caret(A, n, o, l))) throw new Error('caret ' + n); };
const startOfBelow = async (A) => A.page.evaluate(() => {
  const el = document.querySelector('.md-block.is-editing'); const t = el.querySelector('p:last-of-type') ?? el;
  const r = document.createRange(); r.setStart(t, 0); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
});
const P = (b) => `# M3\n\n${b}\n\nbelow para words\n`;
const CASES = [
  ['unbold-part', P('前文 <span style="font-weight: bold">粗体文字 here</span> 后面 words'), 'words', [sel('粗体文字', 2, 2), key('Meta+b')]],
  ['unbold-whole', P('前文 <span style="font-weight: 700">整段粗体</span> 后面 words'), 'words', [sel('整段粗体', 0, 4), key('Meta+b')]],
  ['unitalic-part-color', P('前文 <span style="font-style: italic; color: red">斜体红字 here</span> 后面 words'), 'words', [sel('斜体红字', 2, 2), key('Meta+i')]],
  ['bold-in-color-span', P('前文 <span style="color: blue">蓝色文字 here</span> 后面 words'), 'words', [sel('蓝色文字', 2, 2), key('Meta+b')]],
  ['italic-in-class-span', P('前文 <span class="note">注释文字 here</span> 后面 words'), 'words', [sel('注释文字', 0, 2), key('Meta+i')]],
  ['shorthand-unbold', P('前文 <span style="font: bold 16px serif">简写粗体 here</span> 后面 words'), 'words', [sel('简写粗体', 0, 2), key('Meta+b')]],
  ['nested-unbold', P('前文 <span style="color: green"><span style="font-weight: bold">嵌套粗体 here</span></span> 后面 words'), 'words', [sel('嵌套粗体', 1, 2), key('Meta+b')]],
  ['unbold-type', P('前文 <span style="font-weight: bold">粗体文字 here</span> 后面 words'), 'words', [sel('粗体文字', 2, 2), key('Meta+b'), type('新')]],
  ['unbold-undo', P('前文 <span style="font-weight: bold">粗体文字 here</span> 后面 words'), 'words', [sel('粗体文字', 2, 2), key('Meta+b', 700), key('Meta+z', 500)], 'orig'],
  ['italic-twice', P('前文 <span style="font-style: italic">斜体文字 here</span> 后面 words'), 'words', [sel('斜体文字', 0, 4), key('Meta+i'), key('Meta+i')]],
  ['unbold-then-join', P('前文 <span style="font-weight: bold">粗体文字 here</span> 后面 words'), 'words', [sel('粗体文字', 2, 2), key('Meta+b', 500), async (A) => { await A.page.keyboard.press('Escape'); await sleep(500); await clickAt(A, 'below para', 0, 2); await caret(A, 'below para', 0); await A.page.keyboard.press('Backspace'); await sleep(500); await type('Q')(A); }]],
  ['join-into-styled', P('前文 <span style="font-weight: bold; color: red">粗红 here</span>'), 'below', [sel('below para', 0), key('Backspace', 500), type('Q')]],
  ['list-unbold', '# M3\n\n- 项目 <span style="font-weight: bold">粗体项 here</span> words\n- 第二项\n', 'words', [sel('粗体项', 0, 2), key('Meta+b')]],
  ['quote-unitalic', '# M3\n\n> 引用 <span style="font-style: italic">斜体引用 here</span> words\n', 'words', [sel('斜体引用', 2, 2), key('Meta+i')]],
  ['bold-plain-then-unbold-span', P('普通 plain 文字 <span style="font-weight: bold">粗体 here</span> words'), 'words', [sel('plain', 0, 5), key('Meta+b'), sel('粗体', 0, 2), key('Meta+b')]],
  ['unbold-part-toolbar', P('前文 <span style="font-weight: bold">粗体文字 here</span> 后面 words'), 'words', [sel('粗体文字', 2, 2), async (A) => { await A.page.click('[data-cmd="edit.bold"]'); await sleep(200); }]],
  ['unitalic-toolbar-shorthand', P('前文 <span style="font: italic 15px serif">简写斜体 here</span> 后面 words'), 'words', [sel('简写斜体', 0, 2), async (A) => { await A.page.click('[data-cmd="edit.italic"]'); await sleep(200); }]],
  ['shorthand-bold-plain-part', P('前文 <span style="font: 15px serif">简写正常 here</span> 后面 words'), 'words', [sel('简写正常', 0, 2), key('Meta+b')]],
  ['unbold-across-span-edge', P('前文 <span style="font-weight: bold">粗体 here</span> 后面 words'), 'words', [sel('here', 2, 2), async (A) => { await A.page.evaluate(() => { const s = getSelection(); const r = s.getRangeAt(0); const el = document.querySelector('.md-block.is-editing'); const tw = document.createTreeWalker(el, 4); for (let n = tw.nextNode(); n; n = tw.nextNode()) if (n.data.includes('后面')) { r.setEnd(n, n.data.indexOf('后面') + 1); break; } s.removeAllRanges(); s.addRange(r); }); }, key('Meta+b')]],
];
const FILTERED = CASES.filter((c) => filter.test(c[0]));

/** Per character of the block (text order): computed weight / style / color. */
const look = (A, editingBlock) => A.page.evaluate((editingBlock) => {
  const root = window.__mdr.app.preview.el;
  const blocks = Array.from(root.querySelectorAll('.md-block'));
  const el = editingBlock ? root.querySelector('.md-block.is-editing') : blocks[1];
  if (!el) return null;
  const out = [];
  const tw = document.createTreeWalker(el, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const cs = getComputedStyle(n.parentElement);
    const w = Number(cs.fontWeight) >= 600 ? 'B' : 'n', i = cs.fontStyle === 'italic' ? 'I' : 'n';
    for (const c of n.data) if (c.trim() && c.codePointAt(0) !== 0x200b) out.push(c + w + i + cs.color.replace(/\s/g, ''));
  }
  return out.join('|');
}, editingBlock);
const props = (s) => new Set([...s.matchAll(/style="([^"]*)"/g)].flatMap((m) => m[1].split(';').map((d) => d.split(':')[0].trim()).filter(Boolean)));

let browser;
const stop = globalTimeout(T_MS, async () => browser?.close());
let bad = 0;
try {
  browser = await launch();
  const A = await openApp(browser, port, { perf: true });
  for (const [name, doc, needle, steps, expect] of FILTERED) {
    A.guard.length = 0;
    await load(A, doc, name + '.md');
    const t0 = await toasts(A);
    const on = await clickAt(A, needle, 0, 1);
    let err = null, seen = null;
    if (on) {
      try { for (const s of steps) await s(A); } catch (e) { err = String(e.message || e); }
      await sleep(300);
      seen = await look(A, true);
    }
    await esc(A);
    await sleep(300);
    const out = await source(A);
    const after = await look(A, false);
    const tt = (await toasts(A)) - t0;
    const invented = [...props(out)].filter((p) => !props(doc).has(p));
    const sameLook = seen == null || name.includes('join') ? null : seen === after;
    const origOk = expect === 'orig' ? out === doc : null;
    const ok = on && !err && invented.length === 0 && sameLook !== false && origOk !== false && !A.guard.length;
    if (!ok) bad++;
    const d = strDiff(doc, out);
    console.log(`${ok ? 'ok ' : 'BAD'} ${name}: session=${on} look=${sameLook} invented=${invented.join(',') || '-'} orig=${origOk} guard=${A.guard.length} toast=${tt} del=${show(d.del)} ins=${show(d.ins)}${err ? ' ERR ' + err : ''}`);
    if (sameLook === false || process.env.VERBOSE) console.log('    seen  ' + seen + '\n    after ' + after);
    if (process.env.VERBOSE) console.log('    source ' + show(out));
  }
  console.log(`RESULT bad=${bad} of ${FILTERED.length}`);
} finally { stop(); await browser?.close(); }
