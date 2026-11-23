// bench/verify/v5-sw-off.mjs — verify-switch (round 4 verification): turning 预览可编辑 OFF (and on) at moments the
// audit's after:* / off-mid:* probes do not cover, compared with the 0.1.1 baseline showing the same source.
//   MDR_PORT=<candidate with test hooks: the tree's Vite dev server> MDR_BASE_PORT=<0.1.1 vite preview>
//   node bench/verify/v5-sw-off.mjs <case|prefix ...|list>
// The candidate is opened with mdr.previewEdit = "0" (off, asserted), then the switch is turned ON by ⌘⇧E as a user
// does, a session is used, and the switch is turned OFF; the baseline gets the same source and the same gesture.
// Prints one JSON line per build and SAME / DIFF. Exit code 0 all SAME, 1 a difference, 2 an error. Global timeout
// 110 s (MDR_TIMEOUT). Uses bench/verify/v5-offc-lib.mjs (starts no server, kills none). Writes nothing.
import {
  PORT, BASE_PORT, sleep, DOC_ALL, open, loadDoc, pointOf, pointOfSel, must, clickAt, dragFromTo, obs, switchState,
} from './v5-offc-lib.mjs';

const TIMEOUT = Number(process.env.MDR_TIMEOUT || 110_000);
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, TIMEOUT);
const CASES = new Map();
const GAP = Number(process.env.MDR_GAP || 0);
const onCase = (n, fn) => CASES.set(n, fn);
const ZW = new RegExp(`[${String.fromCharCode(0x200b)}${String.fromCharCode(0xfeff)}]`);

async function toggle(B) { await B.page.keyboard.press('Meta+Shift+KeyE'); await sleep(120); }
async function turnOn(B) {
  await toggle(B);
  const st = await switchState(B);
  if (st.pressed !== 'true') throw new Error(`switch did not turn on: ${JSON.stringify(st)}`);
}
const lineOf = (src, needle) => src.split('\n').find((l) => l.includes(needle)) ?? null;
/** What a session could leave behind in the preview, plus the document-level settings a session touches. */
const leftovers = (B) => B.page.evaluate(() => {
  const root = document.querySelector('.mdr-preview');
  return {
    ce: root.querySelectorAll('[contenteditable]').length,
    spell: root.querySelectorAll('[spellcheck]').length,
    mdrO: root.querySelectorAll('[data-mdr-o]').length,
    editing: root.querySelectorAll('.is-editing').length,
    cap: root.querySelectorAll('textarea').length,
    linkBox: root.querySelectorAll('.mdr-preview__link-input').length,
    mathSrc: root.querySelectorAll('.md-math-src').length,
    dps: document.queryCommandValue('defaultParagraphSeparator'),
    scrollH: root.scrollHeight,
  };
});
const toastsOf = (B) => B.page.evaluate(() => Array.from(document.querySelectorAll('.mdr-toast__text')).map((t) => t.textContent));
async function slowWorker(B, ms) {
  await B.page.evaluate((ms) => {
    const pv = window.__mdr.app.preview;
    if (!window.__origDelta) { window.__origDelta = pv.applyStructureDelta.bind(pv); window.__origHtml = pv.applyHtml.bind(pv); }
    window.__delayMs = ms;
    pv.applyStructureDelta = (m) => { if (window.__delay) { setTimeout(() => window.__origDelta(m), window.__delayMs); return true; } return window.__origDelta(m); };
    pv.applyHtml = (m) => { if (window.__delay) setTimeout(() => window.__origHtml(m), window.__delayMs); else window.__origHtml(m); };
    window.__delay = ms > 0;
  }, ms);
}

// A. a session IN the task list, the switch turned off, then a tick on another task of that list d ms later
for (const how of ['esc', 'key']) {
  for (const d of [0, 80, 300, 1000]) {
    onCase(`task-own-${how}-${d}`, async (C, Bb) => {
      await turnOn(C);
      await loadDoc(C, DOC_ALL);
      await clickAt(C.page, await must(await pointOf(C.page, 'task beta', 6), 'task beta')); await sleep(400);
      await C.page.keyboard.type('Z'); await sleep(150);
      if (how === 'esc') { await C.page.keyboard.press('Escape'); await sleep(30); }
      await toggle(C);
      const srcC = await C.source();
      if (d) await sleep(d);
      const box = await must(await pointOfSel(C.page, 'input[type="checkbox"]', { n: 2 }), 'box gamma');
      await C.page.mouse.click(box.x, box.y);
      await sleep(900); await C.idle(150);
      const c = { gamma: lineOf(await C.source(), 'task gamma'), beta: lineOf(await C.source(), 'task beta'), toasts: await toastsOf(C), left: await leftovers(C), st: await switchState(C) };
      await loadDoc(Bb, srcC);
      if (d) await sleep(d);
      const bb = await must(await pointOfSel(Bb.page, 'input[type="checkbox"]', { n: 2 }), 'box gamma');
      await Bb.page.mouse.click(bb.x, bb.y);
      await sleep(900); await Bb.idle(150);
      const b = { gamma: lineOf(await Bb.source(), 'task gamma'), beta: lineOf(await Bb.source(), 'task beta'), toasts: await toastsOf(Bb), left: await leftovers(Bb) };
      return { cand: c, base: b, keys: ['gamma', 'beta'] };
    });
  }
}
// A2. the same with a slow worker (500 ms): the released list's re-render is still on its way when the box is clicked
onCase('task-own-slow', async (C, Bb) => {
  await turnOn(C);
  await loadDoc(C, DOC_ALL);
  await clickAt(C.page, await must(await pointOf(C.page, 'task beta', 6), 'task beta')); await sleep(400);
  await C.page.keyboard.type('Z'); await sleep(150);
  await slowWorker(C, 500);
  await C.page.keyboard.press('Escape'); await sleep(30);
  await toggle(C);
  const box = await must(await pointOfSel(C.page, 'input[type="checkbox"]', { n: 2 }), 'box gamma');
  await C.page.mouse.click(box.x, box.y);
  const shownAt = await C.page.evaluate(() => [...document.querySelectorAll('.mdr-preview input[type="checkbox"]')].map((c) => (c.checked ? 1 : 0)).join(''));
  await sleep(1500); await slowWorker(C, 0); await C.idle(150);
  const srcC = await C.source();
  const c = { gamma: lineOf(srcC, 'task gamma'), toasts: (await toastsOf(C)).filter((t) => !t.startsWith('预览可编辑')), shownAt };
  await loadDoc(Bb, srcC.replace('- [x] task gamma', '- [ ] task gamma'));
  const bb = await must(await pointOfSel(Bb.page, 'input[type="checkbox"]', { n: 2 }), 'box gamma');
  await Bb.page.mouse.click(bb.x, bb.y);
  await sleep(900); await Bb.idle(150);
  return { cand: c, base: { gamma: lineOf(await Bb.source(), 'task gamma'), toasts: await toastsOf(Bb) }, keys: ['gamma', 'toasts'] };
});
// B. the released task list scrolled out of the window before its re-render could mount, switch off, back, tick
onCase('task-released-offscreen', async (C, Bb) => {
  await turnOn(C);
  await loadDoc(C, DOC_ALL);
  await clickAt(C.page, await must(await pointOf(C.page, 'task alpha', 6), 'task alpha')); await sleep(400);
  await C.page.keyboard.type('Q'); await sleep(100);
  await C.page.keyboard.press('Escape');
  await C.page.evaluate(() => { const r = document.querySelector('.mdr-preview'); r.scrollTop = r.scrollHeight; });
  await toggle(C);
  await sleep(1500); await C.idle(200);
  await C.page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
  await sleep(800); await C.idle(200);
  const srcC = await C.source();
  const left0 = await leftovers(C);
  const box = await must(await pointOfSel(C.page, 'input[type="checkbox"]', { n: 1 }), 'box beta');
  await C.page.mouse.click(box.x, box.y);
  await sleep(800); await C.idle(150);
  const c = { beta: lineOf(await C.source(), 'task beta'), toasts: await toastsOf(C), left0, left: await leftovers(C) };
  await loadDoc(Bb, srcC);
  const bb = await must(await pointOfSel(Bb.page, 'input[type="checkbox"]', { n: 1 }), 'box beta');
  await Bb.page.mouse.click(bb.x, bb.y);
  await sleep(800); await Bb.idle(150);
  return { cand: c, base: { beta: lineOf(await Bb.source(), 'task beta'), toasts: await toastsOf(Bb), left: await leftovers(Bb) }, keys: ['beta'] };
});
// C. document-level settings of a session and the EDITOR pane afterwards: Enter variants typed in the editor
const EDITOR_KEYS = ['Enter', 'Shift+Enter', 'Alt+Enter', 'Control+o', 'Meta+Enter', 'Control+Enter'];
onCase('editor-after-session', async (C, Bb) => {
  await turnOn(C);
  await loadDoc(C, DOC_ALL);
  await clickAt(C.page, await must(await pointOf(C.page, 'Clickhere', 4), 'Clickhere')); await sleep(400);
  await C.page.keyboard.type('X'); await sleep(200);
  await C.page.keyboard.press('Enter'); await sleep(400);
  await C.page.keyboard.type('Y'); await sleep(300);
  await C.page.keyboard.press('Escape'); await sleep(200);
  await toggle(C); await C.idle(200);
  const srcC = await C.source();
  const run = async (B) => {
    const out = {};
    const p = await must(await pointOf(B.page, 'ordinary words', 2, 'left', '.cm-content'), 'ordinary words in editor');
    await clickAt(B.page, p); await sleep(150);
    for (const k of EDITOR_KEYS) { await B.page.keyboard.press('End'); await B.page.keyboard.press(k); await B.page.keyboard.type('k'); await sleep(120); }
    await B.idle(150);
    const s = await B.source();
    const i = Math.max(0, s.indexOf('ordinary words') - 60);
    out.region = s.slice(i, i + 120);
    out.left = await leftovers(B);
    return out;
  };
  const c = await run(C);
  await loadDoc(Bb, srcC);
  const b = await run(Bb);
  return { cand: c, base: b, keys: ['region'] };
});
// D. a session that changed nothing, the block taken out of the window at once, switch off: attributes left?
for (const away of [false, true]) {
  onCase(`noedit-leftover${away ? '-away' : ''}`, async (C, Bb) => {
    await turnOn(C);
    await loadDoc(C, DOC_ALL);
    await clickAt(C.page, await must(await pointOf(C.page, 'italic words', 2), 'italic')); await sleep(500);
    await C.page.keyboard.press('Escape');
    if (away) await C.page.evaluate(() => { const r = document.querySelector('.mdr-preview'); r.scrollTop = r.scrollHeight; });
    await toggle(C);
    await sleep(1200); await C.idle(200);
    await C.page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
    await sleep(900); await C.idle(200);
    const c = await leftovers(C);
    const html = await C.page.evaluate(() => { const p = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes('italic words')); return p ? p.outerHTML.length : -1; });
    const htmlC = await C.page.evaluate(() => [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes('italic words'))?.outerHTML ?? '');
    if (process.env.MDR_VERBOSE) console.log('CAND-P ' + htmlC);
    await loadDoc(Bb, await C.source());
    const b = await leftovers(Bb);
    const bh = await Bb.page.evaluate(() => { const p = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes('italic words')); return p ? p.outerHTML.length : -1; });
    if (process.env.MDR_VERBOSE) console.log('BASE-P ' + await Bb.page.evaluate(() => [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes('italic words'))?.outerHTML ?? ''));
    return { cand: { ...c, pLen: html, src: (await C.source()) === DOC_ALL }, base: { ...b, pLen: bh, src: true }, keys: ['ce', 'spell', 'mdrO', 'editing', 'cap', 'pLen', 'src'] };
  });
}
// E. the switch turned off d ms after a paste of 300 paragraphs into a session
const PASTE = Array.from({ length: 300 }, (_, i) => `PastePara ${i + 1} end.`).join('\n\n');
for (const d of [0, 30, 120, 400]) {
  onCase(`paste300-off-${d}`, async (C) => {
    await C.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${PORT}` });
    await turnOn(C);
    await loadDoc(C, DOC_ALL);
    const p = await must(await pointOf(C.page, 'collapsed clicks', 0), 'collapsed'); await clickAt(C.page, p); await sleep(400);
    await C.page.evaluate((t) => navigator.clipboard.writeText(t), PASTE);
    await C.page.keyboard.press('Meta+v');
    if (d) await sleep(d);
    await toggle(C);
    await sleep(2500); await C.idle(300);
    const s = await C.source();
    const found = Array.from({ length: 300 }, (_, i) => s.split(`PastePara ${i + 1} end.`).length - 1);
    const missing = found.flatMap((n, i) => (n === 0 ? [i + 1] : [])), twice = found.flatMap((n, i) => (n > 1 ? [i + 1] : []));
    const want = DOC_ALL.replace('for collapsed clicks', `for ${PASTE}collapsed clicks`);
    return { cand: { missing: missing.length, twice: twice.length, exact: s === want, zw: ZW.test(s), nbsp: s.includes('&nbsp;'), left: await leftovers(C), toasts: await toastsOf(C), st: await switchState(C), head: missing.slice(0, 5) }, base: { missing: 0, twice: 0, exact: true, zw: false, nbsp: false }, keys: ['missing', 'twice', 'exact', 'zw', 'nbsp'] };
  });
}
// F. the switch turned off with the link box open, by the key in the box and by the toolbar button
for (const how of ['key', 'button']) {
  onCase(`linkbox-off-${how}`, async (C) => {
    await turnOn(C);
    await loadDoc(C, DOC_ALL);
    const p = await must(await pointOf(C.page, 'ordinary', 3), 'ordinary');
    await C.page.mouse.dblclick(p.x, p.y); await sleep(400);
    await C.page.keyboard.press('Meta+k'); await sleep(300);
    const boxOpen = await C.page.evaluate(() => document.querySelectorAll('.mdr-preview__link-input').length);
    await C.page.keyboard.type('https://ex.test/a');
    if (how === 'key') await toggle(C);
    else { await C.page.click('[data-cmd="view.togglePreviewEdit"]'); await sleep(150); }
    await sleep(600); await C.idle(200);
    const s = await C.source();
    return { cand: { boxOpen, para: lineOf(s, 'Clickhere'), left: await leftovers(C), st: await switchState(C), toasts: await toastsOf(C) }, base: { boxOpen: 1, para: lineOf(DOC_ALL, 'Clickhere'), left: { ce: 0, linkBox: 0 } }, keys: ['para', 'left.ce', 'left.linkBox', 'left.cap'] };
  });
}
// G. fast toggling: 20 toggles within about a second, alternating with clicks and keys (with and without a slow worker)
for (const slow of [0, 250]) {
  onCase(`fast-toggle${slow ? '-slow' : ''}`, async (C) => {
    await loadDoc(C, DOC_ALL);
    if (slow) await slowWorker(C, slow);
    const p = await must(await pointOf(C.page, 'Clickhere', 4), 'Clickhere');
    const q = await must(await pointOf(C.page, 'Second last', 3), 'second last');
    const typed = [];
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) {
      await C.page.keyboard.press('Meta+Shift+KeyE');
      await C.page.mouse.click(...((i % 2) ? [q.x, q.y] : [p.x, p.y]));
      const ch = String.fromCharCode(65 + i);
      typed.push(ch);
      await C.page.keyboard.type(ch);
    }
    const ms = Date.now() - t0;
    await sleep(1500 + slow * 4);
    if (slow) await slowWorker(C, 0);
    await C.page.keyboard.press('Escape');
    await sleep(800); await C.idle(300);
    const s = await C.source();
    // what was inserted: every char not in DOC_ALL at its place
    let i = 0; while (i < s.length && s[i] === DOC_ALL[i]) i++;
    const ins = [];
    { let a = 0, b = 0; while (a < s.length) { if (s[a] === DOC_ALL[b]) { a++; b++; } else { ins.push(s[a]); a++; } } }
    const st = await switchState(C);
    const left = await leftovers(C);
    const untypedIns = ins.filter((ch) => !typed.includes(ch));
    return {
      cand: { ms, st, consistent: (st.pressed === 'true') === st.editable && st.stored === (st.editable ? '1' : '0'), inserted: ins.join(''), untypedIns: untypedIns.join(''), zw: ZW.test(s), nbsp: (s.match(/&nbsp;/g) || []).length - (DOC_ALL.match(/&nbsp;/g) || []).length, deleted: s.length - ins.length !== DOC_ALL.length, left, toasts: await toastsOf(C) },
      base: { consistent: true, untypedIns: '', zw: false, nbsp: 0, deleted: false },
      keys: ['consistent', 'untypedIns', 'zw', 'nbsp', 'deleted'],
    };
  });
}
// I. turning it ON with a selection in the preview: nothing happens before a click; the copy is unchanged
onCase('on-with-selection', async (C, Bb) => {
  const run = async (B, cand) => {
    await loadDoc(B, DOC_ALL);
    const a = await must(await pointOf(B.page, 'Clickhere', 0), 'a'), b = await must(await pointOf(B.page, 'collapsed', 0), 'b');
    await dragFromTo(B.page, a, b);
    await sleep(300);
    const sel0 = await B.page.evaluate(() => getSelection().toString());
    if (cand) await toggle(B);
    await sleep(300);
    const sel1 = await B.page.evaluate(() => getSelection().toString());
    const o = await obs(B);
    await B.page.keyboard.press('x'); await sleep(300);
    const srcSame = (await B.source()) === DOC_ALL;
    const ce = await B.page.evaluate(() => document.querySelectorAll('.mdr-preview [contenteditable="true"]').length);
    return { sel0, sel1, active: o.active, srcSame, ceAfterKey: ce };
  };
  return { cand: await run(C, true), base: await run(Bb, false), keys: ['sel0', 'sel1', 'active', 'srcSame', 'ceAfterKey'] };
});
// J. the switch turned off with an IME composition open in a session: what the preview shows equals the source's rendering
const paraText = (B, needle) => B.page.evaluate((t) => [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes(t))?.textContent ?? null, needle);
for (const how of ['key', 'button']) {
  onCase(`ime-off-${how}`, async (C, Bb) => {
    await turnOn(C);
    await loadDoc(C, DOC_ALL);
    await clickAt(C.page, await must(await pointOf(C.page, 'ordinary', 0), 'ordinary')); await sleep(500);
    const cdp = await C.context.newCDPSession(C.page);
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    await sleep(250);
    if (how === 'key') await toggle(C); else { await C.page.click('[data-cmd="view.togglePreviewEdit"]'); await sleep(150); }
    await sleep(1200); await C.idle(200);
    await cdp.detach().catch(() => {});
    const src = await C.source();
    const c = { para: lineOf(src, 'collapsed'), shown: await paraText(C, 'collapsed'), left: await leftovers(C), st: await switchState(C) };
    await loadDoc(Bb, src);
    return { cand: c, base: { para: c.para, shown: await paraText(Bb, 'collapsed') }, keys: ['shown'] };
  });
}
// K. switch off, a click that starts nothing, switch on, a key: nothing; then a click starts the session there
onCase('on-after-dead-click', async (C) => {
  await loadDoc(C, DOC_ALL);
  await clickAt(C.page, await must(await pointOf(C.page, 'Clickhere', 4), 'Clickhere')); await sleep(400);
  await toggle(C);
  await C.page.keyboard.type('x'); await sleep(400);
  const srcSame = (await C.source()) === DOC_ALL;
  const ce0 = (await leftovers(C)).ce;
  await clickAt(C.page, await must(await pointOf(C.page, 'Second last', 3), 'second last')); await sleep(500);
  await C.page.keyboard.type('y'); await sleep(500);
  const line = lineOf(await C.source(), 'Secyond') ?? lineOf(await C.source(), 'Sec');
  return { cand: { srcSame, ce0, line }, base: { srcSame: true, ce0: 0, line: 'Secyond last paragraph before filler.' } };
});
// L. ⌘Z in the editor after the switch was turned off undoes the session's text
onCase('undo-after-off', async (C) => {
  await turnOn(C);
  await loadDoc(C, DOC_ALL);
  await clickAt(C.page, await must(await pointOf(C.page, 'Clickhere', 4), 'Clickhere')); await sleep(400);
  await C.page.keyboard.type('XYZ'); await sleep(400);
  await toggle(C); await sleep(300);
  const after = lineOf(await C.source(), 'Clic');
  await clickAt(C.page, await must(await pointOf(C.page, 'Heading Alpha', 2, 'left', '.cm-content'), 'heading in editor')); await sleep(200);
  for (let i = 0; i < 3 && (await C.source()) !== DOC_ALL; i++) { await C.page.keyboard.press('Meta+z'); await sleep(250); }
  const back = (await C.source()) === DOC_ALL;
  await C.page.keyboard.press('Meta+Shift+z'); await sleep(250);
  const redo = lineOf(await C.source(), 'Clic');
  return { cand: { after, back, redo }, base: { after: 'ClicXYZkhere paragraph two has ordinary words only for collapsed clicks and keys.', back: true, redo: 'ClicXYZkhere paragraph two has ordinary words only for collapsed clicks and keys.' } };
});
// N. a document-wide execCommand setting of a session outlives it: compared with 0.1.1 after the switch is off
onCase('dps-leftover', async (C, Bb) => {
  const before = await C.page.evaluate(() => document.queryCommandValue('defaultParagraphSeparator'));
  await turnOn(C);
  await loadDoc(C, DOC_ALL);
  await clickAt(C.page, await must(await pointOf(C.page, 'Clickhere', 4), 'Clickhere')); await sleep(400);
  await C.page.keyboard.press('Escape'); await sleep(200);
  await toggle(C); await sleep(300);
  const after = await C.page.evaluate(() => document.queryCommandValue('defaultParagraphSeparator'));
  const b = await Bb.page.evaluate(() => document.queryCommandValue('defaultParagraphSeparator'));
  return { cand: { before, afterOff: after }, base: { before: b, afterOff: b } };
});
// O. the switch turned off through the command palette, and by ⌘⇧E from the find field and the outline, during a session
onCase('palette-off', async (C) => {
  await turnOn(C);
  await loadDoc(C, DOC_ALL);
  await clickAt(C.page, await must(await pointOf(C.page, 'Clickhere', 4), 'Clickhere')); await sleep(400);
  await C.page.keyboard.type('PAL');
  await C.page.keyboard.press('Meta+Shift+KeyP'); await sleep(300);
  await C.page.keyboard.type('预览可编辑'); await sleep(200);
  await C.page.keyboard.press('Enter'); await sleep(600); await C.idle(150);
  return { cand: { line: lineOf(await C.source(), 'Clic'), st: (await switchState(C)).pressed, ce: (await leftovers(C)).ce, toasts: await toastsOf(C) }, base: { line: 'ClicPALkhere paragraph two has ordinary words only for collapsed clicks and keys.', st: 'false', ce: 0 }, keys: ['line', 'st', 'ce'] };
});
onCase('find-field-key', async (C) => {
  await turnOn(C);
  await loadDoc(C, DOC_ALL);
  await clickAt(C.page, await must(await pointOf(C.page, 'Clickhere', 4), 'Clickhere')); await sleep(400);
  await C.page.keyboard.type('FND'); await sleep(100);
  await clickAt(C.page, await must(await pointOf(C.page, 'Heading Alpha', 2, 'left', '.cm-content'), 'editor')); await sleep(200);
  await C.page.keyboard.press('Meta+f'); await sleep(300);
  const inFind = await C.page.evaluate(() => !!document.activeElement?.closest('.cm-search, .cm-panel'));
  await C.page.keyboard.type('para');
  await toggle(C); await sleep(200);
  const field = await C.page.evaluate(() => document.activeElement?.value ?? null);
  const st1 = (await switchState(C)).pressed;
  await toggle(C); await sleep(200);
  return { cand: { inFind, field, st1, st2: (await switchState(C)).pressed, line: lineOf(await C.source(), 'Clic') }, base: { inFind: true, field: 'para', st1: 'false', st2: 'true', line: 'ClicFNDkhere paragraph two has ordinary words only for collapsed clicks and keys.' } };
});
onCase('outline-key', async (C) => {
  await loadDoc(C, DOC_ALL);
  const toc = await C.page.evaluate(() => { const a = document.querySelector('.mdr-toc a, .mdr-toc [role="treeitem"], .mdr-toc li'); if (!a) return null; a.focus?.(); const b = a.getBoundingClientRect(); return { x: b.left + 5, y: b.top + b.height / 2, tag: a.tagName }; });
  if (toc) { await C.page.mouse.click(toc.x, toc.y); await sleep(300); }
  const where = await C.page.evaluate(() => document.activeElement?.closest('.mdr-toc') ? 'toc' : document.activeElement?.tagName);
  await toggle(C); await sleep(200);
  return { cand: { toc: !!toc, where, st: (await switchState(C)).pressed, srcSame: (await C.source()) === DOC_ALL }, base: { toc: true, where: 'toc', st: 'true', srcSame: true }, keys: ['st', 'srcSame'] };
});
// P. the switch turned off with a selection that holds a helper character (U21 spacer), then ⌘C
for (const how of ['key', 'button']) {
  onCase(`helper-sel-off-${how}`, async (C) => {
    await C.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${PORT}` });
    await turnOn(C);
    await loadDoc(C, '$x+y$ starts this paragraph with a formula.\n\n' + DOC_ALL);
    await clickAt(C.page, await must(await pointOf(C.page, 'starts this', 3), 'starts')); await sleep(500);
    await C.page.keyboard.press('Meta+ArrowLeft'); await C.page.keyboard.press('Shift+End'); await sleep(200);
    const selIn = await C.page.evaluate((zw) => new RegExp(zw).test(getSelection().toString()), `[${String.fromCharCode(0x200b)}${String.fromCharCode(0xfeff)}]`);
    if (how === 'key') await toggle(C); else { await C.page.click('[data-cmd="view.togglePreviewEdit"]'); await sleep(150); }
    await sleep(500); await C.idle(150);
    await C.page.evaluate(() => navigator.clipboard.writeText('<<none>>'));
    const sel = await C.page.evaluate(() => getSelection().toString());
    await C.page.keyboard.press('Meta+c'); await sleep(300);
    const clipText = await C.page.evaluate(() => navigator.clipboard.readText());
    const domZw = await C.page.evaluate((zw) => (document.querySelector('.mdr-preview__body').textContent.match(new RegExp(zw, 'g')) || []).length, `[${String.fromCharCode(0x200b)}${String.fromCharCode(0xfeff)}]`);
    const src = await C.source();
    return { cand: { selIn, sel: sel.slice(0, 60), clipZw: ZW.test(clipText), domZw, srcZw: ZW.test(src), srcSame: src === '$x+y$ starts this paragraph with a formula.\n\n' + DOC_ALL, ce: (await leftovers(C)).ce }, base: { clipZw: false, domZw: 0, srcZw: false, srcSame: true, ce: 0 }, keys: ['clipZw', 'domZw', 'srcZw', 'srcSame', 'ce'] };
  });
}
// Q. turning it ON during a drag selection in the preview, and while a document loads
onCase('on-during-drag', async (C, Bb) => {
  const run = async (B, cand) => {
    await loadDoc(B, DOC_ALL);
    const a = await must(await pointOf(B.page, 'Clickhere', 0), 'a'), b = await must(await pointOf(B.page, 'collapsed', 0), 'b');
    await B.page.mouse.move(a.x, a.y); await B.page.mouse.down();
    await B.page.mouse.move((a.x + b.x) / 2, a.y, { steps: 5 });
    if (cand) await toggle(B);
    await B.page.mouse.move(b.x, b.y, { steps: 6 }); await B.page.mouse.up(); await sleep(400);
    const sel = await B.page.evaluate(() => getSelection().toString());
    const ce = await B.page.evaluate(() => document.querySelectorAll('.mdr-preview [contenteditable="true"]').length);
    await B.page.keyboard.type('k'); await sleep(300);
    const srcSame = (await B.source()) === DOC_ALL;
    let after = null;
    if (cand) {
      await clickAt(B.page, await must(await pointOf(B.page, 'Second last', 3), 'second')); await sleep(500);
      await B.page.keyboard.type('y'); await sleep(500);
      after = lineOf(await B.source(), 'Sec');
    }
    return { sel, ce, srcSame, after };
  };
  const c = await run(C, true);
  const b = await run(Bb, false);
  b.after = 'Secyond last paragraph before filler.';
  return { cand: c, base: b };
});
onCase('on-during-load', async (C) => {
  await loadDoc(C, DOC_ALL);
  await C.page.evaluate((t) => window.__mdr.loadText(t, 'other.md'), '# Other\n\nFresh paragraph one here.\n\nFresh paragraph two here.\n');
  await toggle(C);
  await sleep(60);
  await C.idle(200);
  const ce0 = (await leftovers(C)).ce;
  await clickAt(C.page, await must(await pointOf(C.page, 'paragraph two', 3), 'two')); await sleep(500);
  await C.page.keyboard.type('W'); await sleep(500);
  const s = await C.source();
  return { cand: { ce0, src: s }, base: { ce0: 0, src: '# Other\n\nFresh paragraph one here.\n\nFresh parWagraph two here.\n' } };
});
onCase('fast-toggle-button', async (C) => {
  await loadDoc(C, DOC_ALL);
  const p = await must(await pointOf(C.page, 'Clickhere', 4), 'Clickhere');
  const btn = await C.page.evaluate(() => { const b = document.querySelector('[data-cmd="view.togglePreviewEdit"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  for (let i = 0; i < 20; i++) {
    await C.page.mouse.click(btn.x, btn.y);
    if (GAP) await sleep(GAP);
    await C.page.mouse.click(p.x, p.y);
    if (GAP) await sleep(GAP);
    await C.page.keyboard.type(String.fromCharCode(97 + i));
    if (GAP) await sleep(GAP);
  }
  await sleep(1200); await C.page.keyboard.press('Escape'); await sleep(500); await C.idle(200);
  const st = await switchState(C);
  const s = await C.source();
  const line = lineOf(s, 'Clic');
  return { cand: { consistent: (st.pressed === 'true') === st.editable && st.stored === (st.editable ? '1' : '0'), st, line, rest: s.replace(line, '') === DOC_ALL.replace(lineOf(DOC_ALL, 'Clic'), ''), left: await leftovers(C), toasts: await toastsOf(C) }, base: { consistent: true, rest: true }, keys: ['consistent', 'rest'] };
});
// R. the switch turned off while a resume waits with keys or an IME composition queued in the capture element
for (const what of ['keys', 'ime']) {
  onCase(`wait-queued-off-${what}`, async (C) => {
    await turnOn(C);
    await loadDoc(C, DOC_ALL);
    await clickAt(C.page, await must(await pointOf(C.page, 'collapsed', 0), 'collapsed')); await sleep(500);
    await slowWorker(C, 1500);
    await C.page.keyboard.press('Enter'); await sleep(120);
    const cap = (await leftovers(C)).cap;
    let cdp = null;
    if (what === 'keys') await C.page.keyboard.type('QK');
    else { cdp = await C.context.newCDPSession(C.page); await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 }); await sleep(150); }
    await toggle(C);
    await sleep(2500); await slowWorker(C, 0); await sleep(500); await C.idle(200);
    await cdp?.detach().catch(() => {});
    const s = await C.source();
    return { cand: { cap, typedInSource: what === 'keys' ? s.includes('QK') : s.includes('ni'), toasts: await toastsOf(C), left: await leftovers(C), split: s.includes('only for \n\ncollapsed') || s.includes('only for\n\ncollapsed') }, base: { note: 'P-G: queued input dropped only with the toast' }, keys: [] };
  });
}
// S. preview mode: a session, the switch off, then keys: Space / ArrowDown / End page the preview as in 0.1.1
onCase('preview-mode-off-keys', async () => {
  const C = await open(PORT, { pref: '0', mode: 'preview' });
  const Bb = await open(BASE_PORT, { base: true, pref: null, mode: 'preview' });
  try {
    const run = async (B, cand) => {
      if (cand) await turnOn(B);
      await loadDoc(B, DOC_ALL);
      await clickAt(B.page, await must(await pointOf(B.page, 'Clickhere', 4), 'Clickhere')); await sleep(500);
      if (cand) { await B.page.keyboard.type('X'); await sleep(200); await toggle(B); await sleep(300); }
      const o0 = await obs(B);
      await B.page.keyboard.press('Space'); await sleep(600);
      const o1 = await obs(B);
      await B.page.keyboard.press('ArrowDown'); await sleep(400);
      const o2 = await obs(B);
      await B.page.keyboard.press('End'); await sleep(700);
      const o3 = await obs(B);
      return { space: o1.pTop - o0.pTop, down: o2.pTop - o1.pTop, end: o3.pTop >= o3.pMax - 2, active: o3.active, ce: o3.ce, srcAfterKeysSame: o3.src === o0.src };
    };
    const r = { cand: await run(C, true), base: await run(Bb, false) };
    if (C.pageErrors.length) r.cand.err = C.pageErrors.join('|');
    return r;
  } finally { await C.close(); await Bb.close(); }
});
// M. every way a resume's wait can end, then a SHORT document: the preview's scrollable height equals 0.1.1's
const SHORT = '# Short\n\nOne short paragraph.\n\nAnother one.\n';
for (const how of ['success', 'off', 'load', 'esc', 'editor-click']) {
  onCase(`wait-end-${how}`, async (C, Bb) => {
    await turnOn(C);
    await loadDoc(C, DOC_ALL);
    await C.page.evaluate(() => window.__mdr.app.preview.mountAll?.()); await sleep(800); await C.idle(200);
    const p = await must(await pointOf(C.page, 'Filler paragraph number 50 ', 30), 'filler 50');
    await clickAt(C.page, p); await sleep(700);
    await slowWorker(C, 1200);
    await C.page.keyboard.press('Enter'); await sleep(150);
    const capDuring = (await leftovers(C)).cap;
    if (how === 'off') await toggle(C);
    else if (how === 'load') await C.page.evaluate((t) => window.__mdr.loadText(t, 'short.md'), SHORT);
    else if (how === 'esc') await C.page.keyboard.press('Escape');
    else if (how === 'editor-click') await clickAt(C.page, await must(await pointOf(C.page, 'Heading Alpha', 2, 'left', '.cm-content'), 'editor'));
    await sleep(how === 'success' ? 3000 : 1800);
    await slowWorker(C, 0);
    if (how !== 'off') { await C.page.keyboard.press('Escape'); await toggle(C); }
    await sleep(300);
    const st = await switchState(C);
    await loadDoc(C, SHORT);
    await sleep(500);
    const m = (B) => B.page.evaluate(() => { const r = document.querySelector('.mdr-preview'); r.scrollTop = 99999; return { scrollH: r.scrollHeight, maxTop: Math.round(r.scrollTop), cap: r.querySelectorAll('textarea').length }; });
    const c = { ...(await m(C)), capDuring, st };
    await loadDoc(Bb, SHORT); await sleep(500);
    return { cand: c, base: await m(Bb), keys: ['scrollH', 'maxTop', 'cap'] };
  });
}

const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
let differ = 0, errors = 0;
const want = process.argv.slice(2);
if (want[0] === 'list') { for (const n of CASES.keys()) console.log(n); process.exit(0); }
const names = [...CASES.keys()].filter((n) => want.length === 0 || want.some((w) => (w.endsWith('*') ? n.startsWith(w.slice(0, -1)) : n === w)));
try {
  for (const name of names) {
    let C = null, Bb = null;
    try {
      C = await open(PORT, { pref: '0' });
      Bb = await open(BASE_PORT, { base: true, pref: null });
      const r = await CASES.get(name)(C, Bb);
      const keys = r.keys || Object.keys(r.cand);
      const diffs = keys.filter((k) => JSON.stringify(get(r.cand, k)) !== JSON.stringify(get(r.base, k)));
      if (C.pageErrors.length) diffs.push(`pageErrors:${C.pageErrors.join('|').slice(0, 120)}`);
      delete r.keys;
      console.log(`${diffs.length ? 'DIFF' : 'SAME'}  ${name}${diffs.length ? `  [${diffs.join(', ')}]` : ''}`);
      console.log(`   cand ${JSON.stringify(r.cand)}`);
      console.log(`   base ${JSON.stringify(r.base)}`);
      if (diffs.length) differ++;
    } catch (e) {
      errors++;
      console.log(`ERROR ${name}: ${String(e && e.stack || e).slice(0, 300)}`);
    } finally { await C?.close(); await Bb?.close(); }
  }
} finally {
  clearTimeout(KILL);
  console.log(`v5-sw-off: ${names.length} cases, ${differ} differ, ${errors} errors`);
  process.exit(errors ? 2 : differ ? 1 : 0);
}
