// bench/verify/v5-rev-taskrest.mjs — verify-review (0.2.0 round 4): the switch-OFF invariant of the tick, at rest.
// For every task item's own checkbox in the preview DOM, the ONE answer (createPreview taskLine) must be the line
// blockStart + data-l when that source line is a task line (else 'none'), and that line must hold the item's text.
// Checked after loading documents, after scrolling / jumping, after random editor-pane edits (also with the preview
// hidden while editing, then shown), always at rest (waitIdle). Switch OFF: mdr.previewEdit = '0' stored before start.
// Run: MDR_PORT=5487 node bench/verify/v5-rev-taskrest.mjs [docs|edits|hidden|all] [seed]
// Writes nothing into the tree. Global timeout 100 s.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const what = process.argv[2] || 'all';
let seed = Number(process.argv[3] || 1);
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = new URL('../../', import.meta.url).pathname;

const SYN = [
  'Intro', '',
  '- [ ] a1 alpha', '- [x] a2 beta', '  - [ ] a3 nested', '    - [ ] a4 deeper', '- [ ] a5 **bold** item', '',
  '1. [ ] b1 ordered', '2) [x] b2 paren', '', '> - [ ] c1 quoted', '> - [x] c2 quoted', '>', '> > - [ ] c3 double', '',
  '* [ ] d1 star', '+ [X] d2 plus', '', '- [ ] e1 loose', '', '- [ ] e2 loose', '', '  continued e2', '',
  '- - [ ] f1 never', '1. - [ ] f2 never', '-', '  [ ] f3 nextline', '',
  '| t | u |', '|---|---|', '| - [ ] g1 cell | x |', '',
  '<div>', '- [ ] h1 inside html', '</div>', '',
  '- [ ] i1 😀 emoji 𝒳', '- [ ] i2 tab\tchar', 'last line - [ ] not a task',
].join('\n');

const CHECK = () => {
  const pv = window.__mdr.app.preview;
  const root = pv.el;
  const lines = window.__mdr.app.getText().split('\n');
  const TASK = /^(?:\s*>)*\s*(?:[-*+]|\d{1,9}[.)])\s+\[[ xX]\]/;
  const own = (li) => { const c = li.cloneNode(true); c.querySelectorAll('ul,ol').forEach((x) => x.remove()); return (c.textContent || '').replace(/\s+/g, ' ').trim(); };
  const r = { boxes: 0, ok: 0, none: 0, bad: [], text: [], pending: 0 };
  for (const b of root.querySelectorAll('input[type="checkbox"]')) {
    const li = b.closest('li');
    if (!li || !li.classList.contains('task-list-item') || !li.hasAttribute('data-l') || li.querySelector('input[type="checkbox"]') !== b) continue;
    let w = null;
    for (let p = b; p && p !== root; p = p.parentElement) if (p.classList.contains('md-block')) w = p;
    if (!w || w.hasAttribute('data-mdr-x')) continue;
    if (w.classList.contains('is-pending') || w.classList.contains('is-stale')) { r.pending++; continue; }
    r.boxes++;
    const info = pv.blockOfElement(w);
    const rel = Number(li.dataset.l);
    const ln = info ? info.startLine + rel : -1;
    const sl = lines[ln - 1] ?? '';
    const want = info && rel < info.lineCount && TASK.test(sl) ? ln : 'none';
    const got = pv.taskLine(b);
    if (got !== want) r.bad.push({ got, want, ln, sl: sl.slice(0, 60), item: own(li).slice(0, 40), stamp: pv.taskStampOf(w) ?? null, sv: pv.structureVersion?.(), v: window.__mdr.version() });
    else if (got === 'none') r.none++; else r.ok++;
    if (typeof want === 'number') {
      const word = (own(li).match(/[A-Za-z]\w+/) || [''])[0];
      if (word && !sl.includes(word)) r.text.push({ ln, sl: sl.slice(0, 60), item: own(li).slice(0, 40) });
    }
  }
  return r;
};

const tot = { checks: 0, boxes: 0, ok: 0, none: 0, bad: 0, text: 0 };
function add(name, r) {
  tot.checks++; tot.boxes += r.boxes; tot.ok += r.ok; tot.none += r.none; tot.bad += r.bad.length; tot.text += r.text.length;
  if (r.bad.length || r.text.length) console.log('BAD', name, JSON.stringify({ bad: r.bad.slice(0, 4), text: r.text.slice(0, 3), boxes: r.boxes }));
}

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('mdr.previewEdit', '0'); } catch { /* */ } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`http://localhost:${port}/?mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  const pressed = await page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? 'nobutton');
  if (pressed === 'true') throw new Error('switch is on');
  const idle = async (ms = 250) => { await page.evaluate(() => window.__mdr.waitIdle()); await sleep(ms); };
  const load = async (t, n) => { await page.evaluate(([t, n]) => window.__mdr.loadText(t, n), [t, n]); await idle(400); };
  const scrollTo = async (f) => { await page.evaluate((f) => { const el = window.__mdr.app.preview.el; el.scrollTop = f * (el.scrollHeight - el.clientHeight); }, f); await sleep(250); await idle(250); };

  if (what === 'docs' || what === 'all') {
    const docs = [['syn.md', SYN], ['small.md', readFileSync(ROOT + 'test-data/small.md', 'utf8')], ['medium.md', readFileSync(ROOT + 'test-data/medium.md', 'utf8')],
      ['crlf.md', SYN.replace(/\n/g, '\r\n')], ['nofinal.md', SYN.replace(/\n+$/, '')], ['bom.md', String.fromCharCode(0xfeff) + SYN]];
    if (process.env.MDR_LARGE) docs.push(['large.md', readFileSync(ROOT + 'test-data/large.md', 'utf8')]);
    for (const [n, t] of docs) {
      await load(t, n);
      add(n + ':top', await page.evaluate(CHECK));
      for (let k = 0; k < (n === 'syn.md' || n.startsWith('crlf') || n.startsWith('no') || n.startsWith('bom') ? 2 : 6); k++) {
        const f = k === 0 ? 1 : rnd();
        await scrollTo(f);
        add(`${n}:scroll${f.toFixed(3)}`, await page.evaluate(CHECK));
      }
    }
  }
  if (what === 'edits' || what === 'hidden' || what === 'all') {
    const hidden = what === 'hidden';
    const base = SYN + '\n\n' + readFileSync(ROOT + 'test-data/small.md', 'utf8');
    await load(base, 'edits.md');
    const EDITS = ['insLine', 'delLine', 'col0', 'join', 'dup', 'toggle', 'undo', 'redo', 'blank', 'swap', 'paste'];
    const N = Number(process.env.MDR_N || 40);
    if (hidden) await page.evaluate(() => window.__mdr.mode('edit'));
    for (let i = 0; i < N; i++) {
      const e = EDITS[Math.floor(rnd() * EDITS.length)];
      const at = rnd();
      await page.evaluate(([e, at]) => {
        const v = window.__mdr.app.editor.view;
        const d = v.state.doc;
        const ln = d.line(Math.max(1, Math.min(d.lines, 1 + Math.floor(at * d.lines))));
        const tasks = [];
        for (let k = 1; k <= d.lines; k++) if (/\[[ xX]\]/.test(d.line(k).text)) tasks.push(k);
        const tl = d.line(tasks[Math.floor(at * tasks.length)] || 1);
        const u = (ch) => v.dispatch({ changes: ch, userEvent: 'input' });
        if (e === 'insLine') u({ from: ln.from, insert: '- [ ] n' + Math.floor(at * 1000) + ' new\n' });
        else if (e === 'delLine' && d.lines > 5) u({ from: ln.from, to: Math.min(d.length, ln.to + 1) });
        else if (e === 'col0') u({ from: tl.from, insert: '  ' });
        else if (e === 'join' && ln.number > 1) u({ from: ln.from - 1, to: ln.from });
        else if (e === 'dup') u({ from: tl.to, insert: '\n' + tl.text });
        else if (e === 'toggle') { const i = tl.text.indexOf('['); if (i >= 0) u({ from: tl.from + i + 1, to: tl.from + i + 2, insert: tl.text[i + 1] === ' ' ? 'x' : ' ' }); }
        else if (e === 'undo') window.__mdr.app.editor.view.dispatch && (window.__undo ? 0 : 0);
        else if (e === 'blank') u({ from: tl.from, insert: '\n' });
        else if (e === 'swap' && tl.number < d.lines) { const nx = d.line(tl.number + 1); u([{ from: tl.from, to: nx.to, insert: nx.text + '\n' + tl.text }]); }
        else if (e === 'paste') u({ from: ln.from, insert: '- [ ] p1 pasted\n- [x] p2 pasted\n\ntext\n' });
      }, [e, at]);
      if (e === 'undo' || e === 'redo') { await page.evaluate(() => window.__mdr.app.editor.view.focus()); await page.keyboard.press(e === 'undo' ? 'Meta+z' : 'Meta+Shift+z'); }
      if (!hidden && rnd() < 0.5) { await idle(150); add(`edit${i}:${e}`, await page.evaluate(CHECK)); }
      if (!hidden && rnd() < 0.2) { await scrollTo(rnd()); add(`edit${i}:${e}:scroll`, await page.evaluate(CHECK)); }
    }
    if (hidden) { await page.evaluate(() => window.__mdr.mode('split')); await idle(600); }
    await idle(300);
    for (let k = 0; k < 5; k++) { await scrollTo(k / 4); add(`final:${k}`, await page.evaluate(CHECK)); }
  }
  console.log('TOTAL', JSON.stringify(tot), 'pageerrors', errs.length, errs.slice(0, 2).join(' | '));
} finally {
  clearTimeout(killer);
  await browser.close();
}
