// bench/verify/r4-rel-default.mjs — fix-release (round 4): the release configuration of 0.2.0 on a PRODUCTION build
// (release decision for 0.2.0, CONTRACT §11). 预览可编辑 is OFF for a user who stored nothing (or a damaged value),
// ON only where the test hooks are installed (?perf=1) and nothing is stored; a stored 1 / 0 is respected.
//   npx vite build --outDir <scratch>/dist-rel --emptyOutDir && npx vite preview --outDir <scratch>/dist-rel --port 5477 --strictPort
//   MDR_PORT=5477 node bench/verify/r4-rel-default.mjs [case-prefix]      (or MDR_URL=http://localhost:5477/)
// Cases: user-default (a), perf-default / perf-stored-0 (b), damaged:<value> (c). Driven through the DOM and the keyboard
// only (a production build without ?perf=1 has no window.__mdr): the document is typed into the editor with insertText.
// Headless Chromium, one fresh context per case. Global timeout 110 s. Writes nothing.
import { chromium } from '@playwright/test';

const BASE = (process.env.MDR_URL || `http://localhost:${process.env.MDR_PORT || 5477}/`).replace(/\/?$/, '/');
const only = process.argv[2] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
let browser = null;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 110_000);

const PARAS = Array.from({ length: 120 }, (_, i) => `Para ${i + 1} text of the release check, long enough to wrap a little in the preview pane.`);
const DOC = `# Release check\n\n${PARAS.join('\n\n')}\n`;

const pressed = (page) => page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? null);
const stored = (page) => page.evaluate(() => { try { return localStorage.getItem('mdr.previewEdit'); } catch { return 'ERR'; } });
const editable = (page) => page.evaluate(() => document.querySelectorAll('[contenteditable="true"]:not(.cm-content)').length);
const marker = (page) => page.evaluate(() => { const m = document.querySelector('[data-stat="mode"]'); return { attr: m?.dataset.previewEdit ?? null, text: m?.textContent ?? '' }; });
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent));
const source = (page) => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));
const scrollTop = (page) => page.evaluate(() => Math.round(document.querySelector('.mdr-preview').scrollTop));

async function ready(page) {
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await page.waitForSelector('[data-cmd="view.togglePreviewEdit"]', { timeout: 20000 });
  await sleep(500);
}
async function open(url, storedValue) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await ready(page);
  if (storedValue !== undefined) {
    await page.evaluate((v) => { localStorage.clear(); localStorage.setItem('mdr.previewEdit', v); }, storedValue);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(page);
  }
  return { context, page };
}
/** Types DOC into the editor (no hooks needed), puts the editor's caret at the start, the preview at the top. */
async function loadDoc(page) {
  await page.click('.cm-content');
  await page.keyboard.press('Meta+a');
  await page.keyboard.insertText(DOC);
  await sleep(900);
  await page.keyboard.press('Meta+ArrowUp');
  await sleep(700);
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
  await sleep(500);
}
/** A point inside the text of the preview paragraph that holds `needle`. */
const pointOf = (page, needle) => page.evaluate((t) => {
  const p = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes(t));
  if (!p) return null;
  const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = n.data.indexOf(t); if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i + 2); r.setEnd(n, i + 3);
    const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 };
  }
  return null;
}, needle);
async function clickPara(page, needle) {
  const p = await pointOf(page, needle);
  if (!p) return false;
  await page.mouse.click(p.x, p.y);
  await sleep(400);
  return true;
}
const toggleKey = async (page) => { await page.keyboard.press('Meta+Shift+KeyE'); await sleep(300); };

const CASES = {
  async 'user-default'() {
    const { context, page } = await open(BASE);
    try {
      check('(a) production build, nothing stored: no window.__mdr (no test hooks)', await page.evaluate(() => window.__mdr === undefined));
      check('(a) the toolbar button is not pressed', (await pressed(page)) === 'false', String(await pressed(page)));
      check('(a) the button title names 实验性', (await page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]').title)).startsWith('预览可编辑（实验性）'));
      check('(a) nothing was stored at startup', (await stored(page)) === null, String(await stored(page)));
      await loadDoc(page);
      check('(a) no contenteditable in the preview at rest', (await editable(page)) === 0);
      check('(a) clicked a paragraph', await clickPara(page, 'Para 3 text'));
      check('(a) a click starts no session (no contenteditable anywhere)', (await editable(page)) === 0, String(await editable(page)));
      const m0 = await marker(page);
      check('(a) no session marker in the status bar', m0.attr === null && !m0.text.includes('预览编辑'), JSON.stringify(m0));
      const t0 = await scrollTop(page);
      await page.keyboard.press('Space');
      await sleep(600);
      const t1 = await scrollTop(page);
      check('(a) Space pages the preview', t1 - t0 > 200, `${t0} → ${t1}`);
      const srcBefore = await source(page);
      // the editor renders only its viewport, which the preview's paging moved: every rendered paragraph line unchanged
      const shownParas = srcBefore.split('\n').filter((l) => l.startsWith('Para '));
      check('(a) Space wrote nothing into the source', shownParas.length > 5 && shownParas.every((l) => PARAS.includes(l)), `${shownParas.length} lines, first ${JSON.stringify(shownParas[0])}`);
      // ⌘⇧E turns it on, with the 实验性 toast
      await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
      await sleep(400);
      await toggleKey(page);
      check('(a) ⌘⇧E turns it on: button pressed, stored 1', (await pressed(page)) === 'true' && (await stored(page)) === '1', `${await pressed(page)} ${await stored(page)}`);
      const tt = await toasts(page);
      check('(a) the toast reads 预览可编辑（实验性）：开', tt.includes('预览可编辑（实验性）：开'), JSON.stringify(tt));
      check('(a) clicked a paragraph (on)', await clickPara(page, 'Para 3 text'));
      check('(a) on: a click starts a session', (await editable(page)) === 1, String(await editable(page)));
      const m1 = await marker(page);
      check('(a) on: the status bar shows the session marker', m1.attr === '1' && m1.text.includes('预览编辑'), JSON.stringify(m1));
      await page.keyboard.type('ZQ');
      await sleep(800);
      const src1 = await source(page);
      const zq = src1.split('\n').filter((l) => l.includes('ZQ'));
      check('(a) on: typing reaches the source', zq.length === 1 && zq[0].replace('ZQ', '') === PARAS[2], JSON.stringify(zq));
      await page.keyboard.press('Escape');
      await sleep(300);
      // a reload keeps it on
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ready(page);
      check('(a) after a reload it is still on (stored 1)', (await pressed(page)) === 'true' && (await stored(page)) === '1', `${await pressed(page)} ${await stored(page)}`);
      // turning it off stores 0, the toast says 关, a reload keeps it off
      await page.click('.mdr-preview', { position: { x: 5, y: 5 } }).catch(() => {});
      await toggleKey(page);
      const tt2 = await toasts(page);
      check('(a) ⌘⇧E turns it off: button not pressed, stored 0', (await pressed(page)) === 'false' && (await stored(page)) === '0', `${await pressed(page)} ${await stored(page)}`);
      check('(a) the toast reads 预览可编辑：关', tt2.includes('预览可编辑：关'), JSON.stringify(tt2));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ready(page);
      check('(a) after a reload it is still off (stored 0)', (await pressed(page)) === 'false' && (await stored(page)) === '0', `${await pressed(page)} ${await stored(page)}`);
      await loadDoc(page);
      check('(a) clicked a paragraph (off again)', await clickPara(page, 'Para 5 text'));
      check('(a) off again: a click starts no session', (await editable(page)) === 0, String(await editable(page)));
    } finally { await context.close(); }
  },
  async 'perf-default'() {
    const { context, page } = await open(`${BASE}?perf=1`);
    try {
      check('(b) ?perf=1 has the test hooks', await page.evaluate(() => typeof window.__mdr === 'object'));
      check('(b) ?perf=1, nothing stored: on', (await pressed(page)) === 'true' && (await page.evaluate(() => window.__mdr.app.preview.isPreviewEditable?.() ?? null)) !== false, String(await pressed(page)));
      check('(b) ?perf=1, nothing stored: nothing written at startup', (await stored(page)) === null);
    } finally { await context.close(); }
  },
  async 'perf-stored-0'() {
    const { context, page } = await open(`${BASE}?perf=1`, '0');
    try {
      check('(b) ?perf=1, stored 0: off', (await pressed(page)) === 'false', String(await pressed(page)));
      await loadDoc(page);
      check('(b) clicked a paragraph', await clickPara(page, 'Para 3 text'));
      check('(b) ?perf=1, stored 0: a click starts no session', (await editable(page)) === 0);
    } finally { await context.close(); }
  },
};
for (const v of ['yes', '', 'null', '2']) {
  CASES[`damaged:${JSON.stringify(v)}`] = async () => {
    const { context, page } = await open(BASE, v);
    try {
      check(`(c) stored ${JSON.stringify(v)}: off for a user`, (await pressed(page)) === 'false', String(await pressed(page)));
      check(`(c) stored ${JSON.stringify(v)}: left as it was`, (await stored(page)) === v, JSON.stringify(await stored(page)));
      await loadDoc(page);
      check(`(c) stored ${JSON.stringify(v)}: clicked a paragraph`, await clickPara(page, 'Para 3 text'));
      check(`(c) stored ${JSON.stringify(v)}: a click starts no session`, (await editable(page)) === 0);
    } finally { await context.close(); }
  };
}

try {
  browser = await chromium.launch({ headless: true });
  console.log(`target ${BASE}`);
  for (const [name, fn] of Object.entries(CASES)) {
    if (only && !name.startsWith(only)) continue;
    try { await fn(); } catch (e) { check(`${name} threw`, false, String(e && e.stack || e).slice(0, 300)); }
  }
} finally {
  clearTimeout(KILL);
  await browser?.close().catch(() => {});
  console.log(`r4-rel-default: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
