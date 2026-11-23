// bench/verify/v3-app-misc.mjs — verify-app (0.2.0 stage 2c), JOB 1: UI operations while a session holds text
// typed 0 ms ago: mode cycle (⌘/), theme (⇧⌘L), TOC toggle (⇧⌘O) and TOC click, palette (⇧⌘P), toolbar find +
// replace-all, a narrow window, the ⌘K link field left open across a mode switch, print media, and the status
// bar / TOC / focus line after a session.
// Needs a renderer on MDR_PORT (candidate: npx vite --port 5383 --strictPort). Writes nothing into the tree.
// Run: MDR_PORT=5383 node bench/verify/v3-app-misc.mjs [case-prefix]
import { openBrowser, step, assert, finish, sleep } from './v2-app-lib.mjs';

await (await import('./v2-app-lib.mjs')).ensureServer();   // starts vite on MDR_PORT when nothing answers there (stopped at exit)
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const only = process.argv[2] ?? '';
const t = (name, fn) => (only && !name.startsWith(only) ? Promise.resolve() : step(name, fn));
const B = await openBrowser();
const { page } = B;
const DOC = ['# 标题一', '', '甲段落文字。', '', '## 标题二', '', '乙段落文字。', '', '## 标题三', '', '丙段落文字。', ''].join('\n');
const L = (doc, needle) => doc.split('\n').findIndex((l) => l.includes(needle)) + 1;
async function startIn(doc, needle) {
  await B.clickLine(L(doc, needle), 'first', needle.slice(0, 2));
  await B.caretAt(needle);
  assert(await B.editing(), 'no session');
}
const typedLine = async (needle) => (await B.source()).split('\n').find((l) => l.includes(needle));
const mode = () => page.evaluate(() => document.querySelector('.mdr-app')?.dataset.mode ?? document.documentElement.dataset.mode ?? null);

try {
  await B.boot('mode=split');
  for (const [name, key] of [['mode', 'Meta+/'], ['theme', 'Meta+Shift+l'], ['toc', 'Meta+Shift+o'], ['palette', 'Meta+Shift+p'], ['pe-toggle', 'Meta+Shift+e']]) {
    await t(`X-${name}: type Q in a session, press ${key} at 0 ms, then type W`, async () => {
      await B.loadDoc(DOC);
      await startIn(DOC, '乙段落文字。');
      await page.keyboard.type('Q');
      await page.keyboard.press(key);
      await sleep(400);
      const s1 = await typedLine('乙段落');
      const ed = await B.editing();
      const active = await page.evaluate(() => document.activeElement?.tagName + '.' + String(document.activeElement?.className).split(' ')[0]);
      await page.keyboard.type('W');
      await B.settle(300);
      const s2 = await B.source();
      // undo the UI change
      if (name === 'palette') await page.keyboard.press('Escape');
      if (name === 'mode') { await page.evaluate(() => window.__mdr.app.registry.run('view.mode.split')); }
      if (name === 'theme' || name === 'toc') await page.keyboard.press(key);
      if (name === 'pe-toggle') await page.evaluate(() => window.__mdr.app.registry.run('view.togglePreviewEdit'));
      await sleep(300);
      await page.keyboard.press('Escape');
      assert(s1 === '乙段落文字。Q', `Q: ${JSON.stringify(s1)}`);
      const wIn = s2.split('\n').filter((l) => l.includes('W'));
      return `session after key=${ed} active=${active} W went to ${JSON.stringify(wIn)}`;
    });
  }
  await t('X-tocclick: type Q, click TOC 标题三 (0 ms): Q in 乙, preview at 标题三', async () => {
    await B.loadDoc(DOC);
    await startIn(DOC, '乙段落文字。');
    await page.keyboard.type('Q');
    const ok = await page.evaluate(() => { const a = [...document.querySelectorAll('.mdr-toc a, .mdr-toc button, .mdr-toc [role=treeitem], .mdr-toc li')].find((e) => e.textContent.trim() === '标题三'); if (!a) return false; const r = a.getBoundingClientRect(); return { x: r.left + 5, y: r.top + r.height / 2 }; });
    assert(ok, 'no TOC entry');
    await page.mouse.click(ok.x, ok.y);
    await B.settle(600);
    const s = await B.source();
    assert(s === DOC.replace('乙段落文字。', '乙段落文字。Q'), `source ${JSON.stringify(s)}`);
    assert(!(await B.editing()), 'session still live');
  });
  await t('X-find: type Q, toolbar find button (0 ms), replace all 段落 → DL: source has Q and every DL', async () => {
    await B.loadDoc(DOC);
    await startIn(DOC, '乙段落文字。');
    await page.keyboard.type('Q');
    const btn = await page.$('.mdr-toolbar__btn[data-cmd="edit.find"]');
    if (btn) await btn.click(); else await page.evaluate(() => window.__mdr.app.registry.run('edit.find'));
    await sleep(400);
    const s0 = await B.source();
    assert(s0.includes('乙段落文字。Q'), `Q lost: ${JSON.stringify(s0)}`);
    await page.keyboard.type('段落');
    await page.evaluate(() => { const r = document.querySelector('.cm-search input[name=replace]'); r.focus(); });
    await page.keyboard.type('DL');
    await page.evaluate(() => { const b = [...document.querySelectorAll('.cm-search button')].find((x) => x.name === 'replaceAll' || /all|全部/i.test(x.textContent)); b.click(); });
    await B.settle(400);
    const s = await B.source();
    assert(s === DOC.replace('乙段落文字。', '乙段落文字。Q').replaceAll('段落', 'DL'), `source ${JSON.stringify(s)}`);
    await page.keyboard.press('Escape');
    const shown = await page.evaluate(() => [...document.querySelectorAll('.mdr-preview section.md-block p')].map((p) => p.textContent));
    assert(JSON.stringify(shown) === JSON.stringify(['甲DL文字。', '乙DL文字。Q', '丙DL文字。']), `preview ${JSON.stringify(shown)}`);
    // a new session on the replaced block
    await startIn(s, '乙DL文字。Q');
    await page.keyboard.type('Z');
    await B.settle(300);
    await B.esc();
    const s2 = await B.source();
    assert(s2 === s.replace('乙DL文字。Q', '乙DL文字。QZ'), `after Z ${JSON.stringify(s2)}`);
  });
  await t('X-narrow: type Q, resize to 600 px wide (0 ms), type W, resize back', async () => {
    await B.loadDoc(DOC);
    await startIn(DOC, '乙段落文字。');
    await page.keyboard.type('Q');
    await page.setViewportSize({ width: 600, height: 800 });
    await sleep(500);
    const ed = await B.editing();
    await page.keyboard.type('W');
    await B.settle(300);
    const s = await B.source();
    await page.setViewportSize({ width: 1400, height: 900 });
    await sleep(400);
    await page.keyboard.press('Escape');
    assert(s.includes('乙段落文字。Q'), `Q lost ${JSON.stringify(s)}`);
    const w = s.split('\n').filter((l) => l.includes('W'));
    assert(!ed || JSON.stringify(w) === JSON.stringify(['乙段落文字。QW']), `W went to ${JSON.stringify(w)} (session ${ed})`);
    return `session after resize=${ed}, W in ${JSON.stringify(w)}, mode ${await mode()}`;
  });
  await t('X-link-mode: ⌘K link field open in a session, then ⌘/ (mode cycle): text kept, nothing stuck, next click edits', async () => {
    await B.loadDoc(DOC);
    await startIn(DOC, '乙段落文字。');
    await page.keyboard.type('Q');
    await B.selectText('段落');
    await page.keyboard.press('Meta+k');
    await sleep(300);
    const field = await page.evaluate(() => document.activeElement?.tagName);
    await page.keyboard.type('https://x.y');
    await page.keyboard.press('Meta+/');
    await sleep(500);
    const s1 = await B.source();
    await page.evaluate(() => window.__mdr.app.registry.run('view.mode.split'));
    await sleep(500);
    const ui = await page.evaluate(() => !!document.querySelector('.mdr-preview [data-mdr-ui] input, .mdr-preview input[type=url], .mdr-preview .mdr-link-ui'));
    await startIn(s1, '甲段落文字。');
    await page.keyboard.type('Z');
    await B.settle(300);
    await B.esc();
    const s2 = await B.source();
    assert(s1.includes('Q'), `Q lost ${JSON.stringify(s1)}`);
    assert(s2.includes('甲段落文字。Z'), `next session ${JSON.stringify(s2)}`);
    return `field ${field}, after ⌘/ ${JSON.stringify(s1.split('\n')[6])}, link UI left: ${ui}`;
  });
  await t('X-print: print media during a session: hint / outline / capture visible?', async () => {
    await B.loadDoc(DOC);
    await startIn(DOC, '乙段落文字。');
    await page.keyboard.type('Q');
    await page.emulateMedia({ media: 'print' });
    await sleep(200);
    const r = await page.evaluate(() => {
      const vis = (sel) => { const e = document.querySelector(sel); if (!e) return null; const cs = getComputedStyle(e); const b = e.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 1 && b.height > 1 ? (e.textContent || '').trim().slice(0, 30) || 'box' : false; };
      const ed = document.querySelector('.mdr-preview .is-editing');
      return { hint: vis('.mdr-preview__edit-hint'), capture: vis('.mdr-preview__edit-capture'), outline: ed ? getComputedStyle(ed).outlineStyle : null };
    });
    await page.emulateMedia({ media: 'screen' });
    await B.esc();
    return JSON.stringify(r);
  });
  await t('X-status: after typing in a session in 丙 and Esc: status bar line, TOC active, editor caret line', async () => {
    await B.loadDoc(DOC);
    await startIn(DOC, '丙段落文字。');
    await page.keyboard.type('Q');
    await B.settle(300);
    const during = await page.evaluate(() => ({ status: document.querySelector('.mdr-statusbar')?.textContent?.match(/行\s*\d+/)?.[0] ?? null, toc: document.querySelector('.mdr-toc [aria-current], .mdr-toc .is-active')?.textContent?.trim() ?? null }));
    await B.esc();
    const after = await page.evaluate(() => { const v = window.__mdr.app.editor.view; return { line: v.state.doc.lineAt(v.state.selection.main.head).number, status: document.querySelector('.mdr-statusbar')?.textContent?.match(/行\s*\d+/)?.[0] ?? null, toc: document.querySelector('.mdr-toc [aria-current], .mdr-toc .is-active')?.textContent?.trim() ?? null }; });
    assert(during.status === '行 11' && during.toc === '标题三', `during ${JSON.stringify(during)}`);
    assert(after.line === 11, `after ${JSON.stringify(after)}`);
    return JSON.stringify({ during, after });
  });
} finally {
  console.log('pageErrors', JSON.stringify(B.pageErrors.slice(0, 5)));
  console.log('consoleErrors', JSON.stringify(B.consoleErrors.slice(0, 5)));
  finish();
  await B.browser.close().catch(() => {});
  clearTimeout(KILL);
}
