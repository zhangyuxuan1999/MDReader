// bench/electron/v3-shell-drop.mjs — verify-shell (0.2.0 stage 2c): drops onto the window through CDP
// Input.dispatchDragEvent (the browser's real drag path, not synthetic DOM events): a URL (text/uri-list,
// app:// and https), a non-Markdown FILE (image), a Markdown file, onto the preview, the editor and the
// toolbar. Chromium's default for an unhandled drop is to navigate (unless navigateOnDragDrop is off).
// Counts navigation events and reads the window URL; a probe document must be shown once afterwards.
//   MDR_TARGET=staging|baseline MDR_V2_TMP=<scratch> node bench/electron/v3-shell-drop.mjs
import * as L from './v2-shell-lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const { sleep, check } = L;
L.watchdog(Number(process.env.MDR_TIMEOUT_MS || 200000), 'v3-drop');
const ctx = await L.launch('drop');
const { app } = ctx;
try {
  const page = await L.firstReady(app);
  await app.evaluate(({ BrowserWindow, shell }) => {
    globalThis.__d = { ev: [], ext: [] };
    shell.openExternal = async (u) => { globalThis.__d.ext.push(u); };
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    wc.on('did-start-navigation', (d) => { if (d.isMainFrame) globalThis.__d.ev.push(`start ${d.url}`); });
    wc.on('will-navigate', (e, u) => setImmediate(() => globalThis.__d.ev.push(`will-navigate ${u} ${e.defaultPrevented ? 'PREVENTED' : 'ALLOWED'}`)));
    wc.on('did-navigate', (_e, u) => globalThis.__d.ev.push(`did-navigate ${u}`));
  });
  const base = L.makeDoc('drop-base');
  await L.emitOpen(app, base.file);
  await L.mainShows(app, base);
  const png = path.join(L.TMP, 'v3-drop.png');
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const md = L.makeDoc('drop-md');
  const cdp = await page.context().newCDPSession(page);
  const spots = await page.evaluate(() => {
    const c = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 60) }; };
    return { preview: c('.mdr-preview__body'), editor: c('.cm-content'), toolbar: c('header, .mdr-toolbar, [class*=toolbar]') };
  });
  const payloads = {
    'uri app': { items: [{ mimeType: 'text/uri-list', data: 'app://mdreader/nonexistent.md' }], dragOperationsMask: 1 | 2 | 16 },
    'uri https': { items: [{ mimeType: 'text/uri-list', data: 'https://example.com/v3-drop' }], dragOperationsMask: 1 | 2 | 16 },
    'file png': { items: [], files: [png], dragOperationsMask: 1 | 2 | 16 },
    'file md': { items: [], files: [md.file], dragOperationsMask: 1 | 2 | 16 },
  };
  const bad = [];
  for (const [where, pt] of Object.entries(spots)) {
    if (!pt) continue;
    for (const [what, data] of Object.entries(payloads)) {
      try {
        for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: pt.x, y: pt.y, data });
      } catch (e) { console.log(`  ${where}/${what}: CDP ${String(e.message).slice(0, 120)}`); }
      await sleep(1200);
      // answer a discard question the md drop may raise
      const s = await L.mainSnap(app);
      if ((s.buttons || []).includes('丢弃')) await L.clickBtn(app, '丢弃');
      const r = await app.evaluate(({ BrowserWindow }) => { const x = { ...globalThis.__d, url: BrowserWindow.getAllWindows()[0]?.webContents.getURL() }; globalThis.__d = { ev: [], ext: [] }; return x; });
      const line = `${where}/${what}: ev=${JSON.stringify(r.ev)} ext=${JSON.stringify(r.ext)} url=${r.url} title=${JSON.stringify(s.title)}`;
      console.log(`  ${line}`);
      if (r.url !== 'app://mdreader/index.html' || r.ev.some((e) => /ALLOWED|did-navigate/.test(e))) bad.push(line);
    }
  }
  check('[drop] no drop navigates the window', bad.length === 0, bad.join(' | '));
  const d = L.makeDoc('drop-probe');
  await L.emitOpen(app, d.file);
  const g = await L.waitMain(app, (x) => (x.buttons || []).includes('丢弃'), 2000);
  if (g.ok) await L.clickBtn(app, '丢弃');
  const m = await L.mainShows(app, d, 10000);
  const n = (await L.openSends(app, d.file)).length;
  check('[drop] probe document shown once afterwards', m.ok && n === 1, `${L.describe(m.s)} sends=${n}`);
} catch (e) {
  check('threw', false, String(e && e.stack || e).slice(0, 300));
} finally {
  await L.hardQuit(ctx);
  const f = L.summary();
  await L.cleanup();
  process.exit(f ? 1 : 0);
}
