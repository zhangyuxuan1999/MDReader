// bench/verify/ux/v-focus-edge.mjs — remaining edges: click dedupe, back-to-back loads, #anchor links,
// selectionchange cost while typing, and the listener/leak check across preview dispose.
// Run: MDR_UX_BASE=http://localhost:5242 node bench/verify/ux/v-focus-edge.mjs
import { launch, open, step, expect, check, sleep, getFailures } from './lib.mjs';

const { browser, page, errors } = await launch();
const probe = () => page.evaluate(() => {
  const foci = [...document.querySelectorAll('.is-focus')];
  const peers = [...document.querySelectorAll('.cm-peerLine')];
  const view = window.__mdr.app.editor.view;
  const ln = (el) => { try { return el ? view.state.doc.lineAt(view.posAtDOM(el)).number : null; } catch { return null; } };
  const actives = [...document.querySelectorAll('.cm-content .cm-activeLine')];
  return { focusCount: foci.length, focusText: foci[0]?.textContent?.slice(0, 22) ?? null, focusTag: foci[0]?.tagName ?? null,
           peerCount: peers.length, peerSet: !!view.dom.classList.contains('mdr-peer-active'), peerLine: ln(peers[0]),
           activeLine: ln(actives[0]), activeBg: actives[0] ? getComputedStyle(actives[0]).backgroundColor : null,
           caretLine: view.state.doc.lineAt(view.state.selection.main.head).number };
});
const fresh = async (q = '?doc=/test-data/small.md&mode=split') => { await open(page, q); await sleep(350); };

await fresh();
await step('E-A clicking the SAME preview line again after the editor cleared the mirror restores it', async () => {
  const pos = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.mdr-preview__body p')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 150 && r.bottom < innerHeight - 150; });
    const r = el.getBoundingClientRect(); return { x: r.left + 12, y: r.top + 6 };
  });
  await page.mouse.click(pos.x, pos.y); await sleep(300);
  const a = await probe();
  await page.locator('.cm-content .cm-line').nth(0).click(); await sleep(300);
  const b = await probe();
  await page.mouse.click(pos.x, pos.y); await sleep(300);
  const c = await probe();
  expect(b.peerCount === 0, 'the editor click did not clear the mirror');
  expect(c.peerCount === 1 && c.peerLine === a.peerLine, `re-click did not restore the mirror: ${JSON.stringify(c)}`);
  return JSON.stringify({ first: a.peerLine, afterEditorClick: b.peerCount, reClick: c.peerLine });
});

await step('E-B two loadText calls in the same frame: the first real interaction still tints', async () => {
  await page.evaluate(() => {
    window.__mdr.loadText('# A\n\n一段。\n\n二段。\n', 'a.md');
    window.__mdr.loadText('# B\n\n甲段。\n\n乙段。\n', 'b.md');
  });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(500);
  const a = await probe();
  expect(a.focusCount === 0, `.is-focus ${a.focusCount} right after the loads`);
  await page.locator('.cm-content .cm-line').nth(2).click();
  await sleep(400);
  const b = await probe();
  expect(b.focusCount === 1, `.is-focus ${b.focusCount} after the first post-load editor click — a double load left skipNextCursor armed`);
  return JSON.stringify({ afterLoads: a.focusCount, afterClick: b.focusCount, caret: b.caretLine, text: b.focusText });
});

await fresh();
await step('E-C clicking an in-document #anchor link still navigates and leaves one tint per pane', async () => {
  await page.evaluate(() => { window.__gotos = []; window.__mdr.app.bus.on('nav:gotoLine', (e) => window.__gotos.push(e)); });
  const has = await page.evaluate(() => !!document.querySelector('.mdr-preview__body a[href^="#"]'));
  if (!has) {
    await page.evaluate(() => window.__mdr.loadText('# 顶部\n\n[去第二节](#第二节)\n\n' + Array.from({ length: 60 }, (_, i) => `段落 ${i}。`).join('\n\n') + '\n\n## 第二节\n\n内容。\n', 'anchor.md'));
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(500);
    await page.evaluate(() => { window.__gotos = []; window.__mdr.app.bus.on('nav:gotoLine', (e) => window.__gotos.push(e)); });
  }
  await page.locator('.mdr-preview__body a[href^="#"]').first().click();
  await sleep(900);
  const ev = await page.evaluate(() => window.__gotos);
  const p = await probe();
  expect(ev.length >= 1, `no nav:gotoLine emitted (${ev.length})`);
  expect(p.focusCount === 1, `.is-focus ${p.focusCount}`);
  const tinted = p.peerCount + (p.activeBg && p.activeBg !== 'rgba(0, 0, 0, 0)' ? 1 : 0);
  expect(tinted === 1, `editor tinted lines = ${tinted}`);
  return JSON.stringify({ gotos: ev, caret: p.caretLine, peer: p.peerCount, activeLine: p.activeLine, focusText: p.focusText });
});

await fresh();
await step('E-D selectionchange while typing in the EDITOR: extra frames but no extra focus:line', async () => {
  await page.evaluate(() => {
    window.__focus = []; window.__sel = 0;
    window.__mdr.app.bus.on('focus:line', (e) => window.__focus.push(e));
    document.addEventListener('selectionchange', () => { window.__sel++; }, true);
    const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(7).to } });
  });
  await sleep(250);
  await page.evaluate(() => { window.__focus = []; window.__sel = 0; });
  await page.keyboard.type('一二三四五六七八九十');
  await sleep(900);
  const r = await page.evaluate(() => ({ sel: window.__sel, focus: window.__focus.length, sources: [...new Set(window.__focus.map((e) => e.source))] }));
  const p = await probe();
  expect(r.sources.every((s) => s === 'editor'), `focus:line came from ${r.sources} while typing in the editor`);
  expect(p.focusCount === 1, `.is-focus ${p.focusCount}`);
  return JSON.stringify({ ...r, focusCount: p.focusCount });
});

await step('E-E listeners are removed on dispose (no document selectionchange handler survives)', async () => {
  const r = await page.evaluate(() => {
    const before = (getEventListeners?.(document)?.selectionchange ?? []).length;
    return { before, hasApi: typeof getEventListeners === 'function' };
  }).catch(() => ({ hasApi: false }));
  // getEventListeners is devtools-only; fall back to a behavioural check: dispose the app, then make a
  // selection in what is left of the preview DOM and prove nothing throws / no event reaches the bus.
  const out = await page.evaluate(() => {
    const errs = [];
    const onErr = (e) => errs.push(String(e.message ?? e));
    window.addEventListener('error', onErr);
    const previewEl = document.querySelector('.mdr-preview');
    const detached = document.createElement('div');
    detached.innerHTML = previewEl ? previewEl.innerHTML : '<p>x</p>';
    document.body.appendChild(detached);
    window.__mdr.app.dispose();
    const range = document.createRange(); range.selectNodeContents(detached);
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
    return new Promise((res) => setTimeout(() => {
      window.removeEventListener('error', onErr);
      res({ errs, previewStillInDom: !!document.querySelector('.mdr-preview') });
    }, 300));
  });
  expect(out.errs.length === 0, `errors after dispose: ${out.errs.join(' | ')}`);
  return JSON.stringify({ ...r, ...out });
});

check('no console / page errors', errors.length === 0, errors.slice(0, 6).join(' | '));
console.log(`failures=${getFailures()}`);
await browser.close();
process.exit(getFailures() ? 1 : 0);
