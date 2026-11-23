// bench/verify/v4-sesa-markers.mjs — verify-session-a: H15 (the marker-failure path) reached by KEYS. The internal
// marker pool is U+E000–U+F8FF and U+FDD0–U+FDEF; a block that holds all but three of them leaves no free set of four.
// Cases: (a) a block holding all but U+E000–U+E003 (still editable), the user types U+E000 (CDP insertText = typing):
// nothing of that keystroke is written, the session ends with the toast, the app stays usable; (b) the same, then
// ⌘Z; (c) U3 merge of two paragraphs whose union holds every marker (the merge is a source join, the merged
// block cannot be edited); (d) Enter inside the all-but-4 block, then typing; (e) the emptied element, then the
// glyphs typed into it. After each: no page error, the source is one of the expected strings, no capture element
// holds the focus, and a click on the last block + typing works.
// Run: MDR_PORT=5431 node bench/verify/v4-sesa-markers.mjs [name-filter]   (T_MS default 110 s)
import { openB, sleep, globalTimeout, J, check, summary, view, clickText, waitSession, load } from './v4-sesa-lib.mjs';

const filter = process.argv[2] || '';
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 110_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
let ALL4 = '';                      // every marker code point except U+E000..U+E003
for (let c = 0xe004; c <= 0xf8ff; c++) ALL4 += String.fromCharCode(c);
for (let c = 0xfdd0; c <= 0xfdef; c++) ALL4 += String.fromCharCode(c);
const E0 = String.fromCharCode(0xe000), E1 = String.fromCharCode(0xe001), E2 = String.fromCharCode(0xe002), E3 = String.fromCharCode(0xe003);
const insert = async (t) => { const c = await B.getCdp(); await c.send('Input.insertText', { text: t }); };
const usable = async (orig) => {
  await page.keyboard.press('Escape'); await settle();
  await clickText(page, 'end zz', 5, { side: 'right' }); const v = await waitSession(page);
  await page.keyboard.type('Y'); await settle(500);
  const s = await B.source();
  await page.keyboard.press('Escape'); await settle();
  return { ok: !!v.editing && s.endsWith('end zzY\n'), s };
};
const cases = [
  ['type-last-marker', `Glyphs ${ALL4} tail\n\nend zz\n`, async () => {
    await clickText(page, 'Glyphs', 2, { side: 'right' }); await waitSession(page);
    await page.keyboard.press('End'); await insert(E0); await settle(600);
    return (s) => s === `Glyphs ${ALL4} tail\n\nend zz\n` || s === `Glyphs ${ALL4} tail${E0}\n\nend zz\n`;
  }],
  ['type-last-marker-undo', `Glyphs ${ALL4} tail\n\nend zz\n`, async () => {
    await clickText(page, 'Glyphs', 2, { side: 'right' }); await waitSession(page);
    await page.keyboard.type('Q'); await settle(500);
    await page.keyboard.press('End'); await insert(E0); await settle(600);
    await page.keyboard.press('Meta+z'); await settle(600);
    return (s) => s === `Glyphs ${ALL4} tail\n\nend zz\n` || s === `GQlyphs ${ALL4} tail\n\nend zz\n` || s === `GlQyphs ${ALL4} tail\n\nend zz\n`;
  }],
  ['merge-union', `aa ${ALL4}\n\nb1 ${E0}${E1}${E2}${E3} yy\n\nend zz\n`, async () => {
    await clickText(page, 'yy', 1, { side: 'right' }); await waitSession(page);
    await page.keyboard.press('Meta+ArrowLeft'); await page.keyboard.press('Backspace'); await settle(600);
    await page.keyboard.type('Q'); await settle(600);
    return (s) => s === `aa ${ALL4}b1 ${E0}${E1}${E2}${E3} yy\n\nend zz\n` || s === `aa ${ALL4}\n\nb1 ${E0}${E1}${E2}${E3} yy\n\nend zz\n` || s === `aa ${ALL4}Qb1 ${E0}${E1}${E2}${E3} yy\n\nend zz\n`;
  }],
  ['enter-in-block', `Glyphs ${ALL4} tail\n\nend zz\n`, async () => {
    await clickText(page, 'tail', 2, { side: 'right' }); await waitSession(page);
    await page.keyboard.press('Enter'); await settle(600); await page.keyboard.type('Q'); await settle(600);
    return (s) => s === `Glyphs ${ALL4} ta\n\nQil\n\nend zz\n`;
  }],
  ['gone-type-glyphs', `aa\n\nxx para\n\nend zz\n`, async () => {
    await clickText(page, 'xx para', 2, { side: 'right' }); await waitSession(page);
    await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace'); await settle(600);
    await insert(ALL4 + E0); await settle(800);
    return (s) => s === 'aa\n\nend zz\n';
  }],
  ['gone-type-glyphs-bs', `aa\n\nxx para\n\nend zz\n`, async () => {
    await clickText(page, 'xx para', 2, { side: 'right' }); await waitSession(page);
    await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace'); await settle(600);
    await insert(ALL4 + E0); await page.keyboard.press('Backspace'); await settle(800);
    return (s) => s === 'aa\n\nend zz\n';
  }],
];
try {
  await B.boot('mode=split');
  for (const [name, doc, run] of cases) {
    if (filter && !name.includes(filter)) continue;
    try {
      await load(B, doc);
      const want = await run();
      const v = await view(page);
      const ok1 = want(v.src);
      const errs = B.pageErrors.splice(0);
      const cap = v.capFocused;
      const u = await usable(doc);
      const ok = ok1 && errs.length === 0 && !cap && u.ok;
      const short = (s) => J(s.replace(new RegExp(`[${String.fromCharCode(0xe004)}-${String.fromCharCode(0xf8ff)}${String.fromCharCode(0xfdd0)}-${String.fromCharCode(0xfdef)}]+`, 'g'), '<PUA>'));
      check(name, ok, `src=${short(v.src)} toast=${J(v.toast.slice(0, 30))} editing=${v.editing ? 'yes' : 'no'} cap=${cap} pageErrors=${J(errs.map((e) => e.slice(0, 120)))} usable=${u.ok ? 'ok' : 'BAD ' + short(u.s)}`);
    } catch (e) { check(name, false, 'threw ' + String(e.message).split('\n')[0]); }
    try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
  }
} finally { summary(); stop(); await B.close(); }
