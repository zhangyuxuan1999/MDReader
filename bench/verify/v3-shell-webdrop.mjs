// bench/verify/v3-shell-webdrop.mjs — verify-shell (0.2.0 stage 2c): SHELL-3 on the WEB page. A Markdown
// file dropped (CDP Input.dispatchDragEvent) onto the editor pane of a clean document. 0.1.1 opens the
// dropped file; the question is whether the candidate first lets CodeMirror insert the file's text.
//   MDR_BASE_URL=http://localhost:5385/ MDR_V2_TMP=<scratch> node bench/verify/v3-shell-webdrop.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.MDR_BASE_URL || 'http://localhost:5385/';
const dir = fs.mkdtempSync(path.join(process.env.MDR_V2_TMP || os.tmpdir(), 'v3-webdrop-'));
const file = path.join(dir, 'v3-webdrop.md');
fs.writeFileSync(file, '# 标题 webdrop\n\nmarker-webdrop-dropped\n', 'utf8');
const timer = setTimeout(() => { console.log('FAIL global timeout'); process.exit(2); }, 90000);
const browser = await chromium.launch({ headless: true });
let code = 1;
try {
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await page.waitForTimeout(800);
  const pt = await page.evaluate(() => { const r = document.querySelector('.cm-content').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 10 }; });
  const before = await page.evaluate(() => ({ title: document.title, text: document.querySelector('.cm-content').textContent.slice(0, 40) }));
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: [file], dragOperationsMask: 1 | 2 | 16 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: pt.x, y: pt.y, data });
  await page.waitForTimeout(2000);
  const after = await page.evaluate(() => ({
    title: document.title,
    text: document.querySelector('.cm-content').textContent,
    buttons: [...document.querySelectorAll('.mdr-dialog__btn')].map((b) => b.textContent.trim()),
  }));
  const ok = !after.title.startsWith('●') && after.buttons.length === 0 && after.text.includes('marker-webdrop-dropped') && after.text.length < 60;
  console.log(`${ok ? 'PASS' : 'FAIL'} [webdrop] ${BASE}: before=${JSON.stringify(before)} after=${JSON.stringify({ ...after, text: after.text.slice(0, 120), len: after.text.length })}`);
  code = ok ? 0 : 1;
} finally {
  clearTimeout(timer);
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}
