// bench/electron/r4-rel-switch.mjs — fix-release (round 4): turns 预览可编辑 on in a desktop test instance.
//
// Release decision for 0.2.0 (CONTRACT §11): without the test hooks (the candidate directory, a packaged app:
// a production renderer, no ?perf=1) 预览可编辑 is OFF until the user turns it on. A desktop script that clicks
// into the preview and expects an editing session turns it on itself, at its start, through the menu item
// 视图 → 预览可编辑（实验性） (what a user does), and then closes the toggle's toast so it does not sit over the
// window. A build without the switch (0.1.1: no toolbar button) and an instance whose profile already stores
// "1" (a relaunch) are left alone. Returns what it found: 'absent' | 'on' (already) | 'turned-on'.
//
//   import { previewEditOn } from './r4-rel-switch.mjs';   await previewEditOn(app, page);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function previewEditOn(app, page) {
  const pressed = () => page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? null).catch(() => null);
  const now = await pressed();
  if (now === null) return 'absent';
  if (now === 'true') return 'on';
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()?.getMenuItemById('view.togglePreviewEdit')?.click(); });
  for (let i = 0; i < 50 && (await pressed()) !== 'true'; i++) await sleep(100);
  if ((await pressed()) !== 'true') throw new Error('r4-rel-switch: 视图 → 预览可编辑（实验性） did not turn the switch on');
  await page.evaluate(() => {
    for (const t of document.querySelectorAll('.mdr-toast')) if (t.textContent.includes('预览可编辑')) t.querySelector('.mdr-toast__close')?.click();
  }).catch(() => {});
  return 'turned-on';
}
