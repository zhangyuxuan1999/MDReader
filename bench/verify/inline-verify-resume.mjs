// bench/verify/inline-verify-resume.mjs — verifier: what happens to input typed between a split write (Enter) and
// the resumed session: resume latency on small.md / large.md, CJK insertText (IME commit) and IME composition
// arriving during that window, and Backspace during it. Run: node bench/verify/inline-verify-resume.mjs (:5263)
import { startServer, stopServer, openBrowser, readRoot, check, note, step, assert, finish, sleep, measure } from './inline-verify-lib.mjs';

await startServer();
const B = await openBrowser();
const { page, context } = B;
const SMALL = readRoot('test-data/small.md');
try {
  await B.boot('mode=split');
  const cdp = await context.newCDPSession(page);
  async function setup(doc, name) {
    await B.loadDoc(doc, name);
    const line = await page.evaluate(() => {
      const pv = window.__mdr.app.preview; const d = window.__mdr.app.editor.view.state.doc;
      let l = Math.min(50000, Math.floor(d.lines / 2));
      for (let i = 0; i < 400; i++) { const b = pv.blockAtLine(l); if (b.kind === 0 && d.line(b.startLine).text.includes('The quick brown fox')) return b.startLine; l = b.startLine + b.lineCount; }
      return null;
    });
    await B.clickLine(line, 'first', 'quick');
    await B.caretAt('jumps');
    return line;
  }
  // resume latency
  for (const [doc, name] of [[SMALL, 'small.md'], ['large', 'large.md']]) {
    const text = doc === 'large' ? await (await fetch(`http://localhost:${Number(process.env.MDR_PORT) || 5263}/test-data/large.md`)).text() : doc;
    const lat = [];
    for (let k = 0; k < 5; k++) {
      await setup(text, name);
      await page.evaluate(() => {
        window.__rs = { t0: 0, t1: -1 };
        const el0 = document.querySelector('.is-editing');
        document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !window.__rs.t0) window.__rs.t0 = performance.now(); }, { capture: true, once: true });
        const poll = () => {
          const e = document.querySelector('.is-editing');
          if (window.__rs.t0 && e && e !== el0 && document.activeElement === e) { window.__rs.t1 = performance.now() - window.__rs.t0; return; }
          if (!window.__rs.t0 || performance.now() - window.__rs.t0 < 5000) setTimeout(poll, 1);
        };
        poll();
      });
      await page.keyboard.press('Enter');
      await sleep(1500);
      const ms = await page.evaluate(() => window.__rs.t1);
      lat.push(ms);
      await B.esc();
    }
    lat.sort((a, b) => a - b);
    measure(`${name}: Enter → resumed session (no-session window)`, `${lat.map((x) => x.toFixed(0)).join('/')} ms (median ${lat[2].toFixed(0)})`, 'as short as possible; input in it must not be lost', lat[4] >= 0);
  }
  // CJK insertText (what an IME commit / Playwright non-ASCII typing produces) right after Enter
  for (const gap of [0, 10, 30, 60, 120, 250]) {
    await step(`CJK text committed ${gap} ms after Enter is not lost`, async () => {
      const line = await setup(SMALL, 'small.md');
      await page.keyboard.press('Enter');
      if (gap) await sleep(gap);
      await cdp.send('Input.insertText', { text: '新段落' });
      await sleep(30);
      await cdp.send('Input.insertText', { text: '开始' });
      await B.settle(500);
      const s = await B.source();
      await B.esc();
      const ls = s.split('\n'); const i = ls.findIndex((l) => l.includes('新段') || l.includes('开始')); assert(s.includes('新段落开始'), `lost; lines near edit: ${JSON.stringify(ls.slice(line - 1, line + 3).map((l) => l.slice(-30)))} found ${i}`);
    });
  }
  for (const gap of [0, 20, 60, 150]) {
    await step(`IME composition starting ${gap} ms after Enter is not lost`, async () => {
      await setup(SMALL, 'small.md');
      await page.keyboard.press('Enter');
      if (gap) await sleep(gap);
      for (const t of ['x', 'xi', 'xin']) { await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length }); await sleep(30); }
      await cdp.send('Input.insertText', { text: '新' });
      await B.settle(500);
      const s = await B.source();
      await B.esc();
      assert(s.includes('\n新over') || s.includes('\n新 over'), `lost: ${JSON.stringify(s.split('\n').find((l) => l.includes('over the lazy')) ?? '').slice(0, 40)}`);
    });
  }
  await step('ASCII typed immediately after Enter is replayed (keydown buffer)', async () => {
    const line = await setup(SMALL, 'small.md');
    await page.keyboard.press('Enter');
    await page.keyboard.type('abc');
    await B.settle(500);
    const s = await B.source();
    await B.esc();
    const ls = s.split('\n');
    assert(ls.slice(line - 1, line + 3).some((l) => l.startsWith('abc')), JSON.stringify(ls.slice(line - 1, line + 3).map((l) => l.slice(0, 30))));
  });
  await cdp.detach();
  check('no console errors', B.consoleErrors.length === 0, B.consoleErrors.slice(0, 3).join(' | '));
  check('no page errors', B.pageErrors.length === 0, B.pageErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('run', false, err.stack);
} finally {
  await B.browser.close().catch(() => {});
  stopServer();
}
finish();
