// bench/electron/packaged-e2e.mjs — the PACKAGED app opening a real document the way the OS hands
// it over. Where packaged-shell.mjs checks the bundle and the app:// plumbing, this script proves
// the product works end to end in the shipped binary: launch with the file as an argument, worker
// rendering, KaTeX fonts, the IndexedDB draft, and a clean quit.
//
//   npm run app:build && node bench/electron/packaged-e2e.mjs
//
// MDR_SHOT=/path/shot.png also saves a screenshot.
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

let pass = 0;
const failures = [];
const notes = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const note = (s) => { notes.push(s); console.log(`  note ${s}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(page, fn, arg, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, arg).catch(() => undefined);
    if (last) return last;
    await sleep(100);
  }
  return last;
}

const DOC = `# 打包端到端

正文一段，用来确认 worker 渲染。

行内公式 $E = mc^2$ 与块级公式：

$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$

\`\`\`js
const hello = () => '高亮';
\`\`\`

| 列一 | 列二 |
|---|---|
| 甲 | 乙 |
`;

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdr-pkg-e2e-'));
const docPath = path.join(tmpDir, '打包端到端.md');
await fsp.writeFile(docPath, DOC, 'utf8');

let app = null;
try {
  console.log('[1] launch the packaged binary with the document as an argument');
  app = await electron.launch({ executablePath: EXE, args: [docPath] });
  const page = await app.firstWindow();
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => requests.push({ url: r.url(), status: r.status(), type: r.headers()['content-type'] || '' }));
  page.on('requestfailed', (r) => requests.push({ url: r.url(), status: 0, type: r.failure()?.errorText || '' }));
  await page.waitForLoadState('domcontentloaded');

  check('the window is on the app:// origin', page.url() === 'app://mdreader/index.html', page.url());
  check('the origin is app://mdreader',
    (await page.evaluate(() => location.origin)) === 'app://mdreader');
  check('no file:// anywhere in the document URL', !page.url().startsWith('file:'));

  console.log('\n[2] the document handed over at launch');
  const opened = await until(page, () => document.title.includes('打包端到端.md') && document.title, null, 20000);
  check('the file passed on the command line opened', !!opened, String(opened || (await page.title())));
  check('the shell adopted it as the represented file',
    (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getRepresentedFilename())) === docPath);
  const stat = await page.evaluate(() => {
    const el = document.querySelector('.mdr-statusbar__item[data-stat="file"]');
    return el ? { text: el.textContent, state: el.dataset.state } : null;
  });
  check('the status bar shows 已保存', !!stat && stat.text.includes('已保存'), stat?.text);

  console.log('\n[3] worker rendering');
  const body = await until(page, () => {
    const t = document.querySelector('.mdr-preview__body')?.textContent || '';
    return t.includes('打包端到端') ? t : '';
  }, null, 20000);
  check('the worker-rendered preview shows the document', !!body);
  const blocks = await page.evaluate(() => document.querySelectorAll('.mdr-preview__body .md-block').length);
  check('the preview is built from worker blocks', blocks > 0, `${blocks} blocks`);
  // Harness repair (lead, 0.2.0 release): the blocks after the first formula are mounted a frame or two after the
  // first text; wait for them instead of sampling once (measured: both present about 200 ms after load, on 0.1.1 too).
  await page.waitForSelector('.mdr-preview__body table', { timeout: 5000 }).catch(() => {});
  await page.waitForSelector('.mdr-preview__body pre code span', { timeout: 5000 }).catch(() => {});
  check('the table rendered', await page.evaluate(() => !!document.querySelector('.mdr-preview__body table')));
  check('the code block was highlighted in the worker',
    await page.evaluate(() => !!document.querySelector('.mdr-preview__body pre code .hljs-keyword, .mdr-preview__body pre code span')));

  console.log('\n[4] KaTeX');
  // KaTeX is a lazy `await import` inside the worker, so the first paint has no math yet.
  const katexCount = await until(page, () => {
    const n = document.querySelectorAll('.mdr-preview__body .katex').length;
    return n >= 2 ? n : 0;
  }, null, 15000);
  check('inline and block math rendered', Number(katexCount) >= 2, `${katexCount || 0} .katex nodes`);
  const fontsLoaded = await until(page, async () => {
    const got = [...document.fonts].filter((f) => f.family.includes('KaTeX') && f.status === 'loaded');
    return got.length ? got.length : 0;
  }, null, 15000);
  check('KaTeX webfonts loaded in the packaged app', Number(fontsLoaded) > 0, `${fontsLoaded} faces`);
  const fontReqs = requests.filter((r) => /KaTeX.*\.woff2?$/.test(r.url));
  check('the fonts were served over app:// with a font MIME type',
    fontReqs.length > 0 && fontReqs.every((r) => r.url.startsWith('app://') && r.status === 200 && /font\//.test(r.type)),
    fontReqs.map((r) => `${r.status} ${r.type}`).join(', ') || 'none');

  console.log('\n[5] IndexedDB draft');
  await page.click('.cm-content');
  await page.keyboard.type('草稿测试内容');
  const draftState = await until(page, () => {
    const el = document.querySelector('.mdr-statusbar__item[data-stat="file"]');
    return el && el.textContent.includes('草稿已存') ? el.textContent : '';
  }, null, 15000);
  check('typing produced a 草稿已存 status (draft written to IndexedDB)', !!draftState, String(draftState || ''));
  const draftKeys = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('keyval-store');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return await new Promise((res) => {
      const tx = db.transaction('keyval', 'readonly');
      const req = tx.objectStore('keyval').getAllKeys();
      req.onsuccess = () => res(req.result.map(String));
      req.onerror = () => res([]);
    });
  }).catch((e) => ['threw: ' + e.message]);
  check('a draft record exists in IndexedDB',
    draftKeys.some((k) => k.startsWith('mdr.draft:')), draftKeys.join(', '));
  check('the draft is keyed by the native path',
    draftKeys.some((k) => k === `mdr.draft:native:${docPath}`), draftKeys.filter((k) => k.startsWith('mdr.draft:')).join(', '));

  if (process.env.MDR_SHOT) {
    await page.screenshot({ path: process.env.MDR_SHOT });
    console.log(`  shot ${process.env.MDR_SHOT}`);
  }

  console.log('\n[6] errors');
  const failed = requests.filter((r) => r.status === 0 || r.status >= 400).filter((r) => !/favicon/i.test(r.url));
  check('no failed requests', failed.length === 0, failed.map((r) => `${r.url} ${r.status}`).join(' | '));
  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log('\n[7] quit');
  // The document is dirty (we typed): answer the guard with 不保存 so the quit is a real user quit.
  await app.evaluate(({ app: a }) => { a.quit(); });
  await page.waitForSelector('.mdr-dialog', { timeout: 10000 });
  check('quitting a dirty document asks first', true);
  await page.evaluate(() => {
    [...document.querySelectorAll('.mdr-dialog__btn')].find((b) => b.textContent.trim() === '不保存').click();
  });
  let alive = true;
  for (let i = 0; i < 100; i++) {
    alive = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length > 0).catch(() => false);
    if (!alive) break;
    await sleep(100);
  }
  check('不保存 quits the app cleanly', !alive);
  check('quitting did not modify the file on disk', (await fsp.readFile(docPath, 'utf8')) === DOC);
} catch (err) {
  check('harness', false, err instanceof Error ? err.stack : String(err));
} finally {
  await app?.close().catch(() => {});
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n[packaged-e2e] ${pass}/${pass + failures.length} checks passed`);
if (notes.length) { console.log('notes:'); for (const n of notes) console.log(`  - ${n}`); }
if (failures.length) { console.log('failures:'); for (const f of failures) console.log(`  - ${f}`); }
process.exit(failures.length === 0 ? 0 : 1);
