// bench/verify/v4-sesb-race.mjs — verify-session-b: U20 (H8) when the released block mounts TWICE: the session typed
// a character whose HTML is still on its way when a Shift-click (or a short drag) ends the session, so the release
// mounts the held, older HTML first (restoreKept runs on it) and the newest HTML a moment later. The worker's HTML
// answers are delayed by MDR_DELAY ms (default 250; a stand-in for a slow worker: a large document). Then ⌘C: the
// copy must equal the 0.1.1 baseline's for the same gesture on the candidate's final source.
// Run (both servers up, see v4-sesb-drag.mjs): node bench/verify/v4-sesb-race.mjs [name-filter]
import { sleep, globalTimeout, J, check, summary, openAt, runSteps, copied, selFacts, prepare, requireServer, view } from './v4-sesb-lib.mjs';

const filter = process.argv[2] || '';
const CP = Number(process.env.MDR_PORT || 5432), BP = Number(process.env.MDR_BASE_PORT || 5442);
const DELAY = Number(process.env.MDR_DELAY || 250);
await requireServer(CP); await requireServer(BP, true);
const DOC = 'First para alpha words here.\n\nSecond para beta words here.\n\nThird para gamma words here.\n\nLast para omega.\n';
async function slowHtml(page, on) {
  await page.evaluate(({ on, ms }) => {
    const pv = window.__mdr.app.preview;
    if (!window.__origHtml) { window.__origHtml = pv.applyHtml.bind(pv); pv.applyHtml = (m) => { if (window.__delayHtml) setTimeout(() => window.__origHtml(m), window.__delayHtml); else window.__origHtml(m); }; }
    window.__delayHtml = on ? ms : 0;
  }, { on, ms: DELAY });
}
/** Counts mounts of the block holding `needle` (childList replacements of its wrapper). */
async function watchMounts(page, needle) {
  await page.evaluate((needle) => {
    const s = Array.from(document.querySelectorAll('.mdr-preview section.md-block')).find((x) => x.textContent.includes(needle));
    window.__mounts = [];
    window.__mo?.disconnect();
    window.__mo = new MutationObserver((rs) => { for (const r of rs) if (r.target === s && r.removedNodes.length) window.__mounts.push(Math.round(performance.now()) + ' ' + s.textContent.slice(0, 40)); });
    if (s) window.__mo.observe(s, { childList: true });
  }, needle);
}
const C = [];
const def = (name, steps) => C.push({ name, steps });
// the first typed character's HTML arrives (held) before the second is typed; the Shift-click follows at once
def('typed-then-shift-click-fwd', [['click', ['beta words', 9, 'right']], ['type', 'A', { after: DELAY + 250 }], ['type', 'B'], ['shift', ['gamma', 2], { after: DELAY * 3 + 400 }]]);
def('typed-then-shift-click-bwd', [['click', ['beta words', 9, 'right']], ['type', 'A', { after: DELAY + 250 }], ['type', 'B'], ['shift', ['alpha', 2], { after: DELAY * 3 + 400 }]]);
def('typed-then-short-drag', [['click', ['beta words', 9, 'right']], ['type', 'A', { after: DELAY + 250 }], ['type', 'B'], ['drag', ['para beta', 2], ['gamma', 2], { steps: 3, gap: 5, after: DELAY * 3 + 400 }]]);
def('control-no-typing-shift-click', [['click', ['beta words', 9, 'right']], ['wait', 300], ['shift', ['gamma', 2], { after: DELAY * 3 + 400 }]]);

const out = [];
let A = null, Bs = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 110_000), async () => { await A?.close(); await Bs?.close(); });
try {
  A = await openAt(CP, false);
  Bs = await openAt(BP, true);
  for (const c of C) {
    if (filter && !c.name.includes(filter)) continue;
    try {
      await slowHtml(A.page, false);
      await prepare(A, DOC);
      await watchMounts(A.page, 'beta');
      await slowHtml(A.page, true);
      await runSteps(A.page, c.steps);
      const sa = await selFacts(A.page);
      const cpA = await copied(A.page);
      const mounts = await A.page.evaluate(() => window.__mounts);
      await slowHtml(A.page, false);
      await A.page.keyboard.press('Escape'); await A.settle(150);
      const srcA = await A.source();
      await prepare(Bs, srcA);
      await runSteps(Bs.page, c.steps, { baseline: true });
      const cpB = await copied(Bs.page);
      check(c.name, cpA === cpB, `cand=${J(cpA)} base=${J(cpB)} mounts=${J(mounts)} candSel=${J({ ...sa, text: undefined })}`);
      out.push({ name: c.name, cpA, cpB });
    } catch (e) { check(c.name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  summary();
} finally { stop(); await A?.close(); await Bs?.close(); }
process.exitCode = out.some((o) => o.cpA !== o.cpB) || out.length === 0 ? 1 : 0;
