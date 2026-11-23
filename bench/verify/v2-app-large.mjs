// bench/verify/v2-app-large.mjs — verify-app (0.2.0 stage 2a), JOB 2: test-data/large.md (102 003 lines) in split
// mode on either renderer: typing in the editor at the top / middle / end (preview follows, tint, TOC active
// entry, status bar line), wheel scrolling either pane (the other follows), a TOC click. RESULT lines = values.
// Candidate: MDR_BASE_URL=http://localhost:5283 node bench/verify/v2-app-large.mjs
// Baseline:  MDR_BASE_URL=http://127.0.0.1:5293 node bench/verify/v2-app-large.mjs
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
const B = await openBrowser();
const { page } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const probe = async (k, fn) => { try { out(k, await fn()); } catch (e) { out(k, `ERROR ${String(e.message).split('\n')[0]}`); } };
const idle = () => page.evaluate(() => window.__mdr.waitIdle());

try {
  // ?doc= is honoured only by the dev server: load through the test hook on both renderers
  await page.goto(`${BASE}/?mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  await page.evaluate(() => { void window.__mdr.loadUrl('/test-data/large.md'); });
  await page.waitForFunction(() => !!window.__mdr && window.__mdr.app.editor.view.state.doc.lines > 100000, null, { timeout: 60_000 });
  await idle(); await sleep(800);
  const n = await page.evaluate(() => window.__mdr.app.editor.view.state.doc.lines);
  for (const [name, line] of [['top', 3], ['middle', Math.floor(n / 2)], ['end', n - 2]]) {
    await probe(`type in editor at ${name}`, async () => {
      // a paragraph line near the target
      const l = await page.evaluate((t) => { const d = window.__mdr.app.editor.view.state.doc; for (let k = t; k < t + 200; k++) { const s = d.line(k).text; if (s.length > 10 && !/^[#|>`-]/.test(s)) return k; } return t; }, line);
      await page.evaluate((l) => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(l).to }, scrollIntoView: true }); }, l);
      await sleep(500); await idle(); await sleep(300);
      await page.keyboard.type('键入测试', { delay: 30 });
      await idle(); await sleep(700);
      return page.evaluate((l) => {
        const a = window.__mdr.app;
        const toc = document.querySelector('.mdr-toc .is-active');
        const status = [...document.querySelectorAll('.mdr-statusbar__item')].map((x) => x.textContent).join('|');
        return {
          line: l, textOk: a.editor.view.state.doc.line(l).text.endsWith('键入测试'),
          previewVisible: a.preview.isLineVisible(l),
          tint: document.querySelector('.mdr-preview .is-focus')?.textContent.trim().slice(-8) ?? null,
          tocActive: toc ? toc.textContent.trim().slice(0, 20) : null,
          statusHasLine: status.includes(String(l)),
        };
      }, l);
    });
  }
  await probe('wheel on editor → preview top line follows', async () => {
    const box = await page.evaluate(() => { const r = window.__mdr.app.editor.view.scrollDOM.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(box.x, box.y);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -2500); await sleep(60); }
    await sleep(900);
    return page.evaluate(() => ({ editor: window.__mdr.app.editor.topVisible().line, preview: window.__mdr.app.preview.topVisible().line }));
  });
  await probe('wheel on preview → editor top line follows', async () => {
    const box = await page.evaluate(() => { const r = window.__mdr.app.preview.el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(box.x, box.y);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 3000); await sleep(60); }
    await sleep(900);
    return page.evaluate(() => ({ editor: window.__mdr.app.editor.topVisible().line, preview: window.__mdr.app.preview.topVisible().line }));
  });
  await probe('TOC click on the 5th item → both panes there', async () => {
    const t = await page.evaluate(() => { const it = document.querySelectorAll('.mdr-toc [data-line], .mdr-toc a, .mdr-toc li')[4]; return it ? it.textContent.trim().slice(0, 20) : null; });
    await page.click(':is(.mdr-toc [data-line], .mdr-toc a, .mdr-toc li) >> nth=4'); await sleep(1200);
    return { item: t, editor: await page.evaluate(() => window.__mdr.app.editor.topVisible().line), preview: await page.evaluate(() => window.__mdr.app.preview.topVisible().line), active: await page.evaluate(() => document.querySelector('.mdr-toc .is-active')?.textContent.trim().slice(0, 20) ?? null) };
  });
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
}
