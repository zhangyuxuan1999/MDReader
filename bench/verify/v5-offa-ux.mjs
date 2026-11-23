// bench/verify/v5-offa-ux.mjs — verify-off-app: bench/verify/ux/lib.mjs for the fx scenarios run against a
// PRODUCTION build: every navigation gets ?perf=1 added before the app's module runs (history.replaceState in an
// init script) and mdr.previewEdit = "0" stored (the switch off, hooks on). Used by the copies that
// bench/verify/v5-offa-fx.mjs generates. Starts nothing.
import * as U from './ux/lib.mjs';
export * from './ux/lib.mjs';
export async function launch(opts = {}) {
  const r = await U.launch(opts);
  await r.context.addInitScript(() => {
    try { localStorage.setItem('mdr.previewEdit', '0'); } catch {}
    try { if (!/[?&]perf=1/.test(location.search)) history.replaceState(history.state, '', location.pathname + (location.search ? location.search + '&perf=1' : '?perf=1') + location.hash); } catch {}
  });
  return r;
}
