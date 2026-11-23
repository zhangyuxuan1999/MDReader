// bench/verify/v4-tru-h17.mjs — verify-trust (stage 2d re-verification, round 3): H17 variations end to end in the
// candidate renderer (real clicks and keys, 预览可编辑 on). A digit…digit inline formula must stay a formula after the
// edit (decision H17). Each case loads a document, clicks at the end of the needle, runs its keys, presses Escape,
// waits for the re-render and counts the formulas shown in the block.
//   MDR_URL=http://localhost:5433/?mode=split node bench/verify/v4-tru-h17.mjs [runs=3]
// Writes nothing. Global timeout 110 s.
import { chromium } from '@playwright/test';

const URL0 = process.env.MDR_URL || 'http://localhost:5433/?mode=split';
const RUNS = Number(process.argv[2] ?? 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 110_000);
const IDSP = String.fromCharCode(0x3000), EMSP = String.fromCharCode(0x2003);
const CASES = [
  { name: 'control-delete-stop', doc: '等于 $10$。\n', needle: '。', keys: async (p) => { await p.keyboard.press('Backspace'); } },
  { name: 'delete-stop-type-ideographic-space', doc: '等于 $10$。\n', needle: '。', keys: async (p) => { await p.keyboard.press('Backspace'); await p.keyboard.insertText(IDSP); } },
  { name: 'replace-word-by-em-space', doc: '面积 $3\\times4$元\n', needle: '元', keys: async (p) => { await p.keyboard.press('Backspace'); await p.keyboard.insertText(EMSP); } },
  { name: 'table-cell-ideographic-space', doc: '| a | b |\n|---|---|\n| 共 $10$个 | x |\n', needle: '个', keys: async (p) => { await p.keyboard.press('Backspace'); await p.keyboard.insertText(IDSP); } },
  { name: 'empty-bold-after-formula', doc: '和 $10$**x**\n', needle: 'x', keys: async (p) => { await p.keyboard.press('Backspace'); } },
];

async function one(page, c) {
  await page.evaluate(() => window.__mdr.app.preview.endEditSession?.());
  await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable?.(true));
  await page.evaluate(({ t }) => window.__mdr.loadText(t, 'h17.md'), { t: c.doc });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(600);
  const before = await page.evaluate(() => document.querySelectorAll('.mdr-preview .md-math').length);
  const pt = await page.evaluate((needle) => {
    const root = document.querySelector('.mdr-preview');
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('.katex') ? 2 : 1) });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.lastIndexOf(needle);
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i + needle.length - 1); r.setEnd(n, i + needle.length);
      const b = r.getBoundingClientRect();
      return { x: b.right - 0.5, y: b.top + b.height / 2 };
    }
    return null;
  }, c.needle);
  if (!pt) return 'needle not shown';
  await page.mouse.click(pt.x, pt.y);
  await sleep(250);
  if (!(await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing')))) return 'no session';
  await c.keys(page);
  await sleep(250);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(400);
  const r = await page.evaluate(() => ({ src: window.__mdr.app.getText(), n: document.querySelectorAll('.mdr-preview .md-math').length }));
  return { before, ...r };
}

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(URL0, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  let failing = 0;
  for (const c of CASES) {
    const res = [];
    for (let k = 0; k < RUNS; k++) res.push(await one(page, c));
    const bad = res.filter((r) => typeof r === 'string' || r.n !== r.before);
    if (bad.length) failing++;
    const ex = bad[0] ?? res[0];
    console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${c.name}  — ${RUNS - bad.length}/${RUNS} keep the formula; e.g. ${typeof ex === 'string' ? ex : `formulas ${ex.before} -> ${ex.n}, source ${JSON.stringify(ex.src)}`}`);
  }
  console.log(`${failing} failing`);
  process.exitCode = failing ? 1 : 0;
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  process.exitCode = 2;
} finally {
  clearTimeout(killer);
  try { await browser?.close(); } catch { /* */ }
}
