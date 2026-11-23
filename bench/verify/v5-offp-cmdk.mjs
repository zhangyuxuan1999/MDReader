// bench/verify/v5-offp-cmdk.mjs — verify-off-preview: reduced form of v5-offp-fuzz seed 23 op 37 (switch OFF): preview
// mode, a long document (2000-row table + 5000-item list), an Alt-click on a table cell near the top (the editor's
// caret goes there), the preview scrolled deep, a right-click + Escape on deep text, then ⌘K (an editor command run
// from outside the editor: App switches to split, focuses the editor, inserts the link). Prints per build and run:
// the editor's caret line, the editor's top line, the preview's top block / offset, and the source's changed line.
//   MDR_PORT=5485 MDR_BASE_PORT=5495 MDR_CAND_PERF=1 node bench/verify/v5-offp-cmdk.mjs [runs]
// Global timeout 115 s. Writes nothing into the tree.
import { chromium } from '@playwright/test';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115000);
const RUNS = Number(process.argv[2] || 2);
const DOC = ['# Big', '', 'Intro paragraph above the table.', '', '| n | name | value |', '|---|---|---|',
  ...Array.from({ length: 2000 }, (_, i) => `| ${i} | row name ${i} | value ${i * 7} |`), '',
  ...Array.from({ length: 5000 }, (_, i) => `- item ${i} text`), '', 'Tail paragraph.', ''].join('\n');
const browsers = [];
async function run(kind) {
  const port = kind === 'cand' ? process.env.MDR_PORT : process.env.MDR_BASE_PORT;
  const b = await chromium.launch({ headless: true }); browsers.push(b);
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' });
  await ctx.addInitScript(() => { try { localStorage.setItem('mdr.previewEdit', '0'); } catch { /* */ } });
  const p = await ctx.newPage();
  await p.goto(`http://localhost:${port}/?mode=preview${kind === 'base' || process.env.MDR_CAND_PERF ? '&perf=1' : ''}`);
  await p.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  await p.evaluate(() => { for (const h of document.querySelectorAll('.mdr-perf')) h.style.display = 'none'; document.documentElement.style.zoom = '0.67'; });
  await p.evaluate((t) => window.__mdr.loadText(t, 'big.md'), DOC);
  await p.evaluate(() => window.__mdr.waitIdle()); await sleep(800);
  const at = async (needle) => p.evaluate((needle) => { const root = document.querySelector('.mdr-preview'); const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(needle); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); const q = r.getBoundingClientRect(); if (q.top > root.getBoundingClientRect().top && q.bottom < root.getBoundingClientRect().bottom) return { x: q.left + 1, y: q.top + q.height / 2 }; } } return null; }, needle);
  const cell = await at('row name 5');
  await p.keyboard.down('Alt'); await p.mouse.click(cell.x, cell.y); await p.keyboard.up('Alt'); await sleep(500);
  await p.evaluate(() => { const n = window.__mdr.app.getText().split('\n').length; window.__mdr.app.preview.scrollToLine(Math.round(n * 0.32), 0, 'instant'); }); await sleep(1500);
  const deep = await p.evaluate(() => { const root = document.querySelector('.mdr-preview'); const ps = Array.from(root.querySelectorAll('li')).find((e) => { const r = e.getBoundingClientRect(); return r.top > root.getBoundingClientRect().top + 100 && r.bottom < root.getBoundingClientRect().bottom - 100; }); const r = ps.getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2, t: ps.textContent }; });
  await p.mouse.click(deep.x, deep.y, { button: 'right' }); await sleep(200); await p.keyboard.press('Escape'); await sleep(200);
  const before = await p.evaluate(() => { const v = window.__mdr.app.editor.view; return v.state.doc.lineAt(v.state.selection.main.head).number; });
  await p.keyboard.press('Meta+k'); await sleep(1500);
  const o = await p.evaluate(() => {
    const v = window.__mdr.app.editor.view; const s = document.querySelector('.cm-scroller'); const root = document.querySelector('.mdr-preview');
    const top = v.state.doc.lineAt(v.lineBlockAtHeight(s.scrollTop).from).number;
    const secs = Array.from(root.querySelectorAll('section.md-block')); const pb = root.getBoundingClientRect();
    const first = secs.find((x) => x.getBoundingClientRect().bottom > pb.top + 2);
    return { caret: v.state.doc.lineAt(v.state.selection.main.head).number, edTop: top, edFocus: v.hasFocus, pvTop: first ? first.dataset.id + '+' + Math.round(pb.top - first.getBoundingClientRect().top) : null, pvRaw: Math.round(root.scrollTop), mode: document.querySelector('#app')?.dataset.mode };
  });
  await b.close();
  return { caretBefore: before, deepText: deep.t, ...o };
}
try {
  for (let i = 0; i < RUNS; i++) {
    const [c, bb] = await Promise.all([run('cand'), run('base')]);
    console.log('run', i, JSON.stringify({ cand: c, base: bb }));
  }
} finally {
  clearTimeout(killer);
  for (const b of browsers) await b.close().catch(() => {});
}
