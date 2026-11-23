// bench/verify/v4-tru-tex.mjs — verify-trust (stage 2d re-verification, round 3): H17's rule ("a formula the session
// shows stays a formula in the source") when the user edits an inline formula's TeX source in the preview (a click on a
// formula opens its TeX). Each case types into the TeX source, presses Escape and counts the formulas shown after the
// re-render. Real clicks and keys in the candidate renderer (预览可编辑 on).
//   MDR_URL=http://localhost:5433/?mode=split node bench/verify/v4-tru-tex.mjs [runs=2]
// Writes nothing. Global timeout 110 s.
import { chromium } from '@playwright/test';

const URL0 = process.env.MDR_URL || 'http://localhost:5433/?mode=split';
const RUNS = Number(process.argv[2] ?? 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 110_000);
const DOC = 'Area $x+1$ here.\n';
const CASES = [
  ['control-type-y', async (p) => { await p.keyboard.type('y'); }],
  ['type-trailing-space', async (p) => { await p.keyboard.type(' '); }],
  ['type-leading-space', async (p) => { await p.keyboard.press('Home'); await p.keyboard.type(' '); }],
  ['type-dollar', async (p) => { await p.keyboard.type('$y'); }],
  ['type-trailing-backslash', async (p) => { await p.keyboard.type('\\'); }],
  // (fix-serial, round 4, rule 4 harness repair: Home / Shift+End now act on the paragraph's line in a session
  // (K19 extended, J26), so they selected the whole paragraph; the TeX source's own text is selected instead, which
  // is what this case means: replace the TeX by `1+2`.)
  ['digit-ends', async (p) => {
    await p.evaluate(() => {
      const e = document.querySelector('.mdr-preview .is-editing .md-math-src');
      const r = document.createRange();
      r.selectNodeContents(e);
      const s = document.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    });
    await p.keyboard.type('1+2');
  }],
];

async function one(page, keys) {
  await page.evaluate(() => window.__mdr.app.preview.endEditSession?.());
  await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable?.(true));
  await page.evaluate(({ t }) => window.__mdr.loadText(t, 'tex.md'), { t: DOC });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(600);
  const pt = await page.evaluate(() => {
    const m = document.querySelector('.mdr-preview .md-math');
    if (!m) return null;
    const b = m.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  if (!pt) return 'no formula';
  await page.mouse.click(pt.x, pt.y);
  await sleep(300);
  const tex = await page.evaluate(() => document.querySelector('.mdr-preview .is-editing .md-math-src')?.textContent ?? null);
  if (tex === null) return 'TeX source did not open';
  await keys(page);
  await sleep(250);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(400);
  return page.evaluate(() => ({ src: window.__mdr.app.getText(), n: document.querySelectorAll('.mdr-preview .md-math').length, text: document.querySelector('.mdr-preview section.md-block')?.textContent?.slice(0, 60) }));
}

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(URL0, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  let failing = 0;
  for (const [name, keys] of CASES) {
    const res = [];
    for (let k = 0; k < RUNS; k++) res.push(await one(page, keys));
    const bad = res.filter((r) => typeof r === 'string' || r.n !== 1);
    if (bad.length) failing++;
    const ex = bad[0] ?? res[0];
    console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${name}  — ${RUNS - bad.length}/${RUNS} keep one formula; e.g. ${typeof ex === 'string' ? ex : `formulas ${ex.n}, source ${JSON.stringify(ex.src)}`}`);
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
