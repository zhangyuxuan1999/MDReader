// bench/verify/ux/v-focus-iso.mjs — each check starts from a FRESH page load so no earlier step's
// scroll position or selection can contaminate it. Run:
//   MDR_UX_BASE=http://localhost:5242 node bench/verify/ux/v-focus-iso.mjs
import { launch, open, step, expect, check, sleep, getFailures, BASE } from './lib.mjs';

const { browser, page, errors } = await launch();

const probe = () => page.evaluate(() => {
  const foci = [...document.querySelectorAll('.is-focus')];
  const cm = document.querySelector('.cm-editor');
  const peers = [...document.querySelectorAll('.cm-peerLine')];
  const actives = [...document.querySelectorAll('.cm-content .cm-activeLine')];
  const gut = document.querySelector('.cm-gutters .cm-activeLineGutter');
  const view = window.__mdr.app.editor.view;
  const lineOfCmEl = (el) => { try { return el ? view.state.doc.lineAt(view.posAtDOM(el)).number : null; } catch { return null; } };
  return {
    focusCount: foci.length, focusTag: foci[0]?.tagName ?? null, focusDataL: foci[0]?.dataset?.l ?? null,
    focusFullText: foci[0]?.textContent ?? null,
    focusBg: foci[0] ? getComputedStyle(foci[0]).backgroundColor : null,
    peerCount: peers.length, peerLine: lineOfCmEl(peers[0]),
    peerBg: peers[0] ? getComputedStyle(peers[0]).backgroundColor : null,
    peerActiveClass: !!cm?.classList.contains('mdr-peer-active'),
    activeCount: actives.length, activeLine: lineOfCmEl(actives[0]),
    activeBg: actives[0] ? getComputedStyle(actives[0]).backgroundColor : null,
    gutterExists: !!gut, gutterBg: gut ? getComputedStyle(gut).backgroundColor : null,
    caretLine: view.state.doc.lineAt(view.state.selection.main.head).number,
    editorFocused: window.__mdr.app.editor.hasFocus(),
    previewScrollTop: document.querySelector('.mdr-preview').scrollTop,
    editorScrollTop: view.scrollDOM.scrollTop,
  };
});

const fresh = async (q = '?doc=/test-data/small.md&mode=split') => { await open(page, q); await sleep(350); };
const lineText = (n) => page.evaluate((k) => window.__mdr.app.editor.view.state.doc.line(k).text, n);

// ---------------------------------------------------------------- A. gutter of the caret line
await fresh();
await step('A1 gutter: the caret-line gutter is tinted when the editor owns the line', async () => {
  await page.locator('.cm-content .cm-line').nth(6).click();
  await sleep(200);
  const p = await probe();
  expect(p.gutterExists, 'no .cm-activeLineGutter element at all');
  return JSON.stringify({ gutterBg: p.gutterBg, activeBg: p.activeBg, caretLine: p.caretLine });
});
await step('A2 gutter: while a peer line is set the caret gutter gives up its background', async () => {
  const pos = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.mdr-preview__body p')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 100 && r.bottom < innerHeight - 100; });
    const r = el.getBoundingClientRect(); return { x: r.left + 15, y: r.top + 6 };
  });
  await page.mouse.click(pos.x, pos.y);
  await sleep(250);
  const p = await probe();
  expect(p.peerCount === 1, `peer count ${p.peerCount}`);
  expect(p.activeBg === 'rgba(0, 0, 0, 0)', `caret line still tinted: ${p.activeBg}`);
  const gutterOk = !p.gutterExists || p.gutterBg === 'rgba(0, 0, 0, 0)';
  expect(gutterOk, `caret gutter still tinted: exists=${p.gutterExists} bg=${p.gutterBg}`);
  return JSON.stringify({ gutterExists: p.gutterExists, gutterBg: p.gutterBg, activeBg: p.activeBg, peerBg: p.peerBg });
});

// ---------------------------------------------------------------- B. real drag selection
await fresh();
await step('B1 real mouse drag selection in the preview tints the anchor line', async () => {
  const box = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.mdr-preview__body p')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 120 && r.bottom < innerHeight - 120 && r.width > 200; });
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, text: el.textContent.slice(0, 20) };
  });
  await page.mouse.move(box.x + 10, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 8, { steps: 10 });
  await page.mouse.up();
  await sleep(300);
  const sel = await page.evaluate(() => document.getSelection().toString());
  const p = await probe();
  expect(sel.length > 0, 'the drag selected nothing');
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  expect(p.peerCount === 1, `peer count ${p.peerCount} — selection did not mirror into the editor`);
  expect(p.peerBg === p.focusBg, `${p.peerBg} != ${p.focusBg}`);
  return JSON.stringify({ selected: sel.slice(0, 20), peerLine: p.peerLine, focusTag: p.focusTag });
});

// ---------------------------------------------------------------- C. programmatic selection API
await fresh();
await step('C1 selection via the DOM selection API (no mouse) tints + mirrors', async () => {
  const info = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.mdr-preview__body p')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 120 && r.bottom < innerHeight - 120; });
    const range = document.createRange(); range.selectNodeContents(el);
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
    return { text: el.textContent.slice(0, 16), collapsed: s.isCollapsed, anchorIn: document.querySelector('.mdr-preview').contains(s.anchorNode) };
  });
  await sleep(350);
  const p = await probe();
  expect(!info.collapsed, 'selection came out collapsed');
  expect(info.anchorIn, 'anchorNode is not inside the preview');
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  expect(p.peerCount === 1, `peer count ${p.peerCount}`);
  return JSON.stringify({ ...info, peerLine: p.peerLine, focusTag: p.focusTag });
});

await step('C2 a selection in the SAME line after the editor cleared the mirror re-mirrors it', async () => {
  const p1 = await probe();
  await page.locator('.cm-content .cm-line').nth(1).click();   // editor takes over, peer cleared
  await sleep(200);
  const mid = await probe();
  expect(mid.peerCount === 0, 'peer not cleared by the editor click');
  // re-select the very same preview text (same line as before)
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.mdr-preview__body p')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 120 && r.bottom < innerHeight - 120; });
    const range = document.createRange(); range.selectNodeContents(el);
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  });
  await sleep(350);
  const p2 = await probe();
  expect(p2.peerCount === 1, `re-selecting the same line did not restore the editor mirror (peer=${p2.peerCount}); ` +
    `lastFocusLine dedupe in interactions.ts swallows it`);
  return JSON.stringify({ first: p1.peerLine, after: p2.peerLine });
});

// ---------------------------------------------------------------- D. checkbox
await fresh();
await step('D1 clicking a task checkbox toggles the source AND tints', async () => {
  const before = await page.evaluate(() => {
    const cb = [...document.querySelectorAll('.mdr-preview__body input[type=checkbox]')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 60 && r.bottom < innerHeight - 60; });
    cb.dataset.probe = '1';
    const r = cb.getBoundingClientRect();
    return { checked: cb.checked, x: r.left + r.width / 2, y: r.top + r.height / 2, dataL: cb.closest('[data-l]').dataset.l };
  });
  const srcBefore = await page.evaluate(() => window.__mdr.app.getText());
  await page.mouse.click(before.x, before.y);
  await sleep(600);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(300);
  const srcAfter = await page.evaluate(() => window.__mdr.app.getText());
  const p = await probe();
  expect(srcBefore !== srcAfter, 'the source text did not change — toggleTask is broken');
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  const t = p.peerLine ? await lineText(p.peerLine) : null;
  return JSON.stringify({ was: before.checked, srcChanged: srcBefore !== srcAfter, peerLine: p.peerLine, srcLine: t, tag: p.focusTag });
});

// ---------------------------------------------------------------- E. Alt+click
await fresh();
await step('E1 Alt+click emits nav:gotoLine, moves the caret, and exactly one line is tinted per pane', async () => {
  await page.evaluate(() => { window.__gotos = []; window.__mdr.app.bus.on('nav:gotoLine', (e) => window.__gotos.push(e)); });
  const pos = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.mdr-preview__body p')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 150 && r.bottom < innerHeight - 150; });
    const r = el.getBoundingClientRect(); return { x: r.left + 12, y: r.top + 6, text: el.textContent.slice(0, 16) };
  });
  // Playwright's page.mouse.click() has no `modifiers` option — with it the page sees altKey:false
  // (v-focus-dbg.mjs DBG1 measured exactly that). Holding Alt on the keyboard is the working form (DBG2).
  await page.keyboard.down('Alt');
  await page.mouse.click(pos.x, pos.y);
  await page.keyboard.up('Alt');
  await sleep(700);
  const ev = await page.evaluate(() => window.__gotos);
  const p = await probe();
  expect(ev.length === 1, `nav:gotoLine emitted ${ev.length}x`);
  expect(p.caretLine === ev[0].line, `caret ${p.caretLine} != goto ${ev[0].line}`);
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  const tinted = p.peerCount + (p.activeBg && p.activeBg !== 'rgba(0, 0, 0, 0)' ? 1 : 0);
  expect(tinted === 1, `editor pane tinted lines = ${tinted} (peer=${p.peerCount} activeBg=${p.activeBg})`);
  return JSON.stringify({ goto: ev[0], caretLine: p.caretLine, peer: p.peerCount, activeBg: p.activeBg, activeLine: p.activeLine });
});

// ---------------------------------------------------------------- F. typing / re-render
await fresh();
await step('F1 typing in the tinted paragraph: the tint follows and there is still exactly one', async () => {
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(7).to } }); });
  await sleep(250);
  const p1 = await probe();
  expect(p1.focusCount === 1, `.is-focus ${p1.focusCount} before typing`);
  await page.keyboard.type('ZZ标记ZZ');
  await sleep(800);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(400);
  const p2 = await probe();
  expect(p2.focusCount === 1, `.is-focus ${p2.focusCount} after typing`);
  expect(p2.focusFullText?.includes('ZZ标记ZZ'), `the tinted element does not contain the typed text (tail: ${p2.focusFullText?.slice(-30)})`);
  expect(p2.peerCount === 0, `peer set while typing (${p2.peerCount})`);
  return JSON.stringify({ tag: p2.focusTag, tail: p2.focusFullText?.slice(-14) });
});

await step('F2 pressing Enter to split the tinted paragraph keeps exactly one tint on the caret line', async () => {
  await page.keyboard.press('Enter');
  await page.keyboard.type('新的一行');
  await sleep(800);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(400);
  const p = await probe();
  expect(p.focusCount === 1, `.is-focus ${p.focusCount}`);
  expect(p.focusFullText?.includes('新的一行'), `tinted element: ${p.focusFullText?.slice(0, 30)}`);
  return JSON.stringify({ tag: p.focusTag, caretLine: p.caretLine, text: p.focusFullText?.slice(0, 20) });
});

// ---------------------------------------------------------------- G. whitespace between blocks
await fresh();
await step('G1 click in the vertical gap between two blocks', async () => {
  const before = await probe();
  const pos = await page.evaluate(() => {
    const bs = [...document.querySelectorAll('.mdr-preview__body .md-block')].filter((b) => b.getBoundingClientRect().height > 0);
    for (let i = 0; i + 1 < bs.length; i++) {
      const a = bs[i].getBoundingClientRect(), b = bs[i + 1].getBoundingClientRect();
      const gap = b.top - a.bottom;
      if (gap >= 2 && a.bottom > 100 && a.bottom < innerHeight - 100) return { x: a.left + 30, y: a.bottom + gap / 2, gap };
    }
    // no gap at all: click the far right of a block, outside any [data-l] child? blocks are full width, so
    // fall back to the body's left padding area.
    const body = document.querySelector('.mdr-preview__body').getBoundingClientRect();
    return { x: body.left + 2, y: innerHeight / 2, gap: 0 };
  });
  await page.mouse.click(pos.x, pos.y);
  await sleep(250);
  const p = await probe();
  expect(p.focusCount <= 1, `.is-focus ${p.focusCount}`);
  expect(p.peerCount <= 1, `peer ${p.peerCount}`);
  return JSON.stringify({ gap: +pos.gap.toFixed(1), before: before.focusCount, after: p.focusCount, tag: p.focusTag, peer: p.peerCount });
});

await step('G2 click in the preview padding left of the body (no block under the pointer)', async () => {
  const pos = await page.evaluate(() => {
    const sc = document.querySelector('.mdr-preview').getBoundingClientRect();
    const body = document.querySelector('.mdr-preview__body').getBoundingClientRect();
    return { x: sc.left + Math.max(2, (body.left - sc.left) / 2), y: sc.top + sc.height / 2, pad: body.left - sc.left };
  });
  const before = await probe();
  await page.mouse.click(pos.x, pos.y);
  await sleep(250);
  const p = await probe();
  expect(p.focusCount <= 1, `.is-focus ${p.focusCount}`);
  return JSON.stringify({ padPx: +pos.pad.toFixed(0), before: before.focusCount, after: p.focusCount, sameTag: before.focusTag === p.focusTag });
});

// ---------------------------------------------------------------- H. fenced code detail
await fresh();
await step('H1 click on the LAST source line inside a fence: what gets tinted / which editor line', async () => {
  const info = await page.evaluate(() => {
    const pre = [...document.querySelectorAll('.mdr-preview__body pre')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 80 && r.bottom < innerHeight - 80; });
    const r = pre.getBoundingClientRect();
    const block = pre.closest('.md-block');
    return { x: r.left + 40, y: r.bottom - 8, preDataL: pre.dataset.l ?? null,
             inner: [...pre.querySelectorAll('[data-l]')].map((e) => e.tagName + '@' + e.dataset.l),
             blockDataL: [...block.querySelectorAll('[data-l]')].map((e) => e.tagName + '@' + e.dataset.l),
             text: pre.textContent.slice(0, 40) };
  });
  await page.mouse.click(info.x, info.y);
  await sleep(300);
  const p = await probe();
  const t = p.peerLine ? await lineText(p.peerLine) : null;
  expect(p.focusCount === 1, `.is-focus ${p.focusCount}`);
  return JSON.stringify({ tinted: p.focusTag, preDataL: info.preDataL, insideFence: info.inner,
                          blockMarks: info.blockDataL, peerLine: p.peerLine, editorLine: t });
});

await step('H2 caret INSIDE the fence in the editor: which preview element is tinted', async () => {
  const n = await page.evaluate(() => {
    const d = window.__mdr.app.editor.view.state.doc;
    for (let i = 1; i <= d.lines; i++) if (d.line(i).text.includes('// section 1')) return i;
    return null;
  });
  await page.evaluate((k) => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(k).from } }); }, n);
  await sleep(300);
  const p = await probe();
  expect(p.focusCount === 1, `.is-focus ${p.focusCount}`);
  return JSON.stringify({ editorLine: n, tinted: p.focusTag, focusDataL: p.focusDataL, snippet: p.focusFullText?.slice(0, 30) });
});

// ---------------------------------------------------------------- I. edit-only / preview-only modes
await fresh('?doc=/test-data/small.md&mode=edit');
await step('I1 edit-only mode: caret tint works, no crash, preview keeps state while hidden', async () => {
  await page.locator('.cm-content .cm-line').nth(6).click();
  await sleep(300);
  const p = await probe();
  expect(p.activeBg && p.activeBg !== 'rgba(0, 0, 0, 0)', `caret line not tinted in edit mode: ${p.activeBg}`);
  return JSON.stringify({ activeBg: p.activeBg, focusCount: p.focusCount, peer: p.peerCount });
});
await step('I2 edit → split: the preview shows the tint for the caret line', async () => {
  await page.evaluate(() => window.__mdr.mode('split'));
  await sleep(600);
  const p = await probe();
  return JSON.stringify({ focusCount: p.focusCount, tag: p.focusTag, caretLine: p.caretLine, activeLine: p.activeLine });
});

await fresh('?doc=/test-data/small.md&mode=preview');
await step('I3 preview-only mode: a click tints the preview and sets the peer line in the hidden editor', async () => {
  const pos = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.mdr-preview__body p')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 120 && r.bottom < innerHeight - 120; });
    const r = el.getBoundingClientRect(); return { x: r.left + 12, y: r.top + 6 };
  });
  await page.mouse.click(pos.x, pos.y);
  await sleep(300);
  const p = await probe();
  expect(p.focusCount === 1, `.is-focus ${p.focusCount}`);
  expect(p.peerCount === 1, `peer count ${p.peerCount} in preview-only mode`);
  return JSON.stringify({ focusCount: p.focusCount, peerLine: p.peerLine, tag: p.focusTag });
});
await step('I4 preview-only → split: the peer line is still there and the caret line is still hidden', async () => {
  await page.evaluate(() => window.__mdr.mode('split'));
  await sleep(600);
  const p = await probe();
  expect(p.peerCount === 1, `peer count ${p.peerCount} after the mode switch`);
  expect(p.focusCount === 1, `.is-focus ${p.focusCount}`);
  expect(p.activeBg === 'rgba(0, 0, 0, 0)', `caret line tinted too: ${p.activeBg}`);
  return JSON.stringify({ peerLine: p.peerLine, activeBg: p.activeBg, peerBg: p.peerBg, focusBg: p.focusBg });
});

check('no console / page errors', errors.length === 0, errors.slice(0, 6).join(' | '));
console.log(`\nBASE=${BASE}  failures=${getFailures()}`);
await browser.close();
process.exit(getFailures() ? 1 : 0);
