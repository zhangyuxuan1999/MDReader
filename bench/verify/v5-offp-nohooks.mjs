// bench/verify/v5-offp-nohooks.mjs — verify-off-preview: what a user gets. The candidate's production build opened
// WITHOUT ?perf=1 and with nothing stored (no test hooks: the switch must be off by the default rule), against 0.1.1
// opened the same way (no ?perf=1). The document is typed into the editor with insertText (no hooks needed); then the
// same gestures on both: a drag-copy across blocks, a task tick, a second tick, ⌘Z with the focus outside the editor,
// Space / PageDown in the preview, a double-click word copy. Compared: the editor's text (.cm-content), the clipboard
// (text/plain, text/html with the origin made equal), the preview's scrollTop, the toasts, the switch button state.
//   MDR_PORT=5485 MDR_BASE_PORT=5495 node bench/verify/v5-offp-nohooks.mjs
// Global timeout 110 s. Writes nothing into the tree.
import { chromium } from '@playwright/test';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110000);
const DOC = ['# Title', '', 'First paragraph with **bold** and `code` and a [link](https://example.com/a).', '',
  '- [ ] alpha task', '- [ ] beta task', '- [x] gamma task', '', '> quoted text here', '',
  '| a | b |', '|---|---|', '| c1 | c2 |', '',
  ...Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i} with enough words to wrap across the preview line once or twice.`).flatMap((l) => [l, '']),
  'End.', ''].join('\n');
const browsers = [];
async function open(kind) {
  const port = kind === 'cand' ? process.env.MDR_PORT : process.env.MDR_BASE_PORT;
  const b = await chromium.launch({ headless: true }); browsers.push(b);
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'light' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${port}` });
  const p = await ctx.newPage();
  const toasts = [];
  await p.goto(`http://localhost:${port}/?mode=split`);
  await p.waitForSelector('.cm-content', { timeout: 60000 });
  await sleep(800);
  await p.click('.cm-content');
  await p.keyboard.press('Meta+a');
  await p.keyboard.insertText(DOC);
  await sleep(1500);
  await p.evaluate(() => { const s = document.querySelector('.cm-scroller'); s.scrollTop = 0; const r = document.querySelector('.mdr-preview'); r.scrollTop = 0; document.activeElement?.blur?.(); });
  await sleep(600);
  await p.evaluate(() => { window.__nh = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList?.contains('mdr-toast')) window.__nh.push(n.textContent.trim()); }).observe(document.body, { childList: true, subtree: true }); });
  return { p, toasts, kind, hooks: await p.evaluate(() => !!window.__mdr), btn: await p.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? 'none') };
}
const edText = (p) => p.evaluate(() => Array.from(document.querySelectorAll('.cm-content .cm-line')).map((l) => l.textContent).join('\n'));
async function look(S) {
  const p = S.p;
  return p.evaluate(async () => {
    let clip = null;
    try { const items = await navigator.clipboard.read(); clip = {}; for (const it of items) for (const t of it.types) clip[t] = (await (await it.getType(t)).text()).replace(/localhost:\d+/g, 'ORIGIN').replace(/(\?mode=split)?(&amp;|&)?perf=1/g, ''); } catch (e) { clip = String(e); }
    const r = document.querySelector('.mdr-preview');
    return { clip, pv: Math.round(r.scrollTop), toasts: window.__nh.slice(), boxes: Array.from(r.querySelectorAll('li input[type=checkbox]')).map((b) => (b.checked ? 'x' : '_')).join('') };
  });
}
async function pt(p, needle, k = 0) { return p.evaluate(([needle, k]) => { const root = document.querySelector('.mdr-preview'); const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(needle); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + k); r.setEnd(n, i + k + 1); const q = r.getBoundingClientRect(); return { x: q.left + 1, y: q.top + q.height / 2 }; } } return null; }, [needle, k]); }
const STEPS = [
  ['drag-copy', async (p) => { const a = await pt(p, 'First', 2); const b = await pt(p, 'quoted', 3); await p.mouse.move(a.x, a.y); await p.mouse.down(); for (let i = 1; i <= 10; i++) { await p.mouse.move(a.x + (b.x - a.x) * i / 10, a.y + (b.y - a.y) * i / 10); await sleep(25); } await p.mouse.up(); await sleep(150); await p.keyboard.press('Meta+c'); }],
  ['tick-beta', async (p) => { const q = await p.evaluate(() => { const x = Array.from(document.querySelectorAll('.mdr-preview li input')).find((b) => b.closest('li').textContent.includes('beta')); const r = x.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }); await p.mouse.click(q.x, q.y); }],
  ['tick-gamma-60', async (p) => { const q = await p.evaluate(() => { const x = Array.from(document.querySelectorAll('.mdr-preview li input')).find((b) => b.closest('li').textContent.includes('gamma')); const r = x.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }); await p.mouse.click(q.x, q.y); await sleep(60); }],
  ['undo-outside', async (p) => { await p.keyboard.press('Meta+z'); }],
  ['space-pagedown', async (p) => { const q = await pt(p, 'Filler paragraph 1 ', 3); await p.mouse.click(q.x, q.y); await p.keyboard.press('Space'); await sleep(300); await p.keyboard.press('PageDown'); }],
  ['dbl-copy', async (p) => { await p.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; }); await sleep(300); const q = await pt(p, 'bold', 1); await p.mouse.dblclick(q.x, q.y); await sleep(100); await p.keyboard.press('Meta+c'); }],
];
try {
  const [C, B] = await Promise.all([open('cand'), open('base')]);
  console.log('setup', JSON.stringify({ candHooks: C.hooks, candSwitch: C.btn, baseHooks: B.hooks }));
  for (const [nm, fn] of STEPS) {
    await Promise.all([fn(C.p), fn(B.p)]);
    await sleep(900);
    const [c, b] = await Promise.all([look(C), look(B)]);
    const [ec, eb] = await Promise.all([edText(C.p), edText(B.p)]);
    const same = JSON.stringify(c) === JSON.stringify(b) && ec === eb;
    const dk = Object.keys(c).filter((k) => JSON.stringify(c[k]) !== JSON.stringify(b[k]));
    console.log(nm, same ? 'same' : 'DIFF', same ? `boxes=${c.boxes} pv=${c.pv}` : JSON.stringify({ fields: dk, edSame: ec === eb, ...Object.fromEntries(dk.map((k) => [k, { c: k === 'clip' ? JSON.stringify(c[k]).slice(0, 200) : c[k], b: k === 'clip' ? JSON.stringify(b[k]).slice(0, 200) : b[k] }])) }).slice(0, 900));
  }
} finally {
  clearTimeout(killer);
  for (const b of browsers) await b.close().catch(() => {});
}
