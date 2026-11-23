// bench/verify/ux/v-focus-dbg.mjs — drill-down on the three suspicious behaviours.
// Run: MDR_UX_BASE=http://localhost:5242 node bench/verify/ux/v-focus-dbg.mjs
import { launch, open, step, expect, check, sleep, getFailures } from './lib.mjs';

const { browser, page, errors } = await launch();
const probe = () => page.evaluate(() => {
  const foci = [...document.querySelectorAll('.is-focus')];
  const peers = [...document.querySelectorAll('.cm-peerLine')];
  const view = window.__mdr.app.editor.view;
  const ln = (el) => { try { return el ? view.state.doc.lineAt(view.posAtDOM(el)).number : null; } catch { return null; } };
  const actives = [...document.querySelectorAll('.cm-content .cm-activeLine')];
  return {
    focusCount: foci.length, focusText: foci[0]?.textContent?.slice(0, 24) ?? null, focusTag: foci[0]?.tagName ?? null,
    peerCount: peers.length, peerLine: ln(peers[0]),
    activeLine: ln(actives[0]), activeBg: actives[0] ? getComputedStyle(actives[0]).backgroundColor : null,
    caretLine: view.state.doc.lineAt(view.state.selection.main.head).number,
    peerActive: !!document.querySelector('.cm-editor')?.classList.contains('mdr-peer-active'),
  };
});
const fresh = async (q = '?doc=/test-data/small.md&mode=split') => { await open(page, q); await sleep(350); };

// ---------------------------------------------------------------- Alt+click: does altKey even arrive?
await fresh();
await step('DBG1 Alt+click: raw event flags seen by a listener on the preview', async () => {
  await page.evaluate(() => {
    window.__clicks = []; window.__gotos = []; window.__focus = [];
    document.querySelector('.mdr-preview').addEventListener('click', (e) => {
      window.__clicks.push({ alt: e.altKey, meta: e.metaKey, ctrl: e.ctrlKey, button: e.button,
                             target: e.target.tagName, defaultPrevented: e.defaultPrevented });
    }, true);
    window.__mdr.app.bus.on('nav:gotoLine', (e) => window.__gotos.push(e));
    window.__mdr.app.bus.on('focus:line', (e) => window.__focus.push(e));
  });
  const pos = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.mdr-preview__body p')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 150 && r.bottom < innerHeight - 150; });
    const r = el.getBoundingClientRect(); return { x: r.left + 12, y: r.top + 6 };
  });
  await page.mouse.click(pos.x, pos.y, { modifiers: ['Alt'] });
  await sleep(600);
  const r = await page.evaluate(() => ({ clicks: window.__clicks, gotos: window.__gotos, focus: window.__focus }));
  return JSON.stringify(r);
});

await step('DBG2 Alt+click via keyboard.down(Alt) + mouse.click', async () => {
  await page.evaluate(() => { window.__clicks = []; window.__gotos = []; window.__focus = []; });
  const pos = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.mdr-preview__body p')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 200 && r.bottom < innerHeight - 200; });
    const r = el.getBoundingClientRect(); return { x: r.left + 12, y: r.top + 6 };
  });
  await page.keyboard.down('Alt');
  await page.mouse.click(pos.x, pos.y);
  await page.keyboard.up('Alt');
  await sleep(600);
  const r = await page.evaluate(() => ({ clicks: window.__clicks, gotos: window.__gotos, focus: window.__focus }));
  const p = await probe();
  expect(r.gotos.length === 1, `nav:gotoLine ${r.gotos.length}x; raw clicks: ${JSON.stringify(r.clicks)}`);
  return JSON.stringify({ ...r, caretLine: p.caretLine, peer: p.peerCount, activeBg: p.activeBg, focusCount: p.focusCount });
});

// ---------------------------------------------------------------- C2: what is actually tinted where
await fresh();
await step('DBG3 selection dedupe: exact state after select → editor click → re-select the SAME line', async () => {
  const pick = () => page.evaluate(() => {
    const el = [...document.querySelectorAll('.mdr-preview__body p')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 120 && r.bottom < innerHeight - 120; });
    const range = document.createRange(); range.selectNodeContents(el);
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
    return el.textContent.slice(0, 18);
  });
  const t = await pick();
  await sleep(350);
  const s1 = await probe();
  await page.locator('.cm-content .cm-line').nth(0).click();   // caret to line 1
  await sleep(350);
  const s2 = await probe();
  await pick();
  await sleep(400);
  const s3 = await probe();
  const ok = s3.peerCount === 1 && s3.focusText === s1.focusText;
  expect(ok, `after re-selecting the same text the panes disagree: preview tints ${JSON.stringify(s3.focusText)} ` +
             `(want ${JSON.stringify(s1.focusText)}), editor peer=${s3.peerCount} caretLineTint=${s3.activeBg} on line ${s3.activeLine}`);
  return JSON.stringify({ selected: t, s1, s2, s3 });
});

// ---------------------------------------------------------------- mode switch loses the peer line
await fresh();
await step('DBG4 preview click, then split → preview → split: which lines are tinted', async () => {
  const pos = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.mdr-preview__body p')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 150 && r.bottom < innerHeight - 150; });
    const r = el.getBoundingClientRect(); return { x: r.left + 12, y: r.top + 6 };
  });
  await page.mouse.click(pos.x, pos.y);
  await sleep(350);
  const a = await probe();
  await page.evaluate(() => window.__mdr.mode('preview'));
  await sleep(400);
  const b = await probe();
  await page.evaluate(() => window.__mdr.mode('split'));
  await sleep(700);
  const c = await probe();
  expect(c.peerCount === 1 && c.peerLine === a.peerLine,
    `mode round trip lost the peer line: before peer=${a.peerLine}, after peer=${c.peerCount}/${c.peerLine}, ` +
    `editor now tints the caret line ${c.activeLine} (${c.activeBg}) while the preview still tints ${JSON.stringify(c.focusText)}`);
  return JSON.stringify({ a, b, c });
});

check('no console / page errors', errors.length === 0, errors.slice(0, 6).join(' | '));
console.log(`failures=${getFailures()}`);
await browser.close();
process.exit(0);
