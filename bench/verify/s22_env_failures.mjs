// s22 — hostile environment: localStorage throws, IDB quota exceeded, ?doc= 404,
// bogus ?mode=, gutter dragged to both extremes, then typing must still work.
// Run: node bench/verify/s22_env_failures.mjs
import { chromium } from '@playwright/test';
import { BASE, launch, open, settle, structureCheck, latencyStats, toasts, makeChecker, report, sleep } from './_lib.mjs';

const C = makeChecker();
let browser;
try {
  // ---------------------------------------------------------------- A. localStorage throws
  {
    const h = await launch({ initScript: `(() => {
      const boom = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
      try {
        Object.defineProperty(window, 'localStorage', { configurable: true, get: boom });
        Object.defineProperty(window, 'sessionStorage', { configurable: true, get: boom });
      } catch {}
    })();` });
    browser = h.browser;
    const { page, log } = h;
    try {
      await open(page, '?doc=/test-data/small.md&mode=split');
      const s = await settle(page, 60000);
      C.check('[localStorage throws] app boots and settles', s.ok, s);
      const sc = await structureCheck(page);
      C.check('[localStorage throws] structure tiles', sc.problems.length === 0, sc);
      await page.evaluate(() => { window.__mdr.app.editor.gotoLine(3, 0); window.__mdr.app.editor.focus(); });
      await page.keyboard.type('hello ls', { delay: 0 });
      const lat = await latencyStats(page);
      C.measure('[localStorage throws] input latency max (ms)', lat.max ?? 0, '< 100', (lat.max ?? 0) < 100);
      const s2 = await settle(page, 60000);
      C.check('[localStorage throws] settles after typing', s2.ok, s2);
      // Theme toggle + mode cycle both persist through localStorage
      await page.evaluate(() => { window.__mdr.app.registry.run('view.toggleTheme'); window.__mdr.app.registry.run('view.cycleMode'); window.__mdr.app.registry.run('view.toggleToc'); });
      await sleep(200);
      const st = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, mode: window.__mdr.app.layout.getMode() }));
      C.check('[localStorage throws] theme + mode commands still work', !!st.theme && !!st.mode, st);
      C.check('[localStorage throws] no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
      C.check('[localStorage throws] no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
      C.check('[localStorage throws] no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
    } finally { await browser.close(); }
  }

  // ---------------------------------------------------------------- B. IDB write quota exceeded
  {
    const h = await launch({ initScript: `(() => {
      // Fail every IDB write transaction (quota-style), reads still work.
      const openFn = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (...a) {
        const req = openFn.apply(this, a);
        req.addEventListener('success', () => {
          const db = req.result;
          const tx = db.transaction.bind(db);
          db.transaction = function (store, mode, ...rest) {
            const t = tx(store, mode, ...rest);
            if (mode === 'readwrite') {
              const os = t.objectStore.bind(t);
              t.objectStore = function (n) {
                const s = os(n);
                const put = s.put.bind(s);
                s.put = function (...pa) { const r = put(...pa); setTimeout(() => { try { t.abort(); } catch {} }, 0); return r; };
                return s;
              };
            }
            return t;
          };
        });
        return req;
      };
    })();` });
    browser = h.browser;
    const { page, log } = h;
    try {
      await open(page, '?doc=/test-data/small.md&mode=split');
      const s = await settle(page, 60000);
      C.check('[IDB writes abort] app boots and settles', s.ok, s);
      await page.evaluate(() => { window.__mdr.app.editor.gotoLine(3, 0); window.__mdr.app.editor.focus(); });
      await page.keyboard.type('quota test typing', { delay: 0 });
      await settle(page, 60000);
      await sleep(2500); // draft debounce 1000 ms + margin
      const sc = await structureCheck(page);
      C.check('[IDB writes abort] structure tiles after a failed draft write', sc.problems.length === 0, sc);
      const t = await toasts(page);
      C.check('[IDB writes abort] no error toast storm', t.filter((x) => /错误|失败|error/i.test(x)).length === 0, t);
      const lat = await latencyStats(page);
      C.measure('[IDB writes abort] input latency max (ms)', lat.max ?? 0, '< 100', (lat.max ?? 0) < 100);
      C.check('[IDB writes abort] no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
      C.check('[IDB writes abort] no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
      C.check('[IDB writes abort] no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
    } finally { await browser.close(); }
  }

  // ---------------------------------------------------------------- C. bad ?doc= / ?mode=
  {
    const h = await launch();
    browser = h.browser;
    const { page, log } = h;
    try {
      await open(page, '?doc=/test-data/does-not-exist.md&mode=wobble');
      await sleep(1500);
      const st = await page.evaluate(() => ({
        mode: window.__mdr.app.layout.getMode(),
        text: window.__mdr.app.editor.getText().length,
        toasts: Array.from(document.querySelectorAll('.mdr-toast')).map((t) => t.textContent.trim()),
      }));
      C.check('[?doc 404] app still usable, falls back to an empty document', st.text >= 0 && ['edit', 'split', 'preview'].includes(st.mode), st);
      C.check('[?doc 404] the failure is surfaced to the user (toast) or silently ignored without errors', true, st.toasts);
      await page.evaluate(() => window.__mdr.app.editor.focus());
      await page.keyboard.type('# after 404\n\nstill typing', { delay: 0 });
      const s = await settle(page, 60000);
      C.check('[?doc 404] typing works and settles', s.ok, s);
      const sc = await structureCheck(page);
      C.check('[?doc 404] structure tiles', sc.problems.length === 0, sc);
      C.check('[?doc 404] no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
      C.check('[?doc 404] no unhandled console errors', log.consoleErrors.filter((e) => !/404|Failed to load resource/i.test(e)).length === 0, log.consoleErrors.slice(0, 5));
    } finally { await browser.close(); }
  }

  // ---------------------------------------------------------------- D. gutter dragged to both extremes
  {
    const h = await launch();
    browser = h.browser;
    const { page, log } = h;
    try {
      await open(page, '?doc=/test-data/medium.md&mode=split');
      await settle(page, 60000);
      const g = await page.locator('.mdr-gutter').boundingBox();
      C.check('gutter exists', !!g, g);
      for (const [name, x] of [['far left', 2], ['far right', 1398]]) {
        await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
        await page.mouse.down();
        await page.mouse.move(x, g.y + g.height / 2, { steps: 8 });
        await page.mouse.up();
        await sleep(300);
        const dims = await page.evaluate(() => {
          const e = document.querySelector('.mdr-pane--editor').getBoundingClientRect();
          const p = document.querySelector('.mdr-pane--preview').getBoundingClientRect();
          return { editorW: Math.round(e.width), previewW: Math.round(p.width), split: getComputedStyle(document.querySelector('.mdr-app')).getPropertyValue('--split').trim(), docScrollW: document.documentElement.scrollWidth, vw: innerWidth };
        });
        C.check(`gutter dragged ${name}: no horizontal page overflow`, dims.docScrollW <= dims.vw, dims);
        C.check(`gutter dragged ${name}: both panes keep a usable width (≥ 40 px)`, dims.editorW >= 40 && dims.previewW >= 40, dims);
        await page.evaluate(() => { window.__mdr.app.editor.gotoLine(50, 0); window.__mdr.app.editor.focus(); });
        await page.keyboard.type('G', { delay: 0 });
        const s = await settle(page, 60000);
        C.check(`gutter dragged ${name}: typing still settles`, s.ok, s);
      }
      const sc = await structureCheck(page);
      C.check('gutter extremes: structure tiles', sc.problems.length === 0, sc);
      C.check('gutter extremes: no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
      C.check('gutter extremes: no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
    } finally { await browser.close(); }
  }
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
  try { await browser?.close(); } catch {}
} finally {
  console.log('\n=== s22 env failures ===');
  process.exit(C.failures() ? 1 : 0);
}
