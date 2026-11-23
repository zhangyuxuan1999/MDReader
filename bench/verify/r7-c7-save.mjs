// bench/verify/r7-c7-save.mjs — challenge-7 (round 7): attacks rule R7 (a replacement waits for the document's own save;
// switch OFF) in headless Chromium with the real app, real OPFS files and IndexedDB drafts, on the rows the fixer's table
// (bench/verify/r7-fs-table.mjs) does not have: a failure that arrives AFTER the question was asked (the wait ran out),
// a second request while the first one waits (打开… twice, 打开… then 新建), typing or a second ⌘S during the wait, an
// untitled document saved under a name, late moments (20 / 200 / 2 000 ms into a 2.5-s save), a save that never settles
// followed by a second request, and the same file reopened after the bound.
// Candidate = the tree's Vite dev server (MDR_PORT; the wait is shortened through the dev module /src/app/App.ts where a
// case says so); baseline = the released 0.2.0 dist under `vite preview` (MDR_BASE_PORT; ?perf=1 added by the lib).
//   MDR_PORT=5465 MDR_BASE_PORT=5475 node bench/verify/r7-c7-save.mjs [case|prefix* ...] [--list]
// Prints both sides per case and the candidate's invariant check (I1 typed text on disk or in a draft unless the user
// discarded it after being told the save failed; I2 no draft left after a save that wrote; I3 a document shown clean
// holds what its file holds; I4 no question left). Global timeout T_MS (default 115 000). Writes nothing in the tree.
import { sleep, runCases, snap, clickBtn, opfsWrite, opfsRead, pickerReturns, pickerSaveReturns, openOpfs, slowWrites, allDrafts, typeEnd } from './v5-offa-lib.mjs';

const setWait = (page, ms) => page.evaluate(async (v) => {
  const u = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/src\/app\/App\.ts(\?|$)/.test(n));
  if (!u) return 'no-module';
  const m = await import(u);
  m.SAVE_WAIT.ms = v;
  m.SAVE_WAIT.gestureMs = Math.min(v, 4000);
  return u;
}, ms);
const dialogUp = (page) => page.evaluate(() => !!document.querySelector('.mdr-dialog'));
async function untilDialog(page, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await dialogUp(page)) return Date.now() - t0; await sleep(30); }
  return -1;
}
const toasts = (page) => page.evaluate(() => (window.__toasts || []).slice());
const run = (page, id) => page.evaluate((c) => { void window.__mdr.app.registry.run(c); }, id);
async function state(page, extra = []) {
  await page.evaluate(() => { window.__slow = false; });
  const s = await snap(page);
  const drafts = (await allDrafts(page)).filter((x) => x.k.startsWith('mdr.draft')).map((x) => x.text);
  const shown = s.title.replace(/^● /, '');
  const disk = {};
  for (const n of ['s.md', 'o.md', 'p.md', 'u.md', ...extra]) disk[n] = await opfsRead(page, n);
  return { title: s.title, text: s.text, dialogs: s.dialogs, drafts, disk, shownDisk: /\.md$/.test(shown) ? disk[shown] ?? (await opfsRead(page, shown)) : null, toasts: (await toasts(page)).filter((t) => /保存|草稿/.test(t)).slice(-4) };
}
async function setup(page, { wait = null, ms = 1500, mode = 'ok' } = {}) {
  await openOpfs(page, 'o.md', '# O\n');
  await openOpfs(page, 'p.md', '# P\n');
  await openOpfs(page, 's.md', '# S\n');
  if (wait !== null) await setWait(page, wait);
  await slowWrites(page, ms, mode);
}
const T = Number(process.env.T_MS ?? 115_000);
const C = {
  // the wait runs out (300 ms) during a save that fails at 1.5 s; the question is up when the failure is reported, the
  // user answers 丢弃 after the failure toast
  'fail-after-ask': async (page, _c, label) => {
    await setup(page, { wait: 300, ms: 1500, mode: 'fail' });
    await typeEnd(page, 'typed');
    await page.keyboard.press('Meta+s');
    await sleep(50);
    await pickerReturns(page, 'o.md');
    await run(page, 'file.open');
    const askedAt = await untilDialog(page, 3000);
    // wait for the failure to be reported while the question is up
    const t0 = Date.now();
    while (Date.now() - t0 < 3000 && !(await toasts(page)).some((t) => /保存失败/.test(t))) await sleep(50);
    const failSeen = (await toasts(page)).some((t) => /保存失败/.test(t));
    await sleep(300);
    const clicked = await clickBtn(page, '丢弃');
    await sleep(1800);
    return { label, askedAt, failSeen, clicked, ...(await state(page)) };
  },
  // two 打开… in a row during a save that writes
  'two-opens': async (page) => {
    await setup(page, { ms: 1500 });
    await typeEnd(page, 'typed');
    await page.keyboard.press('Meta+s');
    await sleep(50);
    await pickerReturns(page, 'o.md');
    await run(page, 'file.open');
    await sleep(80);
    await pickerReturns(page, 'p.md');
    await run(page, 'file.open');
    const asked = await untilDialog(page, 2500);
    if (asked >= 0) await clickBtn(page, '丢弃');
    await sleep(1500);
    if ((await untilDialog(page, 300)) >= 0) await clickBtn(page, '丢弃');
    await sleep(800);
    return { asked, ...(await state(page)) };
  },
  'open-then-new': async (page) => {
    await setup(page, { ms: 1500 });
    await typeEnd(page, 'typed');
    await page.keyboard.press('Meta+s');
    await sleep(50);
    await pickerReturns(page, 'o.md');
    await run(page, 'file.open');
    await sleep(80);
    await run(page, 'file.new');
    const asked = await untilDialog(page, 2500);
    if (asked >= 0) await clickBtn(page, '丢弃');
    await sleep(1500);
    if ((await untilDialog(page, 300)) >= 0) await clickBtn(page, '丢弃');
    await sleep(800);
    return { asked, ...(await state(page)) };
  },
  // typing during the wait: the question must come (the typed-later text is unsaved); 取消 keeps everything
  'open-then-type-cancel': async (page) => {
    await setup(page, { ms: 1500 });
    await typeEnd(page, 'typed');
    await page.keyboard.press('Meta+s');
    await sleep(50);
    await pickerReturns(page, 'o.md');
    await run(page, 'file.open');
    await sleep(300);
    await page.keyboard.type('more');
    const asked = await untilDialog(page, 3000);
    if (asked >= 0) await clickBtn(page, '取消');
    await sleep(1500);
    return { asked, ...(await state(page)) };
  },
  // a second ⌘S during the wait: both saves write; no question; the request goes on
  'open-then-save2': async (page) => {
    await setup(page, { ms: 1500 });
    await typeEnd(page, 'typed');
    await page.keyboard.press('Meta+s');
    await sleep(50);
    await pickerReturns(page, 'o.md');
    await run(page, 'file.open');
    await sleep(300);
    await page.keyboard.type('more');
    await page.keyboard.press('Meta+s');
    const asked = await untilDialog(page, 3500);
    if (asked >= 0) await clickBtn(page, '丢弃');
    await sleep(1500);
    return { asked, ...(await state(page)) };
  },
  // an untitled document saved under a name (the save panel answers u.md), 打开… during the write
  'untitled-saveas-open': async (page) => {
    await setup(page, { ms: 1500 });
    await run(page, 'file.new');
    await sleep(300);
    await pickerSaveReturns(page, 'u.md');
    await typeEnd(page, 'typed');
    await page.keyboard.press('Meta+s');
    await sleep(200);
    await pickerReturns(page, 'o.md');
    await run(page, 'file.open');
    const asked = await untilDialog(page, 2500);
    if (asked >= 0) await clickBtn(page, '丢弃');
    await sleep(1500);
    return { asked, ...(await state(page)) };
  },
  'untitled-saveas-fail-new': async (page) => {
    await setup(page, { ms: 1500, mode: 'fail' });
    await run(page, 'file.new');
    await sleep(300);
    await pickerSaveReturns(page, 'u.md');
    await typeEnd(page, 'typed');
    await page.keyboard.press('Meta+s');
    await sleep(200);
    await run(page, 'file.new');
    const asked = await untilDialog(page, 3000);
    const failFirst = (await toasts(page)).some((t) => /保存失败/.test(t));
    if (asked >= 0) await clickBtn(page, '取消');
    await sleep(1500);
    return { asked, failFirst, ...(await state(page)) };
  },
  // the save never settles; the wait (shortened to 400 ms) runs out for the first request (取消); a second request asks
  // at once (丢弃): the draft of s.md must hold the typed text (its save is still in flight); then typing works
  'never-then-second': async (page) => {
    await setup(page, { wait: 400, ms: 600_000 });
    await typeEnd(page, 'typed');
    await page.keyboard.press('Meta+s');
    await sleep(50);
    await pickerReturns(page, 'o.md');
    await run(page, 'file.open');
    const a1 = await untilDialog(page, 3000);
    if (a1 >= 0) await clickBtn(page, '取消');
    await sleep(200);
    await pickerReturns(page, 'o.md');
    await run(page, 'file.open');
    const a2 = await untilDialog(page, 3000);
    if (a2 >= 0) await clickBtn(page, '丢弃');
    await sleep(1500);
    await typeEnd(page, 'X');
    await sleep(300);
    return { a1, a2, ...(await state(page)) };
  },
  // the same file reopened after the bound (300 ms) during its own 1.5-s save, 丢弃; the save then writes
  'same-after-bound': async (page) => {
    await setup(page, { wait: 300, ms: 1500 });
    await typeEnd(page, 'typed');
    await page.keyboard.press('Meta+s');
    await sleep(50);
    await pickerReturns(page, 's.md');
    await run(page, 'file.open');
    const asked = await untilDialog(page, 2500);
    if (asked >= 0) await clickBtn(page, '丢弃');
    await sleep(300);
    const mid = (await snap(page)).text;
    await sleep(2500);
    return { asked, mid, ...(await state(page)) };
  },
  // the same, but the user types into the reopened (old) text before the late save writes
  'same-after-bound-type': async (page) => {
    await setup(page, { wait: 300, ms: 1500 });
    await typeEnd(page, 'typed');
    await page.keyboard.press('Meta+s');
    await sleep(50);
    await pickerReturns(page, 's.md');
    await run(page, 'file.open');
    const asked = await untilDialog(page, 2500);
    if (asked >= 0) await clickBtn(page, '丢弃');
    await sleep(300);
    await typeEnd(page, 'Z');
    await sleep(2500);
    return { asked, ...(await state(page)) };
  },
};
// a restored draft while a save that FAILS is in flight: s.md typed (its draft left), reload, reopen from the recent list
// (the offer), type NOW, ⌘S (fails at 1.5 s), 恢复 at 50 ms; the restore question (if asked) answered 取消 or 恢复
for (const ans of ['取消', '恢复']) {
  C[`restore-fail-${ans === '取消' ? 'cancel' : 'restore'}`] = async (page) => {
    await openOpfs(page, 's.md', '# S\n');
    await typeEnd(page, 'DRAFT');
    await sleep(2200);
    await page.reload();
    await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app);
    await sleep(1000);
    await page.evaluate(() => {
      window.__toasts = [];
      new MutationObserver(() => { for (const e of document.querySelectorAll('.mdr-toast__text')) if (!window.__toasts.includes(e.textContent)) window.__toasts.push(e.textContent); }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await page.click('.mdr-toolbar__file'); await sleep(200);
    await page.evaluate(() => { const li = [...document.querySelectorAll('.mdr-recent li')].find((e) => /s\.md/.test(e.textContent)); if (li) li.click(); });
    await sleep(1200);
    const offer = (await snap(page)).toasts;
    await slowWrites(page, 1500, 'fail');
    await typeEnd(page, 'NOW');
    await page.keyboard.press('Meta+s');
    await sleep(50);
    const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll('.mdr-toast button')].find((x) => x.textContent.trim() === '恢复'); if (b) b.click(); return !!b; });
    const askedAt = await untilDialog(page, 3000);
    const failFirst = (await toasts(page)).some((t) => /保存失败/.test(t));
    const q = (await snap(page)).dialogs;
    if (askedAt >= 0) await clickBtn(page, ans);
    await sleep(1800);
    const st = await state(page);
    return { offer: offer.filter((t) => /草稿/.test(t)).length, clicked, askedAt, failFirst, q, ...st, nowSomewhere: /NOW/.test(st.text) || /NOW/.test(st.disk['s.md'] ?? '') || st.drafts.some((t) => /NOW/.test(t ?? '')) };
  };
}
// late moments into a 2.5-s save: 打开… another file, the same file, 新建
for (const m of [20, 200, 2000]) {
  for (const kind of ['open', 'same', 'new']) {
    C[`${kind}-${m}`] = async (page) => {
      await setup(page, { ms: 2500 });
      await typeEnd(page, 'typed');
      await page.keyboard.press('Meta+s');
      await sleep(m);
      if (kind === 'new') await run(page, 'file.new');
      else { await pickerReturns(page, kind === 'same' ? 's.md' : 'o.md'); await run(page, 'file.open'); }
      const asked = await untilDialog(page, 3500);
      if (asked >= 0) await clickBtn(page, '丢弃');
      await sleep(1500);
      return { asked, ...(await state(page)) };
    };
  }
}
const J = {};
for (const n of Object.keys(C)) {
  J[n] = (c, b) => {
    if (!c || c.error) return 'cand error ' + (c && c.error);
    const p = [];
    const typedSomewhere = (s) => /typed/.test(s.disk['s.md'] ?? '') || /typed/.test(s.disk['u.md'] ?? '') || s.drafts.some((t) => /typed/.test(t ?? '')) || /typed/.test(s.text);
    if (!typedSomewhere(c)) p.push('I1 typed nowhere');
    if (!c.title.startsWith('●') && c.shownDisk !== null && c.shownDisk !== undefined && c.text !== c.shownDisk) p.push(`I3 shown clean ${JSON.stringify(c.text)} vs disk ${JSON.stringify(c.shownDisk)}`);
    if (c.dialogs.length) p.push('I4 question left');
    const wrote = /typed/.test(c.disk['s.md'] ?? '') || /typed/.test(c.disk['u.md'] ?? '');
    if (wrote && c.drafts.some((t) => t === c.disk['s.md'] || t === c.disk['u.md'])) p.push('I2 draft equal to the saved text left');
    if (b && !b.error && !typedSomewhere(b) && p.length === 0) return null;
    return p.length ? p.join('; ') : null;
  };
}
const bad = await runCases(C, { judge: J, timeoutMs: T });
process.exit(bad ? 1 : 0);
