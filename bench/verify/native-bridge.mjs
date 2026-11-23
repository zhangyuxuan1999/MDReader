// Renderer-side sanity check for CONTRACT §10: boots the real app in Chromium with a FAKE
// window.mdrNative injected before any script runs, and drives the desktop flows end to end.
// Starts its own Vite server on 5252 (engineer port) and kills it at the end.
import { chromium } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5252;
const BASE = `http://localhost:${PORT}`;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killPort(port) {
  try {
    const pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
    for (const pid of pids.split(/\s+/).filter(Boolean)) {
      try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ }
    }
  } catch { /* nothing listening */ }
}

const FAKE = () => {
  const disk = { '/docs/hello.md': '# 你好\n\nMDReader 桌面版。\n', '/docs/other.md': '# 其他\n' };
  const log = [];
  const openCbs = [];
  const cmdCbs = [];
  let pendingLaunch = '/docs/hello.md';
  window.__fake = {
    log,
    disk,
    emitOpen: (p) => openCbs.forEach((cb) => cb(p)),
    emitCommand: (id) => cmdCbs.forEach((cb) => cb(id)),
    closes: [],
    states: [],
    recents: [],
    nextSave: null,
  };
  window.mdrNative = {
    platform: 'darwin',
    version: '0.1.0',
    async openDialog() {
      log.push('openDialog');
      return { path: '/docs/other.md', name: 'other.md', text: disk['/docs/other.md'], lastModified: 1000 };
    },
    async saveDialog(suggested, current) {
      log.push(`saveDialog:${suggested}:${current}`);
      return window.__fake.nextSave;
    },
    async readFile(path) {
      log.push('readFile:' + path);
      if (!(path in disk)) throw { code: 'ENOENT', message: '没有那个文件' };
      return { path, name: path.split('/').pop(), text: disk[path], lastModified: 1000 };
    },
    async writeFile(path, text) {
      log.push('writeFile:' + path);
      disk[path] = text;
      return { lastModified: 2000 };
    },
    pathForFile: () => null,
    onOpenFile(cb) {
      openCbs.push(cb);
      if (pendingLaunch) { const p = pendingLaunch; pendingLaunch = null; setTimeout(() => cb(p), 0); }
      return () => openCbs.splice(openCbs.indexOf(cb), 1);
    },
    onCommand(cb) {
      cmdCbs.push(cb);
      return () => cmdCbs.splice(cmdCbs.indexOf(cb), 1);
    },
    resolveClose: (d) => window.__fake.closes.push(d),
    setDocumentState: (s) => window.__fake.states.push(s),
    addRecent: (p) => window.__fake.recents.push(p),
  };
};

const server = (() => {
  killPort(PORT);
  const p = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  return p;
})();

const shutdown = () => {
  try { server.kill('SIGKILL'); } catch { /* gone */ }
  killPort(PORT);
};
process.on('exit', shutdown);

let browser;
try {
  // wait for the dev server
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE); if (r.ok) break; } catch { /* not up yet */ }
    await sleep(250);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.addInitScript(FAKE);
  await page.goto(BASE);
  await page.waitForFunction(() => !!window.__mdr);
  await page.waitForFunction(() => document.title.includes('hello.md'), null, { timeout: 5000 });

  // 1. the launch document opened through onOpenFile
  check('launch open-file loaded the document', true, await page.title());
  check(
    'editor holds the file text',
    (await page.evaluate(() => window.__mdr.app.getText())).includes('MDReader 桌面版'),
  );
  check('shell was told about the document', await page.evaluate(() => {
    const s = window.__fake.states.at(-1);
    return s && s.path === '/docs/hello.md' && s.name === 'hello.md' && s.dirty === false;
  }));
  check('addRecent was called for the opened path', await page.evaluate(() => window.__fake.recents.includes('/docs/hello.md')));

  // 2. typing marks it dirty and reports that to the shell
  await page.click('.cm-content');
  await page.keyboard.type('新增一行\n');
  await page.waitForFunction(() => window.__fake.states.at(-1)?.dirty === true, null, { timeout: 4000 });
  check('dirty state reaches the shell', true, JSON.stringify(await page.evaluate(() => window.__fake.states.at(-1))));
  check('title shows the dirty dot', (await page.title()).startsWith('●'));

  // 3. Cmd+S writes back to the SAME path
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => window.__fake.log.includes('writeFile:/docs/hello.md'), null, { timeout: 4000 });
  check('⌘S wrote back to the original path', await page.evaluate(() => window.__fake.disk['/docs/hello.md'].includes('新增一行')));
  check('no save dialog was shown for an in-place save', await page.evaluate(() => !window.__fake.log.some((l) => l.startsWith('saveDialog'))));
  check('clean state reported after save', await page.evaluate(() => window.__fake.states.at(-1).dirty === false));

  // 4. the web beforeunload guard is NOT installed
  check('beforeunload guard not installed with a bridge', await page.evaluate(async () => {
    window.__mdr.app.editor.setDoc('dirty again');
    await new Promise((r) => setTimeout(r, 50));
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented === false;
  }));

  // 5. app.closeRequested with a dirty document → three-button dialog
  await page.evaluate(() => window.__fake.emitCommand('app.closeRequested'));
  await page.waitForSelector('.mdr-dialog', { timeout: 4000 });
  const labels = await page.$$eval('.mdr-dialog__btn', (bs) => bs.map((b) => b.textContent));
  check('three-button zh-CN close dialog', labels.length === 3 && ['保存', '不保存', '取消'].every((l) => labels.includes(l)), labels.join(' / '));
  check('dialog text names the document', (await page.textContent('.mdr-dialog__text')).includes('有未保存的更改'), await page.textContent('.mdr-dialog__text'));
  check('保存 has focus by default', await page.evaluate(() => document.activeElement?.textContent === '保存'));

  // 取消
  await page.click('.mdr-dialog__btn[data-choice="cancel"]');
  await page.waitForFunction(() => window.__fake.closes.length === 1, null, { timeout: 4000 });
  check('取消 → resolveClose("cancel")', (await page.evaluate(() => window.__fake.closes.at(-1))) === 'cancel');

  // 不保存
  await page.evaluate(() => window.__fake.emitCommand('app.closeRequested'));
  await page.waitForSelector('.mdr-dialog', { timeout: 4000 });
  await page.click('.mdr-dialog__btn[data-choice="discard"]');
  await page.waitForFunction(() => window.__fake.closes.length === 2, null, { timeout: 4000 });
  check('不保存 → resolveClose("discard")', (await page.evaluate(() => window.__fake.closes.at(-1))) === 'discard');

  // 保存 → writes, then resolveClose('save')
  await page.evaluate(() => window.__fake.emitCommand('app.closeRequested'));
  await page.waitForSelector('.mdr-dialog', { timeout: 4000 });
  await page.click('.mdr-dialog__btn[data-choice="save"]');
  await page.waitForFunction(() => window.__fake.closes.length === 3, null, { timeout: 5000 });
  check('保存 → wrote the file and resolveClose("save")', await page.evaluate(
    () => window.__fake.closes.at(-1) === 'save' && window.__fake.disk['/docs/hello.md'] === 'dirty again',
  ));

  // 6. a cancelled 另存为 during the close flow keeps the window open
  await page.evaluate(() => {
    window.__fake.nextSave = null;
    window.__mdr.app.registry.run('file.new');
  });
  await sleep(300);
  await page.click('.cm-content');
  await page.keyboard.type('未命名内容');
  await page.waitForFunction(() => window.__fake.states.at(-1)?.path === null && window.__fake.states.at(-1)?.dirty === true, null, { timeout: 4000 });
  await page.evaluate(() => window.__fake.emitCommand('app.closeRequested'));
  await page.waitForSelector('.mdr-dialog', { timeout: 4000 });
  await page.click('.mdr-dialog__btn[data-choice="save"]');
  await page.waitForFunction(() => window.__fake.closes.length === 4, null, { timeout: 5000 });
  check('保存 → cancelled save dialog → resolveClose("cancel")', (await page.evaluate(() => window.__fake.closes.at(-1))) === 'cancel');

  // 7. a save-as that succeeds adopts the new path
  await page.evaluate(() => { window.__fake.nextSave = '/docs/saved-as.md'; });
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => window.__fake.log.includes('writeFile:/docs/saved-as.md'), null, { timeout: 5000 });
  check('untitled ⌘S → save dialog → new path adopted', await page.evaluate(
    () => window.__fake.states.at(-1).path === '/docs/saved-as.md' && window.__fake.recents.includes('/docs/saved-as.md'),
  ), await page.evaluate(() => JSON.stringify(window.__fake.states.at(-1))));

  // 8. a vanished file from the OS is reported, not crashed on
  await page.evaluate(() => window.__fake.emitOpen('/docs/gone.md'));
  // Older 已保存 toasts are still on screen: wait for the TEXT, not for any toast element.
  let toast = '';
  for (let i = 0; i < 60; i++) {
    toast = await page.$$eval('.mdr-toast', (ts) => ts.map((t) => t.textContent).join(' | ')).catch(() => '');
    if (toast.includes('文件已不存在')) break;
    await sleep(100);
  }
  check('missing file → 文件已不存在 toast', toast.includes('文件已不存在'), toast);
  check('the vanished file did not replace the document', (await page.title()).includes('saved-as.md'), await page.title());

  // 9. recents dropdown lists the path entries
  await page.click('.mdr-toolbar__file');
  await page.waitForSelector('.mdr-recent', { timeout: 4000 });
  const recents = await page.$$eval('.mdr-recent__item', (is) => is.map((i) => i.textContent));
  check('recent list offers the desktop entries', recents.includes('hello.md') && recents.includes('saved-as.md'), recents.join(' / '));

  check('no console/page errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('harness', false, err instanceof Error ? err.stack : String(err));
} finally {
  await browser?.close().catch(() => {});
  shutdown();
}
console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
