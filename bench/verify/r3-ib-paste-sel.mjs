// bench/verify/r3-ib-paste-sel.mjs — fix-session-b (round 3): U19 / H14, a paste over a selection replaces exactly the
// selection. For each document and selection: (a) paste T with the real ⌘V, (b) TYPE T over the same selection on a
// freshly loaded document; both sources must be equal (and contain no &nbsp; the document did not have). Then ⌘Z after
// the paste: one step, byte for byte the original. Multi-paragraph pastes have a fixed expectation instead.
//   MDR_PORT=5411 node bench/verify/r3-ib-paste-sel.mjs [name-filter]          (exit code 1 on a failure)
import { openB, sleep, globalTimeout, J, check, summary, view, clickText, pointOf, undoTo } from './v3-ses-lib.mjs';

const filter = process.argv[2] || '';
const B = await openB({ clipboard: true });
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), B.close);
const { page } = B;
const settle = async (ms = 350) => { await sleep(ms); await B.settle(200); };
async function waitSession(ms = 2000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await view(page); if (v.editing && !v.capFocused) return v; await sleep(30); }
  return view(page);
}
/** Loads `doc`, starts a session on `click`, makes the selection `how` says: ['dbl', word] (a real double click),
 *  ['sel', needle] (inside one text node), ['join', needle] (across element boundaries). */
async function prepare(doc, click, how) {
  await B.loadDoc(doc);
  await B.mountLine(1);
  await sleep(650);
  if (how[0] === 'dbl') {
    const p = await pointOf(page, how[1], 1);
    await page.mouse.dblclick(p.x, p.y);
    await sleep(250);
    // the session starts on the release; the double click's word selection stays
    await waitSession();
  } else {
    await clickText(page, click, click.length - 1, { side: 'right' });
    if (!(await waitSession()).editing) throw new Error('no session');
    if (how[0] === 'sel') await B.selectText(how[1]); else await B.joined(how[1], 'select');
  }
  return page.evaluate(() => getSelection().toString());
}
async function paste(text) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press('Meta+v');
}

const CASES = [
  // name, doc, block to click, selection, text, expected (null: equal to typing the text)
  ['dblclick-word', 'Some words here to replace now.\n\nz\n', 'words', ['dbl', 'here'], 'there', null],
  ['dblclick-first-word', 'Some words here.\n\nz\n', 'words', ['dbl', 'Some'], 'One', null],
  ['dblclick-last-word', 'Some words here\n\nz\n', 'words', ['dbl', 'here'], 'there', null],
  ['sel-ends-in-space', 'abc def ghi\n\nz\n', 'abc', ['sel', 'def '], 'X', null],
  ['sel-starts-with-space', 'abc def ghi\n\nz\n', 'abc', ['sel', ' def'], 'X', null],
  ['sel-word', 'abc def ghi\n\nz\n', 'abc', ['sel', 'def'], 'X', null],
  ['sel-whole-paragraph', 'abc def ghi\n\nz\n', 'abc', ['sel', 'abc def ghi'], 'X', null],
  ['sel-across-bold', 'abc **def** ghi\n\nz\n', 'abc', ['join', 'c de'], 'X', null],
  ['sel-across-bold-spaces', 'abc **def** ghi\n\nz\n', 'abc', ['join', ' def '], 'X', null],
  ['sel-across-two-items', '- one two\n- three four\n\nz\n', 'one', ['join', 'two\nthree'], 'X', null],
  ['sel-across-two-paras-in-quote', '> one two\n>\n> three four\n\nz\n', 'one', ['join', 'two\nthree'], 'X', null],
  ['sel-in-code', '```\nabc def ghi\n```\n\nz\n', 'abc', ['sel', 'def'], 'X', null],
  ['sel-in-code-space', '```\nabc def ghi\n```\n\nz\n', 'abc', ['sel', ' def'], 'X', null],
  ['sel-in-cell', '| h |\n|---|\n| abc def ghi |\n\nz\n', 'abc', ['sel', 'def'], 'X', null],
  ['sel-in-heading', '# abc def ghi\n\nz\n', 'abc', ['sel', 'def'], 'X', null],
  ['paras-over-word', 'abc def ghi\n\nz\n', 'abc', ['sel', 'def'], 'X\n\nY', 'abc X\n\nY ghi\n\nz\n'],
  ['paras-over-dblclick', 'Some words here to replace now.\n\nz\n', 'words', ['dbl', 'here'], 'X\n\nY', 'Some words X\n\nY to replace now.\n\nz\n'],
  ['lines-over-word', 'abc def ghi\n\nz\n', 'abc', ['sel', 'def'], 'X\nY', 'abc X  \nY ghi\n\nz\n'],
];

let bad = 0;
try {
  await B.boot('mode=split');
  for (const [name, doc, click, how, text, exp] of CASES) {
    if (filter && !name.includes(filter)) continue;
    try {
      const sel1 = await prepare(doc, click, how);
      await paste(text);
      await settle();
      const pasted = (await view(page)).src;
      const u = await undoTo(B, doc, 3);
      let typed = null, sel2 = null;
      if (exp === null) {
        await page.keyboard.press('Escape'); await settle(120);
        sel2 = await prepare(doc, click, how);
        await page.keyboard.type(text);
        await settle();
        typed = (await view(page)).src;
      }
      const want = exp ?? typed;
      // (an &nbsp; that TYPING over the selection writes too is Chromium's typing, not the paste's: equality decides)
      const nbsp = pasted.includes('&nbsp;') && !doc.includes('&nbsp;') && !(typed ?? '').includes('&nbsp;');
      const ok = pasted === want && !nbsp && u.ok && u.n === 1 && (exp !== null || sel1 === sel2);
      if (!check(name, ok, `sel=${J(sel1)}${sel2 !== null && sel2 !== sel1 ? ' typedSel=' + J(sel2) : ''} pasted=${J(pasted)} ${exp === null ? 'typed' : 'exp'}=${J(want)} undo=${u.ok ? u.n + ' step(s)' : 'FAIL ' + J(u.now)}`)) bad++;
    } catch (e) { bad++; check(name, false, 'threw ' + String(e.message).split('\n')[0]); }
    try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
  }
  console.log('pageErrors', J(B.pageErrors.slice(0, 3)), 'console', J(B.consoleErrors.filter((x) => !/DevTools|Download/.test(x)).slice(0, 3)));
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
