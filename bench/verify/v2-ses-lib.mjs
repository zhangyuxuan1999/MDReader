// bench/verify/v2-ses-lib.mjs — verify-session (0.2.0 stage 2a) shared helpers for bench/verify/v2-ses-*.mjs.
// Reuses inline-verify-lib.mjs's page helpers but NEVER kills the port at exit (several v2-ses scripts share one
// Vite on MDR_PORT, default 5282). If nothing answers on the port, a detached Vite is started and left running
// (stop it with: lsof -ti tcp:5282 | xargs kill). Writes nothing into the tree.
process.env.MDR_PORT = process.env.MDR_PORT || '5282';
const lib = await import('./inline-verify-lib.mjs');
process.removeListener('exit', lib.stopServer);
process.removeAllListeners('SIGINT');
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { chromium } from '@playwright/test';

export const { makeHelpers, BASE, PORT, sleep, ROOT, lineDiff, readRoot } = lib;
export const SCRATCH = process.env.MDR_SCRATCH || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v2-ses';

/** Kills the whole process after `ms` (the agent's 120 s per-call bound / background bound). */
export function globalTimeout(ms, cleanup) {
  const t = setTimeout(async () => {
    console.log(`GLOBAL TIMEOUT after ${ms} ms`);
    try { await cleanup?.(); } catch { /* */ }
    process.exit(3);
  }, ms);
  return () => clearTimeout(t);
}

export async function ensureServer() {
  try { if ((await fetch(`${BASE}/`)).ok) return; } catch { /* */ }
  mkdirSync(SCRATCH, { recursive: true });
  const out = openSync(`${SCRATCH}/vite-${PORT}.log`, 'a');
  const p = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: { ...process.env, BROWSER: 'none' } });
  p.unref();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/`)).ok) return; } catch { /* */ }
    await sleep(200);
  }
  throw new Error(`vite not up on ${PORT}`);
}

export async function openB(opts = {}) {
  await ensureServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1400, height: 900 }, colorScheme: 'light' });
  if (opts.clipboard) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await context.newPage();
  const consoleErrors = [], pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack : e)));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const h = makeHelpers(page);
  let cdp = null;
  const getCdp = async () => (cdp ??= await context.newCDPSession(page));
  /** Real IME composition through CDP: intermediate composition strings, then commit. */
  async function ime(steps, commit) {
    const c = await getCdp();
    for (const s of steps) { await c.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length }); await sleep(15); }
    if (commit !== undefined) await c.send('Input.insertText', { text: commit });
  }
  const state = () => page.evaluate(() => {
    const ae = document.activeElement;
    const ed = document.querySelector('.mdr-preview .is-editing');
    const cap = document.querySelector('.mdr-preview__edit-capture');
    return {
      active: ae ? (ae.className || ae.tagName) : null,
      editing: ed ? Number(ed.dataset.id) : null,
      editingText: ed ? ed.textContent : null,
      resuming: window.__mdr.app.preview && typeof window.__mdr.app.preview.isPreviewEditable === 'function' ? undefined : undefined,
      capInDom: !!cap, capFocused: ae === cap,
      scrollTop: document.querySelector('.mdr-preview')?.scrollTop,
    };
  });
  const close = async () => { try { await browser.close(); } catch { /* */ } };
  return { browser, context, page, consoleErrors, pageErrors, ime, getCdp, state, close, ...h };
}

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
}

export const results = { pass: 0, fail: 0, fails: [] };
export function check(name, ok, detail = '') {
  if (ok) results.pass++; else { results.fail++; results.fails.push(name); }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}
export const J = (x) => JSON.stringify(x);
