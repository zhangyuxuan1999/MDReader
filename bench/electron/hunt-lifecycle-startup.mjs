// bench/electron/hunt-lifecycle-startup.mjs — hunt:lifecycle, cold start / new-window timing / draft races.
//   node bench/electron/hunt-lifecycle-startup.mjs [scenario ...]     (default: all; ~90 s, run in background)
//   MDR_EXE=/path/to/MDReader node bench/electron/hunt-lifecycle-startup.mjs
import * as L from './hunt-lifecycle-lib.mjs';

L.watchdog(Number(process.env.MDR_HUNT_TIMEOUT || 115000));
const dir = L.tmpDir('mdr-hunt-docs-');
const A = L.writeDoc(dir, 'hunt-a.md', 3);
const B = L.writeDoc(dir, 'hunt-b.md', 5);
const mk = (d) => ({ marker: `标题 ${d.name} ${d.blocks / 2}` });
const isDoc = (s, d) => !!s && s.title?.includes(d.name) && s.matchesExpected === true && s.editorChars === d.length;

async function seedDrafts(prof, { untitled = false, target = null } = {}) {
  const { app } = await L.launch({ profile: prof });
  try {
    const w = await L.readyWindow(app);
    await L.sleep(600);
    const out = {};
    if (untitled) {
      await L.typeInEditor(w, 'untitled-draft-text');
      await L.sleep(1800);
      out.untitled = (await L.snap(w)).status.includes('草稿已存');
    }
    if (target) {
      if (untitled) { // the guard: 丢弃 keeps the untitled draft in IndexedDB
        await L.emitOpen(app, target.path); await L.sleep(600); await L.clickDialog(w, '丢弃');
      } else await L.emitOpen(app, target.path);
      await L.waitTitle(w, target.name);
      await L.sleep(500);
      await L.typeInEditor(w, 'target-draft-text');
      await L.sleep(1800);
      out.target = (await L.snap(w)).status.includes('草稿已存');
    }
    return out;
  } finally { await L.closeApp(app); }
}

async function withApp(opts, fn) {
  const ctx = await L.launch(opts);
  await L.instrumentSends(ctx.app).catch(() => {}); // no WebContents yet on a very early call
  try { return { ...(await fn(ctx)), errors: ctx.errors }; } finally { await L.closeApp(ctx.app); }
}

const delayScenario = (d) => async () => withApp({}, async ({ app }) => {
  const w0 = await L.readyWindow(app);
  await L.sleep(700);
  await L.instrumentSends(app);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await L.sleep(800);
  const p = app.waitForEvent('window', { timeout: 8000 });
  await app.evaluate(({ app: a }, [fp, ms]) => {
    a.emit('activate', { preventDefault() {} }, false); // Dock click → createWindow()
    if (ms === 0) a.emit('open-file', { preventDefault() {} }, fp);
    else setTimeout(() => a.emit('open-file', { preventDefault() {} }, fp), ms);
  }, [A.path, d]);
  const w = await p;
  await w.waitForSelector('.cm-content', { timeout: 15000 });
  await L.sleep(2000 + d);
  const s = await L.snap(w, mk(A));
  return { expected: `${A.name} (open-file ${d} ms after createWindow)`, actual: { snap: s, sends: await L.sends(app) }, pass: isDoc(s, A) };
});

const S = {
  coldOneArg: () => withApp({ args: [A.path] }, async ({ app }) => {
    const w = await L.readyWindow(app);
    await L.waitTitle(w, A.name);
    await L.sleep(1500);
    const s = await L.snap(w, mk(A));
    return { expected: A.name, actual: { snap: s }, pass: isDoc(s, A) };
  }),
  coldTwoArgs: () => withApp({ args: [A.path, B.path] }, async ({ app }) => {
    const w = await L.readyWindow(app);
    await L.sleep(2500);
    const s = await L.snap(w, mk(B));
    return { expected: `${B.name} last (A then B)`, actual: { snap: s, sends: await L.sends(app) }, pass: isDoc(s, B) };
  }),
  coldRelativeArg: () => withApp({ args: [A.name], cwd: dir }, async ({ app }) => {
    const w = await L.readyWindow(app);
    await L.sleep(2000);
    const s = await L.snap(w, mk(A));
    return { expected: A.name, actual: { snap: s }, pass: isDoc(s, A) };
  }),
  coldOpenFileEarly: () => withApp({}, async ({ app }) => {
    // As early as Playwright can reach the main process (Finder cold launch delivers the Apple event about here).
    await L.emitOpen(app, A.path);
    const w = await L.readyWindow(app);
    await L.sleep(2000);
    const s = await L.snap(w, mk(A));
    return { expected: A.name, actual: { snap: s }, pass: isDoc(s, A) };
  }),
  newWindow0ms: delayScenario(0),
  newWindow50ms: delayScenario(50),
  newWindow150ms: delayScenario(150),
  newWindow400ms: delayScenario(400),
  newWindow1000ms: delayScenario(1000),
  async draftUntitledColdArg() {
    const prof = L.tmpDir('mdr-hunt-prof-');
    const seeded = await seedDrafts(prof, { untitled: true });
    return withApp({ profile: prof, args: [A.path] }, async ({ app }) => {
      const w = await L.readyWindow(app);
      await L.waitTitle(w, A.name);
      await L.sleep(1500);
      const s = await L.snap(w, mk(A));
      return { expected: `${A.name}, no untitled-draft offer over it`, actual: { seeded, snap: s }, pass: isDoc(s, A) && s.toasts.length === 0 };
    });
  },
  async draftTargetColdArg() {
    const prof = L.tmpDir('mdr-hunt-prof-');
    const seeded = await seedDrafts(prof, { target: A });
    return withApp({ profile: prof, args: [A.path] }, async ({ app }) => {
      const w = await L.readyWindow(app);
      await L.waitTitle(w, A.name);
      await L.sleep(1500);
      const s = await L.snap(w, mk(A));
      return { expected: `${A.name} disk text (${A.length} chars) + a restore offer, not auto-replaced`, actual: { seeded, snap: s }, pass: isDoc(s, A) && s.toasts.some((t) => t.includes('草稿')) };
    });
  },
  async draftBothOpenDelays() {
    const prof = L.tmpDir('mdr-hunt-prof-');
    const seeded = await seedDrafts(prof, { untitled: true, target: A });
    const out = [];
    for (const d of [0, 150, 400, 800]) {
      const r = await withApp({ profile: prof }, async ({ app }) => {
        const w = await L.readyWindow(app);
        await L.sleep(d);
        await L.emitOpen(app, A.path);
        await L.waitTitle(w, A.name);
        await L.sleep(1500);
        const s = await L.snap(w, mk(A));
        return { d, ok: isDoc(s, A), title: s.title, chars: s.editorChars, toasts: s.toasts, dialogs: s.dialogs };
      });
      out.push(r);
    }
    return { expected: `${A.name} every time, only its own draft offered`, actual: { seeded, runs: out }, pass: out.every((r) => r.ok && r.toasts.length === 1) };
  },
  async draftUntitledRestoreClickedBeforeLaunchDoc() {
    // Untitled draft offer appears 400 ms after boot; the user clicks 恢复; then the double-clicked doc arrives.
    const prof = L.tmpDir('mdr-hunt-prof-');
    const seeded = await seedDrafts(prof, { untitled: true });
    return withApp({ profile: prof }, async ({ app }) => {
      const w = await L.readyWindow(app);
      await w.waitForSelector('.mdr-toast', { timeout: 5000 }).catch(() => {});
      const t = await L.snap(w);
      await w.evaluate(() => { const b = [...document.querySelectorAll('.mdr-toast button')].find((x) => x.textContent.trim() === '恢复'); b?.click(); });
      await L.sleep(500);
      const restored = await L.snap(w);
      await L.emitOpen(app, A.path);
      await L.sleep(900);
      const s = await L.snap(w);
      return { expected: 'restored draft is dirty → the guard asks before loading A', actual: { seeded, toastBefore: t.toasts, restored: { title: restored.title, chars: restored.editorChars }, afterOpen: s }, pass: s.dialogs.length === 1 };
    });
  },
};

const pick = process.argv.slice(2);
const names = pick.length ? pick : Object.keys(S);
const results = [];
for (const name of names) {
  const t0 = Date.now();
  try {
    const r = await S[name]();
    results.push({ scenario: name, ...r, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ scenario: name, pass: false, threw: String(e).slice(0, 300), ms: Date.now() - t0 });
  }
  console.log(JSON.stringify(results[results.length - 1]));
}
await L.closeAll();
L.cleanupTmp();
console.log(JSON.stringify({ exe: L.EXE, summary: results.map((r) => `${r.pass ? 'PASS' : 'FAIL'} ${r.scenario}`) }));
process.exit(0);
