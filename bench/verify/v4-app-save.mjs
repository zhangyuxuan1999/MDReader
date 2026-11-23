// bench/verify/v4-app-save.mjs — verify-app (0.2.0 stage 2d). Save (web File System Access path through OPFS
// handles, and the download fallback) at 0 ms after round 3's U18 deletion / insertion: emptied blocks in
// tight neighbourhoods (U18 (b) keep rule, (c) joinsAbove), typing into the emptied place, Backspace in it.
// The file must equal the source, the source must keep its neighbours apart, the title must be clean.
//   MDR_PORT=5436 node bench/verify/v4-app-save.mjs [filter]
// Needs the renderer already listening. Writes nothing into the tree (OPFS of a throw-away browser context).
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const only = process.argv[2] ?? '';
const B = await openBrowser();
const { page } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const answer = (label) => page.evaluate((label) => {
  const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === label);
  if (!b) return false; b.click(); return true;
}, label);
async function openOpfs(name, text) {
  await page.keyboard.press('Escape');
  await answer('取消');
  await B.loadDoc('', 'reset.md');
  await page.evaluate(async ([n, tx]) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle(n, { create: true });
    const w = await h.createWritable(); await w.write(tx); await w.close();
    window.showOpenFilePicker = async () => [h];
  }, [name, text]);
  await page.evaluate(() => window.__mdr.app.registry.run('file.open'));
  const end = Date.now() + 6000;
  while (Date.now() < end) { if (await page.evaluate((tx) => window.__mdr.app.getText() === tx, text)) break; await sleep(80); }
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(400);
}
const readOpfs = (name) => page.evaluate(async (n) => (await (await (await navigator.storage.getDirectory()).getFileHandle(n)).getFile()).text(), name);
const savedToast = async () => {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes('已保存')))) return true;
    await sleep(60);
  }
  return false;
};
async function emptyAt(doc, needle) {
  const line = doc.split('\n').findIndex((l) => l.includes(needle)) + 1;
  await B.clickLine(line, 'first', needle.slice(0, 1));
  await sleep(120);
  if (!(await B.editing())) return false;
  await page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.keyboard.press('Backspace');
  return true;
}
// [name, doc, needle of the block to empty, typed after emptying ('' = none), extra key]
const CASES = [
  ['mid', 'a 段\n\n乙 段\n\nz 段\n', '乙', '', ''],
  ['list-between-headings', '# H1\n- 乙项\n# H2\n', '乙', '', ''],
  ['list-between-headings-typeQ', '# H1\n- 乙项\n# H2\n', '乙', 'Q', ''],
  ['heading-under-para', 'a 段\n## 乙题\n\nz 段\n', '乙', '', ''],
  ['heading-under-para-typeQ', 'a 段\n## 乙题\n\nz 段\n', '乙', 'Q', ''],
  ['list-under-para', 'a 段\n- 乙项\n- 乙二\n\nz 段\n', '乙', '', ''],
  ['list-under-para-typeQ', 'a 段\n- 乙项\n- 乙二\n\nz 段\n', '乙', 'Q', ''],
  ['last-no-newline', 'a 段\n\n乙 段', '乙', '', ''],
  ['last-no-newline-typeQ', 'a 段\n\n乙 段', '乙', 'Q', ''],
  ['last-tight', '# H1\n- 乙项\n', '乙', '', ''],
  ['first-leading-blank', '\n\n乙 段\n\nz 段\n', '乙', '', ''],
  ['first-leading-blank-typeQ', '\n\n乙 段\n\nz 段\n', '乙', 'Q', ''],
  ['mid-backspace', 'a 段\n\n乙 段\n\nz 段\n', '乙', '', 'Backspace'],
  ['mid-backspace-typeQ', 'a 段\n\n乙 段\n\nz 段\n', '乙', '', 'Backspace+Q'],
  ['quote-between-lists', '- a\n\n> 乙引\n\n- z\n', '乙', 'Q', ''],
  ['code-between-paras', 'a 段\n\n```\n乙码\n```\n\nz 段\n', '乙', '', ''],
];
try {
  await B.boot('mode=split');
  let n = 0;
  for (const [name, doc, needle, typed, extra] of CASES) {
    if (only && !name.startsWith(only)) continue;
    n++;
    try {
      const fname = `s${n}.md`;
      await openOpfs(fname, doc);
      const ok = await emptyAt(doc, needle);
      if (typed) { await sleep(60); await page.keyboard.type(typed); }
      if (extra === 'Backspace') { await sleep(60); await page.keyboard.press('Backspace'); }
      if (extra === 'Backspace+Q') { await sleep(60); await page.keyboard.press('Backspace'); await sleep(60); await page.keyboard.type('Q'); }
      await page.keyboard.press('ControlOrMeta+s');
      const saved = await savedToast();
      await sleep(400);
      const file = await readOpfs(fname);
      const src = await B.source();
      const title = await page.evaluate(() => document.title);
      await page.keyboard.press('Escape'); await B.settle(300);
      const srcEsc = await B.source();
      const titleEsc = await page.evaluate(() => document.title);
      const shown = await page.evaluate(() => [...document.querySelectorAll('.mdr-preview > * .md-block, .mdr-preview .md-block')].filter((e) => !e.parentElement.closest('.md-block')).map((e) => e.textContent.trim()).filter(Boolean));
      await page.keyboard.press('ControlOrMeta+z'); await B.settle(300);
      const undone = await B.source();
      out(name, { ok, saved, fileEqSrc: file === src, file, title, srcAfterEscSame: srcEsc === src, titleEsc, shown, undo1: undone });
    } catch (e) { out(name, `ERROR ${String(e.message).split('\n')[0]}`); }
  }
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  console.log('BASE', BASE);
}
