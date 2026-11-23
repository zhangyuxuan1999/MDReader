// bench/electron/v3-shell-queue2.mjs — verify-shell (0.2.0 stage 2c), step 2 continued: cancelled
// page navigations with a DIRTY document and while the dirty-close question is up.
//   MDR_TARGET=staging|baseline MDR_V2_TMP=<scratch> node bench/electron/v3-shell-queue2.mjs [case ...]
// Cases:
//   dirtyDuring     dirty doc; open-file inside did-start-navigation of a cancelled app:// navigation → discard guard → 丢弃 → shown
//   askDuringCancel close question up; open-file inside did-start of a cancelled navigation → held; 取消 → 丢弃 → shown
//   askDuringDiscard close question up; same; 不保存 → window closes and the next window shows the doc
//   askHeldThenNav  close question up; open-file (held); then a cancelled navigation; 取消 → 丢弃 → shown
//   askNavThenOpen  close question up; a cancelled navigation; then open-file → held; 取消 → 丢弃 → shown
//   askQuitNav      quit question up (⌘Q); cancelled navigation; 取消 → app stays; ⌘W + 不保存 → closes, no quit
import * as L from './v2-shell-lib.mjs';

const { sleep, check } = L;
L.watchdog(Number(process.env.MDR_TIMEOUT_MS || 400000), 'v3-queue2');
const NAV = "location.href = 'app://mdreader/nonexistent.md'";

const armDidStart = (app, p) => app.evaluate(({ BrowserWindow, app: a }, fp) => {
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const fn = (d) => { if (!d.isMainFrame || d.isSameDocument) return; wc.removeListener('did-start-navigation', fn); a.emit('open-file', { preventDefault() {} }, fp); };
  wc.on('did-start-navigation', fn);
}, p);
const nav = (app) => L.execMain(app, `(() => { ${NAV}; return 1; })()`).catch(() => {});
const qUp = (app, label = '不保存') => L.waitMain(app, (s) => (s.buttons || []).includes(label), 8000);

async function withApp(name, fn) {
  const ctx = await L.launch(name);
  let exit = null;
  ctx.app.process().once('exit', (code, signal) => { exit = { code, signal }; });
  try {
    await L.firstReady(ctx.app);
    await ctx.app.evaluate(({ shell }) => { shell.openExternal = async () => {}; });
    const base = L.makeDoc(`base-${name}`);
    await L.emitOpen(ctx.app, base.file);
    await L.mainShows(ctx.app, base);
    await L.makeDirty(ctx.app, `DIRTY-${name}`);
    await fn(ctx.app, L.makeDoc(`q2-${name}`), () => exit);
  } catch (e) {
    check(`[q2] ${name} threw`, false, String(e && e.message).slice(0, 300));
  } finally {
    await L.hardQuit(ctx);
  }
}
async function guardThenShown(app, d) {
  const g = await qUp(app, '丢弃');
  if (g.ok) await L.clickBtn(app, '丢弃');
  return { g: g.ok, m: await L.mainShows(app, d, 10000) };
}

const CASES = {
  async dirtyDuring() {
    await withApp('dirtyDuring', async (app, d) => {
      await armDidStart(app, d.file);
      await nav(app);
      const r = await guardThenShown(app, d);
      const n = (await L.openSends(app, d.file)).length;
      check('[q2] dirty doc, open-file inside a cancelled navigation: guard, 丢弃, shown once', r.g && r.m.ok && n === 1, `guard=${r.g} ${L.describe(r.m.s)} sends=${n}`);
    });
  },
  async askDuringCancel() {
    await withApp('askDuringCancel', async (app, d) => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      const q = await qUp(app);
      await armDidStart(app, d.file);
      await nav(app);
      await sleep(800);
      const held = (await L.openSends(app, d.file)).length === 0;
      await L.clickBtn(app, '取消');
      const r = await guardThenShown(app, d);
      const n = (await L.openSends(app, d.file)).length;
      check('[q2] close question, open-file inside a cancelled navigation: held, 取消 → shown once', q.ok && held && r.m.ok && n === 1, `q=${q.ok} held=${held} guard=${r.g} ${L.describe(r.m.s)} sends=${n}`);
    });
  },
  async askDuringDiscard() {
    await withApp('askDuringDiscard', async (app, d, ex) => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      const q = await qUp(app);
      await armDidStart(app, d.file);
      await nav(app);
      await sleep(800);
      await L.clickBtn(app, '不保存');
      await sleep(1500);
      const m = await L.mainShows(app, d, 12000);
      const n = (await L.openSends(app, d.file)).length;
      check('[q2] close question, open-file inside a cancelled navigation, 不保存: the next window shows it once', q.ok && m.ok && n === 1 && !ex(), `q=${q.ok} ${L.describe(m.s)} sends=${n} exit=${JSON.stringify(ex())}`);
    });
  },
  async askHeldThenNav() {
    await withApp('askHeldThenNav', async (app, d) => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      const q = await qUp(app);
      await L.emitOpen(app, d.file);
      await sleep(300);
      await nav(app);
      await sleep(800);
      const held = (await L.openSends(app, d.file)).length === 0;
      await L.clickBtn(app, '取消');
      const r = await guardThenShown(app, d);
      const n = (await L.openSends(app, d.file)).length;
      check('[q2] close question, held doc, then a cancelled navigation: 取消 → shown once', q.ok && held && r.m.ok && n === 1, `q=${q.ok} held=${held} guard=${r.g} ${L.describe(r.m.s)} sends=${n}`);
    });
  },
  async askNavThenOpen() {
    await withApp('askNavThenOpen', async (app, d) => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      const q = await qUp(app);
      await nav(app);
      await sleep(800);
      await L.emitOpen(app, d.file);
      await sleep(800);
      const held = (await L.openSends(app, d.file)).length === 0;
      const stillAsked = (await L.mainSnap(app)).buttons?.includes('不保存');
      await L.clickBtn(app, '取消');
      const r = await guardThenShown(app, d);
      const n = (await L.openSends(app, d.file)).length;
      check('[q2] close question, cancelled navigation, then open-file: held, question kept, 取消 → shown once', q.ok && held && stillAsked && r.m.ok && n === 1, `q=${q.ok} held=${held} asked=${stillAsked} guard=${r.g} ${L.describe(r.m.s)} sends=${n}`);
    });
  },
  async askQuitNav() {
    await withApp('askQuitNav', async (app, _d, ex) => {
      await app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 10); });
      const q = await qUp(app);
      await nav(app);
      await sleep(800);
      await L.clickBtn(app, '取消');
      await sleep(800);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      const q2 = await qUp(app);
      await L.clickBtn(app, '不保存');
      await sleep(2500);
      const ws = ex() ? null : await L.windowsInfo(app);
      check('[q2] quit question, cancelled navigation, 取消; then ⌘W + 不保存: window closes, app does not quit', q.ok && q2.ok && !ex() && ws && ws.length === 0, `q=${q.ok} q2=${q2.ok} exit=${JSON.stringify(ex())} windows=${ws && ws.length}`);
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
