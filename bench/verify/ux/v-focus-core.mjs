// bench/verify/ux/v-focus-core.mjs — VERIFIER script for the focus-line feature (CONTRACT §9).
// Drives the real UI with real mouse clicks / drags on small.md in split mode.
// Run: MDR_UX_BASE=http://localhost:5242 node bench/verify/ux/v-focus-core.mjs
import { launch, open, step, expect, check, sleep, getFailures, BASE } from './lib.mjs';

const { browser, page, errors } = await launch();

/** Everything about the current tint, in one round trip. */
const probe = () => page.evaluate(() => {
  const body = document.querySelector('.mdr-preview__body');
  const foci = [...document.querySelectorAll('.is-focus')];
  const cm = document.querySelector('.cm-editor');
  const peers = [...document.querySelectorAll('.cm-peerLine')];
  const actives = [...document.querySelectorAll('.cm-content .cm-activeLine')];
  const view = window.__mdr.app.editor.view;
  const lineOfCmEl = (el) => {
    if (!el) return null;
    try { return view.state.doc.lineAt(view.posAtDOM(el)).number; } catch { return null; }
  };
  const blockOf = (el) => {
    const b = el?.closest?.('.md-block');
    return b ? { id: Number(b.dataset.id), tag: el.tagName } : null;
  };
  const sel = view.state.selection.main;
  return {
    focusCount: foci.length,
    focusTag: foci[0]?.tagName ?? null,
    focusDataL: foci[0]?.dataset?.l ?? null,
    focusBlock: blockOf(foci[0]),
    focusInBody: foci[0] ? !!body?.contains(foci[0]) : false,
    focusBg: foci[0] ? getComputedStyle(foci[0]).backgroundColor : null,
    focusShadow: foci[0] ? getComputedStyle(foci[0]).boxShadow : null,
    focusText: foci[0]?.textContent?.slice(0, 40) ?? null,
    peerCount: peers.length,
    peerLine: lineOfCmEl(peers[0]),
    peerBg: peers[0] ? getComputedStyle(peers[0]).backgroundColor : null,
    peerActiveClass: !!cm?.classList.contains('mdr-peer-active'),
    activeCount: actives.length,
    activeLine: lineOfCmEl(actives[0]),
    activeBg: actives[0] ? getComputedStyle(actives[0]).backgroundColor : null,
    activeGutterBg: (() => {
      const g = document.querySelector('.cm-gutters .cm-activeLineGutter');
      return g ? getComputedStyle(g).backgroundColor : null;
    })(),
    caretLine: view.state.doc.lineAt(sel.head).number,
    editorFocused: window.__mdr.app.editor.hasFocus(),
    editorScrollTop: view.scrollDOM.scrollTop,
    previewScrollTop: document.querySelector('.mdr-preview').scrollTop,
    activeElement: document.activeElement?.className || document.activeElement?.tagName,
  };
});

/** Absolute line of a preview element (block start + data-l), computed in the page. */
const lineOfSelector = (sel, nth = 0) => page.evaluate(([s, n]) => {
  const el = document.querySelectorAll(s)[n];
  if (!el) return null;
  const block = el.closest('.md-block');
  const start = window.__mdr.app.preview.blockAtLine(1) && (() => {
    const id = Number(block.dataset.id);
    const p = window.__mdr.app.preview;
    // walk: find the block whose id matches by scanning lines is too slow; use the model through blockAtLine
    // binary search over lines instead.
    let lo = 1, hi = window.__mdr.app.editor.lineCount();
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const b = p.blockAtLine(mid);
      if (b.id === id) return b.startLine;
      if (b.id < id) lo = mid + 1; else hi = mid;
    }
    const b = p.blockAtLine(lo);
    return b.id === id ? b.startLine : null;
  })();
  const rel = Number(el.closest('[data-l]')?.dataset.l ?? 0);
  return start === null ? null : start + (Number.isFinite(rel) ? rel : 0);
}, [sel, nth]);

await open(page, '?doc=/test-data/small.md&mode=split');
await sleep(300);

await step('load: nothing tinted in the preview, editor caret line tinted', async () => {
  const p = await probe();
  expect(p.focusCount === 0, `preview .is-focus count ${p.focusCount}, want 0 at load`);
  expect(p.peerCount === 0, `cm-peerLine count ${p.peerCount}, want 0`);
  return JSON.stringify({ focusCount: p.focusCount, activeLine: p.activeLine, activeBg: p.activeBg });
});

// ---------------------------------------------------------------- 1. editor click → preview tint
await step('editor click on a paragraph line tints exactly one preview element on the same line', async () => {
  // click on the editor line that renders paragraph line 7
  await page.evaluate(() => {
    const v = window.__mdr.app.editor.view;
    v.focus();
    v.dispatch({ selection: { anchor: v.state.doc.line(7).from + 3 } });
  });
  await sleep(200);
  const p = await probe();
  expect(p.focusCount === 1, `preview .is-focus count ${p.focusCount}, want 1`);
  expect(p.peerCount === 0, `peer line should not be set while the editor owns the focus (${p.peerCount})`);
  expect(p.activeLine === 7, `caret line ${p.activeLine}`);
  expect(p.focusBg === p.activeBg, `preview tint ${p.focusBg} != editor caret tint ${p.activeBg}`);
  return JSON.stringify({ tag: p.focusTag, bg: p.focusBg, text: p.focusText });
});

// ---------------------------------------------------------------- 2. real mouse click in the preview
await step('real mouse click in a preview paragraph: peer line in the editor, same colour', async () => {
  const before = await probe();
  const target = page.locator('.mdr-preview__body p').nth(3);
  await target.click({ position: { x: 20, y: 6 } });
  await sleep(200);
  const p = await probe();
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  expect(p.peerCount === 1, `cm-peerLine count ${p.peerCount}, want 1`);
  expect(p.peerActiveClass, 'view.dom missing mdr-peer-active');
  expect(p.peerBg === p.focusBg, `peer bg ${p.peerBg} != preview bg ${p.focusBg}`);
  expect(p.activeBg === 'rgba(0, 0, 0, 0)', `caret line still tinted while a peer line is set: ${p.activeBg}`);
  expect(p.activeGutterBg === 'rgba(0, 0, 0, 0)', `caret gutter still tinted: ${p.activeGutterBg}`);
  expect(p.caretLine === before.caretLine, `caret moved ${before.caretLine} → ${p.caretLine}`);
  expect(!p.editorFocused, 'preview click pulled focus into the editor');
  expect(Math.abs(p.editorScrollTop - before.editorScrollTop) < 2, `editor scrolled ${before.editorScrollTop}→${p.editorScrollTop}`);
  expect(Math.abs(p.previewScrollTop - before.previewScrollTop) < 2, `preview scrolled ${before.previewScrollTop}→${p.previewScrollTop}`);
  return JSON.stringify({ peerLine: p.peerLine, focusTag: p.focusTag, bg: p.focusBg });
});

// ---------------------------------------------------------------- 3. exactly one per pane, ever
await step('clicking a second preview paragraph moves the tint (still exactly one per pane)', async () => {
  await page.locator('.mdr-preview__body p').nth(6).click({ position: { x: 20, y: 6 } });
  await sleep(200);
  const p = await probe();
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  expect(p.peerCount === 1, `peer count ${p.peerCount}`);
  return JSON.stringify({ peerLine: p.peerLine });
});

// ---------------------------------------------------------------- 4. headings
await step('click on a heading (h2) tints the heading element and mirrors it', async () => {
  const h = page.locator('.mdr-preview__body h2').first();
  await h.click({ position: { x: 10, y: 6 } });
  await sleep(200);
  const p = await probe();
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  expect(p.focusTag === 'H2', `tinted ${p.focusTag}, want H2`);
  expect(p.peerCount === 1, 'no peer line for the heading');
  const t = await page.evaluate((n) => window.__mdr.app.editor.view.state.doc.line(n).text, p.peerLine);
  expect(t.startsWith('## '), `editor line ${p.peerLine} is ${JSON.stringify(t)}, want a "## " heading`);
  return JSON.stringify({ tag: p.focusTag, peerLine: p.peerLine, text: t });
});

// ---------------------------------------------------------------- 5. nested list li > p
await step('click on a nested list item tints the deepest element with that data-l', async () => {
  const li = page.locator('.mdr-preview__body li').filter({ hasText: '嵌套项' }).last();
  await li.click({ position: { x: 20, y: 6 } });
  await sleep(200);
  const p = await probe();
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  const t = await page.evaluate((n) => window.__mdr.app.editor.view.state.doc.line(n).text, p.peerLine);
  expect(t.includes('嵌套项'), `editor line ${p.peerLine} = ${JSON.stringify(t)}, want the 嵌套项 line`);
  return JSON.stringify({ tag: p.focusTag, dataL: p.focusDataL, peerLine: p.peerLine, text: t });
});

// ---------------------------------------------------------------- 6. table
await step('click inside a table cell', async () => {
  const td = page.locator('.mdr-preview__body table td').nth(1);
  await td.click();
  await sleep(200);
  const p = await probe();
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  const t = await page.evaluate((n) => window.__mdr.app.editor.view.state.doc.line(n).text, p.peerLine);
  return JSON.stringify({ tag: p.focusTag, dataL: p.focusDataL, peerLine: p.peerLine, editorLine: t });
});

// ---------------------------------------------------------------- 7. blockquote
await step('click inside a blockquote', async () => {
  const bq = page.locator('.mdr-preview__body blockquote').first();
  await bq.click({ position: { x: 20, y: 8 } });
  await sleep(200);
  const p = await probe();
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  const t = await page.evaluate((n) => window.__mdr.app.editor.view.state.doc.line(n).text, p.peerLine);
  expect(t.startsWith('>'), `editor line ${p.peerLine} = ${JSON.stringify(t)}`);
  return JSON.stringify({ tag: p.focusTag, peerLine: p.peerLine, text: t });
});

// ---------------------------------------------------------------- 8. fenced code
await step('click inside a fenced code block (3rd source line of the fence)', async () => {
  const info = await page.evaluate(() => {
    const pre = document.querySelector('.mdr-preview__body pre');
    const r = pre.getBoundingClientRect();
    return { x: r.left + 40, y: r.top + r.height * 0.6, tag: pre.tagName, dataL: pre.dataset.l ?? null,
             inner: [...pre.querySelectorAll('[data-l]')].map((e) => e.tagName + ':' + e.dataset.l) };
  });
  await page.mouse.click(info.x, info.y);
  await sleep(200);
  const p = await probe();
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  const t = await page.evaluate((n) => window.__mdr.app.editor.view.state.doc.line(n).text, p.peerLine);
  return JSON.stringify({ tinted: p.focusTag, preDataL: info.dataL, innerDataL: info.inner,
                          peerLine: p.peerLine, editorLineText: t });
});

// ---------------------------------------------------------------- 9. text selection by real mouse drag
await step('real mouse drag selection inside a preview paragraph tints the anchor line', async () => {
  const box = await page.locator('.mdr-preview__body p').nth(8).boundingBox();
  await page.mouse.move(box.x + 10, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 6, { steps: 8 });
  await page.mouse.up();
  await sleep(250);
  const p = await probe();
  const selText = await page.evaluate(() => document.getSelection().toString());
  expect(selText.length > 0, 'nothing was selected by the drag');
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  expect(p.peerCount === 1, `peer count ${p.peerCount}`);
  return JSON.stringify({ selLen: selText.length, peerLine: p.peerLine });
});

await step('programmatic selection API (page.evaluate) also tints', async () => {
  // clear first by clicking into the editor
  await page.evaluate(() => { window.__mdr.app.editor.view.focus(); });
  await sleep(120);
  const r = await page.evaluate(() => {
    const ps = document.querySelectorAll('.mdr-preview__body p');
    const p = ps[11] ?? ps[ps.length - 1];
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return { text: p.textContent.slice(0, 20) };
  });
  await sleep(250);
  const p = await probe();
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  expect(p.peerCount === 1, `peer count ${p.peerCount} after a programmatic selection`);
  return JSON.stringify({ ...r, peerLine: p.peerLine });
});

// ---------------------------------------------------------------- 10. clicking back into the editor
await step('clicking back into the editor clears the peer line and restores the caret tint', async () => {
  await page.locator('.cm-content .cm-line').nth(4).click();
  await sleep(200);
  const p = await probe();
  expect(p.peerCount === 0, `peer line survived an editor click (${p.peerCount})`);
  expect(!p.peerActiveClass, 'mdr-peer-active survived an editor click');
  expect(p.activeBg !== 'rgba(0, 0, 0, 0)', `caret line not tinted again: ${p.activeBg}`);
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  expect(p.focusBg === p.activeBg, `tints diverged: ${p.focusBg} vs ${p.activeBg}`);
  return JSON.stringify({ activeLine: p.activeLine, focusTag: p.focusTag, bg: p.focusBg });
});

// ---------------------------------------------------------------- 11. first / last line
await step('first line of the document', async () => {
  await page.evaluate(() => {
    const v = window.__mdr.app.editor.view;
    v.focus(); v.dispatch({ selection: { anchor: 0 } });
  });
  await sleep(200);
  const p = await probe();
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  expect(p.focusTag === 'H1', `tinted ${p.focusTag} for line 1, want H1`);
  return JSON.stringify({ tag: p.focusTag });
});

await step('last line of the document (editor caret at the end)', async () => {
  const n = await page.evaluate(() => {
    const v = window.__mdr.app.editor.view;
    v.focus();
    v.dispatch({ selection: { anchor: v.state.doc.length }, scrollIntoView: true });
    return v.state.doc.lines;
  });
  await sleep(600);
  const p = await probe();
  expect(p.focusCount <= 1, `.is-focus count ${p.focusCount}`);
  return JSON.stringify({ lines: n, focusCount: p.focusCount, tag: p.focusTag, caretLine: p.caretLine });
});

await step('last preview element clicked', async () => {
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 1e9; });
  await sleep(500);
  const ok = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.mdr-preview__body .md-block:not(.is-pending) [data-l]')];
    const el = els[els.length - 1];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(20, r.width / 2), y: r.top + Math.min(8, r.height / 2), tag: el.tagName };
  });
  expect(ok, 'no mounted element at the document end');
  await page.mouse.click(ok.x, ok.y);
  await sleep(200);
  const p = await probe();
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  return JSON.stringify({ clicked: ok.tag, tinted: p.focusTag, peerLine: p.peerLine, lines: await page.evaluate(() => window.__mdr.app.editor.lineCount()) });
});

// ---------------------------------------------------------------- 12. whitespace between blocks
await step('click on the whitespace between two blocks does not break anything', async () => {
  const before = await probe();
  const pos = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.mdr-preview__body .md-block')].filter((b) => b.getBoundingClientRect().height > 0);
    for (let i = 0; i + 1 < blocks.length; i++) {
      const a = blocks[i].getBoundingClientRect(), b = blocks[i + 1].getBoundingClientRect();
      const gap = b.top - a.bottom;
      if (gap > 6 && a.bottom > 80 && a.bottom < window.innerHeight - 80) {
        return { x: a.right - 20, y: a.bottom + gap / 2, gap };
      }
    }
    return null;
  });
  expect(pos, 'no visible gap between blocks found');
  await page.mouse.click(pos.x, pos.y);
  await sleep(200);
  const p = await probe();
  expect(p.focusCount <= 1, `.is-focus count ${p.focusCount} after a gap click`);
  expect(p.peerCount <= 1, `peer count ${p.peerCount}`);
  return JSON.stringify({ gap: pos.gap.toFixed(1), focusCount: p.focusCount, focusTag: p.focusTag, peerLine: p.peerLine, unchanged: p.focusTag === before.focusTag });
});

await step('click on the preview padding area (outside any block)', async () => {
  const p0 = await probe();
  await page.evaluate(() => {
    const b = document.querySelector('.mdr-preview__body').getBoundingClientRect();
    return b;
  });
  const r = await page.locator('.mdr-preview').boundingBox();
  await page.mouse.click(r.x + 4, r.y + r.height - 6);
  await sleep(200);
  const p = await probe();
  expect(p.focusCount <= 1, `.is-focus count ${p.focusCount}`);
  return JSON.stringify({ before: p0.focusCount, after: p.focusCount });
});

// ---------------------------------------------------------------- 13. checkbox + link
await step('clicking a task checkbox still toggles the source AND tints', async () => {
  const before = await page.evaluate(() => {
    const cb = document.querySelector('.mdr-preview__body input[type=checkbox]');
    const li = cb.closest('[data-l]');
    return { checked: cb.checked, dataL: li.dataset.l };
  });
  await page.locator('.mdr-preview__body input[type=checkbox]').first().click();
  await sleep(500);
  const p = await probe();
  const after = await page.evaluate(() => document.querySelector('.mdr-preview__body input[type=checkbox]').checked);
  const t = await page.evaluate((n) => window.__mdr.app.editor.view.state.doc.line(n).text, p.peerLine ?? 1);
  expect(after !== before.checked, `checkbox state unchanged (${before.checked} → ${after}) — toggleTask broken`);
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  return JSON.stringify({ was: before.checked, now: after, peerLine: p.peerLine, srcLine: t, focusTag: p.focusTag });
});

await step('clicking an external link still works (target=_blank, no navigation) and tints', async () => {
  const p0 = await page.evaluate(() => {
    const a = [...document.querySelectorAll('.mdr-preview__body a[href^="http"]')][0];
    const r = a.getBoundingClientRect();
    a.dataset.mdrProbe = '1';
    return { x: r.left + 4, y: r.top + r.height / 2, target: a.target, href: a.href };
  });
  const url0 = page.url();
  await page.mouse.click(p0.x, p0.y);
  await sleep(250);
  const p = await probe();
  expect(page.url() === url0, `page navigated away: ${page.url()}`);
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  return JSON.stringify({ target: p0.target, focusTag: p.focusTag, peerLine: p.peerLine });
});

await step('Alt+click still jumps (nav:gotoLine) AND tints', async () => {
  const pos = await page.evaluate(() => {
    const ps = [...document.querySelectorAll('.mdr-preview__body p')];
    const el = ps[Math.min(5, ps.length - 1)];
    const r = el.getBoundingClientRect();
    return { x: r.left + 10, y: r.top + 6 };
  });
  const gotos = [];
  await page.evaluate(() => {
    window.__gotos = [];
    window.__mdr.app.bus.on('nav:gotoLine', (e) => window.__gotos.push(e));
  });
  // Playwright's page.mouse.click() has no `modifiers` option — with it the page sees altKey:false
  // (v-focus-dbg.mjs DBG1 measured exactly that). Holding Alt on the keyboard is the working form (DBG2).
  await page.keyboard.down('Alt');
  await page.mouse.click(pos.x, pos.y);
  await page.keyboard.up('Alt');
  await sleep(500);
  const p = await probe();
  const ev = await page.evaluate(() => window.__gotos);
  expect(ev.length === 1, `nav:gotoLine emitted ${ev.length} times, want 1`);
  expect(p.focusCount === 1, `.is-focus count ${p.focusCount}`);
  const oneTinted = (p.peerCount + (p.activeBg !== 'rgba(0, 0, 0, 0)' ? 1 : 0));
  expect(oneTinted === 1, `editor pane has ${oneTinted} tinted lines after Alt+click (peer=${p.peerCount}, activeBg=${p.activeBg})`);
  expect(p.caretLine === ev[0].line, `caret ${p.caretLine} != gotoLine ${ev[0].line}`);
  return JSON.stringify({ goto: ev[0], caretLine: p.caretLine, peerCount: p.peerCount, activeBg: p.activeBg, focusTag: p.focusTag });
});

// ---------------------------------------------------------------- 14. typing in the tinted paragraph (re-render)
await step('typing in the tinted paragraph keeps exactly one tint and follows the caret', async () => {
  await page.evaluate(() => {
    const v = window.__mdr.app.editor.view;
    v.focus();
    v.dispatch({ selection: { anchor: v.state.doc.line(7).to } });
  });
  await sleep(200);
  const p1 = await probe();
  await page.keyboard.type('ABC测试');
  await sleep(700);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(300);
  const p2 = await probe();
  expect(p2.focusCount === 1, `.is-focus count ${p2.focusCount} after typing`);
  expect(p2.focusText?.includes('ABC测试'), `tinted element does not contain the typed text: ${p2.focusText}`);
  expect(p2.peerCount === 0, `peer line set while typing in the editor (${p2.peerCount})`);
  return JSON.stringify({ before: p1.focusTag, after: p2.focusTag, text: p2.focusText?.slice(-12) });
});

// ---------------------------------------------------------------- 15. mode switches keep state
await step('mode switch split → edit → preview → split keeps the tint', async () => {
  await page.locator('.mdr-preview__body p').nth(4).click({ position: { x: 20, y: 6 } });
  await sleep(200);
  const a = await probe();
  for (const m of ['edit', 'preview', 'split']) {
    await page.evaluate((mm) => window.__mdr.mode(mm), m);
    await sleep(250);
  }
  const b = await probe();
  expect(b.focusCount === 1, `.is-focus count ${b.focusCount} after the mode round trip`);
  return JSON.stringify({ beforePeer: a.peerCount, afterPeer: b.peerCount, afterFocus: b.focusCount, afterTag: b.focusTag });
});

// ---------------------------------------------------------------- 16. loadText clears both
await step('loading a new document clears both tints, and the next editor click tints again', async () => {
  await page.evaluate(() => window.__mdr.loadText('# 新文档\n\n第一段。\n\n第二段。\n', 'new.md'));
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(400);
  const a = await probe();
  expect(a.focusCount === 0, `.is-focus count ${a.focusCount} right after a load, want 0`);
  expect(a.peerCount === 0, `peer count ${a.peerCount} right after a load`);
  // the user's FIRST interaction after the load must tint (skipNextCursor must not eat it)
  await page.locator('.cm-content .cm-line').nth(2).click();
  await sleep(300);
  const b = await probe();
  expect(b.focusCount === 1, `.is-focus count ${b.focusCount} after the first post-load editor click — skipNextCursor ate it?`);
  return JSON.stringify({ afterLoad: a.focusCount, afterFirstClick: b.focusCount, caretLine: b.caretLine, tag: b.focusTag });
});

check('no console / page errors', errors.length === 0, errors.slice(0, 6).join(' | '));
console.log(`\nBASE=${BASE}  failures=${getFailures()}`);
await browser.close();
process.exit(getFailures() ? 1 : 0);
