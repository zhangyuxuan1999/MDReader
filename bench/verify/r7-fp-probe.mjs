// bench/verify/r7-fp-probe.mjs — fix-pre (round 7, H2): the case 'absorbed' of v4-tru-e2e on one dev server, run with the
// tree's renderer (/src) or with the frozen copy of the released 0.2.0 (test/fixtures/src-0.2.0) served by the same server
// (the page's HTML is rewritten to load that copy's main.ts). Prints whether a click starts a session and, from the app's
// own module instances, the start test's pieces (unsupportedReason, the baseline, baselineFaithful).
//   MDR_PORT=5468 node bench/verify/r7-fp-probe.mjs tree|frozen [doc-json]
// Writes nothing. Global timeout 100 s.
import { chromium } from '@playwright/test';

const PORT = Number(process.env.MDR_PORT) || 5468;
const WHICH = process.argv[2] || 'tree';
const DOC = process.argv[3] ? JSON.parse(process.argv[3]) : "- Please read <b title='\n- class=md-math x='y'>the terms\n";
const SRC = WHICH === 'frozen' ? '/test/fixtures/src-0.2.0' : '/src';
// MDR_URL: any page instead (a build: no module imports); MDR_HIDE_PERF=1 hides the ?perf=1 overlay, which covers part of
// the preview and takes the click
const URL1 = process.env.MDR_URL || `http://localhost:${PORT}/?mode=split`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 100_000);
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  if (WHICH === 'frozen') {
    await page.route(`http://localhost:${PORT}/?*`, async (route) => {
      const r = await route.fetch();
      const html = (await r.text()).replace('/src/main.ts', '/test/fixtures/src-0.2.0/main.ts');
      await route.fulfill({ response: r, body: html });
    });
  }
  await page.goto(URL1, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  if (process.env.MDR_HIDE_PERF === '1') await page.addStyleTag({ content: '.mdr-perf { display: none !important; }' });
  await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable?.(true));
  await page.evaluate(({ t }) => window.__mdr.loadText(t, 'e2e.md'), { t: DOC });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(700);
  const info = process.env.MDR_URL ? [] : await page.evaluate(async ({ SRC }) => {
    const ser = await import(`${SRC}/preview/serialize.ts`);
    const fid = await import(`${SRC}/preview/fidelity.ts`);
    const pv = window.__mdr.app.preview;
    const out = [];
    const text = window.__mdr.app.getText();
    for (const w of document.querySelectorAll('.mdr-preview .md-block')) {
      const line = Number(w.getAttribute('data-l') ?? w.querySelector('[data-l]')?.getAttribute('data-l'));
      const bi = pv.blockAtLine(line + 1);
      if (!bi) continue;
      const raw = text.split('\n').slice(bi.startLine - 1, bi.startLine - 1 + bi.lineCount);
      while (raw.length && raw[raw.length - 1].trim() === '') raw.pop();
      const content = raw.join('\n');
      const why = ser.unsupportedReason(w, content);
      let base = null, err = null, faithful = null;
      try { base = ser.serializeBlock(w, bi.kind, { ...ser.sourceStyleHints(content), editing: true }); faithful = fid.baselineFaithful(w, bi.kind, base); } catch (e) { err = String(e); }
      out.push({ kind: bi.kind, html: w.innerHTML.slice(0, 300), flagged: w.hasAttribute('data-mdr-x'), why, base, err, faithful });
    }
    return out;
  }, { SRC });
  console.log(WHICH, JSON.stringify(info, null, 1));
  const pt = await page.evaluate(() => {
    const root = document.querySelector('.mdr-preview');
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf('terms');
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i + 2); r.setEnd(n, i + 3);
      const b = r.getBoundingClientRect();
      if (b.width) { const x = b.left + 1, y = b.top + b.height / 2, e = document.elementFromPoint(x, y); return { x, y, hit: e ? e.tagName + '.' + e.className : null }; }
    }
    return null;
  });
  console.log(WHICH, 'click point hits', pt.hit);
  await page.mouse.click(pt.x, pt.y);
  await sleep(250);
  const live = await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
  console.log(WHICH, 'modules', await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /main.ts|inlineEdit/.test(n)).join(' ')));
  console.log(WHICH, 'session', live, 'page errors', errs.length, errs.slice(0, 2).join(' | '));
  const before = await page.evaluate(() => window.__mdr.app.getText());
  if (live) { await page.keyboard.press('End'); await page.keyboard.type('s'); }
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(300);
  const after = await page.evaluate(() => window.__mdr.app.getText());
  console.log(WHICH, 'source', JSON.stringify(before), '->', JSON.stringify(after));
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  process.exitCode = 2;
} finally {
  clearTimeout(killer);
  try { await browser?.close(); } catch { /* */ }
}
