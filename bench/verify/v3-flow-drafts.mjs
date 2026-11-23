// bench/verify/v3-flow-drafts.mjs — verify-flows (0.2.0 stage 2c): R4 draft rules on the WEB build.
//   MDR_URL=http://localhost:5384/ node bench/verify/v3-flow-drafts.mjs [D1 D3 …]          # candidate (own Vite)
//   MDR_URL='http://localhost:5394/?perf=1' node bench/verify/v3-flow-drafts.mjs [D1 …]   # baseline 0.1.1 dist
// Needs the renderer already running (see v3-flow-lib.mjs). Writes nothing into the tree. Global timeout 110 s.
import {
  URL0, IS_BASE, sleep, check, until, storedRecord, storedDraft, seedDraft, toasts, offers, dialogs, editorText, run,
  boot, typeInEditor, waitDraft, answer, toastButton, hide, main,
} from './v3-flow-lib.mjs';

const S = {};
const FUTURE = () => Date.now() + 3600_000;

// D1 — an unanswered crash offer; the user types and takes it back (Backspace / ⌘Z): the document text is
// again the loaded text. R4: a draft is written only for text the user CHANGED; it is never overwritten by
// a clean document. Then the tab dies (no beforeunload) and a new tab boots: is the crash text offered?
for (const [name, keys] of [['D1a', ['x', 'Backspace']], ['D1b', ['a', 'b', 'c', 'Meta+z']]]) {
  S[name] = async (ctx) => {
    console.log(`[${name}] offer up, type ${keys.join(' ')} (back to the loaded text), wait, tab dies`);
    const p = await ctx.newPage();
    await boot(p);
    await seedDraft(p, { docId: 'untitled', version: 7, text: 'crash text', at: Date.now() });
    await p.reload();
    await until(p, () => !!window.__mdr && !!window.__mdr.app, null, 20000);
    const off = await until(p, () => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes('发现未保存的草稿')), null, 4000);
    check(`${name} precondition: offer shown`, !!off, JSON.stringify(await toasts(p)));
    await p.evaluate(() => window.__mdr.app.editor.focus());
    for (const k of keys) { if (k.length === 1) await p.keyboard.type(k); else await p.keyboard.press(k); await sleep(30); }
    console.log(`     editor now ${JSON.stringify(await editorText(p))}`);
    await sleep(1800); // past the worker's 1 s debounce
    const rec = await storedRecord(p, 'untitled');
    check(`${name} the crash draft is still stored (the document is back to its loaded text)`, rec && rec.text === 'crash text', `stored ${JSON.stringify(rec && rec.text)}`);
    await hide(p);
    await sleep(500);
    console.log(`     after hide: ${JSON.stringify(await storedDraft(p, 'untitled'))}`);
    await p.close({ runBeforeUnload: false });
    const p2 = await ctx.newPage();
    await boot(p2);
    await sleep(900);
    check(`${name} the next tab offers the crash text`, (await offers(p2)) === 1, `toasts ${JSON.stringify(await toasts(p2))}, stored ${JSON.stringify(await storedDraft(p2, 'untitled'))}`);
  };
}

// D3 — G29 variation: the change after the offer is a PREVIEW-SESSION edit (not editor typing); 恢复 must ask.
// Then 取消 keeps typing and offer; 恢复 → 恢复: one undo step back to the typed text, redo forward.
S.D3 = async (ctx) => {
  console.log('[D3] offer up, a preview-session edit, then 恢复');
  const p = await ctx.newPage();
  await boot(p);
  await seedDraft(p, { docId: 'text:g29.md', version: 3, text: 'crash version\n', at: FUTURE() });
  await p.evaluate(() => window.__mdr.app.loadText('para one\n', 'g29.md'));
  const off = await until(p, () => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes('发现未保存的草稿')), null, 4000);
  check('D3 precondition: offer shown', !!off);
  await p.evaluate(() => window.__mdr.app.layout.setMode && 0);
  const box = await until(p, () => {
    const el = document.querySelector('.mdr-preview section.md-block p');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.right - 2, y: r.top + r.height / 2 };
  }, null, 5000);
  await sleep(700);
  await p.mouse.click(box.x, box.y);
  const ses = await until(p, () => !!document.querySelector('section.md-block.is-editing'), null, 2000);
  check('D3 precondition: a session started', !!ses);
  await p.keyboard.press('End');
  await p.keyboard.type('Z');
  // no wait: 恢复 right away (restoreDraft commits the session before it decides)
  const clicked = await toastButton(p, '发现未保存的草稿', '恢复');
  await sleep(500);
  const q = await dialogs(p);
  check('D3 恢复 after a session edit asks first', clicked && q.some((t) => t.includes('草稿提示出现后文档又有改动')), `dialogs ${JSON.stringify(q)} editor ${JSON.stringify(await editorText(p))}`);
  if (q.length) {
    await answer(p, '取消');
    await sleep(300);
    check('D3 取消 keeps the session typing', (await editorText(p)) === 'para oneZ\n', JSON.stringify(await editorText(p)));
    check('D3 取消 keeps the offer (one)', (await offers(p)) === 1, JSON.stringify(await toasts(p)));
    await toastButton(p, '发现未保存的草稿', '恢复');
    await sleep(300);
    await answer(p, '恢复');
    await sleep(400);
    check('D3 恢复 → 恢复 puts the draft in', (await editorText(p)) === 'crash version\n', JSON.stringify(await editorText(p)));
    await p.evaluate(() => window.__mdr.app.editor.focus());
    await p.keyboard.press('Meta+z');
    await sleep(200);
    const u = await editorText(p);
    check('D3 one ⌘Z gives the typed text back', u === 'para oneZ\n', JSON.stringify(u));
    await p.keyboard.press('Meta+Shift+z');
    await sleep(200);
    check('D3 ⇧⌘Z redoes the restore', (await editorText(p)) === 'crash version\n', JSON.stringify(await editorText(p)));
  }
};

// D4 — G36 variation: 新建 three times without waiting (all queued at once), then a loadText of another
// document and 新建 back: one offer at a time.
S.D4 = async (ctx) => {
  console.log('[D4] crash offer; 新建 ×3 at once; another document and back');
  const p = await ctx.newPage();
  await boot(p);
  await seedDraft(p, { docId: 'untitled', version: 7, text: 'crash text', at: Date.now() });
  await p.reload();
  await until(p, () => !!window.__mdr && !!window.__mdr.app, null, 20000);
  await sleep(700);
  await p.evaluate(() => { const r = window.__mdr.app.registry; void r.run('file.new'); void r.run('file.new'); void r.run('file.new'); });
  await sleep(1200);
  check('D4 one offer after 新建 ×3 at once', (await offers(p)) === 1, JSON.stringify(await toasts(p)));
  await p.evaluate(() => window.__mdr.app.loadText('other\n', 'other.md'));
  await sleep(500);
  check('D4 no offer on another document', (await offers(p)) === 0, JSON.stringify(await toasts(p)));
  await run(p, 'file.new');
  await sleep(900);
  check('D4 one offer back on the untitled document', (await offers(p)) === 1, JSON.stringify(await toasts(p)));
  check('D4 crash text still stored', (await storedDraft(p, 'untitled')) === 'crash text', JSON.stringify(await storedDraft(p, 'untitled')));
};

// D8 — typing during a SLOW save (File System Access, the writable's close takes 2.5 s): the newer text's
// draft must survive and be offered after a crash.
S.D8 = async (ctx) => {
  console.log('[D8] typing while a slow save is in flight, then the tab dies');
  const p = await ctx.newPage();
  await boot(p);
  await p.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle('d8.md', { create: true });
    const w = await h.createWritable(); await w.write('# D8\n'); await w.close();
    window.showOpenFilePicker = async () => [h];
  });
  await run(p, 'file.open');
  check('D8 precondition: opened', !!(await until(p, () => window.__mdr.app.getText() === '# D8\n')));
  await p.evaluate(() => {
    const P = FileSystemFileHandle.prototype;
    const orig = P.createWritable;
    P.createWritable = async function (...a) {
      const w = await orig.apply(this, a);
      const close = w.close.bind(w);
      w.close = async () => { await new Promise((r) => setTimeout(r, 2500)); return close(); };
      return w;
    };
  });
  await p.evaluate(() => window.__mdr.app.editor.focus());
  await p.keyboard.press('End');
  await p.keyboard.type('saved part');
  await p.keyboard.press('Meta+s');
  await sleep(100);
  await p.keyboard.type(' NEWER');
  await sleep(3500); // the save finishes after the draft's debounce wrote the newer text
  const rec = await storedRecord(p, (await p.evaluate(() => window.__mdr.app ? null : null)) ?? '');
  const docId = await p.evaluate(async () => {
    const dbs = await indexedDB.databases();
    return dbs.map((d) => d.name).join(',');
  });
  void rec; void docId;
  const all = await p.evaluate(() => new Promise((res) => {
    const o = indexedDB.open('keyval-store');
    o.onsuccess = () => {
      const db = o.result;
      const out = [];
      const c = db.transaction('keyval').objectStore('keyval').openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { if (String(cur.key).startsWith('mdr.draft:')) out.push({ k: cur.key, text: cur.value.text, at: cur.value.at }); cur.continue(); } else { db.close(); res(out); } };
    };
  }));
  const fileText = await p.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('d8.md')).getFile()).text());
  const mtime = await p.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('d8.md')).getFile()).lastModified);
  console.log(`     on disk ${JSON.stringify(fileText)} mtime ${mtime}; drafts ${JSON.stringify(all)}`);
  check('D8 a draft of the newer text exists', all.some((d) => d.text.includes('NEWER')), JSON.stringify(all));
  const d = all.find((x) => x.text.includes('NEWER'));
  if (d) check('D8 … and it is newer than the file (else it is never offered)', d.at > mtime, `draft.at ${d.at} mtime ${mtime}`);
  await p.close({ runBeforeUnload: false });
  const p2 = await ctx.newPage();
  await boot(p2);
  await p2.click('.mdr-toolbar__file');
  await p2.waitForSelector('.mdr-recent__item', { timeout: 3000 });
  const items = await p2.$$eval('.mdr-recent__item', (els) => els.map((e) => e.textContent));
  console.log(`     recent items ${JSON.stringify(items)}`);
  await (await p2.$$('.mdr-recent__item'))[Math.max(0, items.findIndex((t) => t.includes('d8.md')))].click();
  await sleep(1500);
  console.log(`     after click: editor ${JSON.stringify(await editorText(p2))} toasts ${JSON.stringify(await toasts(p2))} dialogs ${JSON.stringify(await dialogs(p2))}`);
  await until(p2, () => window.__mdr.app.getText().startsWith('# D8'), null, 4000);
  await sleep(800);
  check('D8 after the crash, reopening the file offers the newer text', (await offers(p2)) === 1, `editor ${JSON.stringify(await editorText(p2))} toasts ${JSON.stringify(await toasts(p2))}`);
};

// D2 — G28 variation: offer unanswered; a preview session starts and ends WITHOUT typing (Escape); the tab is
// hidden; the same document is loaded again (same docId). The crash draft must stay and be offered once.
S.D2 = async (ctx) => {
  console.log('[D2] offer up; empty session; hide; same document again');
  const p = await ctx.newPage();
  await boot(p);
  await seedDraft(p, { docId: 'text:g28.md', version: 3, text: 'crash g28\n', at: FUTURE() });
  await p.evaluate(() => window.__mdr.app.loadText('para one\n\npara two\n', 'g28.md'));
  await until(p, () => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes('发现未保存的草稿')), null, 4000);
  const box = await until(p, () => {
    const el = document.querySelector('.mdr-preview section.md-block p');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + 10, y: r.top + r.height / 2 };
  }, null, 5000);
  await sleep(700);
  await p.mouse.click(box.x, box.y);
  const ses = await until(p, () => !!document.querySelector('section.md-block.is-editing'), null, 2000);
  check('D2 precondition: a session started', !!ses);
  await p.keyboard.press('Escape');
  await sleep(300);
  await hide(p);
  await sleep(1500);
  check('D2 after an empty session + hide the crash draft is still stored', (await storedDraft(p, 'text:g28.md')) === 'crash g28\n', JSON.stringify(await storedDraft(p, 'text:g28.md')));
  await p.evaluate(() => { delete document.visibilityState; });
  await p.evaluate(() => window.__mdr.app.loadText('para one\n\npara two\n', 'g28.md'));
  await sleep(700);
  check('D2 G36: the same document loaded again shows one offer', (await offers(p)) === 1, JSON.stringify(await toasts(p)));
};

// D5 — G29 variation: the offer was dismissed by another document and shown again by 新建; typing then; 恢复
// from the re-shown offer must ask (its own "offered at" is the re-show).
S.D5 = async (ctx) => {
  console.log('[D5] re-shown offer, typing, 恢复');
  const p = await ctx.newPage();
  await boot(p);
  await seedDraft(p, { docId: 'untitled', version: 7, text: 'crash d5', at: Date.now() });
  await p.reload();
  await until(p, () => !!window.__mdr && !!window.__mdr.app, null, 20000);
  await sleep(600);
  await p.evaluate(() => window.__mdr.app.loadText('other\n', 'other.md'));
  await sleep(400);
  await run(p, 'file.new');
  await until(p, () => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes('发现未保存的草稿')), null, 4000);
  await typeInEditor(p, 'fresh typing');
  await sleep(200);
  await toastButton(p, '发现未保存的草稿', '恢复');
  await sleep(500);
  const q = await dialogs(p);
  check('D5 恢复 from the re-shown offer after typing asks', q.some((t) => t.includes('草稿提示出现后文档又有改动')), `dialogs ${JSON.stringify(q)} editor ${JSON.stringify(await editorText(p))}`);
};

console.log(`renderer ${URL0}${IS_BASE ? ' (baseline)' : ''}`);
await main(S);
