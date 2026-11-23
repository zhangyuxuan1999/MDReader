// bench/electron/v5-offk-copy.mjs — verify-off-desktop (0.2.0 r4 verification): copying from the preview of the
// desktop window with the switch OFF, compared byte for byte (text/plain and text/html) with the 0.1.1 shell:
//   MDR_OFFK_TMP=<scratch> MDR_TARGET=cand|base node bench/electron/v5-offk-copy.mjs > x.log
//   node bench/electron/v5-offk-menu.mjs --compare cand.log base.log
// Selections are made with the real mouse (drag) or with a DOM range, copied with the menu role's call
// (webContents.copy) and with ⌘C. The user's clipboard is saved inside the main process first and written back at
// the end (never printed); only this script's own document text is printed (sha1 + length + a prefix).
// Launch only through ./_electron.mjs. No full screen. Global timeout 110 s.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = process.env.MDR_TARGET === 'base' ? path.join(ROOT, 'release/baseline-0.1.1.noindex') : path.join(ROOT, 'release/staging-0.2.0.noindex');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_OFFK_TMP || os.tmpdir(), 'offk-copy-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app = null, page = null;
async function quit() {
  if (!app) return;
  const a = app; app = null;
  const pid = a.process()?.pid;
  try { await a.evaluate(async ({ clipboard }) => { const s = globalThis.__offkClip; if (!s) return; if (s.length) await clipboard.write(s); else clipboard.clear(); }); } catch { /* */ }
  try { await Promise.race([a.evaluate(({ app: x }) => { setTimeout(() => x.exit(0), 20); }), sleep(3000)]); } catch { /* gone */ }
  if (pid) for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch { break; } if (i === 25) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } } await sleep(150); }
  await Promise.race([a.close().catch(() => {}), sleep(3000)]);
}
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await quit(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(3); }, 110_000);
const DOC = [
  '# 复制检查 Copy',
  '',
  '普通段落，含 **粗体**、*斜体*、`代码`、[链接](https://example.com/x) 与 ~~删除线~~。',
  '',
  '公式 $E=mc^2$ 在行内，后面还有文字。',
  '',
  '$$',
  '\\int_0^1 x^2\\,dx = \\frac{1}{3}',
  '$$',
  '',
  '- [ ] 任务一',
  '- [x] 任务二',
  '  - 子项',
  '',
  '| 列A | 列B |',
  '|---|---|',
  '| 1 | 二 |',
  '',
  '```js',
  'const a = 1; // 注释',
  '```',
  '',
  '> 引用的文字',
  '',
  '1. 第一',
  '2. 第二',
  '',
  '<div><b>raw</b> html 块</div>',
  '',
  '最后一段。',
  '',
].join('\n');
const out = (k, o) => console.log(`OBS ${k} ${JSON.stringify(o)}`);
const clip = () => app.evaluate(async ({ clipboard }) => {
  const r = { text: String(await clipboard.readText()), html: '' };
  for (const it of await clipboard.read()) if (it.types.includes('text/html')) r.html = await (await it.getType('text/html')).text();
  return r;
});
const sum = (s) => ({ len: s.length, head: s.slice(0, 60), tail: s.slice(-40) });
const BLOCKS = ['h1', 'p:nth-of-type(1)', '.katex, .md-math', 'ul', 'table', 'pre', 'blockquote', 'ol'];
try {
  const f = path.join(TMP, 'copy.md'); fs.writeFileSync(f, DOC);
  app = await electron.launch({ args: [DIR, f, `--user-data-dir=${path.join(TMP, 'prof')}`], timeout: 30000 });
  page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => /最后一段/.test(document.querySelector('.mdr-preview')?.textContent || ''), null, { timeout: 15000 });
  await app.evaluate(async ({ clipboard }) => { globalThis.__offkClip = await clipboard.read(); });
  await sleep(1500);
  // 1. DOM ranges over single blocks and over everything, copied by the role call
  const ranges = { all: null, 'p-to-table': ['p', 'table'], 'math-to-list': ['.katex-display, .md-math', 'ul'], 'list-only': ['ul', 'ul'], 'code-to-end': ['pre', 'p:last-of-type'] };
  for (const [name, r] of Object.entries(ranges)) {
    await page.evaluate((rr) => {
      const root = document.querySelector('.mdr-preview'); const s = getSelection(); const g = document.createRange();
      if (!rr) g.selectNodeContents(root); else { const a = root.querySelector(rr[0]); const b = [...root.querySelectorAll(rr[1])].pop(); g.setStartBefore(a); g.setEndAfter(b); }
      s.removeAllRanges(); s.addRange(g);
    }, r);
    await app.evaluate(async ({ clipboard }) => { await clipboard.writeText('<<offk>>'); });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.copy());
    await sleep(500);
    const c = await clip();
    out(`range-${name}`, { text: sum(c.text), textFull: c.text.length < 600 ? c.text : undefined, html: sum(c.html.replace(/data-mdr-x=""/g, '')), htmlLen: c.html.length });
  }
  // 2. a real mouse drag over the first paragraph, then ⌘C
  const pts = await page.evaluate(() => { const p = document.querySelector('.mdr-preview p'); const r = p.getBoundingClientRect(); return { x0: r.left + 3, y: r.top + 8, x1: r.right - 10 }; });
  await page.mouse.move(pts.x0, pts.y); await page.mouse.down(); await page.mouse.move(pts.x1, pts.y + 2, { steps: 8 }); await page.mouse.up();
  await sleep(300);
  await app.evaluate(async ({ clipboard }) => { await clipboard.writeText('<<offk>>'); });
  await page.keyboard.press('Meta+c');
  await sleep(500);
  const c2 = await clip();
  out('drag-cmd-c', { sel: await page.evaluate(() => getSelection().toString()), text: c2.text, html: sum(c2.html) });
  // 3. a double click on a word in the task list and the menu copy
  const w = await page.evaluate(() => { const li = document.querySelector('.mdr-preview ul li'); const n = [...li.childNodes].find((x) => x.nodeType === 3 && x.textContent.trim()); const g = document.createRange(); g.setStart(n, Math.min(2, n.length - 1)); g.setEnd(n, Math.min(3, n.length)); const b = g.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; });
  await page.mouse.dblclick(w.x, w.y); await sleep(300);
  await app.evaluate(async ({ clipboard }) => { await clipboard.writeText('<<offk>>'); });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.copy()); await sleep(500);
  out('dbl-task-word', { sel: await page.evaluate(() => getSelection().toString()), text: (await clip()).text });
  out('source-unchanged', { same: await page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n')) === DOC.replace(/\n$/, '\n').split('\n').join('\n').replace(/\n$/, '\n') ? 'yes' : 'check', title: await page.evaluate(() => document.title) });
} catch (e) {
  console.log('THREW', String(e).split('\n')[0]);
} finally {
  clearTimeout(KILL);
  await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
}
