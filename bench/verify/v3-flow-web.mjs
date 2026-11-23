// bench/verify/v3-flow-web.mjs — verify-flows (0.2.0 stage 2c): web open-failure messages, the picker, draft
// ownership across tabs, and the legacy (no File System Access) backend.
//   MDR_URL=http://localhost:5384/ node bench/verify/v3-flow-web.mjs [P1 O1 …]          # candidate (own Vite)
//   MDR_URL='http://localhost:5394/?perf=1' node bench/verify/v3-flow-web.mjs [P1 …]    # baseline 0.1.1 dist
// Needs the renderer already running (see v3-flow-lib.mjs). Writes nothing into the tree. Global timeout 110 s.
import {
  URL0, IS_BASE, sleep, check, until, storedRecord, storedDraft, seedDraft, toasts, offers, dialogs, editorText, run,
  boot, typeInEditor, waitDraft, answer, toastButton, hide, main,
} from './v3-flow-lib.mjs';

const S = {};
const closeToasts = (p) => p.evaluate(() => { for (const b of document.querySelectorAll('.mdr-toast__close')) b.click(); });

// P1 — G33 variations: the picker rejects with AbortError (the user cancelled: nothing to say), NotAllowedError,
// SecurityError, and a picked file whose read fails afterwards (NotFoundError from getFile).
S.P1 = async (ctx) => {
  console.log('[P1] 打开… panel outcomes');
  const p = await ctx.newPage();
  await boot(p);
  for (const [name, msg] of [['AbortError', 'The user aborted a request.'], ['NotAllowedError', 'File picker already active.'], ['SecurityError', 'Must be handling a user gesture to show a file picker.']]) {
    await closeToasts(p);
    await p.evaluate(([n, m]) => { window.showOpenFilePicker = async () => { throw new DOMException(m, n); }; }, [name, msg]);
    await run(p, 'file.open');
    await sleep(700);
    const t = await toasts(p);
    console.log(`     ${name}: ${JSON.stringify(t)}`);
    if (name === 'AbortError') check('P1 AbortError (cancel): no message', t.length === 0, JSON.stringify(t));
    else check(`P1 ${name}: the picker message`, t.length === 1 && t[0].includes('文件选择窗口'), JSON.stringify(t));
  }
  await closeToasts(p);
  await p.evaluate(() => {
    const fake = { kind: 'file', name: 'gone.md', getFile: async () => { throw new DOMException('A requested file or directory could not be found at the time an operation was processed.', 'NotFoundError'); }, isSameEntry: async () => false, queryPermission: async () => 'granted' };
    window.showOpenFilePicker = async () => [fake];
  });
  await run(p, 'file.open');
  await sleep(700);
  const t = await toasts(p);
  console.log(`     picked then unreadable: ${JSON.stringify(t)}`);
  check('P1 picked file unreadable: no picker wording', !t.some((x) => x.includes('文件选择窗口')), JSON.stringify(t));
};

// O1 — G34 web: a recent entry fails (permission), then the same file opens through the picker: the stale
// failure goes; another file with the SAME name failing elsewhere is not cleared by it (shared name key).
S.O1 = async (ctx) => {
  console.log('[O1] web failure, then the same file through another entry point');
  const p = await ctx.newPage();
  await boot(p);
  await p.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle('o1.md', { create: true });
    const w = await h.createWritable(); await w.write('# O1\n'); await w.close();
    window.__o1 = h;
    window.showOpenFilePicker = async () => [h];
  });
  await run(p, 'file.open');
  await until(p, () => window.__mdr.app.getText() === '# O1\n');
  await run(p, 'file.new');
  await sleep(500);
  await p.evaluate(() => {
    const P = FileSystemHandle.prototype;
    window.__q = P.queryPermission; window.__r = P.requestPermission;
    P.queryPermission = async () => 'prompt'; P.requestPermission = async () => 'denied';
  });
  await p.click('.mdr-toolbar__file');
  await p.waitForSelector('.mdr-recent__item', { timeout: 3000 });
  await sleep(200);
  const items = await p.$$eval('.mdr-recent__item', (els) => els.map((e) => e.textContent));
  await (await p.$$('.mdr-recent__item'))[items.indexOf('o1.md')].click();
  await sleep(900);
  const t1 = await toasts(p);
  console.log(`     after the refused recent: ${JSON.stringify(t1)}`);
  check('O1 the refusal names the file and asks to re-authorise', t1.some((x) => x.includes('o1.md') && x.includes('授权')), JSON.stringify(t1));
  await p.evaluate(() => { const P = FileSystemHandle.prototype; P.queryPermission = window.__q; P.requestPermission = window.__r; });
  await run(p, 'file.open');
  await until(p, () => window.__mdr.app.getText() === '# O1\n');
  await sleep(400);
  const t2 = await toasts(p);
  check('O1 after opening o1.md through the picker the failure is gone', !t2.some((x) => x.includes('o1.md')), JSON.stringify(t2));
};

// G30 — three tabs on the untitled document; writes and discards interleaved (0, 5, 50 ms).
S.G30 = async (ctx) => {
  console.log('[G30] three tabs, interleaved writes and discards');
  for (const gap of [0, 5, 50]) {
    const [a, b, c] = [await ctx.newPage(), await ctx.newPage(), await ctx.newPage()];
    for (const x of [a, b, c]) await boot(x);
    // clean the key between rounds
    await a.evaluate(() => new Promise((res) => { const o = indexedDB.open('keyval-store'); o.onsuccess = () => { const tx = o.result.transaction('keyval', 'readwrite'); tx.objectStore('keyval').delete('mdr.draft:untitled'); tx.oncomplete = () => { o.result.close(); res(); }; }; }));
    await typeInEditor(a, 'A text'); await waitDraft(a, 'untitled', 'A text');
    await typeInEditor(b, 'B text'); await waitDraft(b, 'untitled', 'B text');
    await typeInEditor(c, 'C text');
    // C writes now (hide → flush) while A and B discard `gap` ms later
    await hide(c);
    if (gap) await sleep(gap);
    await Promise.all([run(a, 'file.new'), run(b, 'file.new')]);
    await Promise.all([answer(a, '丢弃'), answer(b, '丢弃')]);
    await sleep(1500);
    const st = await storedDraft(a, 'untitled');
    check(`G30 gap ${gap} ms: C's draft survives A's and B's 丢弃`, st === 'C text', `stored ${JSON.stringify(st)}`);
    // now C discards: its own draft goes
    await run(c, 'file.new');
    await answer(c, '丢弃');
    await sleep(1200);
    check(`G30 gap ${gap} ms: C's own 丢弃 deletes it`, (await storedDraft(a, 'untitled')) === null, JSON.stringify(await storedDraft(a, 'untitled')));
    for (const x of [a, b, c]) await x.close({ runBeforeUnload: false });
  }
};

// L1 — legacy backend (no File System Access): an untitled document that was "saved" (downloaded as 未命名.md)
// keeps a draft under legacy:未命名.md; ANOTHER tab saving its own untitled text deletes that draft.
S.L1 = async (ctx) => {
  console.log('[L1] legacy backend: two untitled downloads share legacy:未命名.md');
  await ctx.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; });
  const a = await ctx.newPage();
  await boot(a);
  check('L1 precondition: legacy backend', await a.evaluate(() => !('showOpenFilePicker' in window)));
  await typeInEditor(a, 'report A');
  await a.keyboard.press('Meta+s');
  await sleep(700);
  await typeInEditor(a, ' continued');
  const key = 'legacy:未命名.md';
  const had = await waitDraft(a, key, 'report A continued');
  check('L1 precondition: tab A has a draft of its newer text', had, JSON.stringify(await storedDraft(a, key)));
  const b = await ctx.newPage();
  await boot(b);
  await closeToasts(b);
  await typeInEditor(b, 'note B');
  await b.keyboard.press('Meta+s');
  await sleep(1200);
  const st = await storedDraft(a, key);
  check('L1 tab B saving its own document leaves tab A’s unsaved draft alone', st !== null && st.includes('report A'), `stored ${JSON.stringify(st)}`);
};

// DR — a Markdown file dropped onto the EDITOR pane of a clean document (web): no question, the file opens,
// nothing of it is spliced into the current document.
S.DR = async (ctx) => {
  console.log('[DR] drop onto the editor pane of a clean document (web)');
  const p = await ctx.newPage();
  await boot(p);
  for (const answerWith of ['取消', '丢弃']) {
    await p.evaluate(() => window.__mdr.app.loadText('alpha line\n\nsecond line\n', 'dr-a.md'));
    await sleep(600);
    await p.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['# DROPPED\n'], 'dr-b.md', { type: 'text/markdown' }));
      const el = document.querySelector('.cm-line');
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.top + r.height / 2 };
      for (const e of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(e, o));
    });
    await sleep(1200);
    const q = await dialogs(p);
    console.log(`     dialogs ${JSON.stringify(q)} editor ${JSON.stringify(await editorText(p))}`);
    check('DR a clean document is not asked about', q.length === 0, JSON.stringify(q));
    if (q.length) { await answer(p, answerWith); await sleep(800); }
    const ed = await editorText(p);
    check(`DR after ${q.length ? answerWith : 'no question'}: one of the two documents, unmixed`, ed === '# DROPPED\n' || ed === 'alpha line\n\nsecond line\n', JSON.stringify(ed));
  }
};

// DR2 — the same drop onto a DIRTY document, answered 取消: is the dropped file's text left in it?
S.DR2 = async (ctx) => {
  console.log('[DR2] drop onto the editor pane of a dirty document, 取消');
  const p = await ctx.newPage();
  await boot(p);
  await p.evaluate(() => window.__mdr.app.loadText('alpha line\n', 'dr2-a.md'));
  await sleep(400);
  await typeInEditor(p, 'X');
  const before = await editorText(p);
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['# DROPPED\n'], 'dr2-b.md', { type: 'text/markdown' }));
    const el = document.querySelector('.cm-line');
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.top + r.height / 2 };
    for (const e of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(e, o));
  });
  await sleep(1000);
  const q = await dialogs(p);
  if (q.length) { await answer(p, '取消'); await sleep(600); }
  const ed = await editorText(p);
  check('DR2 取消 leaves the dirty document as it was', ed === before, `before ${JSON.stringify(before)} after ${JSON.stringify(ed)} dialogs ${JSON.stringify(q)}`);
};

console.log(`renderer ${URL0}${IS_BASE ? ' (baseline)' : ''}`);
await main(S);
