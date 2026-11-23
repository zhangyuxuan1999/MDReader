// bench/verify/inline-verify-render.mjs — verifier: no flicker / re-render during a session, structure stays exact,
// scroll sync, eviction never removes the session block, undo coalescing cause (CONTRACT §11).
// Run: node bench/verify/inline-verify-render.mjs   (own vite :5263, killed at exit)
import { startServer, stopServer, openBrowser, readRoot, check, note, step, assert, eq, finish, sleep, measure } from './inline-verify-lib.mjs';

await startServer();
const B = await openBrowser();
const { page } = B;
const MEDIUM = readRoot('test-data/medium.md');
const SMALL = readRoot('test-data/small.md');

/** Starts a MutationObserver on the preview root; returns a stopper that summarises what changed. */
async function observe() {
  await page.evaluate(() => {
    const root = window.__mdr.app.preview.el;
    const sess = document.querySelector('.mdr-preview .is-editing');
    window.__mo = { sess, recs: [] };
    window.__moObs = new MutationObserver((list) => {
      for (const m of list) {
        const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        const sec = t?.closest?.('section.md-block');
        window.__mo.recs.push({
          type: m.type, attr: m.attributeName, tag: t?.tagName, inSess: !!(sess && sess.contains(m.target)), sessSelf: m.target === sess,
          secId: sec?.dataset.id ?? null, removed: m.removedNodes.length, added: m.addedNodes.length,
          removedSess: [...m.removedNodes].some((n) => n === sess || (n.contains && n.contains(sess))),
          removedInner: m.target === sess && [...m.removedNodes].some((n) => n.nodeType === 1),
          cls: m.type === 'attributes' && m.attributeName === 'class' ? `${m.oldValue} → ${t.className}` : undefined,
        });
      }
    });
    window.__moObs.observe(root, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true });
  });
  return async () => page.evaluate(() => {
    window.__moObs.disconnect();
    const r = window.__mo.recs;
    const sessId = window.__mo.sess?.dataset.id;
    const out = { total: r.length, inSess: 0, outside: {}, sessChildList: 0, sessRemovedElements: 0, sessRemoved: 0, attrsInSess: {}, classChangesInSess: [] };
    for (const x of r) {
      if (x.removedSess) out.sessRemoved++;
      if (x.inSess) {
        out.inSess++;
        if (x.removedInner) out.sessRemovedElements++;
        if (x.type === 'attributes') { out.attrsInSess[x.attr] = (out.attrsInSess[x.attr] ?? 0) + 1; if (x.cls && out.classChangesInSess.length < 6) out.classChangesInSess.push(`${x.tag}: ${x.cls}`); }
      } else {
        const k = `${x.secId ?? 'root'}:${x.type}${x.attr ? '/' + x.attr : ''}`;
        out.outside[k] = (out.outside[k] ?? 0) + 1;
      }
    }
    out.sessId = sessId;
    return out;
  });
}

try {
  await B.boot('mode=split');

  // ------------------------------------------------------------ no re-render of the session block while typing
  await B.loadDoc(SMALL);
  const P = SMALL.split('\n').findIndex((l) => l.includes('The quick brown fox')) + 1;
  await step('typing 40 chars: only the session block mutates; never a worker replaceChildren on it', async () => {
    await B.clickLine(P, 'first', 'quick');
    await B.caretAt('quick');
    const stop = await observe();
    await page.keyboard.type('abcdefghijklmnopqrstuvwxyz0123456789ABCD', { delay: 40 });
    await B.settle(400);
    const r = await stop();
    await B.esc();
    const outsideKeys = Object.keys(r.outside);
    note('mutations during typing', JSON.stringify(r));
    assert(r.sessRemoved === 0, 'session section removed');
    assert(r.sessRemovedElements === 0, `${r.sessRemovedElements} element removals directly under the session section (replaceChildren?)`);
    const foreign = outsideKeys.filter((k) => !k.startsWith('root:') && !/class$/.test(k));
    assert(foreign.length === 0, `other blocks mutated: ${foreign.join(', ')}`);
    return `inSess ${r.inSess}, outside ${JSON.stringify(r.outside)}`;
  });

  await step('undo coalescing: what touches the session DOM besides typing (class/attr writes break Chrome typing groups)', async () => {
    await B.loadDoc(SMALL);
    await B.clickLine(P, 'first', 'quick');
    await B.caretAt('quick');
    const stop = await observe();
    await page.keyboard.type('undo', { delay: 40 });
    await B.settle(300);
    const r = await stop();
    await page.keyboard.press('ControlOrMeta+z');
    await B.settle(300);
    const line = (await B.source()).split('\n')[P - 1];
    await B.esc();
    note('attrs in session during typing', `${JSON.stringify(r.attrsInSess)} ${JSON.stringify(r.classChangesInSess)}; after one ⌘Z: «${line.slice(0, 30)}»`);
  });

  // ------------------------------------------------------------ structure tiles after each write
  await step('structure tiles the document after every write (typing, Enter split, list Enter, Esc)', async () => {
    await B.loadDoc(SMALL);
    const bad = [];
    await B.clickLine(P, 'first', 'quick');
    await B.caretAt('quick');
    for (const k of ['a', 'b', 'Enter', 'c', 'Shift+Enter', 'd', 'Enter', 'Enter', 'e']) {
      if (k.length === 1) await page.keyboard.type(k); else await page.keyboard.press(k);
      await B.settle(150);
      const t = await B.tiles();
      if (!t.ok) bad.push(`${k}: ${JSON.stringify(t)}`);
    }
    await B.esc();
    const t = await B.tiles();
    if (!t.ok) bad.push(`after Esc: ${JSON.stringify(t)}`);
    // the structure equals a fresh load of the same text
    const now = await page.evaluate(() => { const pv = window.__mdr.app.preview; const n = window.__mdr.app.editor.view.state.doc.lines; const o = []; let l = 1; while (l <= n) { const b = pv.blockAtLine(l); o.push(`${b.startLine}+${b.lineCount}:${b.kind}`); l += b.lineCount; } return o.join(' '); });
    await B.loadDoc(await B.source());
    const fresh = await page.evaluate(() => { const pv = window.__mdr.app.preview; const n = window.__mdr.app.editor.view.state.doc.lines; const o = []; let l = 1; while (l <= n) { const b = pv.blockAtLine(l); o.push(`${b.startLine}+${b.lineCount}:${b.kind}`); l += b.lineCount; } return o.join(' '); });
    assert(bad.length === 0, bad.join(' | '));
    eq(now === fresh, true, 'incremental structure equals a fresh segmentation');
    return `${t.count} blocks tile ${t.lines} lines`;
  });

  // ------------------------------------------------------------ scroll sync after edits
  await step('scroll sync after a preview edit lands within 1 block (editor → preview)', async () => {
    await B.loadDoc(SMALL);
    await B.clickLine(P, 'first', 'quick');
    await B.caretAt('quick');
    await page.keyboard.press('Enter');
    await page.keyboard.type('插入');
    await B.settle(400);
    await B.esc();
    const box = await page.locator('.cm-scroller').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const r = [];
    for (let k = 0; k < 3; k++) {
      await page.mouse.wheel(0, 2500);
      await sleep(500);
      r.push(await page.evaluate(() => {
        const app = window.__mdr.app; const pv = app.preview;
        const et = app.editor.topVisible(); const pt = pv.topVisible();
        return { edLine: et.line, pvLine: pt.line, want: pv.blockAtLine(et.line).index, got: pv.blockAtLine(pt.line).index };
      }));
    }
    // and preview → editor
    const pbox = await page.locator('.mdr-preview').boundingBox();
    await page.mouse.move(pbox.x + pbox.width / 2, pbox.y + pbox.height / 2);
    await page.mouse.wheel(0, 3000);
    await sleep(500);
    r.push(await page.evaluate(() => {
      const app = window.__mdr.app; const pv = app.preview;
      const et = app.editor.topVisible(); const pt = pv.topVisible();
      return { dir: 'pv→ed', edLine: et.line, pvLine: pt.line, want: pv.blockAtLine(pt.line).index, got: pv.blockAtLine(et.line).index };
    }));
    const off = r.filter((x) => Math.abs(x.want - x.got) > 1);
    assert(off.length === 0, JSON.stringify(r));
    return JSON.stringify(r);
  });

  // ------------------------------------------------------------ eviction never removes the session block
  await step('medium.md: session block survives scrolling 30 screens away and back (same element, still editing, typing continues)', async () => {
    await B.loadDoc(MEDIUM, 'medium.md');
    const start = await page.evaluate(() => {
      const pv = window.__mdr.app.preview; const doc = window.__mdr.app.editor.view.state.doc;
      let l = 200;
      for (let i = 0; i < 100; i++) { const b = pv.blockAtLine(l); if (b.kind === 0 && doc.line(b.startLine).text.length > 20) return b.startLine; l = b.startLine + b.lineCount; }
      return null;
    });
    await B.clickLine(start, 'first');
    const e0 = await B.editing();
    assert(e0, 'no session');
    await page.evaluate(() => { window.__sessEl = document.querySelector('.mdr-preview .is-editing'); });
    await page.keyboard.type('前');
    const h = await page.evaluate(() => window.__mdr.app.preview.el.clientHeight);
    const trace = [];
    for (let i = 1; i <= 30; i++) {
      await page.evaluate((dy) => { window.__mdr.app.preview.el.scrollTop += dy; }, h);
      await sleep(40);
      if (i % 10 === 0) trace.push(await page.evaluate(() => ({ connected: window.__sessEl.isConnected, editing: window.__sessEl.classList.contains('is-editing'), mounted: document.querySelectorAll('.mdr-preview section.md-block:not(.is-pending)').length })));
    }
    await B.settle(300);
    const away = await page.evaluate(() => ({ connected: window.__sessEl.isConnected, editing: window.__sessEl.classList.contains('is-editing'), focus: document.activeElement === window.__sessEl }));
    // type while it is off screen
    await page.keyboard.type('远');
    await B.settle(200);
    await page.evaluate((l) => window.__mdr.app.preview.scrollToLine(l, 0, 'instant'), start);
    await B.settle(300);
    const back = await page.evaluate(() => ({ connected: window.__sessEl.isConnected, editing: window.__sessEl.classList.contains('is-editing'), same: document.querySelector('.mdr-preview .is-editing') === window.__sessEl }));
    await page.keyboard.type('回');
    await B.settle(300);
    const line = (await B.source()).split('\n')[start - 1];
    await B.esc();
    assert(away.connected && away.editing, `after 30 screens: ${JSON.stringify(away)}`);
    assert(back.connected && back.same, `back: ${JSON.stringify(back)}`);
    assert(line.includes('前') && line.includes('远') && line.includes('回'), `typed text: ${line.slice(0, 60)}`);
    return `trace ${JSON.stringify(trace)}; off-screen focus kept=${away.focus}`;
  });

  await step('medium.md: while a session is live, edits in CodeMirror elsewhere keep the session block tracked (line shift)', async () => {
    await B.loadDoc(MEDIUM, 'medium.md');
    const start = await page.evaluate(() => { const pv = window.__mdr.app.preview; let l = 300; for (let i = 0; i < 100; i++) { const b = pv.blockAtLine(l); if (b.kind === 0) return b.startLine; l = b.startLine + b.lineCount; } return null; });
    await B.clickLine(start, 'first');
    await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: 0, insert: '插入一行\n\n' } }); });
    await B.settle(300);
    await page.keyboard.type('Q');
    await B.settle(300);
    const src = (await B.source()).split('\n');
    await B.esc();
    const t = await B.tiles();
    assert(src[start + 1].includes('Q'), `typed Q not on shifted line ${start + 2}: «${src[start + 1].slice(0, 40)}»`);
    assert(t.ok, 'tiles');
  });

  // ------------------------------------------------------------ Esc re-render equals a fresh render
  await step('Esc after edits → block HTML equals a fresh render of the new source', async () => {
    await B.loadDoc(SMALL);
    await B.clickLine(P, 'first', 'quick');
    await B.caretAt('quick');
    await page.keyboard.type(' **星** `码`');
    await B.esc();
    await sleep(300);
    const norm = (h) => h.replace(/\s(data-l|data-mdr-o|contenteditable|spellcheck)="[^"]*"/g, '').replace(/\s*\bis-(focus|editing)\b/g, '').replace(/\sclass=""/g, '').replace(/\s+/g, ' ');
    const a = await page.evaluate((l) => { const pv = window.__mdr.app.preview; return pv.elementOfBlock(pv.blockAtLine(l).id).innerHTML; }, P);
    await B.loadDoc(await B.source());
    await B.mountLine(P);
    const b = await page.evaluate((l) => { const pv = window.__mdr.app.preview; return pv.elementOfBlock(pv.blockAtLine(l).id).innerHTML; }, P);
    eq(norm(a), norm(b), 'html');
  });


  // ------------------------------------------------------------ the preview must not jump while typing far down
  async function wheelToAndClick(url, wheelPx) {
    await page.evaluate((u) => window.__mdr.loadUrl(u), url);
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(1000);
    const pb = await page.locator('.mdr-preview').boundingBox();
    await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
    for (let left = wheelPx; left > 0; left -= 3000) { await page.mouse.wheel(0, Math.min(3000, left)); await sleep(30); }
    await sleep(600);
    const pt = await page.evaluate(() => {
      const vh = window.__mdr.app.preview.el.getBoundingClientRect();
      for (const s of document.querySelectorAll('.mdr-preview section.md-block:not(.is-pending)')) {
        const r = s.getBoundingClientRect(); const p = s.querySelector('p');
        if (r.top > vh.top + 50 && r.bottom < vh.bottom - 50 && p && p.textContent.includes('性能测试的段落')) {
          const n = document.createTreeWalker(p, 4).nextNode(); const i = n.data.indexOf('性能测试');
          const rg = document.createRange(); rg.setStart(n, i + 2); rg.setEnd(n, i + 3); const rr = rg.getBoundingClientRect();
          return { x: rr.left + 1, y: rr.top + rr.height / 2 };
        }
      }
      return null;
    });
    assert(pt, 'no paragraph on screen');
    await page.mouse.click(pt.x, pt.y);
    await sleep(100);
    assert(await B.editing(), 'no session');
  }
  for (const [mode, url, wheel] of [['split', '/test-data/small.md', 30000], ['split', '/test-data/large.md', 300000], ['preview', '/test-data/small.md', 30000]]) {
    await step(`${mode} · ${url.split('/').pop()}: typing in a block scrolled far down (wheel, then click) keeps the preview where it is`, async () => {
      await page.evaluate((m) => window.__mdr.mode(m), mode);
      await sleep(300);
      await wheelToAndClick(url, wheel);
      const before = await page.evaluate(() => ({ top: window.__mdr.app.preview.topVisible().line, st: window.__mdr.app.preview.el.scrollTop, edCaret: window.__mdr.app.editor.view.state.doc.lineAt(window.__mdr.app.editor.view.state.selection.main.head).number }));
      await page.keyboard.type('xyz', { delay: 40 });
      await sleep(700);
      const after = await page.evaluate(() => ({ top: window.__mdr.app.preview.topVisible().line, st: window.__mdr.app.preview.el.scrollTop, vis: (() => { const e = document.querySelector('.is-editing'); if (!e) return false; const r = e.getBoundingClientRect(); const v = window.__mdr.app.preview.el.getBoundingClientRect(); return r.bottom > v.top && r.top < v.bottom; })() }));
      await B.esc();
      await page.evaluate(() => window.__mdr.mode('split'));
      measure(`${mode}/${url.split('/').pop()} preview scroll drift while typing 3 chars`, `${Math.round(after.st - before.st)} px (top line ${before.top} → ${after.top}; editor caret on line ${before.edCaret})`, '≈ 0 px, edited block stays on screen', Math.abs(after.st - before.st) < 50 && after.vis);
      assert(Math.abs(after.st - before.st) < 50 && after.vis, `preview jumped: top line ${before.top} → ${after.top}, edited block visible ${after.vis}`);
    });
  }
  await step('split · large.md: Enter in a block scrolled far down → session resumes on the new paragraph and typing lands there', async () => {
    await wheelToAndClick('/test-data/large.md', 300000);
    await page.keyboard.press('Enter');
    await sleep(600);
    const e = await B.editing();
    await page.keyboard.type('abc');
    await B.settle(400);
    const src = await B.source();
    await B.esc();
    assert(e, 'no session after Enter (resume failed)');
    assert(/\nabc/.test(src), 'typed text lost');
  });
  check('no console errors', B.consoleErrors.length === 0, B.consoleErrors.slice(0, 3).join(' | '));
  check('no page errors', B.pageErrors.length === 0, B.pageErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('run', false, err.stack);
} finally {
  await B.browser.close().catch(() => {});
  stopServer();
}
finish();
