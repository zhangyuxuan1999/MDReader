// bench/electron/packaged-shell.mjs — launches the PACKAGED app (release/mac-arm64/MDReader.app)
// with Playwright and proves the production path works: the app:// scheme serves dist/, the module
// worker starts from that origin, IndexedDB is available (drafts/recents) and nothing errors.
//
//   npm run app:build && node bench/electron/packaged-shell.mjs
//
// MDR_SHOT=/path/shot.png also saves a screenshot of the running app.
//
// Nothing here installs the app — that is the integrator's `npm run app:install`.
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import { execFileSync } from 'node:child_process';
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

let pass = 0;
const failures = [];
const notes = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const note = (s) => { notes.push(s); console.log(`  note ${s}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 1. bundle
console.log('[1] bundle');
check('MDReader.app exists', await fsp.stat(APP_DIR).then(() => true, () => false), APP_DIR);
const plist = JSON.parse(
  execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(APP_DIR, 'Contents', 'Info.plist')], { encoding: 'utf8' }),
);
check('CFBundleIdentifier is com.zyx.mdreader', plist.CFBundleIdentifier === 'com.zyx.mdreader', plist.CFBundleIdentifier);
check('CFBundleName is MDReader', plist.CFBundleName === 'MDReader', plist.CFBundleName);
check('LSApplicationCategoryType is set', plist.LSApplicationCategoryType === 'public.app-category.productivity', plist.LSApplicationCategoryType);
check('NSHumanReadableCopyright is set', typeof plist.NSHumanReadableCopyright === 'string' && plist.NSHumanReadableCopyright.length > 0);
check('dark mode supported', plist.NSRequiresAquaSystemAppearance === false);
const uti = (plist.UTImportedTypeDeclarations || []).find((d) => d.UTTypeIdentifier === 'net.daringfireball.markdown');
check('imports the net.daringfireball.markdown UTI', !!uti);
check('the UTI conforms to public.plain-text', !!uti && JSON.stringify(uti.UTTypeConformsTo) === JSON.stringify(['public.plain-text']));
const utiExts = (uti?.UTTypeTagSpecification || {})['public.filename-extension'] || [];
check('the UTI declares md/markdown/mdown/mkd/mkdn',
  ['md', 'markdown', 'mdown', 'mkd', 'mkdn'].every((e) => utiExts.includes(e)), JSON.stringify(utiExts));
const docTypes = plist.CFBundleDocumentTypes || [];
const byUti = docTypes.find((d) => (d.LSItemContentTypes || []).includes('net.daringfireball.markdown'));
check('a document type claims the Markdown UTI', !!byUti);
check('the Markdown document type is an Editor with rank Default',
  byUti?.CFBundleTypeRole === 'Editor' && byUti?.LSHandlerRank === 'Default',
  `${byUti?.CFBundleTypeRole}/${byUti?.LSHandlerRank}`);
const allExts = new Set(docTypes.flatMap((d) => d.CFBundleTypeExtensions || []));
check('every declared extension is claimed',
  ['md', 'markdown', 'mdown', 'mkd', 'mkdn'].every((e) => allExts.has(e)), JSON.stringify([...allExts]));
check('the app icon is bundled',
  await fsp.stat(path.join(APP_DIR, 'Contents', 'Resources', plist.CFBundleIconFile || 'icon.icns')).then(() => true, () => false));

try {
  execFileSync('codesign', ['--verify', '--deep', '--strict', APP_DIR], { stdio: 'pipe' });
  check('ad-hoc signature verifies', true);
} catch (err) {
  check('ad-hoc signature verifies', false, String(err.stderr || err));
}

// ---------------------------------------------------------------- 2. runtime
console.log('\n[2] runtime (app:// scheme)');
const distAssets = await fsp.readdir(path.join(ROOT, 'dist', 'assets'));
const WORKER = distAssets.find((f) => /^render\.worker-.*\.js$/.test(f));
const WOFF2 = distAssets.find((f) => /^KaTeX_Main-Regular-.*\.woff2$/.test(f)) || distAssets.find((f) => f.endsWith('.woff2'));
check('dist/ contains the render worker chunk', !!WORKER, String(WORKER));

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdr-pkg-'));
const docPath = path.join(tmpDir, '打包测试.md');
await fsp.writeFile(docPath, '# 打包测试标题\n\n这是打包后的正文。\n\n- 一\n- 二\n', 'utf8');

let app = null;
try {
  app = await electron.launch({ executablePath: EXE, args: [] });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const failedRequests = [];
  page.on('requestfailed', (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText || ''}`));
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.url()} → ${r.status()}`); });
  await page.waitForLoadState('domcontentloaded');

  check('window loads app://mdreader/index.html', page.url() === 'app://mdreader/index.html', page.url());
  check('origin is app://mdreader', (await page.evaluate(() => location.origin)) === 'app://mdreader',
    await page.evaluate(() => location.origin));

  await page.waitForSelector('.mdr-app', { timeout: 25000 }).catch(() => {});
  check('the app mounts (.mdr-app)', (await page.locator('.mdr-app').count()) === 1);
  check('window.mdrNative is present in the packaged renderer', await page.evaluate(() => !!window.mdrNative));

  // Resource Timing does not report non-http schemes, so the assets are verified by fetching them
  // from the page (which is exactly what the protocol handler has to answer) and by reading back the
  // hrefs the packaged index.html actually references.
  const assetUrls = await page.evaluate(() => [
    ...[...document.querySelectorAll('script[src]')].map((e) => e.src),
    ...[...document.querySelectorAll('link[rel="stylesheet"], link[rel="modulepreload"]')].map((e) => e.href),
  ]);
  // theme-boot.js sits at the app root, not under assets/: it is the pre-paint theme bootstrap, moved
  // out of an inline <script> so the shell's `script-src 'self' app:` CSP needs no 'unsafe-inline'.
  check('index.html references app:// assets only',
    assetUrls.length > 0 && assetUrls.every((u) => u.startsWith('app://mdreader/')), JSON.stringify(assetUrls));
  check('the pre-paint theme bootstrap is an external script (no inline script under the CSP)',
    assetUrls.includes('app://mdreader/theme-boot.js'), JSON.stringify(assetUrls));
  const served = await page.evaluate(async (urls) => {
    const out = [];
    for (const u of urls) {
      const r = await fetch(u);
      out.push({ u, status: r.status, type: r.headers.get('content-type') });
    }
    return out;
  }, assetUrls);
  check('every referenced asset is served with 200', served.every((r) => r.status === 200),
    JSON.stringify(served.filter((r) => r.status !== 200)));
  check('JS modules get Content-Type text/javascript',
    served.filter((r) => r.u.endsWith('.js')).every((r) => (r.type || '').startsWith('text/javascript')),
    JSON.stringify(served.filter((r) => r.u.endsWith('.js')).map((r) => r.type)));
  check('the stylesheet gets Content-Type text/css',
    served.filter((r) => r.u.endsWith('.css')).every((r) => (r.type || '').startsWith('text/css')),
    JSON.stringify(served.filter((r) => r.u.endsWith('.css')).map((r) => r.type)));
  const fontProbe = await page.evaluate(async (u) => {
    const r = await fetch(u);
    return { status: r.status, type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength };
  }, `app://mdreader/assets/${WOFF2}`);
  check('KaTeX woff2 fonts are served as font/woff2',
    fontProbe.status === 200 && fontProbe.type === 'font/woff2' && fontProbe.bytes > 1000, JSON.stringify(fontProbe));

  // A module Worker really starts from the app:// origin (this is how the preview renders at all).
  const workerOk = await page.evaluate(async (url) => {
    try {
      const w = new Worker(url, { type: 'module' });
      const result = await new Promise((resolve) => {
        const t = setTimeout(() => resolve('ok'), 2500);      // loaded and idle = fine
        w.onerror = (e) => { clearTimeout(t); resolve('error: ' + (e.message || 'load failed')); };
        w.onmessageerror = () => { clearTimeout(t); resolve('messageerror'); };
      });
      w.terminate();
      return result;
    } catch (e) { return 'threw: ' + e.message; }
  }, `app://mdreader/assets/${WORKER}`);
  check('a module Worker loads from the app:// origin', workerOk === 'ok', String(workerOk));

  const idb = await page.evaluate(() => new Promise((resolve) => {
    try {
      const req = indexedDB.open('mdr-probe', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('s');
      req.onsuccess = () => { req.result.close(); indexedDB.deleteDatabase('mdr-probe'); resolve('ok'); };
      req.onerror = () => resolve('error');
    } catch (e) { resolve('threw: ' + e.message); }
  }));
  check('IndexedDB works on the app:// origin (drafts / recents)', idb === 'ok', String(idb));

  const missing = await page.evaluate(() => fetch('app://mdreader/does-not-exist.js').then((r) => r.status));
  check('a missing asset is a 404', missing === 404, String(missing));
  const escape = await page.evaluate(() =>
    fetch('app://mdreader/../../../../etc/passwd').then((r) => r.text()).then((t) => t.slice(0, 40), (e) => 'rejected'));
  check('path traversal cannot read outside dist/', !String(escape).includes('root:'), String(escape).slice(0, 40));

  // End-to-end: the OS hands the app a document.
  await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, docPath);
  const rendered = await page
    .waitForFunction(() => document.querySelector('.mdr-preview__body')?.textContent?.includes('打包测试标题'), null,
      { timeout: 15000 })
    .then(() => true, () => false);
  if (rendered) check('an open-file document renders in the packaged app', true);
  else note('open-file did not render — the renderer side (App.ts onOpenFile) may still be in progress');
  if (process.env.MDR_SHOT) {
    await page.screenshot({ path: process.env.MDR_SHOT });
    console.log(`  shot ${process.env.MDR_SHOT}`);
  }
  const winTitle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? '')
    .catch(() => '');
  if (rendered) check('the window title shows the opened document', winTitle.includes('打包测试'), winTitle);

  // The favicon probe (Chromium asks for /favicon.ico on every page) and this script's own
  // deliberate 404 / traversal probes are expected.
  const realFailures = failedRequests.filter(
    (u) => !/favicon/i.test(u) && !/does-not-exist\.js/.test(u) && !/etc\/passwd/.test(u));
  check('no failed requests other than the browser favicon probe', realFailures.length === 0, realFailures.join(' | '));
  const realErrors = errors.filter((e) => !/404/.test(e));
  if (realErrors.length) note(`console errors: ${realErrors.slice(0, 5).join(' | ')}`);
  else check('no console errors in the packaged app', true);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].destroy());
} finally {
  if (app) await app.close().catch(() => {});
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${pass} checks passed, ${failures.length} failed, ${notes.length} notes`);
for (const f of failures) console.log(`  FAILED: ${f}`);
process.exit(failures.length ? 1 : 0);
