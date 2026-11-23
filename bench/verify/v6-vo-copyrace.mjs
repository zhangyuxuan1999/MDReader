// bench/verify/v6-vo-copyrace.mjs — verify-off (0.2.0 stage 2f, round 5): copies with 预览可编辑 OFF, candidate against
// 0.1.1, for the focus race the integrator suspected (bench/electron/v5-offk-copy.mjs range-list-only once copied the
// editor's line on the candidate). A REAL USER page (no ?perf=1); the document arrives by a dropped file. Per round:
// the editor focused (a click, caret on a line), then a DOM range made in the preview (list only / paragraph to table /
// math to list / everything), then after d ms (0, 16, 60, 250) a copy by ⌘C or by document.execCommand('copy') (what
// the desktop menu's Copy role does), optionally with the editor blurred or re-focused in between. The headless
// (in-memory) clipboard's text/plain and text/html are read and hashed; both builds run the same rounds alternately.
//   [VO_D=0] node bench/verify/v6-vo-copyrace.mjs <candPort> <basePort> [rounds=2]     VO_D: only the variants with that delay
//   With VERBOSE=1 every outcome is printed; a count of the outcomes that copied the editor's line (text/html empty) per build.
// Prints per variant the outcomes of both builds and SAME / DIFF. Global timeout 115 s. Writes nothing.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';

const [pa, pb] = process.argv.slice(2, 4);
const ROUNDS = Number(process.argv[4] || 2);
const NL = String.fromCharCode(10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => createHash('sha1').update(String(s).replace(/localhost:[0-9]+/g, 'localhost:PORT')).digest('hex').slice(0, 10);
const DOC = ['# 复制检查 Copy', '', '第一段文字 first paragraph.', '', '- 列表一 item one', '- 列表二 item two', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '$$', 'a^2+b^2', '$$', '', '- [ ] 任务 task', '', '```js', 'let x = 1;', '```', '', '最后一段 last paragraph.', ''].join(NL);
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const browser = await chromium.launch({ headless: true });
const RANGES = { list: ['ul', 'ul'], 'p-table': ['p', 'table'], 'math-list': ['.md-math, .katex-display', 'ul:last-of-type'], all: [null, null] };
const VARIANTS = [];
for (const r of Object.keys(RANGES)) for (const d of [0, 16, 60, 250]) for (const how of ['key', 'exec']) VARIANTS.push({ r, d, how, focus: 'editor' });
for (const r of ['list', 'p-table']) for (const focus of ['blur-between', 'refocus-between']) VARIANTS.push({ r, d: 30, how: 'key', focus });
if (process.env.VO_D !== undefined) { const keep = VARIANTS.filter((v) => String(v.d) === process.env.VO_D); VARIANTS.length = 0; VARIANTS.push(...keep); }
const out = {};
try {
  const pages = {};
  for (const port of [pa, pb]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${port}` });
    await ctx.addInitScript(() => { try { localStorage.removeItem('mdr.previewEdit'); } catch {} });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${port}/`);
    await page.waitForSelector('.cm-content', { timeout: 30000 });
    await sleep(500);
    const dt = await page.evaluateHandle((t) => { const d = new DataTransfer(); d.items.add(new File([t], 'copy.md', { type: 'text/markdown' })); return d; }, DOC);
    for (const ev of ['dragenter', 'dragover', 'drop']) await page.dispatchEvent('.mdr-preview', ev, { dataTransfer: dt });
    await page.waitForFunction(() => /最后一段/.test(document.querySelector('.mdr-preview')?.textContent || ''), null, { timeout: 15000 });
    await sleep(1000);
    pages[port] = page;
  }
  for (let round = 0; round < ROUNDS; round++) {
    for (const v of VARIANTS) {
      const key = `${v.r}/${v.d}/${v.how}/${v.focus}`;
      for (const port of round % 2 ? [pb, pa] : [pa, pb]) {
        const page = pages[port];
        await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'));
        await page.click('.cm-line >> nth=2');
        await sleep(60);
        await page.evaluate(([a, b]) => {
          const root = document.querySelector('.mdr-preview'); const g = document.createRange();
          if (!a) g.selectNodeContents(root);
          else { const x = root.querySelector(a), y = [...root.querySelectorAll(b)].pop(); g.setStartBefore(x); g.setEndAfter(y); }
          const s = getSelection(); s.removeAllRanges(); s.addRange(g);
        }, RANGES[v.r]);
        if (v.focus === 'blur-between') { await sleep(v.d); await page.evaluate(() => document.activeElement?.blur?.()); }
        else if (v.focus === 'refocus-between') { await sleep(v.d); await page.evaluate(() => document.querySelector('.cm-content').focus({ preventScroll: true })); }
        await sleep(v.d);
        if (v.how === 'key') await page.keyboard.press('Meta+C');
        else await page.evaluate(() => document.execCommand('copy'));
        await sleep(120);
        const c = await page.evaluate(async () => {
          const items = await navigator.clipboard.read(); const o = {};
          for (const it of items) for (const t of it.types) o[t] = await (await it.getType(t)).text();
          return { o, active: document.activeElement?.className?.toString().split(' ')[0] || document.activeElement?.nodeName };
        });
        const res = `${hash(c.o['text/plain'] ?? '')}:${hash(c.o['text/html'] ?? '')}:${(c.o['text/plain'] ?? '').slice(0, 14).replace(/\n/g, '⏎')}:${c.active}`;
        ((out[key] ??= {})[port] ??= []).push(res);
      }
    }
  }
  let same = 0, diff = 0;
  for (const [k, o] of Object.entries(out)) {
    const a = o[pa].join(' | '), b = o[pb].join(' | ');
    if (a === b) same++; else { diff++; console.log(`DIFF ${k}: cand ${a}  base ${b}`); }
  }
  const editorLine = (port) => Object.values(out).flatMap((o) => o[port]).filter((r) => r.split(':')[1] === 'da39a3ee5e').length;
  const total = (port) => Object.values(out).flatMap((o) => o[port]).length;
  if (process.env.VERBOSE) for (const [k, o] of Object.entries(out)) console.log(`  ${k}: cand ${o[pa].join(' | ')}  base ${o[pb].join(' | ')}`);
  console.log(`variants=${VARIANTS.length} rounds=${ROUNDS} same=${same} diff=${diff}; copies that took the editor's line instead of the preview range: cand ${editorLine(pa)}/${total(pa)} base ${editorLine(pb)}/${total(pb)}`);
  console.log('sample: ' + Object.entries(out).slice(0, 4).map(([k, o]) => `${k}=${o[pa][0]}`).join(' ; '));
} finally {
  clearTimeout(KILL);
  await browser.close();
}
