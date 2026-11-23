// bench/electron/hunt-lifecycle-gestures.mjs — hunt:lifecycle: which user gestures put the app into the
// "window closed, app alive" state that loses the next double-clicked document. Uses the real menu items
// (关闭窗口 = role close ⌘W, 最小化 = role minimize ⌘M, 隐藏 MDReader = role hide ⌘H) and also captures
// what the window shows after a renderer crash.
//   node bench/electron/hunt-lifecycle-gestures.mjs            MDR_EXE=... to target another build
import * as L from './hunt-lifecycle-lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

L.watchdog(Number(process.env.MDR_HUNT_TIMEOUT || 110000));
const dir = L.tmpDir('mdr-hunt-docs-');
const A = L.writeDoc(dir, 'hunt-a.md', 3);
const mk = { marker: `标题 ${A.name} 3` };
const isDoc = (s) => !!s && s.title?.includes(A.name) && s.matchesExpected === true && s.editorChars === A.length;

const roleClick = (app, role) => app.evaluate(({ Menu, BrowserWindow }, r) => {
  const win = BrowserWindow.getAllWindows()[0];
  const find = (items) => { for (const it of items) { if (it.role && it.role.toLowerCase() === r.toLowerCase()) return it; if (it.submenu) { const f = find(it.submenu.items); if (f) return f; } } return null; };
  const item = find(Menu.getApplicationMenu().items);
  if (!item) return 'no item';
  item.click(undefined, win, win?.webContents);
  return 'clicked';
}, role);

async function gesture(role) {
  const { app, errors } = await L.launch();
  try {
    const w = await L.readyWindow(app);
    await L.sleep(700);
    await L.instrumentSends(app);
    const clicked = await roleClick(app, role);
    await L.sleep(1200);
    const before = await L.mainState(app);
    const p = before.windows === 0 ? app.waitForEvent('window', { timeout: 8000 }).catch(() => null) : null;
    await L.emitOpen(app, A.path);
    const nw = p ? await p : w;
    if (nw) await nw.waitForSelector('.cm-content', { timeout: 15000 }).catch(() => {});
    await L.sleep(2500);
    const s = nw ? await L.snap(nw, mk) : null;
    return { scenario: `menuRole:${role}`, clicked, before, after: await L.mainState(app), snap: s, sends: await L.sends(app), pass: isDoc(s), errors };
  } finally { await L.closeApp(app); }
}

async function crashLook() {
  const { app, errors } = await L.launch();
  try {
    const w = await L.readyWindow(app);
    await L.sleep(700);
    await L.emitOpen(app, A.path);
    await L.waitTitle(w, A.name);
    await L.sleep(600);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    await L.sleep(1500);
    const info = await app.evaluate(async ({ BrowserWindow }) => {
      const b = BrowserWindow.getAllWindows()[0];
      let img = null;
      try { const i = await b.capturePage(); const bm = i.toBitmap(); const sz = i.getSize(); let uniq = new Set(); for (let k = 0; k < bm.length; k += 4 * 97) uniq.add(`${bm[k]},${bm[k + 1]},${bm[k + 2]}`); img = { w: sz.width, h: sz.height, distinctSampledColours: uniq.size, png: i.toPNG().toString('base64') }; } catch (e) { img = { error: String(e) }; }
      return { title: b.getTitle(), visible: b.isVisible(), crashed: b.webContents.isCrashed(), img };
    });
    const shot = info.img?.png ? path.join(process.env.MDR_SHOT_DIR || dir, 'after-crash.png') : null;
    if (shot) fs.writeFileSync(shot, Buffer.from(info.img.png, 'base64'));
    if (info.img) delete info.img.png;
    // Does anything bring the renderer back? (Dock click = activate, a new open-file)
    await app.evaluate(({ app: a }) => a.emit('activate', { preventDefault() {} }, true));
    await L.sleep(1500);
    const afterActivate = await L.mainState(app);
    return { scenario: 'rendererCrashLook', info, shot: process.env.MDR_SHOT_DIR ? shot : '(set MDR_SHOT_DIR to keep)', afterActivate, pass: afterActivate.crashed === 0, errors };
  } finally { await L.closeApp(app); }
}

const out = [];
for (const role of ['close', 'minimize', 'hide']) { out.push(await gesture(role)); console.log(JSON.stringify(out[out.length - 1])); }
out.push(await crashLook()); console.log(JSON.stringify(out[out.length - 1]));
await L.closeAll();
L.cleanupTmp();
console.log(JSON.stringify({ exe: L.EXE, summary: out.map((r) => `${r.pass ? 'PASS' : 'FAIL'} ${r.scenario}`) }));
process.exit(0);
