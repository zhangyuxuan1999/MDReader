// bench/verify/v3-app-ident.mjs — verify-app (0.2.0 stage 2c): the U9 emptied-block path against the
// block identity rule (createPreview: unkeepReusedId / held). When the emptied block has a byte-identical
// neighbour, the structure update can hand the deleted block's id to the neighbour — the same situation the
// U14 change addresses for a first block with a leading blank line. Empty a block, then: type N (must land
// where the emptied block was), or Esc (nothing more), or ⌘Z (restores), and check source + screen.
// Needs a renderer on MDR_PORT (candidate: npx vite --port 5383 --strictPort). Writes nothing into the tree.
// Run: MDR_PORT=5383 node bench/verify/v3-app-ident.mjs [case-filter]
import { openBrowser, step, assert, finish, sleep } from './v2-app-lib.mjs';

await (await import('./v2-app-lib.mjs')).ensureServer();   // starts vite on MDR_PORT when nothing answers there (stopped at exit)
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const only = process.argv[2] ?? '';
const B = await openBrowser();
const { page } = B;

/** Emptied block selected by its occurrence index among paragraphs/headings/items whose text === needle. */
async function startOn(needle, nth) {
  const pt = await page.evaluate(({ needle, nth }) => {
    const els = [...document.querySelectorAll('.mdr-preview section.md-block')].filter((e) => e.textContent.trim() === needle);
    const el = els[nth];
    if (!el) return null;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.data.trim() ? 1 : 2) });
    const n = w.nextNode();
    const k = n.data.length > 1 ? 1 : 0; const r = document.createRange(); r.setStart(n, k); r.setEnd(n, k + 1);
    const b = r.getBoundingClientRect();
    return { x: b.left + 1, y: b.top + b.height / 2 };
  }, { needle, nth });
  if (!pt) throw new Error(`no block "${needle}" #${nth}`);
  await page.mouse.click(pt.x, pt.y);
  await sleep(120);
  assert(await B.editing(), 'no session');
}
async function emptyIt() {
  await page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const r = document.createRange(); r.selectNodeContents(el.querySelector('p, h1, h2, h3, li, td') ?? el);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.keyboard.press('Backspace');
  await sleep(150);
}
const screen = () => page.evaluate(() => [...document.querySelectorAll('.mdr-preview section.md-block')]
  .filter((e) => !e.closest('.md-ghost-holder') && e.getBoundingClientRect().height > 0).map((e) => e.textContent.trim()).filter(Boolean));

const DOCS = [
  // [name, doc, needle, nth, after typing N, after Esc]
  ['P-dup-first', 'A\n\nsame\n\nsame\n\nC\n', 'same', 0, 'A\n\nN\n\nsame\n\nC\n', 'A\n\nsame\n\nC\n'],
  ['P-dup-second', 'A\n\nsame\n\nsame\n\nC\n', 'same', 1, 'A\n\nsame\n\nN\n\nC\n', 'A\n\nsame\n\nC\n'],
  ['P-dup-three-mid', 'same\n\nsame\n\nsame\n', 'same', 1, 'same\n\nN\n\nsame\n', 'same\n\nsame\n'],
  ['P-dup-first-doc', 'same\n\nsame\n\nC\n', 'same', 0, 'N\n\nsame\n\nC\n', 'same\n\nC\n'],
  ['H-dup', '# T\n\n# T\n\nx\n', 'T', 0, 'N\n\n# T\n\nx\n', '# T\n\nx\n'],
  ['lead-dup', '\nsame\n\nsame\n\nC\n', 'same', 0, '\nN\n\nsame\n\nC\n', '\nsame\n\nC\n'],
  ['lead-dup2', '\nsame\n\nsame\n', 'same', 1, '\nsame\n\nN\n', '\nsame\n'],
  ['lead-ws', ' \nabc\n\nabc\n', 'abc', 0, ' \nN\n\nabc\n', ' \nabc\n'],
];

try {
  await B.boot('mode=split');
  for (const [name, doc, needle, nth, wantN, wantEsc] of DOCS) {
    if (only && !name.startsWith(only)) continue;
    await step(`${name} empty #${nth} "${needle}", type N → ${JSON.stringify(wantN)}`, async () => {
      await B.loadDoc(doc);
      await startOn(needle, nth);
      await emptyIt();
      await page.keyboard.type('N');
      await B.settle(400);
      const s1 = await B.source();
      await page.keyboard.type('M');
      await B.settle(300);
      const s2 = await B.source();
      await B.esc();
      const scr = await screen();
      assert(s1 === wantN, `after N: ${JSON.stringify(s1)}`);
      assert(s2 === wantN.replace('N', 'NM'), `after M: ${JSON.stringify(s2)}`);
      const want = wantN.replace('N', 'NM').split('\n').map((x) => x.replace(/^# /, '').trim()).filter(Boolean);
      assert(JSON.stringify(scr) === JSON.stringify(want), `screen ${JSON.stringify(scr)} vs ${JSON.stringify(want)}`);
    });
    await step(`${name} empty #${nth}, Esc → ${JSON.stringify(wantEsc)}; ⌘Z (outside) restores`, async () => {
      await B.loadDoc(doc);
      await startOn(needle, nth);
      await emptyIt();
      await B.settle(200);
      await B.esc();
      const s1 = await B.source();
      const scr = await screen();
      assert(s1 === wantEsc, `after Esc: ${JSON.stringify(s1)}`);
      const want = wantEsc.split('\n').map((x) => x.replace(/^# /, '').trim()).filter(Boolean);
      assert(JSON.stringify(scr) === JSON.stringify(want), `screen ${JSON.stringify(scr)} vs ${JSON.stringify(want)}`);
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('Meta+z');
      await B.settle(400);
      const s2 = await B.source();
      assert(s2 === doc, `after ⌘Z: ${JSON.stringify(s2)}`);
      const scr2 = await screen();
      const want2 = doc.split('\n').map((x) => x.replace(/^# /, '').trim()).filter(Boolean);
      assert(JSON.stringify(scr2) === JSON.stringify(want2), `screen after ⌘Z ${JSON.stringify(scr2)}`);
    });
    await step(`${name} empty #${nth}, then click the OTHER block and type Q → Q in that block`, async () => {
      await B.loadDoc(doc);
      await startOn(needle, nth);
      await emptyIt();
      await B.settle(200);
      const other = await page.evaluate(({ needle }) => [...document.querySelectorAll('.mdr-preview section.md-block')].filter((e) => !e.closest('.md-ghost-holder') && e.textContent.trim() === needle && !e.classList.contains('is-editing')).length, { needle });
      if (!other) return 'no other block';
      await startOn(needle, 0);
      await B.caretEnd();
      await page.keyboard.type('Q');
      await B.settle(400);
      await B.esc();
      const s = await B.source();
      assert(s === wantEsc.replace(needle, needle + 'Q'), `source ${JSON.stringify(s)}`);
      const scr = await screen();
      const want = wantEsc.replace(needle, needle + 'Q').split('\n').map((x) => x.replace(/^# /, '').trim()).filter(Boolean);
      assert(JSON.stringify(scr) === JSON.stringify(want), `screen ${JSON.stringify(scr)}`);
    });
  }
} finally {
  console.log('pageErrors', JSON.stringify(B.pageErrors.slice(0, 5)));
  console.log('consoleErrors', JSON.stringify(B.consoleErrors.slice(0, 5)));
  finish();
  await B.browser.close().catch(() => {});
  clearTimeout(KILL);
}
