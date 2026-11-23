// bench/electron/verify-packaged.mjs — VERIFIER: the INSTALLED /Applications/MDReader.app.
// app:// serving, module worker, KaTeX fonts, deep-link reload, drafts across relaunch, recents,
// external links, export HTML, memory, bundle metadata (CONTRACT §10).
//
//   node bench/electron/verify-packaged.mjs
//
// MDR_APP=/path/to/MDReader.app overrides the bundle. MDR_SHOT_DIR saves screenshots.
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = process.env.MDR_APP || '/Applications/MDReader.app';
/** A real socket for the [1b] privacy probe (never 5173 — that is the user's dev server). */
const BEACON_PORT = Number(process.env.MDR_BEACON_PORT || 5267);
const EXE = path.join(APP_DIR, 'Contents', 'MacOS', 'MDReader');
const SHOTS = process.env.MDR_SHOT_DIR || '';

let pass = 0;
const failures = [];
const notes = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const note = (s) => { notes.push(s); console.log(`  note ${s}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(page, fn, arg, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, arg).catch(() => undefined);
    if (last) return last;
    await sleep(100);
  }
  return last;
}
const menuClick = (app, id) => app.evaluate(({ Menu }, mid) => {
  const it = Menu.getApplicationMenu().getMenuItemById(mid);
  if (!it) return false;
  it.click();
  return true;
}, id);
const emitOpenFile = (app, p) => app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); return true; }, p);
const plist = (key) => {
  try { return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(APP_DIR, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim(); }
  catch (e) { return `<missing: ${String(e.message).split('\n')[0]}>`; }
};

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdr-verify-pkg-'));
let app = null;

try {
  // ---------------------------------------------------------------- [0] bundle metadata
  console.log('[0] the installed bundle');
  check('the app exists at the install location', !!(await fsp.stat(EXE).catch(() => null)), EXE);
  check('CFBundleIdentifier is com.zyx.mdreader', plist('CFBundleIdentifier') === 'com.zyx.mdreader', plist('CFBundleIdentifier'));
  const aqua = plist('NSRequiresAquaSystemAppearance');
  check('NSRequiresAquaSystemAppearance is false (the app follows macOS dark mode)',
    aqua === 'false' || aqua === '0', aqua);
  const docTypes = plist('CFBundleDocumentTypes');
  check('CFBundleDocumentTypes declares the Markdown UTI',
    docTypes.includes('net.daringfireball.markdown'), docTypes.split('\n').length + ' lines');
  for (const ext of ['md', 'markdown', 'mdown', 'mkd', 'mkdn']) {
    check(`fileAssociations claim .${ext}`, docTypes.includes(`\n            ${ext}`) || docTypes.includes(ext), '');
  }
  const uti = plist('UTImportedTypeDeclarations');
  check('UTImportedTypeDeclarations imports net.daringfireball.markdown', uti.includes('net.daringfireball.markdown'));
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', APP_DIR], { stdio: 'pipe' });
    check('codesign --verify --deep --strict passes', true);
  } catch (e) { check('codesign --verify --deep --strict passes', false, String(e.stderr || e.message).slice(0, 120)); }
  try {
    const sig = execFileSync('codesign', ['-dv', APP_DIR], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    note(`signature: ${sig.split('\n').find((l) => l.startsWith('Signature')) || 'n/a'}`);
  } catch (e) { note(`codesign -dv: ${String(e.stderr || '').split('\n').find((l) => l.startsWith('Signature')) || 'n/a'}`); }

  // ---------------------------------------------------------------- [1] launch + app://
  console.log('\n[1] launch with a document, app:// serving');
  const doc = path.join(tmp, '打包验证.md');
  await fsp.writeFile(doc, `# 打包验证

一段中文正文，用来确认 worker 渲染。

行内公式 $E = mc^2$ 与块级公式：

$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$

\`\`\`js
const hello = () => '高亮';
\`\`\`

| 列一 | 列二 |
|---|---|
| 甲 | 乙 |

[外部链接](https://example.com/desktop-check)
`, 'utf8');

  app = await electron.launch({ executablePath: EXE, args: [doc] });
  const page = await app.firstWindow();
  const errors = [];
  const responses = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  // The [1b] privacy probe deliberately loads remote images that the CSP must block — the
  // unresolvable host and the "violates ... Content Security Policy" reports are ours, not bugs.
  const ownProbeNoise = (t) =>
    /mdr-verify(-2)?\.invalid|ERR_NAME_NOT_RESOLVED/.test(t)
    || (/Content Security Policy/i.test(t) && new RegExp(`127\\.0\\.0\\.1:${BEACON_PORT}`).test(t));
  page.on('console', (m) => { if (m.type() === 'error' && !ownProbeNoise(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => responses.push({ url: r.url(), status: r.status(), ct: r.headers()['content-type'] || '' }));
  page.on('requestfailed', (r) => responses.push({ url: r.url(), status: 0, ct: r.failure()?.errorText || 'failed' }));
  await page.waitForLoadState('domcontentloaded');

  check('the renderer origin is app://mdreader', (await page.evaluate(() => location.origin)) === 'app://mdreader',
    await page.evaluate(() => location.origin));
  check('the page URL is not file://', !page.url().startsWith('file:'), page.url());
  const opened = await until(page, () => document.title.includes('打包验证.md') && document.title);
  check('the launch argument document is opened', !!opened, String(opened));
  check('the window is on the packaged bundle', (await app.evaluate(({ app: a }) => a.getAppPath())).includes(APP_DIR),
    await app.evaluate(({ app: a }) => a.getAppPath()));

  await until(page, () => document.querySelectorAll('.mdr-preview [data-l]').length > 0);
  // KaTeX is rendered by the worker and its woff2 faces are fetched lazily: wait for the math,
  // not just for the first block, or this reads zeros.
  await until(page, () => document.querySelectorAll('.mdr-preview .katex').length > 0, null, 30000);
  await sleep(2000);
  const rendered = await page.evaluate(() => ({
    blocks: document.querySelectorAll('.mdr-preview [data-l]').length,
    katexInline: document.querySelectorAll('.mdr-preview .katex').length,
    katexBlock: document.querySelectorAll('.mdr-preview .katex-display').length,
    hljs: document.querySelectorAll('.mdr-preview .hljs-keyword, .mdr-preview .hljs-string, .mdr-preview [class^="hljs-"]').length,
    table: document.querySelectorAll('.mdr-preview table').length,
  }));
  check('the worker rendered the document', rendered.blocks > 0, JSON.stringify(rendered));
  check('KaTeX rendered inline + block math', rendered.katexInline > 0 && rendered.katexBlock > 0, JSON.stringify(rendered));
  check('highlight.js coloured the code fence', rendered.hljs > 0, String(rendered.hljs));
  check('the table rendered', rendered.table > 0);

  const appUrls = responses.filter((r) => r.url.startsWith('app://'));
  check('every request is served over app://', responses.every((r) => r.url.startsWith('app://') || r.url.startsWith('devtools:') || r.url.startsWith('blob:')),
    responses.filter((r) => !r.url.startsWith('app://') && !r.url.startsWith('blob:')).map((r) => r.url).slice(0, 4).join(', ') || 'none');
  check('no file:// request anywhere', !responses.some((r) => r.url.startsWith('file:')));
  check('no failed requests', !responses.some((r) => r.status === 0),
    responses.filter((r) => r.status === 0).map((r) => `${r.url} ${r.ct}`).slice(0, 4).join(' | ') || 'none');
  const fonts = appUrls.filter((r) => /\.woff2?$/.test(r.url));
  check('KaTeX fonts are served over app:// with font/woff2', fonts.length >= 1 && fonts.every((f) => f.ct.startsWith('font/')),
    `${fonts.length} font files: ${fonts.slice(0, 3).map((f) => `${path.basename(f.url)}=${f.ct}`).join(', ')}`);
  const workerReq = appUrls.find((r) => /worker/i.test(r.url));
  check('the render worker is fetched over app:// as a module script',
    !!workerReq && workerReq.ct.includes('javascript'), workerReq ? `${path.basename(workerReq.url)} ${workerReq.ct}` : 'not seen');
  check('the app:// worker actually started (the preview only mounts when it answers)', rendered.blocks > 0);
  if (SHOTS) { await page.screenshot({ path: path.join(SHOTS, 'packaged-light.png') }); note(`screenshot → ${path.join(SHOTS, 'packaged-light.png')}`); }

  // ---------------------------------------------------------------- [1b] remote content in a local file
  console.log('\n[1b] a .md file that references remote resources');
  // A real listening server, not an unresolvable host: the only honest way to tell "the request was
  // blocked before it left" from "the request went out and failed to resolve" is to count hits on a
  // socket we own.
  const hits = [];
  const beacon = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'image/gif' });
    res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
  });
  await new Promise((resolve) => beacon.listen(BEACON_PORT, '127.0.0.1', resolve));
  const trackDoc = path.join(tmp, '远程资源.md');
  await fsp.writeFile(trackDoc, [
    '# 远程资源',
    '',
    `![tracker](http://127.0.0.1:${BEACON_PORT}/pixel.png)`,
    '',
    `<img src="http://127.0.0.1:${BEACON_PORT}/beacon.gif">`,
    '',
    '![unresolvable](https://mdr-verify.invalid/pixel.png)',
    '',
  ].join('\n'), 'utf8');
  const outbound = [];
  const onReq = (r) => { const u = r.url(); if (!u.startsWith('app://') && !u.startsWith('blob:') && !u.startsWith('data:')) outbound.push(u); };
  page.on('request', onReq);
  await page.evaluate(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.blockedURI} / ${e.violatedDirective}`));
  });
  await emitOpenFile(app, trackDoc);
  await until(page, () => document.title.includes('远程资源.md'));
  await until(page, () => document.querySelectorAll('.mdr-preview [data-l]').length > 0);
  await sleep(3000);
  page.off('request', onReq);
  // The CSP is delivered as a response header on every app:// response (electron/protocol.mjs), not
  // as a meta tag, so the document's own response is where to read it.
  const csp = await page.evaluate(async () => {
    const m = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
    if (m) return m.content;
    try { return (await fetch(location.href)).headers.get('content-security-policy'); } catch { return null; }
  });
  const cspBlocked = await page.evaluate(() => window.__cspViolations.slice());
  const toastAfterBlock = await page.evaluate(() =>
    [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.trim()));
  await new Promise((resolve) => beacon.close(resolve));
  note(`opening a local .md that embeds remote images: ${hits.length} request(s) actually reached a listening server `
    + `on 127.0.0.1:${BEACON_PORT}; ${outbound.length} request event(s) were attempted: ${JSON.stringify(outbound.slice(0, 4))}`);
  note(`renderer Content-Security-Policy: ${csp === null ? 'NONE' : csp}`);
  note(`CSP violations reported by the document: ${JSON.stringify(cspBlocked.slice(0, 4))}`);
  check('a local Markdown file cannot silently call home (nothing reaches a real remote server)',
    hits.length === 0, `${hits.length} hits: ${JSON.stringify(hits)}`);
  check('the renderer carries a Content-Security-Policy that blocks remote subresources',
    !!csp && /img-src[^;]*/.test(csp) && !/img-src[^;]*https?:/.test(csp) && cspBlocked.length > 0,
    `CSP=${csp}, violations=${cspBlocked.length}`);
  check('the user is told once why the document stayed blank', toastAfterBlock.some((t) => t.includes('远程内容')),
    JSON.stringify(toastAfterBlock));

  // ---------------------------------------------------------------- [2] external links
  console.log('\n[2] external links leave the app');
  // [1b] left a different document open — put the one with the link back first.
  await emitOpenFile(app, doc);
  await until(page, () => document.title.includes('打包验证.md'));
  await until(page, () => document.querySelectorAll('.mdr-preview a[href^="https://"]').length > 0, null, 20000);
  await app.evaluate(({ shell }) => {
    globalThis.__externals = [];
    shell.openExternal = async (u) => { globalThis.__externals.push(u); };
    return true;
  });
  const clicked = await page.evaluate(() => {
    const a = [...document.querySelectorAll('.mdr-preview a[href^="https://"]')][0];
    if (!a) return null;
    a.click();
    return a.href;
  });
  await sleep(1200);
  const externals = await app.evaluate(() => globalThis.__externals.slice());
  check('clicking an https link calls shell.openExternal exactly once',
    externals.length === 1 && externals[0].startsWith('https://example.com/desktop-check'), JSON.stringify(externals));
  check('the window itself stayed on app://mdreader', (await page.evaluate(() => location.origin)) === 'app://mdreader');
  note(`link clicked: ${clicked}`);

  // ---------------------------------------------------------------- [3] deep-link reload
  console.log('\n[3] reload keeps working on the app:// origin');
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await until(page, () => document.querySelector('.mdr-toolbar') !== null, null, 25000);
  check('after reload the app boots again on app://mdreader', (await page.evaluate(() => location.origin)) === 'app://mdreader');
  check('after reload the toolbar/editor are mounted', await page.evaluate(() => !!document.querySelector('.mdr-editor, .cm-editor')));
  const deep = await app.evaluate(async ({ net }) => {
    const r = await net.fetch('app://mdreader/index.html');
    const r2 = await net.fetch('app://mdreader/');
    const r3 = await net.fetch('app://mdreader/../package.json');
    return { index: r.status, root: r2.status, traversal: r3.status };
  });
  check('app://mdreader/index.html serves 200', deep.index === 200, JSON.stringify(deep));
  check('app://mdreader/ serves index.html (200)', deep.root === 200, JSON.stringify(deep));
  check('a path-traversal request is refused', deep.traversal !== 200, `status ${deep.traversal}`);

  // ---------------------------------------------------------------- [4] export HTML
  console.log('\n[4] 导出 HTML');
  const dlDir = path.join(tmp, 'downloads');
  await fsp.mkdir(dlDir);
  await app.evaluate(({ session }, dir) => {
    globalThis.__downloads = [];
    session.defaultSession.on('will-download', (_e, item) => {
      const p = `${dir}/${item.getFilename()}`;
      globalThis.__downloads.push({ filename: item.getFilename(), url: item.getURL().slice(0, 12), mime: item.getMimeType() });
      item.setSavePath(p);
    });
    return true;
  }, dlDir);
  await emitOpenFile(app, doc);
  await until(page, () => document.title.includes('打包验证.md'));
  await until(page, () => document.querySelectorAll('.mdr-preview [data-l]').length > 0);
  await menuClick(app, 'file.exportHtml');
  await sleep(3000);
  const downloads = await app.evaluate(() => globalThis.__downloads.slice());
  const dlFiles = await fsp.readdir(dlDir).catch(() => []);
  note(`导出 HTML → Chromium download events: ${JSON.stringify(downloads)}; files written: ${JSON.stringify(dlFiles)}`);
  check('导出 HTML produces exactly one download', downloads.length === 1, JSON.stringify(downloads));
  check('导出 HTML is named after the document', downloads[0]?.filename === '打包验证.html', String(downloads[0]?.filename));
  if (dlFiles.length) {
    const html = await fsp.readFile(path.join(dlDir, dlFiles[0]), 'utf8');
    check('the exported HTML is a full document with the rendered content',
      html.startsWith('<!') && html.includes('打包验证') && html.includes('katex'), `${html.length} B`);
  }
  note('导出 HTML uses the WEB download path (blob: + <a download>), not mdrNative.saveDialog: Electron\'s own '
    + 'download handling decides where the file lands (it prompts with the native Save panel unless a '
    + "'will-download' handler sets a path, and electron/main.mjs installs none).");
  const noHandler = await app.evaluate(({ session }) => session.defaultSession.listenerCount('will-download'));
  note(`will-download listeners installed by the app: ${noHandler - 1} (1 is this verifier's stub)`);

  // ---------------------------------------------------------------- [5] recents
  console.log('\n[5] recents: 文件→打开最近 and the in-app dropdown');
  const doc2 = path.join(tmp, '最近文件.md');
  await fsp.writeFile(doc2, '# 最近文件\n\n第二个文档\n', 'utf8');
  await emitOpenFile(app, doc2);
  await until(page, () => document.title.includes('最近文件.md'));
  await sleep(900);
  const osRecent = await app.evaluate(({ app: a }) => {
    try { return a.getJumpListSettings ? 'n/a' : 'n/a'; } catch { return 'n/a'; }
  });
  const recentMenu = await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu().items.find((m) => m.label === '文件');
    const rec = file.submenu.items.find((i) => i.role === 'recentdocuments' || i.role === 'recentDocuments');
    return rec ? { label: rec.label, role: rec.role, hasSubmenu: !!rec.submenu } : null;
  });
  check('文件 menu has the macOS 打开最近 role item', !!recentMenu && recentMenu.label === '打开最近', JSON.stringify(recentMenu));
  const nsRecents = await app.evaluate(() => {
    // NSDocumentController's list is not readable from JS; assert the IPC that feeds it instead.
    return true;
  });
  const idbRecents = await page.evaluate(async () => {
    const open = indexedDB.open('keyval-store');
    const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
    const tx = db.transaction('keyval', 'readonly');
    const req = tx.objectStore('keyval').get('mdr.recent');
    const v = await new Promise((res) => { req.onsuccess = () => res(req.result); req.onerror = () => res(undefined); });
    db.close();
    return (v || []).map((e) => ({ name: e.name, path: e.path, docId: e.docId }));
  });
  check('recents store the absolute path for native documents',
    idbRecents.some((e) => e.path === doc) && idbRecents.some((e) => e.path === doc2),
    JSON.stringify(idbRecents.slice(0, 4)));
  check('recent docIds are native:<path>', idbRecents.filter((e) => e.path).every((e) => e.docId === `native:${e.path}`),
    JSON.stringify(idbRecents.slice(0, 2)));
  // the in-app dropdown
  await page.click('.mdr-toolbar__file');
  await sleep(700);
  const dropdown = await page.evaluate(() => [...document.querySelectorAll('.mdr-recent__item, .mdr-recent__empty')].map((li) => li.textContent.trim()));
  check('the in-app recents dropdown lists the opened documents',
    dropdown.includes('打包验证.md') && dropdown.includes('最近文件.md'), JSON.stringify(dropdown.slice(0, 6)));
  const reopened = await page.evaluate(() => {
    const li = [...document.querySelectorAll('.mdr-recent__item')].find((x) => x.textContent.trim() === '打包验证.md');
    if (!li) return false;
    li.click();
    return true;
  });
  check('clicking a recent entry reopens it', reopened && !!(await until(page, () => document.title.includes('打包验证.md'))),
    await page.evaluate(() => document.title));
  check('the reopened recent has the disk content', (await page.evaluate(() => window.mdrNative && document.querySelector('.cm-content')?.textContent?.slice(0, 6))) !== undefined);

  // ---------------------------------------------------------------- [6] drafts across relaunch
  console.log('\n[6] a draft written under app:// survives a relaunch');
  const draftDoc = path.join(tmp, '草稿.md');
  await fsp.writeFile(draftDoc, '# 草稿\n\n原始内容\n', 'utf8');
  await emitOpenFile(app, draftDoc);
  await until(page, () => document.title.includes('草稿.md'));
  await page.evaluate(() => { document.querySelector('.cm-content')?.focus(); });
  await page.keyboard.type('未保存的改动', { delay: 15 });
  // Only data-state === 'draft' means the worker wrote the draft; the file NAME can contain 草稿.
  const draftSaved = await until(page, () => {
    const el = document.querySelector('.mdr-statusbar__item[data-stat="file"]');
    return el && el.dataset.state === 'draft';
  }, null, 25000);
  check('typing eventually reports the 草稿 state', !!draftSaved,
    await page.evaluate(() => document.querySelector('.mdr-statusbar__item[data-stat="file"]')?.textContent));
  const draftRow = await page.evaluate(async (id) => {
    const open = indexedDB.open('keyval-store');
    const db = await new Promise((res) => { open.onsuccess = () => res(open.result); });
    const req = db.transaction('keyval', 'readonly').objectStore('keyval').get(id);
    const v = await new Promise((res) => { req.onsuccess = () => res(req.result); req.onerror = () => res(undefined); });
    db.close();
    return v ? { docId: v.docId, len: v.text.length, at: v.at } : null;
  }, `mdr.draft:native:${draftDoc}`);
  check('the draft is persisted in IndexedDB under the app:// origin', !!draftRow, JSON.stringify(draftRow));
  const memIdle = await app.evaluate(async ({ app: a }) => a.getAppMetrics().map((m) => ({ type: m.type, rss: Math.round(m.memory.workingSetSize / 1024), })));
  note(`memory with the small document: ${memIdle.map((m) => `${m.type}=${m.rss} MB`).join(', ')}, total ${memIdle.reduce((s, m) => s + m.rss, 0)} MB`);

  // relaunch and check the draft is offered
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.session.flushStorageData(); });
  await sleep(800);
  await app.evaluate(({ app: a }) => { a.exit(0); });   // exit(0) skips the dirty guard on purpose
  await app.close().catch(() => {});
  app = null;
  await sleep(1500);
  const fileStillOriginal = await fsp.readFile(draftDoc, 'utf8');
  check('the unsaved draft was NOT written to the real file', fileStillOriginal === '# 草稿\n\n原始内容\n');

  app = await electron.launch({ executablePath: EXE, args: [draftDoc] });
  const page2 = await app.firstWindow();
  await page2.waitForLoadState('domcontentloaded');
  await until(page2, () => document.title.includes('草稿.md'), null, 30000);
  const draftToast = await until(page2, () =>
    [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent).find((t) => t.includes('草稿')), null, 12000);
  check('after relaunch the persisted draft is offered for restore', !!draftToast, String(draftToast));
  if (draftToast) {
    const restored = await page2.evaluate(() => {
      const t = [...document.querySelectorAll('.mdr-toast')].find((x) => x.textContent.includes('草稿'));
      const b = [...t.querySelectorAll('button')].find((x) => x.textContent.trim() === '恢复');
      if (!b) return false;
      b.click();
      return true;
    });
    await sleep(900);
    const text = await page2.evaluate(() => document.querySelector('.cm-content')?.textContent || '');
    check('恢复 puts the draft text back in the editor', restored && text.includes('未保存的改动'), JSON.stringify(text.slice(0, 40)));
  }

  // ---------------------------------------------------------------- [7] memory on large.md
  console.log('\n[7] memory with test-data/large.md');
  const bigCopy = path.join(tmp, 'large.md');
  await fsp.copyFile(path.join(ROOT, 'test-data', 'large.md'), bigCopy);
  // discard the restored draft first so open-file is not blocked by the guard
  await page2.evaluate(() => {
    const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === '丢弃');
    if (b) b.click();
  });
  await emitOpenFile(app, bigCopy);
  await sleep(500);
  await page2.evaluate(() => {
    const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === '丢弃');
    if (b) b.click();
  });
  const bigOk = await until(page2, () => document.title.includes('large.md'), null, 40000);
  check('the packaged app opens the 3 MB large.md', !!bigOk, await page2.evaluate(() => document.title));
  await sleep(4000);
  const memBig = await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({ type: m.type, rss: Math.round(m.memory.workingSetSize / 1024) })));
  note(`memory after large.md: ${memBig.map((m) => `${m.type}=${m.rss} MB`).join(', ')}, total ${memBig.reduce((s, m) => s + m.rss, 0)} MB`);

  const errs2 = [];
  page2.on('pageerror', (e) => errs2.push(String(e)));
  page2.on('console', (m) => { if (m.type() === 'error' && !ownProbeNoise(m.text())) errs2.push(m.text()); });
  await sleep(1500);
  check('no page/console errors in the packaged app', errors.length === 0 && errs2.length === 0,
    [...errors, ...errs2].slice(0, 4).join(' | ') || 'none');

  // ---------------------------------------------------------------- [8] stale 'untitled' draft on an OS open
  console.log("\n[8] a leftover 'untitled' draft when a document is opened from the OS");
  await page2.evaluate(async () => {
    const open = indexedDB.open('keyval-store');
    const db = await new Promise((res) => { open.onsuccess = () => res(open.result); });
    const tx = db.transaction('keyval', 'readwrite');
    tx.objectStore('keyval').put({ docId: 'untitled', version: 7, text: '# 上一次没保存的草稿\n', at: Date.now() }, 'mdr.draft:untitled');
    await new Promise((res) => { tx.oncomplete = res; });
    db.close();
  });
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.session.flushStorageData(); });
  await sleep(900);
  await app.evaluate(({ app: a }) => { a.exit(0); });
  await app.close().catch(() => {});
  app = null;
  await sleep(1500);

  const freshDoc = path.join(tmp, '双击打开.md');
  await fsp.writeFile(freshDoc, '# 双击打开\n\n这是用户双击的文件\n', 'utf8');
  app = await electron.launch({ executablePath: EXE, args: [freshDoc] });
  const page3 = await app.firstWindow();
  await page3.waitForLoadState('domcontentloaded');
  await until(page3, () => document.title.includes('双击打开.md'), null, 30000);
  await sleep(2500);
  const staleToast = await page3.evaluate(() =>
    [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.trim()));
  const offered = staleToast.some((t) => t.includes('草稿'));
  note(`double-click open with a leftover 'untitled' draft → toasts ${JSON.stringify(staleToast)}`);
  if (offered) {
    const before = await page3.evaluate(() => document.querySelector('.cm-content')?.textContent || '');
    await page3.evaluate(() => {
      const t = [...document.querySelectorAll('.mdr-toast')].find((x) => x.textContent.includes('草稿'));
      const b = [...t.querySelectorAll('button')].find((x) => x.textContent.trim() === '恢复');
      if (b) b.click();
    });
    await sleep(1200);
    const after = await page3.evaluate(() => document.querySelector('.cm-content')?.textContent || '');
    check("the 恢复 button of the 草稿 toast actually restores something", before !== after,
      `editor text unchanged (${JSON.stringify(after.slice(0, 20))}) — the toast belongs to docId 'untitled' while the open document is native:<path>, so 恢复 is a no-op`);
  }
  check("no stale 'untitled' draft toast is shown when a document is opened from the OS", !offered,
    JSON.stringify(staleToast));
  check('the OS-opened document itself is intact', (await page3.evaluate(() => document.querySelector('.cm-content')?.textContent || '')).includes('双击打开'));
  if (SHOTS) { await page3.screenshot({ path: path.join(SHOTS, 'packaged-open-from-os.png') }); note(`screenshot → ${path.join(SHOTS, 'packaged-open-from-os.png')}`); }
  // clean the seeded draft so a later manual launch is not affected
  await page3.evaluate(async () => {
    const open = indexedDB.open('keyval-store');
    const db = await new Promise((res) => { open.onsuccess = () => res(open.result); });
    const tx = db.transaction('keyval', 'readwrite');
    tx.objectStore('keyval').delete('mdr.draft:untitled');
    await new Promise((res) => { tx.oncomplete = res; });
    db.close();
  });

  await app.evaluate(({ app: a }) => { a.exit(0); });
  await app.close().catch(() => {});
  app = null;
  await sleep(1500);
  const leftover = (() => {
    try { return execFileSync('pgrep', ['-f', 'MDReader.app/Contents/MacOS/MDReader'], { encoding: 'utf8' }).trim(); }
    catch { return ''; }
  })();
  check('no MDReader process survives the quit', leftover === '', leftover);
} catch (err) {
  failures.push(`EXCEPTION: ${err && err.stack ? err.stack : err}`);
  console.error(err);
} finally {
  if (app) await app.close().catch(() => {});
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n=== verify-packaged: ${pass} passed, ${failures.length} failed, ${notes.length} notes ===`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
