// bench/electron/hunt-lifecycle-guards.mjs — hunt:lifecycle, dirty guard / close dialog / quit scenarios.
//   node bench/electron/hunt-lifecycle-guards.mjs [scenario ...]     (default: all)
//   MDR_EXE=/path/to/MDReader node bench/electron/hunt-lifecycle-guards.mjs
import * as L from './hunt-lifecycle-lib.mjs';

L.watchdog(Number(process.env.MDR_HUNT_TIMEOUT || 110000));
const dir = L.tmpDir('mdr-hunt-docs-');
const A = L.writeDoc(dir, 'hunt-a.md', 3);
const B = L.writeDoc(dir, 'hunt-b.md', 5);
const mk = (d) => ({ marker: `标题 ${d.name} ${d.blocks / 2}` });
const isDoc = (s, d) => !!s && s.title?.includes(d.name) && s.matchesExpected === true && s.editorChars === d.length;
const TYPED = 'dirty-text';

async function boot() {
  const ctx = await L.launch();
  const w = await L.readyWindow(ctx.app);
  await L.sleep(700);
  await L.instrumentSends(ctx.app);
  return { ...ctx, w };
}
const live = (app) => app.windows().filter((x) => !x.isClosed()).pop();

const S = {
  async dirtyOpenCancel({ app, w }) {
    await L.typeInEditor(w, TYPED);
    await L.emitOpen(app, A.path);
    await L.sleep(800);
    const dlg = await L.snap(w);
    await L.clickDialog(w, '取消');
    await L.sleep(800);
    const s = await L.snap(w);
    return { expected: `guard shown; 取消 keeps ${TYPED.length} chars`, actual: { dialog: dlg.dialogs, after: s }, pass: dlg.dialogs.length === 1 && s.editorChars === TYPED.length && !s.title.includes(A.name) };
  },
  async dirtyOpenDiscard({ app, w }) {
    await L.typeInEditor(w, TYPED);
    await L.emitOpen(app, A.path);
    await L.sleep(800);
    const dlg = await L.snap(w);
    await L.clickDialog(w, '丢弃');
    await L.waitTitle(w, A.name);
    await L.sleep(800);
    const s = await L.snap(w, mk(A));
    return { expected: `丢弃 loads ${A.name}`, actual: { dialog: dlg.dialogs, after: s }, pass: isDoc(s, A) };
  },
  async dirtyTwoOpensDiscard({ app, w }) {
    await L.typeInEditor(w, TYPED);
    await L.emitOpen(app, A.path);
    await L.sleep(100);
    await L.emitOpen(app, B.path);
    await L.sleep(800);
    const dlg = await L.snap(w);
    await L.clickDialog(w, '丢弃');
    await L.sleep(1500);
    const s = await L.snap(w, mk(B));
    return { expected: `one guard; then A then B; ${B.name} last`, actual: { dialogs: dlg.dialogs, after: s }, pass: dlg.dialogs.length === 1 && isDoc(s, B) };
  },
  async openWhileNewGuard({ app, w }) {
    // 文件 → 新建 while dirty shows the discard guard; a double-click arrives while it is up.
    await L.typeInEditor(w, TYPED);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.new').click());
    await L.sleep(700);
    const dlg1 = await L.snap(w);
    await L.emitOpen(app, A.path);
    await L.sleep(900);
    const dlg2 = await L.snap(w);
    await L.clickDialog(w, '丢弃');
    await L.sleep(1500);
    const s = await L.snap(w, mk(A));
    return { expected: `after answering, ${A.name} is opened (or a second guard asks for it)`, actual: { dialogsAfterNew: dlg1.dialogs, dialogsAfterOpen: dlg2.dialogs, after: s }, pass: isDoc(s, A) || s.dialogs.length > 0 };
  },
  async openWhileCloseDialog_closeDontSave({ app, w }) {
    await L.typeInEditor(w, TYPED);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    await L.sleep(800);
    const d1 = await L.snap(w);
    await L.emitOpen(app, A.path);
    await L.sleep(900);
    const d2 = await L.snap(w);
    // answer the CLOSE dialog (the first one): 不保存
    const clicked = await w.evaluate(() => {
      const dl = [...document.querySelectorAll('.mdr-dialog')];
      const first = dl[0];
      const b = first && [...first.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === '不保存');
      if (b) { b.click(); return true; }
      return false;
    });
    await L.sleep(1500);
    const st = await L.mainState(app);
    const lw = live(app);
    const s = lw ? await L.snap(lw, mk(A)) : null;
    return { expected: `${A.name} ends up on screen (the open must not vanish with the closed window)`, actual: { closeDialog: d1.dialogs, afterOpen: d2.dialogs, clicked, state: st, snap: s }, pass: isDoc(s, A) };
  },
  async openWhileCloseDialog_guardDiscardThenClose({ app, w }) {
    await L.typeInEditor(w, TYPED);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    await L.sleep(800);
    await L.emitOpen(app, A.path);
    await L.sleep(900);
    const d2 = await L.snap(w);
    await L.clickDialog(w, '丢弃'); // the discard guard (topmost)
    await L.sleep(1200);
    const mid = await L.snap(w, mk(A));
    // the close dialog is still up and still names the untitled doc
    await L.clickDialog(w, '不保存');
    await L.sleep(1500);
    const st = await L.mainState(app);
    return { expected: `${A.name} loaded; the stale close question must not close the window under the freshly opened, clean document`, actual: { dialogsAfterOpen: d2.dialogs, mid, state: st }, pass: isDoc(mid, A) && st.windows === 1 };
  },
  async quitRightAfterOpenClean({ app }) {
    const t0 = Date.now();
    const exited = new Promise((r) => app.process().once('exit', (c, sig) => r({ c, sig, ms: Date.now() - t0 })));
    await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); setTimeout(() => a.quit(), 0); }, A.path).catch(() => {});
    const r = await Promise.race([exited, L.sleep(8000).then(() => 'still running')]);
    return { expected: 'quits cleanly', actual: { exit: r }, pass: typeof r === 'object' };
  },
  async quitRightAfterOpenDirty({ app, w }) {
    await L.typeInEditor(w, TYPED);
    await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); setTimeout(() => a.quit(), 30); }, A.path).catch(() => {});
    await L.sleep(1200);
    const s = await L.snap(w);
    return { expected: 'one question; typed text not lost without asking', actual: { snap: s, state: await L.mainState(app) }, pass: s.dialogs.length === 1 };
  },
  async closeDialogThenSecondClose({ app, w }) {
    // close requested twice (red button pressed twice) then open
    await L.typeInEditor(w, TYPED);
    await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.close(); b.close(); });
    await L.sleep(800);
    const s = await L.snap(w);
    return { expected: 'exactly one close dialog', actual: { dialogs: s.dialogs }, pass: s.dialogs.length === 1 };
  },
};

const pick = process.argv.slice(2);
const names = pick.length ? pick : Object.keys(S);
const results = [];
for (const name of names) {
  const t0 = Date.now();
  let ctx;
  try {
    ctx = await boot();
    const r = await S[name](ctx);
    results.push({ scenario: name, ...r, sends: await L.sends(ctx.app).catch(() => null), errors: ctx.errors, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ scenario: name, pass: false, threw: String(e).slice(0, 300), errors: ctx?.errors, ms: Date.now() - t0 });
  } finally {
    if (ctx) await L.closeApp(ctx.app);
  }
  console.log(JSON.stringify(results[results.length - 1]));
}
L.cleanupTmp();
console.log(JSON.stringify({ exe: L.EXE, summary: results.map((r) => `${r.pass ? 'PASS' : 'FAIL'} ${r.scenario}`) }));
process.exit(0);
