// s31 — spec §9 failure modes: KaTeX import fails → math=false, `$$` shown as text, ONE toast,
// no .md-error storm; plus: is the 「大文件…」 downgrade toast emitted once per document or repeated?
// Run: node bench/verify/s31_katex_fail_toasts.mjs
import { launch, open, settle, structureCheck, toasts, makeChecker, report, sleep } from './_lib.mjs';

const C = makeChecker();
{
  const { browser, page, log } = await launch();
  try {
    // Block every katex chunk request (main thread and worker both fetch through the dev server).
    let blocked = 0;
    const blockedUrls = [];
    await page.route(/katex/, (route) => {
      const u = route.request().url();
      if (/\.css(\?|$)/.test(u) || /katex\.min\.css/.test(u) || /fonts?\//i.test(u) || /\.woff|\.ttf/.test(u)) return route.continue();
      blocked++; blockedUrls.push(u); return route.abort('failed');
    });
    await open(page, '?mode=split');
    await settle(page, 60000);
    await page.evaluate(async () => {
      let t = '# Math doc\n\n';
      for (let i = 0; i < 50; i++) t += `Inline $x_${i} = \\frac{a}{b}$ here.\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$\n\n`;
      await window.__mdr.loadText(t, 'math.md');
    });
    const s = await settle(page, 90000);
    C.check('[katex blocked] settles', s.ok, s);
    await page.evaluate(() => window.__mdr.app.preview.mountAll());
    await sleep(1200);
    const sc = await structureCheck(page);
    C.check('[katex blocked] structure tiles', sc.problems.length === 0, sc);
    C.check('[katex blocked] no .md-error blocks', sc.errors === 0, sc);
    const t = await toasts(page);
    C.check('[katex blocked] exactly one KaTeX-failure toast (spec §9)', t.filter((x) => /公式|katex|数学/i.test(x)).length <= 1, t);
    C.check('[katex blocked] the user is told math is off', t.some((x) => /公式|katex|数学/i.test(x)), t);
    const shown = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.md-block')).find((x) => x.textContent.includes('sum_'));
      return { hasKatexEl: !!document.querySelector('.katex'), sample: b ? b.textContent.trim().slice(0, 60) : null, blocks: document.querySelectorAll('.md-block').length };
    });
    C.check('[katex blocked] $$ blocks fall back to text (no .katex nodes)', !shown.hasKatexEl, shown);
    await page.evaluate(() => { window.__mdr.app.editor.gotoLine(3, 0); window.__mdr.app.editor.focus(); });
    await page.keyboard.type(' more $y=1$ math ', { delay: 0 });
    const s2 = await settle(page, 90000);
    C.check('[katex blocked] typing more math still settles', s2.ok, s2);
    const t2 = await toasts(page);
    C.check('[katex blocked] no toast storm after more math is typed', t2.filter((x) => /公式|katex|数学/i.test(x)).length <= 1, t2);
    C.check('[katex blocked] no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
    C.check('[katex blocked] no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
    console.log('katex requests blocked:', blocked, blockedUrls.slice(0,5));
  } catch (e) { C.check('[katex blocked] script completed', false, String((e && e.stack) || e)); }
  finally { report('s31a katex blocked', log); await browser.close(); }
}
{
  const { browser, page, log } = await launch();
  try {
    await open(page, '?mode=split');
    await settle(page, 60000);
    for (let i = 0; i < 5; i++) {
      await page.evaluate(async (i) => { await window.__mdr.loadText('x'.repeat(300000) + `\n\n# doc ${i}\n`, `big${i}.md`); }, i);
      await settle(page, 90000);
      await sleep(200);
    }
    const t = await toasts(page);
    const downgrade = t.filter((x) => x.includes('大文件'));
    C.check('language-downgrade toast is not repeated per document (deduped or once)', downgrade.length <= 1, t);
    console.log('downgrade toasts:', JSON.stringify(downgrade));
    C.check('[downgrade] no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  } catch (e) { C.check('[downgrade] script completed', false, String((e && e.stack) || e)); }
  finally { report('s31b downgrade toasts', log); await browser.close(); }
}
process.exit(C.failures() ? 1 : 0);
