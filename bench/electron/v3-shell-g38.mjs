// bench/electron/v3-shell-g38.mjs — verify-shell (0.2.0 stage 2c): variations of r1 G38 (⌘Q while the
// dirty-close question is up and the window minimised / the app hidden does nothing visible).
// ⌘Q = app.quit() (what the 退出 menu item, the Dock's 退出 and a logout do).
//   MDR_TARGET=staging|baseline MDR_V2_TMP=<scratch> node bench/electron/v3-shell-g38.mjs [case ...]
// Cases:
//   hiddenFirstQuit   dirty, app hidden, NO question yet, ⌘Q        → question visible (app unhidden) or quit
//   minHiddenQuit     question from ⌘W, window minimised AND app hidden, ⌘Q → question visible
//   quitQuestionMin   question from ⌘Q, window minimised, ⌘Q again → question visible
//   minFirstQuit      dirty, minimised, NO question yet, ⌘Q        → question visible
//   cancelThenClose   question from ⌘W, hidden, ⌘Q, 取消, then ⌘W + 不保存 → window closes, app does NOT quit
//   quitThenDiscard   question from ⌘W, hidden, ⌘Q, 不保存          → the app quits (exit 0)
import * as L from './v2-shell-lib.mjs';

const { sleep, check } = L;
L.watchdog(Number(process.env.MDR_TIMEOUT_MS || 300000), 'v3-g38');

const state = (app) => app.evaluate(({ BrowserWindow, app: a }) => {
  const ws = BrowserWindow.getAllWindows();
  const w = ws[0];
  return { windows: ws.length, min: w?.isMinimized(), vis: w?.isVisible(), hidden: a.isHidden?.() };
});
const visibleQ = async (app) => {
  const st = await state(app);
  const s = await L.mainSnap(app);
  return { ok: st.windows === 1 && st.vis && !st.min && st.hidden !== true && (s.buttons || []).includes('不保存'), st, buttons: s.buttons };
};

async function withApp(name, fn) {
  const ctx = await L.launch(name);
  let exit = null;
  ctx.app.process().once('exit', (code, signal) => { exit = { code, signal }; });
  try {
    await L.firstReady(ctx.app);
    const d = L.makeDoc(`g38-${name}`);
    await L.emitOpen(ctx.app, d.file);
    await L.mainShows(ctx.app, d);
    await L.makeDirty(ctx.app, `DIRTY-${name}`);
    await fn(ctx.app, () => exit);
  } catch (e) {
    check(`[g38] ${name} threw`, false, String(e && e.message).slice(0, 300));
  } finally {
    await L.hardQuit(ctx);
  }
}
const quit = (app) => app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 10); });
const closeWin = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
const qUp = (app) => L.waitMain(app, (s) => (s.buttons || []).includes('不保存'), 8000);

const CASES = {
  async hiddenFirstQuit() {
    await withApp('hiddenFirstQuit', async (app, ex) => {
      await app.evaluate(({ app: a }) => a.hide());
      await sleep(1000);
      const pre = await state(app);
      await quit(app);
      await sleep(2000);
      const v = ex() ? null : await visibleQ(app);
      check('[g38] dirty + app hidden, no question yet, ⌘Q: the question is visible (or the app quit)', !!ex() || v.ok, `pre=${JSON.stringify(pre)} exit=${JSON.stringify(ex())} post=${JSON.stringify(v)}`);
    });
  },
  async minHiddenQuit() {
    await withApp('minHiddenQuit', async (app, ex) => {
      await closeWin(app);
      const q = await qUp(app);
      await app.evaluate(({ BrowserWindow, app: a }) => { BrowserWindow.getAllWindows()[0].minimize(); setTimeout(() => a.hide(), 600); });
      await sleep(1800);
      const pre = await state(app);
      await quit(app);
      await sleep(2000);
      const v = ex() ? null : await visibleQ(app);
      check('[g38] question (⌘W) + minimised + hidden, ⌘Q: the question is visible', q.ok && (!!ex() || v.ok), `pre=${JSON.stringify(pre)} exit=${JSON.stringify(ex())} post=${JSON.stringify(v)}`);
    });
  },
  async quitQuestionMin() {
    await withApp('quitQuestionMin', async (app, ex) => {
      await quit(app);
      const q = await qUp(app);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      await sleep(1200);
      const pre = await state(app);
      await quit(app);
      await sleep(2000);
      const v = ex() ? null : await visibleQ(app);
      check('[g38] question (⌘Q) + minimised, ⌘Q again: the question is visible', q.ok && (!!ex() || v.ok), `pre=${JSON.stringify(pre)} exit=${JSON.stringify(ex())} post=${JSON.stringify(v)}`);
    });
  },
  async minFirstQuit() {
    await withApp('minFirstQuit', async (app, ex) => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      await sleep(1200);
      await quit(app);
      await sleep(2000);
      const v = ex() ? null : await visibleQ(app);
      check('[g38] dirty + minimised, no question yet, ⌘Q: the question is visible', !!ex() || v.ok, `exit=${JSON.stringify(ex())} post=${JSON.stringify(v)}`);
    });
  },
  async cancelThenClose() {
    await withApp('cancelThenClose', async (app, ex) => {
      await closeWin(app);
      await qUp(app);
      await app.evaluate(({ app: a }) => a.hide());
      await sleep(1000);
      await quit(app);
      await sleep(1500);
      const c = await L.clickBtn(app, '取消');
      await sleep(800);
      await closeWin(app);
      const q2 = await qUp(app);
      await L.clickBtn(app, '不保存');
      await sleep(2500);
      const st = ex() ? null : await state(app);
      check('[g38] question + hidden + ⌘Q, 取消, then ⌘W + 不保存: the window closes and the app stays (no leftover quit)', c && q2.ok && !ex() && st && st.windows === 0,
        `exit=${JSON.stringify(ex())} post=${JSON.stringify(st)}`);
    });
  },
  async quitThenDiscard() {
    await withApp('quitThenDiscard', async (app, ex) => {
      await closeWin(app);
      await qUp(app);
      await app.evaluate(({ app: a }) => a.hide());
      await sleep(1000);
      await quit(app);
      await sleep(1500);
      const v = await visibleQ(app);
      await L.clickBtn(app, '不保存');
      for (let i = 0; i < 40 && !ex(); i++) await sleep(150);
      check('[g38] question + hidden + ⌘Q, then 不保存: the question was visible and the app quits cleanly', v.ok && !!ex() && ex().code === 0,
        `visible=${JSON.stringify(v)} exit=${JSON.stringify(ex())}`);
    });
  },
};

const pick = process.argv.slice(2);
console.log(`target: ${L.TARGET} ${L.APP_DIR}`);
try {
  for (const n of pick.length ? pick : Object.keys(CASES)) await CASES[n]();
} finally {
  const f = L.summary();
  await L.cleanup();
  process.exit(f ? 1 : 0);
}
