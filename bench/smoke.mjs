// bench/smoke.mjs — end-to-end smoke test in real Chromium (Playwright) against the Vite dev server.
// Usage: node bench/smoke.mjs        (starts `vite --port 5199 --strictPort` itself and kills it at the end)
// Exit code 0 = every check passed; 1 = at least one check failed (details printed).
import { chromium } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5199;
const BASE = `http://localhost:${PORT}`;
const HEADLESS = process.env.HEADED !== '1';

// ---------------------------------------------------------------- tiny assertion harness
const results = [];
let failures = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
async function step(name, fn) {
  try {
    const detail = await fn();
    check(name, true, typeof detail === 'string' ? detail : '');
  } catch (err) {
    check(name, false, err instanceof Error ? err.message : String(err));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- dev server lifecycle
function killPort(port) {
  try {
    const pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
    if (pids) {
      for (const pid of pids.split(/\s+/)) {
        try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ }
      }
      console.log(`[smoke] killed stale listener(s) on :${port}: ${pids.replace(/\s+/g, ', ')}`);
    }
  } catch { /* nothing listening */ }
}

async function startServer() {
  killPort(PORT);
  const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, BROWSER: 'none' },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`vite exited early (${server.exitCode}):\n${log}`);
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) return server;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error(`vite did not come up on :${PORT} within 60 s\n${log}`);
}

function stopServer(server) {
  if (!server) return;
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
  try { server.kill('SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
    killPort(PORT);
  }, 1500).unref();
}

// ---------------------------------------------------------------- page helpers
const lastMark = (name) => `performance.getEntriesByName(${JSON.stringify(name)}).at(-1)?.startTime ?? -1`;

async function waitFirstVisibleAfterOpen(page, timeout = 20_000) {
  await page.waitForFunction(
    () => {
      const open = performance.getEntriesByName('mdr:open').at(-1)?.startTime ?? -1;
      const fv = performance.getEntriesByName('mdr:first-visible').at(-1)?.startTime ?? -1;
      return open >= 0 && fv >= open;
    },
    null,
    { timeout },
  );
  return page.evaluate(() => {
    const open = performance.getEntriesByName('mdr:open').at(-1).startTime;
    const fv = performance.getEntriesByName('mdr:first-visible').at(-1).startTime;
    return fv - open;
  });
}

/** Snapshot of the editor/preview state used by many checks. */
const readState = (page) =>
  page.evaluate(() => {
    const { editor, preview, layout } = window.__mdr.app;
    return {
      mode: layout.getMode(),
      theme: document.documentElement.dataset.theme,
      editorTop: editor.topVisible(),
      previewTop: preview.topVisible(),
      cursorLine: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number,
      blockCount: preview.blockCount(),
      mounted: document.querySelectorAll('.md-block:not(.is-pending)').length,
      wrappers: document.querySelectorAll('.md-block').length,
      tocItems: document.querySelectorAll('.mdr-toc__item').length,
      version: editor.version,
    };
  });

const lineText = (page, line) => page.evaluate((l) => window.__mdr.app.editor.view.state.doc.line(l).text, line);

// ---------------------------------------------------------------- main
const smallMd = readFileSync(resolve(ROOT, 'test-data/small.md'), 'utf8').split('\n');
const H1 = smallMd[0].replace(/^#\s+/, '');
const h2Line = smallMd.findIndex((l) => l.startsWith('## ')) + 1;
const H2 = smallMd[h2Line - 1].replace(/^##\s+/, '');
const paraLine = smallMd.findIndex((l, i) => i > 0 && l.trim() && !/^[#\-*>|`$ ]/.test(l)) + 1;
const taskLine = smallMd.findIndex((l) => /^\s*[-*+] \[ \]/.test(l)) + 1;
const tocTargetLine = smallMd.findIndex((l, i) => i > h2Line && l.startsWith('## ')) + 1;
const tocTargetText = smallMd[tocTargetLine - 1].replace(/^##\s+/, '');
console.log(`[smoke] fixture: h1="${H1}" h2(line ${h2Line})="${H2}" paragraph line ${paraLine}, task line ${taskLine}, toc target line ${tocTargetLine}`);

let server = null;
let browser = null;
try {
  server = await startServer();
  console.log(`[smoke] vite up on ${BASE}`);
  browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error') consoleErrors.push(m.text());
    else if (t === 'warning') consoleWarnings.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack : e)));

  const url = `${BASE}/?doc=/test-data/small.md&mode=split`;

  // Warm-up: the first request lets Vite pre-bundle dependencies (may trigger a reload); then load for real.
  await page.goto(url);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  await sleep(1500);
  consoleErrors.length = 0; consoleWarnings.length = 0; pageErrors.length = 0;
  await page.goto(url);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });

  // ---- 1. open small.md: first-visible, content, TOC, status bar
  await step('open small.md → mdr:first-visible', async () => {
    const ms = await waitFirstVisibleAfterOpen(page);
    return `${ms.toFixed(0)} ms`;
  });
  await sleep(400);
  const s0 = await readState(page);
  await step('preview has mounted .md-block elements with content', async () => {
    if (s0.blockCount <= 0 || s0.mounted <= 0) throw new Error(`blocks=${s0.blockCount} mounted=${s0.mounted}`);
    const nonEmpty = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.md-block:not(.is-pending)')).filter((b) => b.textContent.trim().length > 0).length);
    if (nonEmpty === 0) throw new Error('mounted blocks are empty');
    return `blocks=${s0.blockCount} wrappers=${s0.wrappers} mounted=${s0.mounted}`;
  });
  await step('h1 / h2 text matches the source', async () => {
    const got = await page.evaluate(() => ({
      h1: document.querySelector('.md-block h1')?.textContent?.trim(),
      h2: document.querySelector('.md-block h2')?.textContent?.trim(),
    }));
    if (got.h1 !== H1) throw new Error(`h1: expected "${H1}", got "${got.h1}"`);
    if (got.h2 !== H2) throw new Error(`h2: expected "${H2}", got "${got.h2}"`);
  });
  await step('TOC has items', async () => {
    if (s0.tocItems <= 0) throw new Error('no .mdr-toc__item');
    return `${s0.tocItems} items`;
  });
  await step('status bar shows stats', async () => {
    const t = await page.evaluate(() => ({
      words: document.querySelector('.mdr-statusbar__item[data-stat="words"]')?.textContent,
      chars: document.querySelector('.mdr-statusbar__item[data-stat="chars"]')?.textContent,
      file: document.querySelector('.mdr-statusbar__item[data-stat="file"]')?.textContent,
    }));
    if (!/字数 \d+/.test(t.words ?? '') || !/字符 [1-9]\d*/.test(t.chars ?? '')) throw new Error(JSON.stringify(t));
    if (!t.file || !t.file.includes('small.md')) throw new Error(`file stat: ${t.file}`);
    return `${t.words} / ${t.chars} / ${t.file}`;
  });
  await step('math rendered with KaTeX', async () => {
    await page.waitForFunction(() => document.querySelector('.md-block .katex') !== null, null, { timeout: 10_000 });
  });

  // ---- 2. typing at the end of a paragraph updates the block in place
  const blockInfo = await page.evaluate((l) => window.__mdr.app.preview.blockAtLine(l), paraLine);
  await step('typing updates the .md-block in place within 500 ms', async () => {
    await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 10_000), paraLine);
    await page.evaluate((id) => {
      const el = document.querySelector(`.md-block[data-id="${id}"]`);
      if (!el) throw new Error('no wrapper for block ' + id);
      el.__smokeMarker = 'original';
    }, blockInfo.id);
    const versionBefore = await page.evaluate(() => window.__mdr.version());
    await page.keyboard.type(' SMOKE');
    const t0 = Date.now();
    await page.waitForFunction(
      (id) => {
        const el = document.querySelector(`.md-block[data-id="${id}"]`);
        return !!el && el.textContent.includes('SMOKE') && !el.classList.contains('is-stale');
      },
      blockInfo.id,
      { timeout: 500 },
    );
    const dt = Date.now() - t0;
    const same = await page.evaluate((id) => document.querySelector(`.md-block[data-id="${id}"]`)?.__smokeMarker === 'original', blockInfo.id);
    if (!same) throw new Error('wrapper element was replaced');
    const versionAfter = await page.evaluate(() => window.__mdr.version());
    if (versionAfter - versionBefore !== 6) throw new Error(`expected 6 transactions, got ${versionAfter - versionBefore}`);
    const text = await lineText(page, paraLine);
    if (!text.endsWith(' SMOKE')) throw new Error(`source line: ${text}`);
    return `updated in ≤ ${dt} ms, same element`;
  });
  await step('status bar reflects dirty state', async () => {
    await page.waitForFunction(() => /未保存|草稿已存/.test(document.querySelector('.mdr-statusbar__item[data-stat="file"]')?.textContent ?? ''), null, { timeout: 1000 });
    const title = await page.title();
    if (!title.startsWith('● ')) throw new Error(`title: ${title}`);
  });
  await step('worker autosaves a draft to IndexedDB (status → 草稿已存)', async () => {
    await page.waitForFunction(() => /草稿已存/.test(document.querySelector('.mdr-statusbar__item[data-stat="file"]')?.textContent ?? ''), null, { timeout: 3000 });
    const stored = await page.evaluate(async () => {
      const req = indexedDB.open('keyval-store');
      const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
      const tx = db.transaction('keyval', 'readonly');
      const get = tx.objectStore('keyval').get('mdr.draft:text:small.md');
      const v = await new Promise((res, rej) => { get.onsuccess = () => res(get.result); get.onerror = () => rej(get.error); });
      db.close();
      return v ? { version: v.version, hasSmoke: v.text.includes('SMOKE') } : null;
    });
    if (!stored || !stored.hasSmoke) throw new Error(`draft record: ${JSON.stringify(stored)}`);
    return `draft v${stored.version} contains the typed text`;
  });

  // ---- 3. mode cycling via Meta+/
  await step('Meta+/ cycles split → preview → edit → split', async () => {
    const seq = [];
    for (const expected of ['preview', 'edit', 'split']) {
      await page.keyboard.press('Meta+/');
      await page.waitForFunction((m) => document.querySelector('.mdr-app')?.dataset.mode === m, expected, { timeout: 1000 });
      seq.push(await page.evaluate(() => document.querySelector('.mdr-app').dataset.mode));
    }
    return seq.join(' → ');
  });

  await step('Meta+Shift+O hides and shows the TOC', async () => {
    await page.keyboard.press('Meta+Shift+o');
    await page.waitForFunction(() => document.querySelector('.mdr-app')?.dataset.toc === 'closed', null, { timeout: 1000 });
    const hidden = await page.evaluate(() => document.querySelector('.mdr-toc').hidden && getComputedStyle(document.querySelector('.mdr-pane--toc')).display === 'none');
    if (!hidden) throw new Error('TOC pane still visible');
    await page.keyboard.press('Meta+Shift+o');
    await page.waitForFunction(() => document.querySelector('.mdr-app')?.dataset.toc === 'open' && !document.querySelector('.mdr-toc').hidden, null, { timeout: 1000 });
  });

  // ---- 3b. pane geometry: hidden siblings must never shift the visible panes into 0-px columns
  const geometry = () => page.evaluate(() => {
    const r = (sel) => { const e = document.querySelector(sel); const b = e.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height), display: getComputedStyle(e).display }; };
    const de = document.documentElement;
    return { vw: innerWidth, mode: document.querySelector('.mdr-app').dataset.mode, toc: document.querySelector('.mdr-app').dataset.toc,
      tocPane: r('.mdr-pane--toc'), editor: r('.mdr-pane--editor'), gutter: r('.mdr-gutter'), preview: r('.mdr-pane--preview'),
      overflow: de.scrollWidth > de.clientWidth || de.scrollHeight > de.clientHeight,
      // hit-test the centre of the editor pane (the .cm-content rect can start above the viewport once scrolled)
      // `hitInEditor` is the actual invariant (the pane is not covered by another pane/toolbar); the class
      // name alone is not — CodeMirror's syntax spans carry generated class names like `ͼr`.
      hit: (() => { const b = document.querySelector('.mdr-pane--editor').getBoundingClientRect(); const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return el ? el.tagName + '.' + el.className : null; })(),
      hitInEditor: (() => { const b = document.querySelector('.mdr-pane--editor').getBoundingClientRect(); const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return !!el?.closest('.cm-editor'); })() };
  });
  await step('layout: TOC hidden → editor and preview share the width, editor is hit-testable', async () => {
    await page.keyboard.press('Meta+Shift+o');
    await page.waitForFunction(() => document.querySelector('.mdr-app')?.dataset.toc === 'closed', null, { timeout: 1000 });
    await sleep(100);
    const g = await geometry();
    if (g.editor.w < 400 || g.preview.w < 400 || g.tocPane.w !== 0) throw new Error(JSON.stringify(g));
    if (!g.hitInEditor) throw new Error(`editor hit test → ${g.hit}`);
    return `editor ${g.editor.w}px, preview ${g.preview.w}px`;
  });
  await step('layout: preview mode with TOC hidden → preview fills the window', async () => {
    await page.evaluate(() => window.__mdr.mode('preview'));
    await sleep(100);
    const g = await geometry();
    if (g.preview.w < 1000 || g.editor.display !== 'none') throw new Error(JSON.stringify(g));
    await page.evaluate(() => window.__mdr.mode('edit'));
    await sleep(100);
    const g2 = await geometry();
    if (g2.editor.w < 1000 || g2.preview.display !== 'none') throw new Error(JSON.stringify(g2));
    await page.evaluate(() => window.__mdr.mode('split'));
    return `preview ${g.preview.w}px / editor ${g2.editor.w}px`;
  });
  await step('layout: TOC closed persisted (mdr.toc=closed) survives a reload', async () => {
    await page.goto(url);
    await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
    await sleep(300);
    const g = await geometry();
    if (g.toc !== 'closed') throw new Error(`toc state not persisted: ${g.toc}`);
    if (g.editor.w < 400 || g.preview.w < 400) throw new Error(JSON.stringify(g));
    await page.keyboard.press('Meta+Shift+o');
    await page.waitForFunction(() => document.querySelector('.mdr-app')?.dataset.toc === 'open', null, { timeout: 1000 });
    return `editor ${g.editor.w}px, preview ${g.preview.w}px`;
  });
  await step('layout: 500 px viewport → TOC collapses, split keeps two usable columns, no overflow', async () => {
    await page.setViewportSize({ width: 500, height: 600 });
    await sleep(200);
    const g = await geometry();
    if (g.tocPane.display !== 'none' || g.tocPane.w !== 0) throw new Error(`toc did not collapse: ${JSON.stringify(g)}`);
    if (g.editor.w < 100 || g.preview.w < 100 || g.overflow) throw new Error(JSON.stringify(g));
    if (!g.hitInEditor) throw new Error(`editor hit test → ${g.hit}`);
    await page.setViewportSize({ width: 1400, height: 900 });
    await sleep(200);
    const back = await geometry();
    if (back.tocPane.w < 100) throw new Error(`toc did not come back: ${JSON.stringify(back)}`);
    return `editor ${g.editor.w}px, preview ${g.preview.w}px at 500px`;
  });
  await step('mode switch preserves the reading position (split → preview → edit → split)', async () => {
    const target = Math.max(2, Math.floor(smallMd.length * 0.6));
    await page.evaluate((l) => { window.__mdr.app.editor.scrollToLine(l, 0); }, target);
    await sleep(400);
    const top = () => page.evaluate(() => ({ mode: window.__mdr.app.layout.getMode(), ed: window.__mdr.app.editor.topVisible().line, pv: window.__mdr.app.preview.topVisible().line }));
    const before = await top();
    await page.evaluate(() => window.__mdr.mode('preview'));
    await sleep(300);
    const p = await top();
    if (Math.abs(p.pv - before.pv) > 5) throw new Error(`split→preview: preview ${before.pv} → ${p.pv}`);
    await page.evaluate(() => window.__mdr.mode('edit'));
    await sleep(300);
    const e = await top();
    if (Math.abs(e.ed - p.pv) > 5) throw new Error(`preview→edit: preview ${p.pv} → editor ${e.ed}`);
    await page.evaluate(() => window.__mdr.mode('split'));
    await sleep(400);
    const s = await top();
    if (Math.abs(s.ed - e.ed) > 5 || Math.abs(s.pv - e.ed) > 5) throw new Error(`edit→split: editor ${e.ed} → editor ${s.ed} / preview ${s.pv}`);
    await page.evaluate(() => { window.__mdr.app.editor.scrollToLine(1, 0); });
    await sleep(200);
    return `${JSON.stringify(before)} → preview ${p.pv} → editor ${e.ed} → split ${s.ed}/${s.pv}`;
  });

  // ---- 4. theme toggle
  await step('Meta+Shift+L toggles theme', async () => {
    const before = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.keyboard.press('Meta+Shift+l');
    const after = await page.evaluate(() => document.documentElement.dataset.theme);
    if (before === after) throw new Error(`theme stayed ${after}`);
    await page.keyboard.press('Meta+Shift+l');
    const back = await page.evaluate(() => document.documentElement.dataset.theme);
    if (back !== before) throw new Error(`theme did not return: ${before} → ${after} → ${back}`);
    return `${before} → ${after} → ${back}`;
  });

  // ---- 5. task checkbox click → source toggled
  await step('clicking a preview checkbox toggles the source line', async () => {
    const before = await lineText(page, taskLine);
    if (!/\[ \]/.test(before)) throw new Error(`line ${taskLine} is not an unchecked task: ${before}`);
    const b = await page.evaluate((l) => window.__mdr.app.preview.blockAtLine(l), taskLine);
    await page.evaluate((l) => window.__mdr.app.preview.scrollToLine(l), taskLine);
    await sleep(200);
    const box = page.locator(`.md-block[data-id="${b.id}"] li[data-l="${taskLine - b.startLine}"] input[type="checkbox"]`).first();
    await box.waitFor({ state: 'visible', timeout: 3000 });
    await box.click();
    await page.waitForFunction((l) => /\[x\]/i.test(window.__mdr.app.editor.view.state.doc.line(l).text), taskLine, { timeout: 1000 });
    // the re-rendered block must show the box checked
    await page.waitForFunction(
      ({ id, rel }) => document.querySelector(`.md-block[data-id="${id}"] li[data-l="${rel}"] input[type="checkbox"]`)?.checked === true,
      { id: b.id, rel: taskLine - b.startLine },
      { timeout: 1000 },
    );
    return `${before.trim()} → ${(await lineText(page, taskLine)).trim()}`;
  });

  // ---- 6. TOC click → editor cursor line
  await step('clicking a TOC item moves the editor cursor to that line', async () => {
    const item = page.locator(`.mdr-toc__item[data-line="${tocTargetLine}"]`).first();
    await item.waitFor({ state: 'visible', timeout: 3000 });
    if ((await item.textContent())?.trim() !== tocTargetText) throw new Error(`toc text mismatch: ${await item.textContent()}`);
    await item.click();
    await page.waitForFunction((l) => {
      const v = window.__mdr.app.editor.view;
      return v.state.doc.lineAt(v.state.selection.main.head).number === l;
    }, tocTargetLine, { timeout: 1000 });
    await sleep(250);
    const s = await readState(page);
    if (Math.abs(s.previewTop.line - tocTargetLine) > 3) throw new Error(`preview top line ${s.previewTop.line}, expected ≈ ${tocTargetLine}`);
    return `cursor line ${s.cursorLine}, preview top ${s.previewTop.line}`;
  });

  // ---- 7. scroll sync both ways
  const previewBox = await page.locator('.mdr-preview').boundingBox();
  const editorBox = await page.locator('.cm-scroller').boundingBox();
  await step('scrolling the preview makes the editor follow', async () => {
    await page.mouse.move(previewBox.x + previewBox.width / 2, previewBox.y + previewBox.height / 2);
    await page.mouse.wheel(0, 2500);
    await sleep(150);
    await page.mouse.wheel(0, 1500);
    await sleep(500);
    const s = await readState(page);
    const diff = Math.abs(s.editorTop.line - s.previewTop.line);
    if (diff > 5) throw new Error(`editor top ${s.editorTop.line} vs preview top ${s.previewTop.line}`);
    if (s.previewTop.line < 20) throw new Error(`preview did not scroll (top line ${s.previewTop.line})`);
    return `preview ${s.previewTop.line} / editor ${s.editorTop.line} (Δ${diff})`;
  });
  await step('scrolling the editor makes the preview follow', async () => {
    await page.mouse.move(editorBox.x + editorBox.width / 2, editorBox.y + editorBox.height / 2);
    await page.mouse.wheel(0, 3000);
    await sleep(150);
    await page.mouse.wheel(0, 2000);
    await sleep(500);
    const s = await readState(page);
    const diff = Math.abs(s.editorTop.line - s.previewTop.line);
    if (diff > 5) throw new Error(`editor top ${s.editorTop.line} vs preview top ${s.previewTop.line}`);
    return `editor ${s.editorTop.line} / preview ${s.previewTop.line} (Δ${diff})`;
  });

  // ---- 8. palette: run a command; then undo the typed text
  await step('Meta+Shift+P opens the palette and runs a command', async () => {
    const before = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.keyboard.press('Meta+Shift+p');
    await page.waitForSelector('.mdr-palette:not([hidden]) .mdr-palette__input', { state: 'visible', timeout: 1000 });
    await page.keyboard.type('切换主题');
    await page.waitForFunction(() => document.querySelector('.mdr-palette__item.is-active')?.dataset.cmd === 'view.toggleTheme', null, { timeout: 1000 });
    await page.keyboard.press('Enter');
    await page.waitForFunction((b) => document.documentElement.dataset.theme !== b, before, { timeout: 1000 });
    const hidden = await page.evaluate(() => document.querySelector('.mdr-palette').hidden);
    if (!hidden) throw new Error('palette still open');
    await page.keyboard.press('Meta+Shift+l'); // restore
    return 'view.toggleTheme ran from the palette';
  });
  await step('undo reverts the typed text and the preview block', async () => {
    await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 0), paraLine);
    // two transactions to undo: the checkbox toggle and the typed text
    await page.keyboard.press('Meta+z');
    await page.keyboard.press('Meta+z');
    await page.waitForFunction((l) => !window.__mdr.app.editor.view.state.doc.line(l).text.includes('SMOKE'), paraLine, { timeout: 1000 });
    await page.waitForFunction(
      (id) => { const el = document.querySelector(`.md-block[data-id="${id}"]`); return !!el && !el.textContent.includes('SMOKE'); },
      blockInfo.id,
      { timeout: 1000 },
    );
    const task = await lineText(page, taskLine);
    if (!/\[ \]/.test(task)) throw new Error(`task line not reverted: ${task}`);
  });
  await step('toolbar bold button wraps the selection; undo reverts', async () => {
    const original = await lineText(page, paraLine);
    await page.evaluate((l) => {
      const v = window.__mdr.app.editor.view;
      const line = v.state.doc.line(l);
      v.dispatch({ selection: { anchor: line.from, head: line.from + 2 } });
      v.focus();
    }, paraLine);
    await page.locator('.mdr-toolbar__btn[data-cmd="edit.bold"]').click();
    await page.waitForFunction((l) => window.__mdr.app.editor.view.state.doc.line(l).text.startsWith('**'), paraLine, { timeout: 1000 });
    const bold = await lineText(page, paraLine);
    if (bold !== `**${original.slice(0, 2)}**${original.slice(2)}`) throw new Error(`unexpected: ${bold}`);
    const focused = await page.evaluate(() => document.activeElement?.closest('.cm-editor') !== null);
    if (!focused) throw new Error('editor lost focus after the toolbar click');
    await page.keyboard.press('Meta+z');
    await page.waitForFunction(({ l, o }) => window.__mdr.app.editor.view.state.doc.line(l).text === o, { l: paraLine, o: original }, { timeout: 1000 });
    return `${bold.slice(0, 12)}…`;
  });
  await step('Meta+F opens the zh-CN search panel, Escape closes it', async () => {
    await page.keyboard.press('Meta+f');
    await page.waitForSelector('.cm-panel.cm-search', { state: 'visible', timeout: 1000 });
    const ph = await page.evaluate(() => document.querySelector('.cm-panel.cm-search input[name="search"]')?.getAttribute('placeholder'));
    if (ph !== '查找') throw new Error(`placeholder: ${ph}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.cm-panel.cm-search'), null, { timeout: 1000 });
    return `placeholder "${ph}"`;
  });
  await step('view.mountAll materializes every block', async () => {
    const t0 = Date.now();
    await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
    await page.waitForFunction(() => document.querySelectorAll('.md-block').length > 0 && document.querySelectorAll('.md-block.is-pending').length === 0, null, { timeout: 10_000 });
    const n = await page.evaluate(() => document.querySelectorAll('.md-block:not(.is-pending)').length);
    return `${n} blocks mounted in ${Date.now() - t0} ms`;
  });

  // ---- 8b. edits made while the preview is hidden must show up when it is shown again
  await step('typing in edit mode → switching to split shows the new text', async () => {
    await page.evaluate(() => window.__mdr.mode('edit'));
    await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 10_000), paraLine);
    await page.keyboard.type(' HIDDEN');
    await sleep(400); // worker renders + pushes while the preview is hidden
    await page.evaluate(() => window.__mdr.mode('split'));
    await page.waitForFunction(
      (id) => { const el = document.querySelector(`.md-block[data-id="${id}"]`); return !!el && el.textContent.includes('HIDDEN') && !el.classList.contains('is-stale'); },
      blockInfo.id,
      { timeout: 1500 },
    );
    await page.keyboard.press('Meta+z');
    await page.waitForFunction((l) => !window.__mdr.app.editor.view.state.doc.line(l).text.includes('HIDDEN'), paraLine, { timeout: 1000 });
  });

  // ---- 8c. reference definitions, anchors, Alt+click, export (small custom document)
  const refDoc = [
    '# Ref Doc',
    '',
    'See [the site][home] and jump to [Second](#second-part).',
    '',
    '[home]: https://example.org/one',
    '',
    '## Second part',
    '',
    'Formula $x^2$ here.',
    '',
    '- [ ] todo',
    '',
  ].join('\n');
  await page.evaluate((t) => window.__mdr.loadText(t, 'refs.md'), refDoc);
  await waitFirstVisibleAfterOpen(page, 20_000);
  await sleep(500);
  await step('changing a reference definition re-renders the block using it', async () => {
    const href0 = await page.evaluate(() => document.querySelector('.md-block a[href^="https://example.org/"]')?.getAttribute('href'));
    if (href0 !== 'https://example.org/one') throw new Error(`initial href ${href0}`);
    await page.evaluate(() => window.__mdr.app.editor.gotoLine(5, 10_000));
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('two');
    await page.waitForFunction(() => document.querySelector('.md-block a[href="https://example.org/two"]') !== null, null, { timeout: 1500 });
    return 'href followed the definition';
  });
  await step('clicking an in-document #anchor navigates both panes', async () => {
    await page.locator('.md-block a[href="#second-part"]').first().click();
    await page.waitForFunction(() => {
      const v = window.__mdr.app.editor.view;
      return v.state.doc.lineAt(v.state.selection.main.head).number === 7;
    }, null, { timeout: 1000 });
  });
  await step('Alt+click on a preview paragraph puts the cursor on its line', async () => {
    await page.evaluate(() => window.__mdr.app.editor.gotoLine(1, 0));
    await page.locator('.md-block p').last().click({ modifiers: ['Alt'] });
    await page.waitForFunction(() => {
      const v = window.__mdr.app.editor.view;
      return v.state.doc.lineAt(v.state.selection.main.head).number === 9;
    }, null, { timeout: 1000 });
  });
  await step('export HTML downloads a standalone document', async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }),
      page.evaluate(() => window.__mdr.app.registry.run('file.exportHtml')),
    ]);
    const path = await download.path();
    const html = readFileSync(path, 'utf8');
    if (!/<h2[^>]*\bid="second-part"/.test(html)) throw new Error('heading ids missing');
    if (!html.includes('class="katex')) throw new Error('math missing');
    if (!html.includes('.mdr-preview__body')) throw new Error('preview css missing');
    if (!html.includes('href="https://example.org/two"')) throw new Error('reference not resolved');
    return `${download.suggestedFilename()} (${html.length} bytes)`;
  });

  // ---- 9. large.md: first-visible budget + no long tasks after the first second
  await step('large.md: first-visible < 1500 ms', async () => {
    await page.evaluate(() => {
      window.__smokeLong = [];
      try {
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__smokeLong.push({ start: e.startTime, dur: e.duration }); })
          .observe({ type: 'longtask', buffered: true });
      } catch { /* unsupported */ }
    });
    const loadStart = await page.evaluate(() => performance.now());
    await page.evaluate(() => window.__mdr.loadUrl('/test-data/large.md'));
    const ms = await waitFirstVisibleAfterOpen(page, 30_000);
    const s = await readState(page);
    if (ms >= 1500) throw new Error(`${ms.toFixed(0)} ms`);
    page.__largeLoadStart = loadStart;
    return `${ms.toFixed(0)} ms (blocks=${s.blockCount})`;
  });
  await step('large.md: no long task > 200 ms after the first second', async () => {
    await sleep(4000);
    const open = await page.evaluate(() => performance.getEntriesByName('mdr:open').at(-1).startTime);
    const tasks = await page.evaluate(() => window.__smokeLong);
    const after = tasks.filter((t) => t.start >= open + 1000);
    const bad = after.filter((t) => t.dur > 200);
    const worst = Math.max(0, ...after.map((t) => t.dur));
    const worstAll = Math.max(0, ...tasks.filter((t) => t.start >= open).map((t) => t.dur));
    if (bad.length) throw new Error(`${bad.length} long task(s) > 200 ms: ${bad.map((t) => `${t.dur.toFixed(0)}ms@+${(t.start - open).toFixed(0)}`).join(', ')}`);
    return `longest after 1 s: ${worst.toFixed(0)} ms; longest during open: ${worstAll.toFixed(0)} ms`;
  });
  await step('large.md: typing mid-document updates its block in place', async () => {
    const lines = await page.evaluate(() => window.__mdr.app.editor.lineCount());
    const largeMd = readFileSync(resolve(ROOT, 'test-data/large.md'), 'utf8').split('\n');
    let target = Math.floor(lines / 2);
    while (target < lines && !(largeMd[target - 1].trim() && !/^[#\-*>|`$ ]/.test(largeMd[target - 1]))) target++;
    await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 10_000), target);
    await sleep(300);
    const b = await page.evaluate((l) => window.__mdr.app.preview.blockAtLine(l), target);
    await page.evaluate((id) => { const el = document.querySelector(`.md-block[data-id="${id}"]`); if (el) el.__smokeMarker = 'orig'; }, b.id);
    await page.keyboard.type(' LARG');
    await page.waitForFunction(
      (id) => { const el = document.querySelector(`.md-block[data-id="${id}"]`); return !!el && el.textContent.includes('LARG') && !el.classList.contains('is-stale'); },
      b.id,
      { timeout: 1500 },
    );
    // latency of one keystroke → mounted block (includes Playwright round trips, so an upper bound)
    const t0 = Date.now();
    await page.keyboard.type('E');
    await page.waitForFunction(
      (id) => { const el = document.querySelector(`.md-block[data-id="${id}"]`); return !!el && el.textContent.includes('LARGE') && !el.classList.contains('is-stale'); },
      b.id,
      { timeout: 1500 },
    );
    const latency = Date.now() - t0;
    const same = await page.evaluate((id) => document.querySelector(`.md-block[data-id="${id}"]`)?.__smokeMarker === 'orig', b.id);
    if (!same) throw new Error('wrapper replaced');
    await page.keyboard.press('Meta+z');
    await page.waitForFunction((l) => !window.__mdr.app.editor.view.state.doc.line(l).text.includes('LARGE'), target, { timeout: 1000 });
    if (latency > 400) throw new Error(`keystroke → mount took ${latency} ms`);
    return `line ${target}, block ${b.id}; keystroke → mount ≤ ${latency} ms`;
  });

  // ---- 10. empty document
  await step('empty document loads without errors', async () => {
    const errs = consoleErrors.length + pageErrors.length;
    await page.evaluate(() => window.__mdr.loadText('', 'empty.md'));
    await sleep(600);
    const s = await readState(page);
    if (s.blockCount !== 0 || s.wrappers !== 0) throw new Error(`blocks=${s.blockCount} wrappers=${s.wrappers}`);
    const words = await page.evaluate(() => document.querySelector('.mdr-statusbar__item[data-stat="words"]')?.textContent);
    if (words !== '字数 0') throw new Error(`words: ${words}`);
    if (consoleErrors.length + pageErrors.length !== errs) throw new Error('errors during empty doc');
    // typing into the empty doc must produce a block
    await page.evaluate(() => window.__mdr.app.editor.focus());
    await page.keyboard.type('hello');
    await page.waitForFunction(() => document.querySelector('.md-block:not(.is-pending)')?.textContent?.includes('hello'), null, { timeout: 1500 });
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => window.__mdr.app.preview.blockCount() === 0, null, { timeout: 1500 });
    return 'zero blocks, type → block, delete → zero blocks';
  });

  // ---- 11. unclosed fence on line 1
  await step('unclosed fence on line 1: no crash, no worker restart', async () => {
    const warnsBefore = consoleWarnings.filter((w) => w.includes('restarting')).length;
    const body = '```\n' + Array.from({ length: 2000 }, (_, i) => `const v${i} = ${i}; // line ${i}`).join('\n') + '\n';
    await page.evaluate((t) => window.__mdr.loadText(t, 'fence.md'), body);
    await waitFirstVisibleAfterOpen(page, 20_000);
    await sleep(700);
    const s = await readState(page);
    if (s.blockCount !== 1) throw new Error(`expected 1 giant block, got ${s.blockCount}`);
    const pre = await page.evaluate(() => !!document.querySelector('.md-block pre.md-code'));
    if (!pre) throw new Error('no pre.md-code mounted');
    // edit inside the giant block
    await page.evaluate(() => window.__mdr.app.editor.gotoLine(2, 10_000));
    await page.keyboard.type(' x');
    await page.waitForFunction(() => document.querySelector('.md-block')?.textContent?.includes('const v0 = 0; // line 0 x'), null, { timeout: 3000 });
    // close the fence at the end → the block splits into fence + trailing prose
    await page.evaluate(() => { const e = window.__mdr.app.editor; e.gotoLine(e.lineCount(), 10_000); });
    await page.keyboard.type('```\n\ntail paragraph');
    await page.waitForFunction(() => window.__mdr.app.preview.blockCount() === 2, null, { timeout: 3000 });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.md-block')).some((b) => b.querySelector('p')?.textContent === 'tail paragraph'), null, { timeout: 3000 });
    const restarts = consoleWarnings.filter((w) => w.includes('restarting')).length - warnsBefore;
    if (restarts) throw new Error(`worker restarted ${restarts}×`);
    return `1 giant block → edit ok → closing the fence splits into 2 blocks`;
  });

  // ---- 12. console / page errors
  await step('no console errors', async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 5).join(' | '));
  });
  await step('no page errors', async () => {
    if (pageErrors.length) throw new Error(pageErrors.slice(0, 3).join(' | '));
  });
  await step('no worker restarts', async () => {
    const r = consoleWarnings.filter((w) => w.includes('restarting'));
    if (r.length) throw new Error(r.join(' | '));
  });
  if (consoleWarnings.length) console.log('[smoke] console warnings:', consoleWarnings.slice(0, 10));
} catch (err) {
  check('smoke run', false, err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  if (browser) await browser.close().catch(() => undefined);
  stopServer(server);
}

console.log(`\n[smoke] ${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
