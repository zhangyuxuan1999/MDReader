// bench/verify/r4-t-stale.mjs — fix-trust r4, item 2(a): a task checkbox clicked right after an edit in the editor
// pane, before the preview's structure caught up, must toggle the task the user clicked (or nothing), never a
// neighbour. The editor gets Enter (a new line above the list) and the checkbox of task "b" is clicked 0 ms and
// 50 ms later. Prints PASS / FAIL per case.
//   MDR_URL='http://localhost:5463/?mode=split' node bench/verify/r4-t-stale.mjs
// Writes nothing into the tree. Global timeout 100 s.
import { chromium } from '@playwright/test';

const URL0 = process.env.MDR_URL || 'http://localhost:5463/?mode=split';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 100_000);

const DOCS = [
  ['enter-above', 'intro\n\n- [ ] a\n- [ ] b\n- [ ] c\n', 'intro', ['Enter']],
  ['two-lines-above', 'intro\n\n- [ ] a\n- [ ] b\n- [ ] c\n', 'intro', ['Enter', 'Enter']],
  ['para-line-above', 'intro\n- [ ] a\n- [ ] b\n- [ ] c\n', 'intro', ['Enter', 'x', 'Enter']],
  ['in-list-above', '- [ ] a\n- [ ] b\n- [ ] c\n', '- [ ] a', ['Enter', '[', ' ', ']', ' ', 'n']],
];

async function one(page, name, doc, lineText, keys, delay, editable) {
  await page.evaluate(() => window.__mdr.app.preview.endEditSession?.());
  await page.evaluate((on) => window.__mdr.app.preview.setPreviewEditable?.(on), editable);
  await page.evaluate(({ t }) => window.__mdr.loadText(t, 'stale.md'), { t: doc });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(300);
  // the editor line to type in, and the checkbox of task "b"
  const pos = await page.evaluate((lt) => {
    const line = Array.from(document.querySelectorAll('.cm-line')).find((l) => l.textContent === lt);
    const r = line.getBoundingClientRect();
    const box = Array.from(document.querySelectorAll('.mdr-preview input[type=checkbox]')).find((i) => (i.parentElement?.textContent ?? '').trim() === 'b');
    const b = box.getBoundingClientRect();
    return { lx: r.right - 2, ly: r.top + r.height / 2, bx: b.left + b.width / 2, by: b.top + b.height / 2 };
  }, lineText);
  // the item whose box the click really hit (after the re-render the box of another item can lie under the point)
  await page.evaluate(() => {
    window.__r4hit = null;
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type === 'checkbox') {
        const li = t.closest('li');
        window.__r4hit = li ? Array.from(li.childNodes).filter((n) => n.nodeType === 3).map((n) => n.data).join('').trim() : null;
      }
    }, { capture: true, once: false });
  });
  await page.mouse.click(pos.lx, pos.ly);
  await page.keyboard.press('End');
  await sleep(200);
  await page.evaluate(() => window.__mdr.waitIdle());
  const before = await page.evaluate(() => window.__mdr.app.getText());
  for (const k of keys) await page.keyboard.press(k);
  if (delay) await sleep(delay);
  await page.mouse.click(pos.bx, pos.by);
  await sleep(600);
  await page.evaluate(() => window.__mdr.waitIdle());
  await page.keyboard.press('Escape');
  await sleep(200);
  const after = await page.evaluate(() => window.__mdr.app.getText());
  const hit = await page.evaluate(() => window.__r4hit);
  const ticked = after.split('\n').filter((l) => /\[x\]/.test(l));
  // right: nothing, or exactly the line of the item whose box was hit
  const own = (l) => hit !== null && l.replace(/^\s*[-*+]\s+\[x\]\s*/, '').trim() === hit;
  const wrong = ticked.length > 1 || ticked.some((l) => !own(l));
  return { ok: !wrong, detail: `hit ${JSON.stringify(hit)}; ${ticked.length ? 'ticked ' + JSON.stringify(ticked) : 'nothing ticked'}; ${JSON.stringify(before)} -> ${JSON.stringify(after)}` };
}

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(URL0, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  await sleep(500);
  let fails = 0, nothing = 0;
  for (const [name, doc, lt, keys] of DOCS) {
    for (const delay of [0, 50]) {
      for (const editable of [true, false]) {
        const tag = `${name} delay=${delay} edit=${editable ? 'on' : 'off'}`;
        try {
          const r = await one(page, name, doc, lt, keys, delay, editable);
          if (!r.ok) fails++;
          if (r.detail.includes('nothing ticked')) nothing++;
          console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${tag}  — ${r.detail}`);
        } catch (e) { fails++; console.log(`FAIL  ${tag}  — threw ${String(e).split('\n')[0]}`); }
      }
    }
  }
  console.log(`page errors: ${errs.length} ${errs.slice(0, 2).join(' | ')}`);
  console.log(`url ${URL0}: ${fails} failing, ${nothing} ticked nothing`);
  process.exitCode = fails ? 1 : 0;
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  process.exitCode = 2;
} finally {
  clearTimeout(killer);
  try { await browser?.close(); } catch { /* */ }
}
