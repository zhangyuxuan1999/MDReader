// bench/electron/v3-shell-mailto.mjs — verify-shell (0.2.0 stage 2c): do mailto: / tel: links of a
// document open outside the app on the desktop (CONTRACT S3: "only http, https, mailto and tel open
// externally")? Counts shell.openExternal (stubbed) AND Chromium's native external-protocol path (the
// 'openExternal' permission request, answered "deny" so no mail / phone app ever opens).
//   MDR_TARGET=staging|baseline MDR_V2_TMP=<scratch> node bench/electron/v3-shell-mailto.mjs
import * as L from './v2-shell-lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const { sleep, check } = L;
L.watchdog(Number(process.env.MDR_TIMEOUT_MS || 150000), 'v3-mailto');
const LINKS = [
  ['md-mailto', '[MD-MAILTO](mailto:v3a@example.com)'],
  ['autolink-mailto', '<v3b@example.com>'],
  ['raw-mailto', '<a href="mailto:v3c@example.com">RAW-MAILTO</a>'],
  ['md-tel', '[MD-TEL](tel:+4912345)'],
  ['md-https', '[MD-HTTPS](https://example.com/v3-m)'],
];
const ctx = await L.launch('mailto');
const { app } = ctx;
let code = 1;
try {
  const page = await L.firstReady(app);
  await app.evaluate(({ shell, session, BrowserWindow }) => {
    globalThis.__m = { ext: [], perm: [], nav: [] };
    shell.openExternal = async (u) => { globalThis.__m.ext.push(String(u)); };
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) => {
      if (perm === 'openExternal') globalThis.__m.perm.push(String(details && details.externalURL));
      cb(false);
    });
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    wc.on('will-navigate', (_e, u) => globalThis.__m.nav.push(u));
  });
  const file = path.join(L.TMP, 'v3-mailto.md');
  fs.writeFileSync(file, `# 标题 mailto\n\n${LINKS.map(([, md]) => `段落 ${md} 尾`).join('\n\n')}\n`, 'utf8');
  await L.emitOpen(app, file);
  await L.waitMain(app, (s) => (s.title || '').includes('v3-mailto'), 8000);
  await sleep(1200);
  // in-preview editing off, so a plain click follows the link in both builds
  const editOn = await page.evaluate(() => !!document.querySelector('[data-cmd="view.togglePreviewEdit"][aria-pressed="true"], button[aria-pressed="true"][title*="预览可编辑"]'));
  if (editOn) { await L.menuClick(app, 'view.togglePreviewEdit'); await sleep(400); }
  const rows = [];
  for (const [id, md] of LINKS) {
    const txt = md.match(/\[([^\]]+)\]|>([^<]+)<|<([^>]+)>/).slice(1).find(Boolean);
    const b = await page.evaluate((t) => {
      const a = [...document.querySelectorAll('.mdr-preview__body a')].find((x) => x.textContent.trim() === t);
      if (!a) return null;
      a.scrollIntoView({ block: 'center' });
      const r = a.getBoundingClientRect();
      return { x: r.left + 4, y: r.top + r.height / 2, href: a.getAttribute('href'), target: a.getAttribute('target') };
    }, txt);
    if (!b) { rows.push(`${id}: link not found (${txt})`); continue; }
    await sleep(700);
    await page.mouse.click(b.x, b.y, { modifiers: ['Meta'] }).catch(() => {});
    await page.keyboard.down('Meta'); await page.mouse.click(b.x, b.y); await page.keyboard.up('Meta');
    await sleep(800);
    const m = await app.evaluate(() => { const r = globalThis.__m; globalThis.__m = { ext: [], perm: [], nav: [] }; return r; });
    rows.push(`${id} [href=${b.href} target=${b.target}] ext=${JSON.stringify(m.ext)} nativeExternal=${JSON.stringify(m.perm)} will-navigate=${JSON.stringify(m.nav)}`);
  }
  for (const r of rows) console.log(`  ${r}`);
  const opened = (id) => rows.find((r) => r.startsWith(id)) || '';
  const mailOk = ['md-mailto', 'autolink-mailto', 'raw-mailto', 'md-tel'].every((id) => /ext=\["(mailto|tel):|nativeExternal=\["(mailto|tel):/.test(opened(id)));
  check('[mailto] (⌘-)clicked mailto / tel links reach the system (shell.openExternal or the native external-protocol path)', mailOk, '');
  code = 0;
} catch (e) {
  check('threw', false, String(e && e.stack || e).slice(0, 300));
} finally {
  await L.hardQuit(ctx);
  const f = L.summary();
  await L.cleanup();
  process.exit(f || code ? 1 : 0);
}
