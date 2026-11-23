// bench/verify/v4-tru-e2e.mjs — verify-trust (stage 2d re-verification, round 3): end-to-end variations of the H1
// exploits (FINDINGS-0.2.0-r2 H1: one typed letter turns hidden raw HTML into a formula; a forged li[data-l] steers a
// checkbox) with other hiding constructs, separators and containers than the original repro. Real clicks and keys in
// the candidate renderer (this tree's dev server, 预览可编辑 on).
//   MDR_URL=http://localhost:5433/?mode=split node bench/verify/v4-tru-e2e.mjs [case ...]
// typing cases: click on "terms", End, type "s", Escape. PASS = the source is unchanged (refused) or differs from the
// original by exactly one inserted "s"; it never gains a "$". box cases: click the checkbox; PASS = no line changes.
// Writes nothing. Global timeout 100 s.
import { chromium } from '@playwright/test';

const URL0 = process.env.MDR_URL || 'http://localhost:5433/?mode=split';
const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 100_000);

const HID = (cls) => `<span class="${cls}" style="display:none"><code>\\text{Call +1 555 0100 now}</code></span>`;
const TYPE = [
  ['nl-sep', `# Terms\n\nPlease read ${HID('a&NewLine;md-math')}the terms\n`],
  ['ff-ref', `# Terms\n\nPlease read ${HID('a&#x0C;md-math')}the terms\n`],
  ['cr-ref-nosemi', `# Terms\n\nPlease read ${HID('a&#13md-math')}the terms\n`],
  ['list-item', `- Please read ${HID('x&Tab;md-math')}the terms\n- other\n`],
  ['table-cell', `| a | b |\n|---|---|\n| Please read ${HID('&#9;md-math')}the terms | x |\n`],
  ['heading', `# Please read ${HID('q&#32;md-math')}the terms\n`],
  ['noembed-comment', `# Terms\n\nPlease read <noembed><!--</noembed>${HID('md-math')}--> the terms\n`],
  ['xmp-cdata', `# Terms\n\nPlease read <xmp><![CDATA[</xmp>${HID('md-math')}]]> the terms\n`],
  ['quote-lazy', `> Please read ${HID('&NewLine;md-math')}\nthe terms\n`],
  ['absorbed', `- Please read <b title='\n- class=md-math x='y'>the terms\n`],
];
const BOX = [
  ['box-xmp', '- [ ] pay the rent\n- [ ] call the bank\n\nread <xmp><!--</xmp><ul><li data-l="-1"><input type="checkbox"> I agree</li></ul>-->\n'],
  ['box-noframes', '- [ ] pay the rent\n\n<noframes><!--</noframes><ul><li data-l="0"><input type="checkbox"> I agree</li></ul>-->\n'],
  ['box-absorbed', "- [ ] pay the rent\n- <b title='\n- ' data-l=0 x='y'><input type=\"checkbox\"> I agree\n"],
];

async function load(page, doc) {
  await page.evaluate(() => window.__mdr.app.preview.endEditSession?.());
  await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable?.(true));
  await page.evaluate(({ t }) => window.__mdr.loadText(t, 'e2e.md'), { t: doc });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(700);
}
const point = (page, needle, k) => page.evaluate(({ needle, k }) => {
  const root = document.querySelector('.mdr-preview');
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = n.data.indexOf(needle);
    if (i < 0 || !n.parentElement || n.parentElement.closest('[style*="display:none"]')) continue;
    const r = document.createRange(); r.setStart(n, i + k); r.setEnd(n, i + k + 1);
    const b = r.getBoundingClientRect();
    if (b.width === 0) continue;
    return { x: b.left + 1, y: b.top + b.height / 2, flagged: !!n.parentElement.closest('[data-mdr-x]') };
  }
  return null;
}, { needle, k });

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(URL0, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  // Harness repair (round 7, integrate): on a build opened with ?perf=1 the perf overlay covers the click points.
  await page.addStyleTag({ content: '.mdr-perf { display: none !important; }' });
  let fails = 0;
  for (const [name, doc] of TYPE) {
    if (only.length && !only.some((o) => name.includes(o))) continue;
    await load(page, doc);
    const orig = await page.evaluate(() => window.__mdr.app.getText());
    const pt = await point(page, 'terms', 2);
    if (!pt) { fails++; console.log(`FAIL  ${name}  — "terms" not shown`); continue; }
    await page.mouse.click(pt.x, pt.y);
    await sleep(200);
    const live = await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
    if (live) { await page.keyboard.press('End'); await page.keyboard.type('s'); await page.keyboard.press('Escape'); }
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(300);
    const now = await page.evaluate(() => window.__mdr.app.getText());
    let oneS = false;
    if (now.length === orig.length + 1) for (let i = 0; i < now.length; i++) if (now[i] === 's' && now.slice(0, i) + now.slice(i + 1) === orig) { oneS = true; break; }
    const ok = (now === orig || oneS) && (now.split('$').length === orig.split('$').length);
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — flagged=${pt.flagged} session=${live} ${now === orig ? 'unchanged' : oneS ? 'one s added' : 'source now ' + JSON.stringify(now)}`);
  }
  for (const [name, doc] of BOX) {
    if (only.length && !only.some((o) => name.includes(o))) continue;
    await load(page, doc);
    const orig = await page.evaluate(() => window.__mdr.app.getText());
    const pt = await page.evaluate(() => {
      for (const i of document.querySelectorAll('.mdr-preview input[type=checkbox]')) {
        if (i.classList.contains('task-list-item-checkbox')) continue;
        const b = i.getBoundingClientRect();
        if (b.width) return { x: b.left + b.width / 2, y: b.top + b.height / 2, flagged: !!i.closest('[data-mdr-x]') };
      }
      return null;
    });
    if (!pt) { console.log(`NOTE  ${name}  — no document checkbox shown`); continue; }
    await page.mouse.click(pt.x, pt.y);
    await sleep(400);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__mdr.waitIdle());
    const now = await page.evaluate(() => window.__mdr.app.getText());
    const ok = now === orig;
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — flagged=${pt.flagged} ${ok ? 'unchanged' : 'source now ' + JSON.stringify(now)}`);
  }
  console.log(`page errors: ${errs.length} ${errs.slice(0, 2).join(' | ')}`);
  console.log(`${fails} failing`);
  process.exitCode = fails ? 1 : 0;
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  process.exitCode = 2;
} finally {
  clearTimeout(killer);
  try { await browser?.close(); } catch { /* */ }
}
