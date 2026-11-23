// bench/verify/v5-ptk-ticks.mjs — proto-ticks (0.2.0, checkpoint C: "the tick that does not wait", switch OFF).
// Two parts, run against a candidate (cand, MDR_PORT) or the 0.1.1 build (base, MDR_BASE_PORT, vite preview):
//   lat-<n>-<gap>: a rapid series of 10 ticks in the 100-task list with formulas; per tick: ms from the press to the
//     box showing its tick (rAF poll), ms from the press to the source holding it, and whether the source held it in the
//     same task as the click (a bubble 'change' listener on window reads the editor right after the app's own);
//     flipsBack = boxes that showed ticked and then unticked without a click.
//   latm-<size>-<gap>: the same in a 20- or 40-task formula list (no giant guard: stale HTML mounts between ticks).
//   atk-<edit>-<list>-<delay>: an edit in the editor pane (real keys, or one dispatched transaction for paste and
//     replace-all), then after <delay> ms a real click on the box the preview shows for the target task; afterwards:
//     which tasks are ticked in the source (by name), the toasts, and the verdict: right / nothing+toast / WRONG.
// Run: MDR_PORT=5531 node bench/verify/v5-ptk-ticks.mjs cand [prefix ...]
//      MDR_BASE_PORT=5532 node bench/verify/v5-ptk-ticks.mjs base [prefix ...]
// The switch is stored off ('0') before load. Writes nothing into the tree.
import { chromium } from '@playwright/test';
const target = process.argv[2] || 'cand';
const only = process.argv.slice(3);
const URL = target === 'base' ? `http://localhost:${process.env.MDR_BASE_PORT}/?perf=1&mode=split` : `http://localhost:${process.env.MDR_PORT}/?mode=split`;
if (!(target === 'base' ? process.env.MDR_BASE_PORT : process.env.MDR_PORT)) throw new Error('pass the port of a running server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const giant = (n) => 'Intro\n\n' + Array.from({ length: n }, (_, i) => `- [ ] task${i} $a_{${i}}$ $b^{${i}}$ $c_${i}$ $\\frac{${i}}{2}$`).join('\n') + '\n\nend\n';
const small = (n) => 'Intro\n\n' + Array.from({ length: n }, (_, i) => `- [ ] task${i} word`).join('\n') + '\n\nend\n';
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'light' })).newPage();
page.on('dialog', (d) => d.dismiss().catch(() => {}));
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
async function boot() {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90000 });
  await page.evaluate(() => { try { localStorage.clear(); localStorage.setItem('mdr.previewEdit', '0'); } catch { /* */ } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90000 });
  await sleep(500);
}
const src = () => page.evaluate(() => window.__mdr.app.getText());
async function load(doc) {
  await page.evaluate(() => window.__mdr.app.preview.endEditSession?.());
  await page.evaluate(() => { const el = document.querySelector('.mdr-preview'); if (el) el.scrollTop = 0; });
  await page.evaluate((t) => window.__mdr.loadText(t, 'v.md'), doc);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(600);
  if ((await src()) !== doc) throw new Error('load mismatch');
}
async function install() {
  await page.evaluate(() => {
    const W = window.__ptk2 = { downs: [], changes: [], first: {}, flips: {}, toasts: [], stop: false };
    const boxes = () => Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]'));
    const nameOf = (b) => (b.closest('li')?.textContent || '').trim().split(/\s+/)[0];
    if (!window.__ptkHooked) {
      window.__ptkHooked = true;
      document.addEventListener('pointerdown', (e) => { const w = window.__ptk2; if (e.target instanceof HTMLInputElement) w.downs.push({ name: nameOf(e.target), t: performance.now() }); }, true);
      window.addEventListener('change', (e) => {
        const w = window.__ptk2; const b = e.target; if (!(b instanceof HTMLInputElement)) return;
        const name = nameOf(b); const text = window.__mdr.app.getText();
        const m = text.match(new RegExp('^\\s*[-*+] \\[([ xX])\\] ' + name + '(?![0-9])', 'm'));
        w.changes.push({ name, checked: b.checked, src: m ? m[1] : null, t: performance.now() });
      }, false);
      // the bus, not the DOM: a repeated toast updates the node already shown (a counter) instead of adding one
      window.__mdr.app.bus?.on?.('toast', (e) => window.__ptk2.toasts.push(e.text));
    }
    const last = {};
    const loop = () => {
      const w = window.__ptk2; if (w.stop) return;
      for (const b of boxes()) {
        const k = nameOf(b); const c = b.checked;
        if (last[k] !== undefined && c !== last[k]) (w.flips[k] ??= []).push(`${c ? 'on' : 'off'}@${Math.round(performance.now())}`);
        if (c && w.first[k] === undefined) w.first[k] = performance.now();
        last[k] = c;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}
const readW = () => page.evaluate(() => { window.__ptk2.stop = true; return window.__ptk2; });
/** The centre of the box the preview shows for task `name` now (scrolled into view). */
async function boxOf(name) {
  return page.evaluate((name) => {
    const b = Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]')).find((x) => ((x.closest('li')?.textContent || '').trim().split(/\s+/)[0]).replace(/Z+$/, '') === name);
    if (!b) return null;
    b.scrollIntoView({ block: 'nearest' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, name);
}
async function clickTask(name) { const p = await boxOf(name); if (!p) throw new Error('no box ' + name); await page.mouse.click(p.x, p.y); }
const tickedNames = (s) => (s.match(/^\s*[-*+] \[x\] (task\d+)/gm) || []).map((x) => x.replace(/^.*\] /, ''));
/** Caret to the end (or start) of the line holding `needle` and focus the editor (a selection transaction, no change). */
async function caret(needle, where = 'end') {
  await page.evaluate(([needle, where]) => {
    const v = window.__mdr.app.editor.view;
    const re = new RegExp(needle.replace(/[$]/g, '\\$') + '(?![0-9])');
    const m = re.exec(v.state.doc.toString()); if (!m) throw new Error('no ' + needle);
    const l = v.state.doc.lineAt(m.index);
    v.dispatch({ selection: { anchor: where === 'end' ? l.to : l.from }, scrollIntoView: true });
    v.focus();
  }, [needle, where]);
}
const key = (k) => page.keyboard.press(k);
const typ = (t) => page.keyboard.type(t);
// edits: [name, async fn(list) , target task, expect: 'tick' | 'gone']
const EDITS = [
  ['above-type', async () => { await caret('Intro'); await typ('abc'); }, 'task5', 'tick'],
  ['above-enter', async () => { await caret('Intro'); await key('Enter'); await typ('new'); }, 'task5', 'tick'],
  ['above-2lines', async () => { await caret('Intro'); await key('Enter'); await key('Enter'); await typ('p'); }, 'task5', 'tick'],
  ['own-text', async () => { await caret('task5'); await typ('Z'); }, 'task5', 'tick'],
  ['neighbour-text', async () => { await caret('task4'); await typ('Z'); }, 'task5', 'tick'],
  ['col0-own', async () => { await caret('task5', 'start'); await typ('  '); }, 'task5', 'tick'],
  ['col0-above', async () => { await caret('task4', 'start'); await typ('x'); }, 'task5', 'tick'],
  ['enter-mid', async () => { await caret('task3'); await key('Enter'); }, 'task5', 'tick'],
  ['enter-mid-text', async () => { await caret('task3'); await key('Enter'); await typ('task77 new'); }, 'task5', 'tick'],
  ['del-above', async () => { await caret('task3'); await key('Shift+Meta+k'); }, 'task5', 'tick'],
  ['del-own', async () => { await caret('task5'); await key('Shift+Meta+k'); }, 'task5', 'gone'],
  ['del-two-above', async () => { await caret('task2'); await key('Shift+Meta+k'); await key('Shift+Meta+k'); }, 'task5', 'tick'],
  ['dup-above', async () => { await caret('task3'); await key('Shift+Alt+ArrowDown'); }, 'task5', 'tick'],
  ['dup-own', async () => { await caret('task5'); await key('Shift+Alt+ArrowDown'); }, 'task5', 'tick'],
  ['swap-own-up', async () => { await caret('task5'); await key('Alt+ArrowUp'); }, 'task5', 'tick'],
  ['swap-above', async () => { await caret('task4'); await key('Alt+ArrowUp'); }, 'task5', 'tick'],
  ['swap-below-up', async () => { await caret('task6'); await key('Alt+ArrowUp'); }, 'task5', 'tick'],
  ['undo-enter', async () => { await caret('task3'); await key('Enter'); await sleep(30); await key('Meta+z'); }, 'task5', 'tick'],
  ['undo-redo-del', async () => { await caret('task3'); await key('Shift+Meta+k'); await sleep(30); await key('Meta+z'); await sleep(30); await key('Meta+Shift+z'); }, 'task5', 'tick'],
  ['paste500-above', async () => { await page.evaluate(() => { const v = window.__mdr.app.editor.view; const t = Array.from({ length: 500 }, (_, i) => `pasted line ${i}`).join('\n') + '\n'; v.focus(); v.dispatch({ changes: { from: 0, insert: t }, userEvent: 'input.paste' }); }); }, 'task5', 'tick'],
  ['replace-all', async () => { await page.evaluate(() => { const v = window.__mdr.app.editor.view; const d = v.state.doc.toString(); const ch = []; const re = /task(\d+)/g; let m; while ((m = re.exec(d))) ch.push({ from: m.index, to: m.index + 4, insert: 'task' }); const re2 = / \[ \] /g; while ((m = re2.exec(d))) ch.push({ from: m.index + 2, to: m.index + 3, insert: ' ' }); v.focus(); v.dispatch({ changes: ch, userEvent: 'input.replace.all' }); }); }, 'task5', 'tick'],
  ['replace-marker', async () => { await page.evaluate(() => { const v = window.__mdr.app.editor.view; const d = v.state.doc.toString(); const ch = []; const re = /^- /gm; let m; while ((m = re.exec(d))) ch.push({ from: m.index, to: m.index + 1, insert: '*' }); v.focus(); v.dispatch({ changes: ch, userEvent: 'input.replace.all' }); }); }, 'task5', 'tick'],
];
const results = [];
function report(name, obj) { results.push({ name, ...obj }); console.log(name, J(obj)); }
async function attack(ename, fn, tgt, expect, listName, delay) {
  const doc = listName === 'giant' ? giant(100) : small(8);
  await load(doc);
  await install();
  await fn();
  if (delay) await sleep(delay);
  await clickTask(tgt);
  const shownAfterClick = await page.evaluate((n) => { const b = Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]')).find((x) => ((x.closest('li')?.textContent || '').trim().split(/\s+/)[0]).replace(/Z+$/, '') === n); return b ? b.checked : null; }, tgt);
  await sleep(1200); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(300);
  const w = await readW();
  const s = await src();
  const t = tickedNames(s);
  let verdict;
  if (expect === 'gone') verdict = t.length === 0 ? (w.toasts.length ? 'nothing+toast' : 'nothing-silent') : 'WRONG:' + t.join(',');
  else verdict = t.length === 1 && t[0] === tgt ? 'right' : t.length === 0 ? (w.toasts.length ? 'nothing+toast' : 'nothing-silent') : 'WRONG:' + t.join(',');
  report(`atk-${ename}-${listName}-${delay}`, { target, verdict, ticked: t, toasts: w.toasts.length, changes: w.changes.map((c) => `${c.name}:${c.checked}/${c.src}`), shownAfterClick });
  await page.keyboard.press('Escape');
}
async function latency(n, gap, size = 100, label = `lat-${n}-${gap}`) {
  await load(giant(size));
  await install();
  const names = Array.from({ length: n }, (_, i) => `task${3 + i}`);
  for (let i = 0; i < n; i++) { await clickTask(names[i]); if (i < n - 1) await sleep(gap); }
  await sleep(Math.max(4000, n * 600)); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(300);
  const w = await readW();
  const s = await src();
  const row = names.map((nm) => {
    const d = w.downs.find((x) => x.name === nm); const c = w.changes.find((x) => x.name === nm);
    return { nm, shownMs: d && w.first[nm] !== undefined ? Math.round(w.first[nm] - d.t) : 'never', srcMs: d && c ? Math.round(c.t - d.t) : 'nochange', sameTask: c ? c.src === 'x' : false };
  });
  const flipsBack = Object.entries(w.flips).filter(([, v]) => v.some((x) => x.startsWith('off'))).map(([k, v]) => `${k}:${v.join(',')}`);
  report(label, { target, ticked: tickedNames(s).length, want: n, row2: row[1], row3: row[2], row10: row[9], all: row.map((r) => `${r.shownMs}/${r.srcMs}${r.sameTask ? '' : '!'}`), toasts: w.toasts.length, flipsBack });
}
try {
  await boot();
  const want = (nm) => !only.length || only.some((o) => nm.startsWith(o));
  for (const gap of [30, 60, 100, 200]) if (want(`lat-10-${gap}`)) { try { await latency(10, gap); } catch (e) { report(`lat-10-${gap}`, { error: String(e.message) }); } }
  // latm-<size>-<gap>: the same series in a smaller formula list (its HTML is below the giant guard, so stale HTML mounts
  // between ticks: the flicker of a box that shows its tick, then not, then again)
  for (const size of [20, 40]) for (const gap of [30, 60, 120]) { const nm = `latm-${size}-${gap}`; if (want(nm)) { try { await latency(10, gap, size, nm); } catch (e) { report(nm, { error: String(e.message) }); } } }
  for (const [ename, fn, tgt, expect] of EDITS) for (const listName of ['small', 'giant']) for (const delay of [0, 20, 60, 150]) {
    const nm = `atk-${ename}-${listName}-${delay}`;
    if (!want(nm)) continue;
    try { await attack(ename, fn, tgt, expect, listName, delay); } catch (e) { report(nm, { error: String(e.message) }); }
  }
} finally {
  if (errs.length) console.log('pageerrors', J(errs.slice(0, 5)));
  const bad = results.filter((r) => String(r.verdict || '').startsWith('WRONG')).map((r) => r.name);
  console.log('summary', J({ target, cases: results.length, wrong: bad, nothing: results.filter((r) => String(r.verdict || '').startsWith('nothing')).map((r) => `${r.name}:${r.verdict}`), errors: results.filter((r) => r.error).map((r) => r.name) }));
  await browser.close();
}
