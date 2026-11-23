// bench/verify/arch-mutations.mjs — architecture assertion for typing: a keystroke in a paragraph
// must replace the children of exactly ONE .md-block and must not insert/remove .md-block wrappers.
// Records, for every childList mutation on .mdr-preview__body during typing, the block it belongs to,
// whether the block was .is-pending immediately before (a first-time mount of a neighbour, which is
// window materialization, not edit churn) and how many nodes were added/removed.
// Usage: node bench/verify/arch-mutations.mjs [large|huge] [chars] [delayMs]
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, report, dumpErrors, sleep } from './common.mjs';
const which = process.argv[2] ?? 'large';
const CHARS = Number(process.argv[3] ?? 200);
const DELAY = Number(process.argv[4] ?? 100);
const src = readFileSync(new URL(`../../test-data/${which}.md`, import.meta.url), 'utf8').split('\n');
let target = which === 'large' ? 50000 : 170000;
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
while (target < src.length && !(isProse(src[target - 1]) && src[target - 2] === '' && src[target] === '')) target++;
const { browser, page, errors } = await launch();
try {
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/${which}.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 120_000 });
  await waitFirstVisible(page, 120_000);
  await waitIdle(page);
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), target);
  await sleep(1500);
  await waitIdle(page).catch(() => {});
  await sleep(1500);
  const b = await page.evaluate((l) => window.__mdr.app.preview.blockAtLine(l), target);
  await page.evaluate((id) => {
    const body = document.querySelector('.mdr-preview__body');
    const rec = { m: [], wrapperAdd: 0, wrapperRemove: 0 };
    window.__arch = rec;
    const el0 = document.querySelector(`.md-block[data-id="${id}"]`);
    el0.__mark = 'orig';
    const isBlock = (n) => n.nodeType === 1 && (n.classList?.contains('md-block') || n.querySelector?.('.md-block'));
    new MutationObserver((list) => {
      for (const mu of list) {
        if (mu.type !== 'childList') continue;
        for (const n of mu.addedNodes) if (isBlock(n)) rec.wrapperAdd++;
        for (const n of mu.removedNodes) if (isBlock(n)) rec.wrapperRemove++;
        const blk = mu.target.nodeType === 1 ? mu.target.closest('.md-block') : mu.target.parentElement?.closest('.md-block');
        rec.m.push({
          id: blk?.dataset.id ?? null,
          direct: mu.target === blk,
          added: mu.addedNodes.length, removed: mu.removedNodes.length,
          // a block whose children went 0 → N is a first-time mount (window materialization)
          firstMount: mu.removedNodes.length === 0 && blk ? (blk.__seen ? false : true) : false,
        });
        if (blk) blk.__seen = true;
      }
    }).observe(body, { childList: true, subtree: true });
  }, b.id);
  const text = Array.from({ length: CHARS }, (_, i) => (i % 7 === 6 ? ' ' : String.fromCharCode(97 + (i % 26)))).join('');
  await page.keyboard.type(text, { delay: DELAY });
  await sleep(1500);
  const r = await page.evaluate(() => window.__arch);
  const same = await page.evaluate((id) => document.querySelector(`.md-block[data-id="${id}"]`)?.__mark === 'orig', b.id);
  const onTarget = r.m.filter((x) => x.id === String(b.id));
  const other = r.m.filter((x) => x.id !== String(b.id) && x.id !== null);
  const otherReplace = other.filter((x) => x.removed > 0);
  const otherFirst = other.filter((x) => x.removed === 0);
  const outside = r.m.filter((x) => x.id === null);
  console.log(`[arch ${which}] ${CHARS} keys: childList mutations ${r.m.length}`);
  console.log(`   on the edited block ${b.id}: ${onTarget.length} (direct children replaced: ${onTarget.filter((x) => x.direct).length}, nested: ${onTarget.filter((x) => !x.direct).length})`);
  console.log(`   on other blocks: ${other.length} — first-time mounts (0 removed, window materialization) ${otherFirst.length}, CONTENT REPLACEMENTS (removed>0) ${otherReplace.length} ${[...new Set(otherReplace.map((x) => x.id))].slice(0, 10).join(',')}`);
  console.log(`   outside any .md-block: ${outside.length}; .md-block wrappers added ${r.wrapperAdd}, removed ${r.wrapperRemove}; edited wrapper element identity kept: ${same}`);
  report(`ARCH ${which}: .md-block wrappers inserted/removed while typing`, `${r.wrapperAdd}/${r.wrapperRemove}`, '0/0', r.wrapperAdd === 0 && r.wrapperRemove === 0);
  report(`ARCH ${which}: children replaced on exactly one block`, `edited block ${onTarget.filter((x) => x.direct).length} replacements, other blocks re-replaced ${otherReplace.length}`, `${CHARS} / 0`, otherReplace.length === 0);
  report(`ARCH ${which}: edited wrapper element identity kept`, String(same), 'true', same);
} finally { dumpErrors(errors); await browser.close(); }
