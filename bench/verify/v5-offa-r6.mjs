// bench/verify/v5-offa-r6.mjs — verify-off-app: R6 (J4) by variation, switch OFF, candidate vs 0.1.1.
// A save in flight (FSA writable close slowed) while the document is replaced by 打开…, a recent entry, 新建,
// a file drop, a second ⌘S; at 0 / 50 / 500 ms into the save; the save then succeeds or fails.
//   MDR_PORT=5486 MDR_BASE_PORT=5496 MDR_TMP=<scratch> node bench/verify/v5-offa-r6.mjs [case|prefix* ...] [--list]
// Prints both builds' observations and the R6 verdict for the candidate. Global timeout 110 s.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleep, runCases, snap, clickBtn, opfsWrite, opfsRead, pickerReturns, pickerSaveReturns, openOpfs, slowWrites, allDrafts, typeEnd } from './v5-offa-lib.mjs';

const dir = fs.mkdtempSync(path.join(process.env.MDR_TMP || os.tmpdir(), 'v5-offa-r6-'));
const DROP = path.join(dir, 'dropped.md');
fs.writeFileSync(DROP, '# DROPPED\n', 'utf8');
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

const SLOW = 1500;
async function after(page, extra = {}) {
  await sleep(SLOW + 600);
  await page.evaluate(() => { window.__slow = false; });
  const a = await snap(page);
  return { afterTitle: a.title, afterText: a.text, ...extra };
}
async function nextSave(page) {
  await typeEnd(page, 'more');
  await page.keyboard.press('Meta+s');
  await sleep(900);
  const s = await snap(page);
  return { finalTitle: s.title };
}
async function disks(page, names) {
  const o = {};
  for (const n of names) o[n] = await opfsRead(page, n);
  return o;
}
async function drop(page) {
  const cdp = await page.context().newCDPSession(page);
  const pt = await page.evaluate(() => { const r = document.querySelector('.cm-content').getBoundingClientRect(); return { x: r.left + 100, y: r.top + 20 }; });
  const data = { items: [], files: [DROP], dragOperationsMask: 1 | 2 | 16 };
  try { for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: pt.x, y: pt.y, data }); } finally { await cdp.detach().catch(() => {}); }
}
const toastsSeen = (page) => page.evaluate(() => (window.__toasts || []).slice());
// fix-save (round 7, rule R7 (a)): a replacement requested during the document's own save now waits for that save;
// a save that failed is reported and THEN the question is asked. The during-save cases answer the question when it
// comes (within the save's duration and a margin) instead of 300 ms after the request; 0.1.1 asks at once.
async function answerWhenAsked(page, label, ms = SLOW + 1200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await clickBtn(page, label)) return true; await sleep(50); }
  return false;
}

const C = {};
const J = {};
for (const d of [0, 50, 500]) {
  for (const mode of ['ok', 'fail']) {
    // 打开… another file
    C[`open-${mode}-${d}`] = async (page) => {
      await openOpfs(page, 's.md', '# S\n');
      await opfsWrite(page, 'o.md', '# O\n');
      await slowWrites(page, SLOW, mode);
      await typeEnd(page, 'typed');
      await page.keyboard.press('Meta+s');
      await sleep(d);
      await pickerReturns(page, 'o.md');
      await page.evaluate(() => { void window.__mdr.app.registry.run('file.open'); });
      await sleep(300);
      const asked = (await snap(page)).dialogs;
      await answerWhenAsked(page, '丢弃');
      const a = await after(page, { asked });
      const n = await nextSave(page);
      return { ...a, ...n, disk: await disks(page, ['s.md', 'o.md']), toasts: await toastsSeen(page) };
    };
    J[`open-${mode}-${d}`] = (c) => {
      if (!c || c.error) return 'error';
      const sOk = mode === 'ok' ? c.disk['s.md'] === '# S\ntyped' || c.disk['s.md'] === '# S\ntyped\n' : c.disk['s.md'] === '# S\n';
      const p = [];
      if (!sOk) p.push('s.md=' + JSON.stringify(c.disk['s.md']));
      if (!/^#?\s*O\n?more/.test(c.disk['o.md'] ?? '')) p.push('o.md=' + JSON.stringify(c.disk['o.md']));
      if (!/o\.md/.test(c.afterTitle)) p.push('afterTitle=' + c.afterTitle);
      if (c.finalTitle.startsWith('●')) p.push('finalTitle=' + c.finalTitle);
      return p.length ? p.join('; ') : null;
    };
    // a recent entry
    C[`recent-${mode}-${d}`] = async (page) => {
      await openOpfs(page, 'o.md', '# O\n');
      await openOpfs(page, 's.md', '# S\n');
      await slowWrites(page, SLOW, mode);
      await typeEnd(page, 'typed');
      await page.keyboard.press('Meta+s');
      await sleep(d);
      await page.click('.mdr-toolbar__file');
      await sleep(150);
      const items = await page.evaluate(() => [...document.querySelectorAll('.mdr-recent li')].map((e) => e.textContent));
      const ok = await page.evaluate(() => { const li = [...document.querySelectorAll('.mdr-recent li')].find((e) => /o\.md/.test(e.textContent)); if (li) li.click(); return !!li; });
      await sleep(300);
      const asked = (await snap(page)).dialogs;
      await answerWhenAsked(page, '丢弃');
      const a = await after(page, { asked, items, ok });
      const n = await nextSave(page);
      const recent = (await allDrafts(page)).filter((x) => x.k.startsWith('mdr.recent'));
      return { ...a, ...n, disk: await disks(page, ['s.md', 'o.md']), toasts: await toastsSeen(page), recent };
    };
    J[`recent-${mode}-${d}`] = J[`open-${mode}-${d}`];
    // 新建, then the new document's first save goes to n.md
    C[`new-${mode}-${d}`] = async (page) => {
      await openOpfs(page, 's.md', '# S\n');
      await slowWrites(page, SLOW, mode);
      await typeEnd(page, 'typed');
      await page.keyboard.press('Meta+s');
      await sleep(d);
      await page.evaluate(() => { void window.__mdr.app.registry.run('file.new'); });
      await sleep(300);
      const asked = (await snap(page)).dialogs;
      await answerWhenAsked(page, '丢弃');
      const a = await after(page, { asked });
      await pickerSaveReturns(page, 'n.md');
      await typeEnd(page, 'NEW');
      await page.keyboard.press('Meta+s');
      await sleep(900);
      const s = await snap(page);
      return { ...a, finalTitle: s.title, disk: await disks(page, ['s.md', 'n.md']), toasts: await toastsSeen(page) };
    };
    J[`new-${mode}-${d}`] = (c) => {
      if (!c || c.error) return 'error';
      const p = [];
      const sWant = mode === 'ok' ? /^# S\ntyped\n?$/ : /^# S\n$/;
      if (!sWant.test(c.disk['s.md'] ?? '')) p.push('s.md=' + JSON.stringify(c.disk['s.md']));
      if (c.disk['n.md'] !== 'NEW' && c.disk['n.md'] !== 'NEW\n') p.push('n.md=' + JSON.stringify(c.disk['n.md']));
      if (/s\.md/.test(c.afterTitle)) p.push('afterTitle=' + c.afterTitle);
      if (!/n\.md/.test(c.finalTitle) || c.finalTitle.startsWith('●')) p.push('finalTitle=' + c.finalTitle);
      return p.length ? p.join('; ') : null;
    };
    // a file drop (no handle: its next save asks for a place: d.md)
    C[`drop-${mode}-${d}`] = async (page) => {
      await openOpfs(page, 's.md', '# S\n');
      await slowWrites(page, SLOW, mode);
      await typeEnd(page, 'typed');
      await page.keyboard.press('Meta+s');
      await sleep(d);
      await drop(page);
      await sleep(400);
      const asked = (await snap(page)).dialogs;
      await answerWhenAsked(page, '丢弃');
      const a = await after(page, { asked });
      await pickerSaveReturns(page, 'd.md');
      const n = await nextSave(page);
      return { ...a, ...n, disk: await disks(page, ['s.md', 'd.md']), toasts: await toastsSeen(page) };
    };
    J[`drop-${mode}-${d}`] = (c) => {
      if (!c || c.error) return 'error';
      const p = [];
      const sWant = mode === 'ok' ? /^# S\ntyped\n?$/ : /^# S\n$/;
      if (!sWant.test(c.disk['s.md'] ?? '')) p.push('s.md=' + JSON.stringify(c.disk['s.md']));
      if (!/dropped/.test(c.afterTitle)) p.push('afterTitle=' + c.afterTitle);
      if (c.finalTitle.startsWith('●')) p.push('finalTitle=' + c.finalTitle);
      return p.length ? p.join('; ') : null;
    };
  }
  // A second ⌘S while the first is in flight, with more text typed in between: nothing replaced, so the
  // ordinary path; the file must end with the latest text and the title must be clean.
  C[`double-${d}`] = async (page) => {
    await openOpfs(page, 's.md', '# S\n');
    await slowWrites(page, SLOW, 'ok');
    await typeEnd(page, 'one');
    await page.keyboard.press('Meta+s');
    await sleep(d);
    await page.keyboard.type('two');
    await page.keyboard.press('Meta+s');
    const a = await after(page);
    await sleep(SLOW);
    const s = await snap(page);
    return { ...a, title2: s.title, disk: await disks(page, ['s.md']), toasts: await toastsSeen(page) };
  };
  J[`double-${d}`] = (c, b) => (JSON.stringify(c) === JSON.stringify(b) ? null : 'DIFF from 0.1.1');
  // Untitled first save: the save picker answers late, the doc is replaced by a drop while the panel is up.
  C[`untitled-drop-${d}`] = async (page) => {
    await page.evaluate(() => { void window.__mdr.app.registry.run('file.new'); });
    await sleep(300);
    await pickerSaveReturns(page, 'u.md', 600);
    await slowWrites(page, SLOW, 'ok');
    await typeEnd(page, 'UNTITLED');
    await page.keyboard.press('Meta+s');
    await sleep(d);
    await drop(page);
    await sleep(400);
    const asked = (await snap(page)).dialogs;
    await clickBtn(page, '丢弃');
    const a = await after(page, { asked });
    await sleep(600);
    await pickerSaveReturns(page, 'd2.md');
    const n = await nextSave(page);
    return { ...a, ...n, disk: await disks(page, ['u.md', 'd2.md']), toasts: await toastsSeen(page) };
  };
  J[`untitled-drop-${d}`] = (c) => {
    if (!c || c.error) return 'error';
    const p = [];
    if (c.disk['u.md'] != null && !/^UNTITLED\n?$/.test(c.disk['u.md'])) p.push('u.md=' + JSON.stringify(c.disk['u.md']));
    if (!/dropped/.test(c.afterTitle)) p.push('afterTitle=' + c.afterTitle);
    if (/u\.md/.test(c.finalTitle) || c.finalTitle.startsWith('●')) p.push('finalTitle=' + c.finalTitle);
    return p.length ? p.join('; ') : null;
  };
}

// The SAME file reopened from the recent list while its own save is in flight (丢弃 on the question).
C['recent-same-500'] = async (page) => {
  await openOpfs(page, 'o.md', '# O\n');
  await openOpfs(page, 's.md', '# S\n');
  await slowWrites(page, SLOW, 'ok');
  await typeEnd(page, 'typed');
  await page.keyboard.press('Meta+s');
  await sleep(500);
  await page.click('.mdr-toolbar__file');
  await sleep(150);
  await page.evaluate(() => { const li = [...document.querySelectorAll('.mdr-recent li')].find((e) => /s\.md/.test(e.textContent)); if (li) li.click(); });
  await sleep(300);
  const asked = (await snap(page)).dialogs;
  await clickBtn(page, '丢弃');
  const a = await after(page, { asked });
  const disk1 = await disks(page, ['s.md']);
  const n = await nextSave(page);
  return { ...a, disk1, ...n, disk: await disks(page, ['s.md']), toasts: await toastsSeen(page) };
};
J['recent-same-500'] = (c) => (c && !c.error && /typed/.test(c.disk['s.md'] ?? '') ? null : 'typed text lost: ' + JSON.stringify(c && c.disk));
// A late FAILURE after 丢弃 + 打开…: is the saved-for text anywhere afterwards (disk or a draft)?
C['fail-where-500'] = async (page) => {
  await openOpfs(page, 's.md', '# S\n');
  await opfsWrite(page, 'o.md', '# O\n');
  await slowWrites(page, SLOW, 'fail');
  await typeEnd(page, 'typed');
  await sleep(2200); // the draft of 'typed' is written
  const before = (await allDrafts(page)).map((x) => x.text ?? x.names);
  await page.keyboard.press('Meta+s');
  await sleep(500);
  await pickerReturns(page, 'o.md');
  await page.evaluate(() => { void window.__mdr.app.registry.run('file.open'); });
  await sleep(300);
  await clickBtn(page, '丢弃');
  await after(page);
  await sleep(500);
  return { before, drafts: (await allDrafts(page)).map((x) => x.text ?? x.names), disk: await disks(page, ['s.md']), toasts: await toastsSeen(page) };
};
// fix-save (round 7, rule R7 (a), (c)): was "the same as 0.1.1"; under R7 the 打开… waits for the save, so the 丢弃
// at 800 ms meets no question, and the text the save was writing must be somewhere afterwards (0.1.1: in its draft).
J['fail-where-500'] = (c) => (c && !c.error && (c.drafts.some((x) => typeof x === 'string' && /typed/.test(x)) || /typed/.test(c.disk['s.md'] ?? '')) ? null : 'typed text lost: ' + JSON.stringify(c && [c.drafts, c.disk]));
// The ordinary cases (nothing replaced): must equal 0.1.1.
C['plain-typing-during'] = async (page) => {
  await openOpfs(page, 's.md', '# S\n');
  await slowWrites(page, SLOW, 'ok');
  await typeEnd(page, 'one');
  await page.keyboard.press('Meta+s');
  await sleep(200);
  await page.keyboard.type(' later');
  const a = await after(page);
  await sleep(1500);
  const dr = (await allDrafts(page)).map((x) => x.text ?? x.names);
  await page.reload();
  await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app);
  await sleep(1200);
  return { ...a, drafts: dr, disk: await disks(page, ['s.md']), toasts: await toastsSeen(page) };
};
C['plain-saveas'] = async (page) => {
  await openOpfs(page, 's.md', '# S\n');
  await pickerSaveReturns(page, 'as.md', 300);
  await slowWrites(page, 600, 'ok');
  await typeEnd(page, 'AS');
  await page.keyboard.press('Meta+Shift+s');
  await sleep(1600);
  await page.evaluate(() => { window.__slow = false; });
  const s = await snap(page);
  await typeEnd(page, '2'); await page.keyboard.press('Meta+s'); await sleep(800);
  return { title: s.title, status: s.status, title2: (await snap(page)).title, disk: await disks(page, ['s.md', 'as.md']), toasts: await toastsSeen(page) };
};
C['plain-fail'] = async (page) => {
  await openOpfs(page, 's.md', '# S\n');
  await slowWrites(page, 300, 'fail');
  await typeEnd(page, 'F');
  await page.keyboard.press('Meta+s');
  await sleep(1000);
  await page.evaluate(() => { window.__slow = false; });
  const s = await snap(page);
  const actions = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast button')].map((b) => b.textContent));
  await page.keyboard.press('Meta+s'); await sleep(800);
  return { title: s.title, status: s.status, actions, title2: (await snap(page)).title, disk: await disks(page, ['s.md']), toasts: await toastsSeen(page) };
};
C['plain-cancel-saveas'] = async (page) => {
  await page.evaluate(() => { window.showSaveFilePicker = async () => { await new Promise((r) => setTimeout(r, 300)); throw new DOMException('x', 'AbortError'); }; });
  await typeEnd(page, 'UN');
  await page.keyboard.press('Meta+s');
  await sleep(900);
  const s = await snap(page);
  return { title: s.title, status: s.status, toasts: await toastsSeen(page), drafts: (await allDrafts(page)).map((x) => x.k.replace(/:.*/, ':*')) };
};
// R4 / R5: a draft offered after a reload, the offer left unanswered while the user types, reload again.
C['plain-r5'] = async (page) => {
  const rl = async () => { await page.reload(); await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app); await sleep(1300); };
  await typeEnd(page, 'first draft 一');
  await sleep(2200);
  await rl();
  const s1 = await snap(page);
  await typeEnd(page, 'typed after offer');
  await sleep(2200);
  const dr1 = (await allDrafts(page)).map((x) => x.text);
  await rl();
  const s2 = await snap(page);
  const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll('.mdr-toast button')].find((x) => x.textContent.trim() === '恢复'); if (b) b.click(); return !!b; });
  await sleep(600);
  return { s1: { text: s1.text, toasts: s1.toasts, title: s1.title }, dr1, s2: { text: s2.text, toasts: s2.toasts }, clicked, restored: (await snap(page)).text };
};
// fx/10-drafts' last step as a user does it: a draft restored after a reload (the document is dirty with it),
// then the document is replaced (新建 + 丢弃, or loadText), new text typed: is its draft kept and offered?
for (const via of ['new', 'loadText', 'new-wait']) {
  C[`plain-draft-after-restore-${via}`] = async (page) => {
    const rl = async () => { await page.reload(); await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(1500); };
    await typeEnd(page, 'MARK draft');
    await sleep(2200);
    await rl();
    const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll('.mdr-toast button')].find((x) => x.textContent.trim() === '恢复'); if (b) b.click(); return !!b; });
    await sleep(1200);
    const restored = (await snap(page)).text;
    if (via === 'new-wait') await sleep(2500);
    if (via === 'loadText') await page.evaluate(() => window.__mdr.loadText('', '未命名.md'));
    else { await page.evaluate(() => { void window.__mdr.app.registry.run('file.new'); }); await sleep(400); await clickBtn(page, '丢弃'); }
    await sleep(800);
    const afterNew = { text: (await snap(page)).text, drafts: (await allDrafts(page)).map((x) => x.k.slice(0, 16) + '=' + JSON.stringify(x.text)) };
    await typeEnd(page, '临时草稿 TEMP');
    await sleep(2400);
    const drafts = (await allDrafts(page)).map((x) => x.k.slice(0, 16) + '=' + JSON.stringify(x.text));
    const status = (await snap(page)).status;
    await rl();
    const s = await snap(page);
    return { clicked, restored, afterNew, drafts, status, offer: s.toasts };
  };
}
// A restored draft while the save is in flight (R6 for restoreDraft): s.md typed, its draft left, reload,
// reopen from the recent list (the offer), type, ⌘S slow, 恢复 at d.
for (const d of [50, 500]) {
  C[`restore-${d}`] = async (page) => {
    await openOpfs(page, 's.md', '# S\n');
    await typeEnd(page, 'DRAFT');
    await sleep(2200);
    await page.reload();
    await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app);
    await sleep(1000);
    await page.click('.mdr-toolbar__file'); await sleep(200);
    await page.evaluate(() => { const li = [...document.querySelectorAll('.mdr-recent li')].find((e) => /s\.md/.test(e.textContent)); if (li) li.click(); });
    await sleep(1200);
    const offer = (await snap(page)).toasts;
    await slowWrites(page, SLOW, 'ok');
    await typeEnd(page, 'NOW');
    await page.keyboard.press('Meta+s');
    await sleep(d);
    const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll('.mdr-toast button')].find((x) => x.textContent.trim() === '恢复'); if (b) b.click(); return !!b; });
    await sleep(400);
    const asked = (await snap(page)).dialogs;
    await page.evaluate(() => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => /恢复/.test(x.textContent)) || document.querySelector('.mdr-dialog__btn--danger'); if (b) b.click(); });
    const a = await after(page, { offer, clicked, asked });
    const n = await nextSave(page);
    return { ...a, ...n, disk: await disks(page, ['s.md']), toasts: await toastsSeen(page) };
  };
}
const bad = await runCases(C, { judge: J, timeoutMs: 115_000 });
process.exit(bad ? 1 : 0);
