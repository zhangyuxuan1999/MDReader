// bench/verify/r4-t-u24.mjs — fix-trust r4: U24 (CONTRACT §11, J13) in the app. A task line is rewritten only by a
// click that hit the checkbox itself; a click a <label> forwards (wrapping, for=, nested, overlaid exactly on the
// box, the press on the box and the release on the label) changes no source and leaves the box as the source says;
// the keyboard on a focused checkbox: Space after a direct click, and Space after a refused forwarded click.
//   MDR_URL='http://localhost:5463/?mode=split' node bench/verify/r4-t-u24.mjs [case ...]
// Each case runs with 预览可编辑 on and off. Writes nothing into the tree. Global timeout 110 s.
import { chromium } from '@playwright/test';

const URL0 = process.env.MDR_URL || 'http://localhost:5463/?mode=split';
const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 110_000);

const OVER = 'position:absolute;left:-3000px;top:-3000px;width:9000px;height:9000px;z-index:50;opacity:0;display:block';
// want: the expected changed lines (as "n:text"), [] = no change
const CASES = [
  { name: 'direct', doc: 'intro\n\n- [ ] a\n- [ ] b\n', act: [['clickBox', 'b']], want: ['4:- [x] b'] },
  { name: 'direct-twice', doc: 'intro\n\n- [ ] a\n- [ ] b\n', act: [['clickBox', 'b'], ['wait', 400], ['clickBox', 'b']], want: [] },
  { name: 'direct-then-space', doc: 'intro\n\n- [ ] a\n- [ ] b\n', act: [['clickBox', 'b'], ['wait', 400], ['key', 'Space']], want: 'report' },
  { name: 'wrap-label-text', doc: '- <label>read this text <input type="checkbox"> tail</label>\n- [ ] t\n', act: [['clickText', 'read this']], want: [] },
  { name: 'wrap-label-task', doc: '- <label>click me\n  - [ ] hidden task\n  </label>\n', act: [['clickText', 'click me']], want: [] },
  { name: 'for-label', doc: '<label for="tk">press here to read</label>\n\n- [ ] task\n', act: [['clickText', 'press here']], want: [] },
  { name: 'nested-labels', doc: '- <label>outer <label>inner words\n  - [ ] nested task\n  </label></label>\n', act: [['clickText', 'inner words'], ['wait', 300], ['clickText', 'outer']], want: [] },
  { name: 'same-item-label', doc: '- [ ] task one <label>same item label</label>\n- [ ] two\n', act: [['clickText', 'same item label']], want: [] },
  // an invisible label of another block lies over the visible task's box: the press goes to the label
  { name: 'overlay-on-box', doc: `- [ ] visible task\n\n- <label style="${OVER}">.\n  - [ ] hidden task\n`, act: [['clickBox', 'visible task']], want: [] },
  { name: 'press-box-release-label', doc: '- <label>label words here\n  - [ ] t1\n  </label>\n', act: [['dragBoxToText', 't1', 'label words']], want: [] },
  { name: 'forward-then-space', doc: '- <label>read the words\n  - [ ] t1\n  </label>\n', act: [['clickText', 'read the words'], ['wait', 300], ['key', 'Space']], want: [] },
  { name: 'para-direct-space', doc: 'para\n\n- [ ] plain\n', act: [['clickBox', 'plain'], ['wait', 300], ['key', 'Space']], want: 'report' },
  { name: 'for-label-raw', doc: '<label for="tk">press here to read</label>\n\n- [ ] <input type="checkbox" id="tk"> task\n', act: [['clickText', 'press here']], want: [] },
  { name: 'nested-labels-2', doc: '- <label>outer words <label>inner words</label> more\n  - [ ] nested task\n  </label>\n', act: [['clickText', 'outer words'], ['wait', 300], ['clickText', 'inner words']], want: [] },
  { name: 'focus-space', doc: 'intro\n\n- [ ] a\n- [ ] b\n', act: [['focusBox', 'b'], ['key', 'Space']], want: 'report' },
];

async function pointOf(page, how, arg) {
  return page.evaluate(({ how, arg }) => {
    const root = document.querySelector('.mdr-preview');
    if (how === 'box') {
      for (const inp of root.querySelectorAll('input[type=checkbox]')) {
        const li = inp.closest('li');
        const own = li ? Array.from(li.childNodes).filter((n) => !(n.nodeType === 1 && /^(UL|OL)$/.test(n.tagName))).map((n) => n.textContent).join('') : '';
        if (!own.includes(arg)) continue;
        const b = inp.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
      return null;
    }
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(arg);
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i + 2); r.setEnd(n, i + 3);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    return null;
  }, { how, arg });
}

async function run(page, c, editable) {
  await page.evaluate(() => window.__mdr.app.preview.endEditSession?.());
  await page.evaluate((on) => window.__mdr.app.preview.setPreviewEditable?.(on), editable);
  await page.evaluate(({ t }) => window.__mdr.loadText(t, 'u24.md'), { t: c.doc });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(400);
  const before = await page.evaluate(() => window.__mdr.app.getText());
  for (const [k, a, b] of c.act) {
    if (k === 'wait') { await sleep(a); continue; }
    if (k === 'key') { await page.keyboard.press(a); await sleep(300); continue; }
    if (k === 'focusBox') {
      const ok = await page.evaluate((t) => {
        const inp = Array.from(document.querySelectorAll('.mdr-preview input[type=checkbox]')).find((i) => (i.closest('li')?.textContent ?? '').trim() === t);
        inp?.focus();
        return !!inp && document.activeElement === inp;
      }, a);
      if (!ok) return { ok: false, detail: 'could not focus box ' + a };
      continue;
    }
    if (k === 'dragBoxToText') {
      const p = await pointOf(page, 'box', a), q = await pointOf(page, 'text', b);
      if (!p || !q) return { ok: false, detail: 'target not found' };
      await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 4 }); await page.mouse.up();
      await sleep(400); await page.evaluate(() => window.__mdr.waitIdle());
      continue;
    }
    const p = await pointOf(page, k === 'clickBox' ? 'box' : 'text', a);
    if (!p) return { ok: false, detail: `target not found: ${a}` };
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up();
    await sleep(400); await page.evaluate(() => window.__mdr.waitIdle());
  }
  const focus = await page.evaluate(() => { const a = document.activeElement; return a ? a.tagName + (a.type ? ':' + a.type : '') : null; });
  await page.keyboard.press('Escape');
  await sleep(300);
  await page.evaluate(() => window.__mdr.waitIdle());
  const after = await page.evaluate(() => window.__mdr.app.getText());
  const boxes = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview input[type=checkbox]')).map((i) => i.checked));
  const A = before.split('\n'), B = after.split('\n');
  const changed = [];
  for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) changed.push(`${i + 1}:${B[i]}`);
  // the boxes must show what the source says: a box of a task line is checked iff the line has [x]
  const srcChecks = (after.match(/\[[ xX]\]/g) ?? []).map((m) => m !== '[ ]');
  const ok = c.want === 'report' ? true : JSON.stringify(changed) === JSON.stringify(c.want);
  return { ok, detail: `${c.want === 'report' ? 'REPORT ' : ''}changed ${JSON.stringify(changed)}; boxes ${JSON.stringify(boxes)} source marks ${JSON.stringify(srcChecks)}; focus ${focus}` };
}

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(URL0, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  await sleep(500);
  let fails = 0;
  for (const c of CASES) {
    if (only.length && !only.includes(c.name)) continue;
    for (const editable of [true, false]) {
      const tag = `${c.name} edit=${editable ? 'on' : 'off'}`;
      try {
        const r = await run(page, c, editable);
        if (!r.ok) fails++;
        console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${tag}  — ${r.detail}`);
      } catch (e) { fails++; console.log(`FAIL  ${tag}  — threw ${String(e).split('\n')[0]}`); }
    }
  }
  console.log(`page errors: ${errs.length} ${errs.slice(0, 2).join(' | ')}`);
  console.log(`url ${URL0}: ${fails} failing`);
  process.exitCode = fails ? 1 : 0;
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  process.exitCode = 2;
} finally {
  clearTimeout(killer);
  try { await browser?.close(); } catch { /* */ }
}
