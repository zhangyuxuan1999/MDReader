// bench/verify/fixF-web-drop.mjs — fixer-F, fix round 0.2.0, R1 on the WEB build (CONTRACT §11): a file
// dropped onto the page while 新建's 取消 / 丢弃 question is on screen is opened after 丢弃 (it used to be
// dropped silently: the single-flight guard answered `false` to the second caller), never with two
// questions at once; and after 取消 the dropped file asks its own question.
//
//   MDR_PORT=5276 node bench/verify/fixF-web-drop.mjs          # own Vite on MDR_PORT (default 5276)
//   MDR_BASE=http://localhost:5299 node bench/verify/fixF-web-drop.mjs   # an already running renderer
//
// Headless Chromium; global timeout 120 s; the Vite it starts is killed in finally.
import { chromium } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.MDR_PORT || 5276);
const BASE = process.env.MDR_BASE || `http://localhost:${PORT}`;
const OWN_SERVER = !process.env.MDR_BASE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  const line = `${name}${detail ? ` — ${detail}` : ''}`;
  if (cond) { pass++; console.log(`  ok   ${line}`); } else { failures.push(line); console.log(`  FAIL ${line}`); }
};
function killPort(port) {
  try {
    const pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
    for (const pid of pids.split(/\s+/).filter(Boolean)) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
  } catch { /* nothing */ }
}
async function waitForServer(url, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* not up */ }
    await sleep(200);
  }
  return false;
}
async function until(page, fn, arg, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, arg).catch(() => undefined);
    if (last) return last;
    await sleep(80);
  }
  return last;
}

const watchdog = setTimeout(() => {
  console.log('GLOBAL TIMEOUT after 120 s');
  if (OWN_SERVER) killPort(PORT);
  process.exit(2);
}, 120_000);

let vite = null;
let browser = null;
try {
  if (OWN_SERVER) {
    killPort(PORT);
    vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    if (!(await waitForServer(BASE))) throw new Error(`vite did not come up on ${BASE}`);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE);
  await until(page, () => !!window.__mdr, null, 30000);

  page.evaluate(() => {
    window.__maxDialogs = 0;
    new MutationObserver(() => {
      window.__maxDialogs = Math.max(window.__maxDialogs, document.querySelectorAll('.mdr-dialog').length);
    }).observe(document.body, { childList: true, subtree: true });
  });
  const drop = (name, text) => page.evaluate(([n, t]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([t], n, { type: 'text/markdown' }));
    const target = document.querySelector('.mdr-app') || document.querySelector('#app') || document.body.firstElementChild;
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return target.className || target.id || target.tagName;
  }, [name, text]);
  const clickBtn = (label) => page.evaluate((l) => {
    const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === l);
    if (b) b.click();
    return !!b;
  }, label);
  const text = () => page.evaluate(() => window.__mdr.app.getText());
  const dialogCount = () => page.evaluate(() => document.querySelectorAll('.mdr-dialog').length);

  // 1. dirty → 新建 (question up) → drop b.md → 丢弃 → b.md is on screen.
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.type('web dirty text', { delay: 5 });
  await page.evaluate(() => window.__mdr.app.registry.run('file.new'));
  await until(page, () => document.querySelectorAll('.mdr-dialog').length === 1);
  const target = await drop('dropped-b.md', '# Dropped B\n\nbody');
  await sleep(600);
  check('drop while the question is up: still one question', (await dialogCount()) === 1, `target ${target}`);
  check('… dropped file not opened yet', (await text()) === 'web dirty text');
  await clickBtn('丢弃');
  const opened = await until(page, () => window.__mdr.app.getText() === '# Dropped B\n\nbody');
  check('丢弃 → the dropped file is opened afterwards (was: silently dropped)', !!opened, JSON.stringify((await text()).slice(0, 40)));
  check('no second question for the clean untitled document', (await dialogCount()) === 0);
  check('title names it', (await page.title()).includes('dropped-b.md'), await page.title());

  // 2. dirty → 新建 → drop → 取消 → the drop asks its own question → 取消 keeps the text.
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.type(' edited', { delay: 5 });
  const before = await text();
  await page.evaluate(() => window.__mdr.app.registry.run('file.new'));
  await until(page, () => document.querySelectorAll('.mdr-dialog').length === 1);
  await drop('dropped-c.md', '# C');
  await sleep(400);
  await clickBtn('取消');
  const asked = await until(page, () => document.querySelectorAll('.mdr-dialog').length === 1);
  check('取消 on 新建 → the dropped file asks its own question', !!asked);
  await clickBtn('取消');
  await sleep(400);
  check('取消 there too → the text is kept', (await text()) === before, JSON.stringify((await text()).slice(0, 40)));
  check('never two questions at once', (await page.evaluate(() => window.__maxDialogs)) === 1, `max ${await page.evaluate(() => window.__maxDialogs)}`);
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('ran to the end', false, String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err));
} finally {
  clearTimeout(watchdog);
  if (browser) await browser.close().catch(() => {});
  if (vite) { try { process.kill(vite.pid, 'SIGKILL'); } catch { /* gone */ } killPort(PORT); }
}
console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
