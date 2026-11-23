// bench/verify/v4-tru-u16.mjs — verify-trust (stage 2d re-verification, round 3): U16 and the checkbox write-back
// (CONTRACT §11) against the candidate renderer (this tree's dev server) and the 0.1.1 baseline renderer.
//   MDR_URL=http://localhost:5433/?mode=split node bench/verify/v4-tru-u16.mjs [case ...]
//   MDR_URL='http://localhost:5443/?mode=split&perf=1' node bench/verify/v4-tru-u16.mjs        (0.1.1 dist)
// Cases (each prints the source lines that changed, or "unchanged"):
//   label-*    a document <label> whose content holds a nested task list: a click ANYWHERE on the label (made an
//              invisible overlay with inline style) is forwarded to the task's checkbox; no reserved name, no forged
//              data-l. Expected (U16's intent, "a checkbox click toggles its own task"): a click that is not on a
//              checkbox changes nothing. label-other: the click is on ANOTHER block's text.
//   flagoff-*  the U15 flag is removed from the wrapper by the script (a stand-in for a scan bypass) and a forged
//              li[data-l] steers the click: outside the block, onto a non-task line, onto a task of another list.
// Writes nothing. Global timeout 100 s.
import { chromium } from '@playwright/test';

const URL0 = process.env.MDR_URL || 'http://localhost:5433/?mode=split';
const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 100_000);

const OVER = 'position:absolute;left:-3000px;top:-3000px;width:9000px;height:9000px;z-index:50;opacity:0;display:block';
const CASES = [
  {
    name: 'label-other', editable: true,
    doc: `Intro paragraph you click to read.\n\n- <label style="${OVER}">x\n  - [ ] wire the money\n\nlast line\n`,
    click: { text: 'Intro paragraph', k: 3 },
  },
  {
    name: 'label-other-noedit', editable: false,
    doc: `Intro paragraph you click to read.\n\n- <label style="${OVER}">x\n  - [ ] wire the money\n\nlast line\n`,
    click: { text: 'Intro paragraph', k: 3 },
  },
  {
    name: 'label-visible', editable: false,
    doc: '- <label>Click this sentence to read more\n  - [ ] wire the money\n',
    click: { text: 'Click this sentence', k: 6 },
  },
  {
    name: 'flagoff-outside', editable: false, unflag: true,
    doc: '- [ ] one\n\npara\n\n<ul><li data-l="3"><input type="checkbox"> forged</li></ul>\n\n- [ ] far away\n- [ ] far away 2\n- [ ] far away 3\n- [ ] far away 4\n- [ ] far away 5\n- [ ] far away 6\n- [ ] far away 7\n',
    box: 'forged',
  },
  {
    name: 'flagoff-nontask', editable: false, unflag: true,
    doc: '- [ ] real task\n- plain item\n- x <ul><li data-l="1"><input type="checkbox"> forged</li></ul>\n',
    box: 'forged',
  },
  {
    name: 'flagoff-otherlist', editable: false, unflag: true,
    doc: '- [ ] list A task\n\n* [ ] list B task <ul><li data-l="0"><input type="checkbox"> forged</li></ul>\n',
    box: 'forged',
  },
];

async function run(page, c) {
  await page.evaluate(() => window.__mdr.app.preview.endEditSession?.());
  await page.evaluate((on) => window.__mdr.app.preview.setPreviewEditable?.(on), c.editable);
  await page.evaluate(({ t }) => window.__mdr.loadText(t, 'u16.md'), { t: c.doc });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(400);
  const before = await page.evaluate(() => window.__mdr.app.getText());
  const info = await page.evaluate(({ c }) => {
    const root = document.querySelector('.mdr-preview');
    const blocks = Array.from(root.querySelectorAll('section.md-block')).map((s) => ({ id: s.dataset.id, x: s.hasAttribute('data-mdr-x'), text: s.textContent.slice(0, 40) }));
    if (c.unflag) for (const s of root.querySelectorAll('section.md-block[data-mdr-x]')) s.removeAttribute('data-mdr-x');
    let pt = null;
    if (c.click) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.data.indexOf(c.click.text);
        if (i < 0) continue;
        const r = document.createRange(); r.setStart(n, i + c.click.k); r.setEnd(n, i + c.click.k + 1);
        const b = r.getBoundingClientRect();
        pt = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        break;
      }
    } else if (c.box) {
      for (const inp of root.querySelectorAll('input[type=checkbox]')) {
        if (inp.classList.contains('task-list-item-checkbox') || !(inp.parentElement?.textContent ?? '').includes(c.box)) continue;
        const b = inp.getBoundingClientRect();
        pt = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        break;
      }
    }
    const hit = pt ? document.elementFromPoint(pt.x, pt.y) : null;
    return { blocks, pt, hit: hit ? hit.tagName + (hit.className ? '.' + hit.className : '') : null };
  }, { c });
  if (!info.pt) return { ok: false, detail: 'target not found ' + JSON.stringify(info.blocks) };
  await page.mouse.move(info.pt.x, info.pt.y);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(500);
  await page.keyboard.press('Escape');
  await sleep(300);
  const after = await page.evaluate(() => window.__mdr.app.getText());
  const a = before.split('\n'), b = after.split('\n');
  const changed = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changed.push(`line ${i + 1}: ${JSON.stringify(a[i])} -> ${JSON.stringify(b[i])}`);
  return { ok: changed.length === 0, detail: `hit ${info.hit}; flags ${JSON.stringify(info.blocks.map((x) => x.x))}; ${changed.length ? changed.join('; ') : 'unchanged'}` };
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
    if (only.length && !only.some((o) => c.name.includes(o))) continue;
    try {
      const r = await run(page, c);
      if (!r.ok) fails++;
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${c.name}  — ${r.detail}`);
    } catch (e) { fails++; console.log(`FAIL  ${c.name}  — threw ${String(e).split('\n')[0]}`); }
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
