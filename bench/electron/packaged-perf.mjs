// bench/electron/packaged-perf.mjs — the browser numbers in README, re-measured inside the SHIPPED
// desktop app so the two are comparable.
//
//   npm run app:build && node bench/electron/packaged-perf.mjs
//
// Metrics (the same definitions bench/perf.spec.ts uses, so the numbers line up):
//   open → first-visible   the 'mdr:open' / 'mdr:first-visible' performance marks
//   keystroke → mount p95  for each preview 'mount' sample, the gap back to the last keydown
//                          within one typing interval; p95 over 100 keys mid-document
//   memory                 main-process process.memoryUsage() + app.getAppMetrics()
//
// The packaged renderer only installs window.__mdr for ?perf=1, so the page is loaded as
// app://mdreader/index.html?perf=1 (the protocol handler ignores the query).
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// `npm run app:install` removes the build artefact so LaunchServices cannot resolve
// com.zyx.mdreader to it (scripts/install-app.mjs); fall back to the installed copy.
const BUILT_APP = path.join(ROOT, 'release', 'mac-arm64', 'MDReader.app');
const APP_DIR = process.env.MDR_APP || (fs.existsSync(BUILT_APP) ? BUILT_APP : '/Applications/MDReader.app');
const EXE = path.join(APP_DIR, 'Contents', 'MacOS', 'MDReader');
const TYPE_INTERVAL_MS = 200; // 60 wpm, exactly as bench/perf.spec.ts
const KEYS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const percentile = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const mb = (bytes) => Math.round(bytes / 1024 / 1024);

// Copy the P-target fixture out of the repo, the way a user's document would live elsewhere.
const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdr-perf-'));
const largeSrc = path.join(ROOT, 'test-data', 'large.md');
const largePath = path.join(tmpDir, 'large.md');
const largePath2 = path.join(tmpDir, 'large-warm.md');
await fsp.copyFile(largeSrc, largePath);
const largeText = await fsp.readFile(largePath, 'utf8');
// The warm fixture must be a genuinely DIFFERENT document: the preview keys blocks by content, so a
// byte-identical copy is an incremental update (no remount, and 'mdr:first-visible' is never re-armed).
// Only lines that START with a letter or digit are marked — never a ``` fence, heading, list, quote,
// table or $$ line — so the block STRUCTURE is identical while the block CONTENT all differs.
// (Marking the fence lines turns the rest of the file into one unclosed code block: 7 blocks, not 30002.)
const warmText = largeText.split('\n').map((l) => (/^[\p{L}\p{N}]/u.test(l) ? `${l} ⟡` : l)).join('\n');
await fsp.writeFile(largePath2, warmText, 'utf8');
const largeStat = await fsp.stat(largePath);
const warmStat = await fsp.stat(largePath2);
const lineCount = largeText.split('\n').length;
console.log(`fixture: ${largePath} — ${(largeStat.size / 1024 / 1024).toFixed(2)} MB, ${lineCount} lines`);
console.log(`warm   : ${largePath2} — ${(warmStat.size / 1024 / 1024).toFixed(2)} MB, same line count, every block distinct`);

const results = {};

/** keystroke → mount p95: for each preview 'mount' sample, the gap back to the last keydown within
 *  one typing interval (the definition bench/perf.spec.ts uses for the README figure). */
async function measureKeystrokes(page, sourceText) {
  console.log(`\n[2] keystroke → mount p95 over ${KEYS} keys mid-document`);
  // Put the cursor on a plain paragraph line in the middle, like bench/perf.spec.ts does.
  const srcLines = sourceText.split('\n');
  const lineCount = await page.evaluate(() => window.__mdr.app.editor.lineCount());
  let target = Math.floor(lineCount / 2);
  while (target < lineCount && !(srcLines[target - 1]?.trim() && !/^[#\-*>|`$ ]/.test(srcLines[target - 1]))) target++;
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 10_000), target);
  await sleep(500);
  await page.evaluate(() => window.__mdr.waitIdle());
  console.log(`  cursor on line ${target}`);

  // Record keydown times in the page on the same clock as the perf samples.
  await page.evaluate(() => {
    window.__keys = [];
    window.__keyProbe = (e) => { if (e.key.length === 1) window.__keys.push(performance.now()); };
    window.addEventListener('keydown', window.__keyProbe, true);
  });
  const sampleFrom = await page.evaluate(() => performance.now());
  await sleep(300);

  const word = 'abcdefghij';
  for (let i = 0; i < KEYS; i++) {
    await page.keyboard.type(word[i % word.length]);
    await sleep(TYPE_INTERVAL_MS);
  }
  await sleep(1000);
  await page.evaluate(() => window.__mdr.waitIdle());

  const perf = await page.evaluate((from) => ({
    keys: window.__keys.filter((t) => t >= from),
    samples: window.__mdr.samples().filter((s) => s.name === 'mount' && s.at >= from),
  }), sampleFrom);
  await page.evaluate(() => window.removeEventListener('keydown', window.__keyProbe, true));

  const mountLatency = [];
  for (const s of perf.samples) {
    const k = perf.keys.filter((t) => t <= s.at).at(-1);
    if (k !== undefined && s.at - k < TYPE_INTERVAL_MS) mountLatency.push(s.at - k);
  }
  results.keys = perf.keys.length;
  results.mountSamples = mountLatency.length;
  if (!mountLatency.length) {
    results.keyToMountP95Ms = null;
    console.log('  no mount samples matched a keystroke — the edited block never remounted');
    return;
  }
  results.keyToMountP50Ms = Number(percentile(mountLatency, 50).toFixed(1));
  results.keyToMountP95Ms = Number(percentile(mountLatency, 95).toFixed(1));
  results.keyToMountMaxMs = Number(Math.max(...mountLatency).toFixed(1));
  console.log(`  keys typed: ${results.keys}, mount samples matched: ${results.mountSamples}`);
  console.log(`  keystroke → mount: p50 ${results.keyToMountP50Ms} ms, p95 ${results.keyToMountP95Ms} ms, max ${results.keyToMountMaxMs} ms`);
}

let app = null;
try {
  app = await electron.launch({ executablePath: EXE, args: [] });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.waitForLoadState('domcontentloaded');

  // Reload with the perf flag so window.__mdr (marks / samples) exists in the packaged build.
  await page.goto('app://mdreader/index.html?perf=1');
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 30000 });
  console.log('hooks available in the packaged app: yes (?perf=1)');

  // ---------------------------------------------------------------- open → first-visible
  console.log('\n[1] open → first-visible on large.md');
  await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, largePath);
  await page.waitForFunction(() => document.title.includes('large.md'), null, { timeout: 60000 });
  await page.waitForFunction(
    () => performance.getEntriesByName('mdr:first-visible').length > 0, null, { timeout: 60000 });
  const openMarks = await page.evaluate(() => ({
    open: performance.getEntriesByName('mdr:open').at(-1)?.startTime ?? -1,
    firstVisible: performance.getEntriesByName('mdr:first-visible').at(-1)?.startTime ?? -1,
  }));
  results.firstVisibleColdMs = Math.round(openMarks.firstVisible - openMarks.open);
  console.log(`  cold (first document in a fresh process): ${results.firstVisibleColdMs} ms`);

  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(2000);
  results.blocksCold = await page.evaluate(() => document.querySelectorAll('.md-block').length);
  results.lines = await page.evaluate(() => window.__mdr.app.editor.lineCount());
  console.log(`  document: ${results.lines} lines, ${results.blocksCold} blocks mounted`);

  await measureKeystrokes(page, largeText);

  // Warm open: an equivalent document with the worker and every lazy chunk already up. Typing above
  // left this document dirty, so answer the open guard with 丢弃 first.
  console.log('\n[3] open → first-visible, warm');
  await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, largePath2);
  const guard = await page.waitForSelector('.mdr-dialog', { timeout: 5000 }).then(() => true, () => false);
  if (guard) {
    await page.evaluate(() => {
      [...document.querySelectorAll('.mdr-dialog__btn')].find((b) => b.textContent.trim() === '丢弃').click();
    });
  }
  await page.waitForFunction(() => document.title.includes('large-warm.md'), null, { timeout: 60000 });
  const warmOk = await page.waitForFunction(() => {
    const open = performance.getEntriesByName('mdr:open').at(-1)?.startTime ?? -1;
    return performance.getEntriesByName('mdr:first-visible').some((e) => e.startTime >= open);
  }, null, { timeout: 60000 }).then(() => true, () => false);
  if (warmOk) {
    const warmMarks = await page.evaluate(() => {
      const open = performance.getEntriesByName('mdr:open').at(-1).startTime;
      const fv = performance.getEntriesByName('mdr:first-visible').find((e) => e.startTime >= open);
      return { open, firstVisible: fv.startTime };
    });
    results.firstVisibleWarmMs = Math.round(warmMarks.firstVisible - warmMarks.open);
    console.log(`  warm (worker and lazy chunks already up): ${results.firstVisibleWarmMs} ms`);
  } else {
    results.firstVisibleWarmMs = null;
    console.log('  warm: no first-visible mark for this open (incremental update, not a remount)');
  }
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(1500);
  results.blocksWarm = await page.evaluate(() => document.querySelectorAll('.md-block').length);

  // ---------------------------------------------------------------- memory
  console.log('\n[4] memory');
  await sleep(2000);
  const mem = await app.evaluate(async ({ app: a }) => {
    const metrics = a.getAppMetrics().map((m) => ({
      type: m.type,
      name: m.name || '',
      workingSetKb: m.memory?.workingSetSize ?? 0,
      peakKb: m.memory?.peakWorkingSetSize ?? 0,
    }));
    return { main: process.memoryUsage(), metrics };
  });
  results.mainRssMb = mb(mem.main.rss);
  results.mainHeapUsedMb = mb(mem.main.heapUsed);
  const byType = {};
  for (const m of mem.metrics) {
    byType[m.type] = (byType[m.type] || 0) + m.workingSetKb;
  }
  results.processes = mem.metrics.length;
  results.totalWorkingSetMb = Math.round(Object.values(byType).reduce((a, b) => a + b, 0) / 1024);
  // Electron reports the window's renderer as 'Tab'; the worker lives inside it.
  results.rendererWorkingSetMb = Math.round(((byType.Tab || 0) + (byType.Renderer || 0)) / 1024);
  console.log(`  main process: rss ${results.mainRssMb} MB, heapUsed ${results.mainHeapUsedMb} MB`);
  console.log(`  renderer working set: ${results.rendererWorkingSetMb} MB`);
  console.log(`  all ${results.processes} processes: ${results.totalWorkingSetMb} MB working set`);
  for (const [type, kb] of Object.entries(byType)) console.log(`    ${type}: ${Math.round(kb / 1024)} MB`);

  results.consoleErrors = errors.length;
  if (errors.length) console.log(`\n  console errors: ${errors.slice(0, 3).join(' | ')}`);

  console.log('\n--- JSON ---');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await app?.close().catch(() => {});
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}
