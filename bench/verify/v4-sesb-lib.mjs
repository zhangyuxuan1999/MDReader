// bench/verify/v4-sesb-lib.mjs — verify-session-b (0.2.0 stage 2d, round-3 re-verification) shared helpers for
// bench/verify/v4-sesb-*.mjs. Wraps v3-ses-lib.mjs (never kills the port at exit). Defaults: MDR_PORT=5432
// (candidate dev server), MDR_SCRATCH = this session's scratchpad/v4-sesb. The 0.1.1 baseline renderer is served by
//   npx vite preview --outDir release/baseline-0.1.1.noindex/dist --port 5442 --strictPort
// and opened with ?perf=1 (MDR_PERF=1). Writes nothing into the tree.
process.env.MDR_PORT = process.env.MDR_PORT || '5432';
process.env.MDR_SCRATCH = process.env.MDR_SCRATCH || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v4-sesb';
const L = await import('./v3-ses-lib.mjs');
export const { openB, sleep, globalTimeout, J, check, summary, view, shownText, pointOf, clickText, loadDocAny, results, BASE, PORT, SCRATCH, rng } = L;
import { mkdirSync } from 'node:fs';
mkdirSync(SCRATCH, { recursive: true });

/** Makes sure a server answers on `port`: when nothing does, a detached one is started and left running (stop it
 *  with: lsof -ti tcp:<port> | xargs kill). `baseline`: the 0.1.1 production renderer (vite preview of
 *  release/baseline-0.1.1.noindex/dist), else the candidate tree's dev server. */
export async function requireServer(port = PORT, baseline = false) {
  const up = async () => { try { return (await fetch(`http://localhost:${port}/`)).ok; } catch { return false; } };
  if (await up()) return;
  const { spawn } = await import('node:child_process');
  const { openSync } = await import('node:fs');
  const root = new URL('../..', import.meta.url).pathname;
  const out = openSync(`${SCRATCH}/vite-${port}.log`, 'a');
  const args = baseline
    ? ['vite', 'preview', '--outDir', `${root}release/baseline-0.1.1.noindex/dist`, '--port', String(port), '--strictPort']
    : ['vite', '--port', String(port), '--strictPort'];
  const p = spawn('npx', args, { cwd: root, detached: true, stdio: ['ignore', out, out], env: { ...process.env, BROWSER: 'none' } });
  p.unref();
  console.log(`started ${baseline ? 'baseline vite preview' : 'vite'} on ${port} (pid ${p.pid}); stop: lsof -ti tcp:${port} | xargs kill`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) { if (await up()) return; await sleep(250); }
  console.log(`nothing answers on ${port}`);
  process.exit(2);
}

export const isBaseline = () => !!process.env.MDR_PERF;

export async function copied(page) {
  await page.evaluate(() => navigator.clipboard.writeText('<<none>>'));
  await page.keyboard.press('Meta+c');
  await sleep(150);
  return page.evaluate(() => navigator.clipboard.readText());
}

/** Centre of the first element matching `css` inside the preview. */
export async function pointOfSel(page, css, fx = 0.5) {
  return page.evaluate(({ css, fx }) => {
    const root = document.querySelector('.mdr-preview');
    const e = root.querySelector(css);
    if (!e) return null;
    let r = e.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    if (r.top < box.top + 10 || r.bottom > box.bottom - 10) { root.scrollTop += r.top - (box.top + box.height / 2); r = e.getBoundingClientRect(); }
    return { x: r.left + r.width * fx, y: r.top + r.height / 2 };
  }, { css, fx });
}

/** A point given as [needle, k, side] or {css, fx} or {x, y}. */
export async function pt(page, p) {
  if (Array.isArray(p)) { const q = await pointOf(page, p[0], p[1] ?? 0, p[2] ?? 'left'); if (!q) throw new Error(`not shown: ${p[0]}`); return q; }
  if (p.css) { const q = await pointOfSel(page, p.css, p.fx ?? 0.5); if (!q) throw new Error(`no element ${p.css}`); return q; }
  return p;
}

/**
 * Runs one gesture script. Steps:
 *   ['click', P, {clickCount, hold}]   ['shift', P]   ['type', text] (candidate only unless {always})
 *   ['drag', P, P2, {via: P3, steps, clickCount, outside}]   ['key', name]   ['wait', ms]   ['paste', text]
 * P = [needle, k, side] | {css, fx} | {x, y}.
 */
export async function runSteps(page, steps, { baseline = false } = {}) {
  for (const st of steps) {
    const [op, a, b, c] = st;
    if (op === 'click') {
      const p = await pt(page, a);
      const o = b || {};
      await page.mouse.move(p.x, p.y);
      for (let n = 1; n <= (o.clickCount ?? 1); n++) {
        await page.mouse.down({ clickCount: n });
        if (o.hold) await sleep(o.hold);
        await page.mouse.up({ clickCount: n });
      }
      await sleep(o.after ?? 350);
    } else if (op === 'shift') {
      const p = await pt(page, a);
      await page.keyboard.down('Shift'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Shift');
      await sleep(b?.after ?? 350);
    } else if (op === 'type') {
      if (baseline && !(b && b.always)) continue;
      await page.keyboard.type(a);
      if (b?.after !== undefined) await sleep(b.after);
    } else if (op === 'paste') {
      if (baseline) continue;
      await page.evaluate((t) => navigator.clipboard.writeText(t), a);
      await page.keyboard.press('Meta+v');
      await sleep(b?.after ?? 300);
    } else if (op === 'key') {
      if (baseline && b?.candOnly) continue;
      await page.keyboard.press(a);
      await sleep(b?.after ?? 200);
    } else if (op === 'wait') {
      await sleep(a);
    } else if (op === 'drag') {
      const o = c || {};
      const p1 = await pt(page, a);
      const p2 = o.outside ? { x: 700, y: -30 } : await pt(page, b);
      const via = o.via ? await pt(page, o.via) : null;
      const steps = o.steps ?? 14;
      await page.mouse.move(p1.x, p1.y);
      const cc = o.clickCount ?? 1;
      for (let n = 1; n < cc; n++) { await page.mouse.down({ clickCount: n }); await page.mouse.up({ clickCount: n }); }
      await page.mouse.down({ clickCount: cc });
      const legs = via ? [[p1, via], [via, p2]] : [[p1, p2]];
      for (const [f, t] of legs) {
        for (let i = 1; i <= steps; i++) { await page.mouse.move(f.x + (t.x - f.x) * i / steps, f.y + (t.y - f.y) * i / steps); await sleep(o.gap ?? 15); }
      }
      await page.mouse.up({ clickCount: cc });
      await sleep(o.after ?? 600);
    } else throw new Error('unknown step ' + op);
  }
}

/** Selection facts of the page right now. */
export async function selFacts(page) {
  return page.evaluate(() => {
    const s = getSelection();
    const d = (n) => (n ? (n.nodeType === 3 ? `#text"${n.data.slice(0, 12)}"` : n.nodeName + (n.dataset?.id ? `[${n.dataset.id}]` : '')) : null);
    return { text: s.toString(), anchor: d(s.anchorNode), aOff: s.anchorOffset, focus: d(s.focusNode), fOff: s.focusOffset, collapsed: s.isCollapsed };
  });
}

export async function prepare(B, doc) {
  const { page } = B;
  await page.evaluate(() => { window.__mdr.app.preview.setPreviewEditable?.(true); getSelection().removeAllRanges(); });
  await loadDocAny(B, doc);
  await sleep(500);
  // the ?perf=1 HUD of the baseline build overlays the preview: out of the way
  await page.evaluate(() => { for (const h of document.querySelectorAll('.mdr-perf')) h.style.display = 'none'; document.querySelector('.mdr-preview').scrollTop = 0; });
  await sleep(150);
}

import { chromium } from '@playwright/test';
/** A page on `port` (perf: open with ?perf=1, for the production build of the 0.1.1 baseline), clipboard granted. */
export async function openAt(port, perf = false, opts = {}) {
  const origin = `http://localhost:${port}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1400, height: 900 }, colorScheme: 'light' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await context.newPage();
  const pageErrors = [], consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack : e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const url = `${origin}/?mode=split${perf ? '&perf=1' : ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* */ } });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  await sleep(400);
  const settle = async (ms = 250) => { await sleep(ms); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(60); };
  const source = () => page.evaluate(() => window.__mdr.app.getText());
  const close = async () => { try { await browser.close(); } catch { /* */ } };
  return { browser, context, page, pageErrors, consoleErrors, settle, source, close, port, perf };
}
