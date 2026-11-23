// bench/electron/v5-offk-ticks.mjs — verify-off-desktop (0.2.0 r4 verification): task ticks in the real desktop
// window with the switch OFF (production renderer, nothing stored), one shell per run:
//   MDR_OFFK_TMP=<scratch> MDR_TARGET=cand|base node bench/electron/v5-offk-ticks.mjs [case ...]
// series-<gap>: three / five boxes of a 100-task list (with formulas) clicked <gap> ms apart (real mouse);
// edit-<kind>-<delay>: an edit in the editor pane, then a click on a box <delay> ms later.
// Judge: every line of the source compared before / after; the clicked task's line must flip and no other line
// may change except the edit itself; toasts counted with a MutationObserver over text changes.
// Launch only through ./_electron.mjs. No full screen. Global timeout 110 s.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = process.env.MDR_TARGET === 'base' ? path.join(ROOT, 'release/baseline-0.1.1.noindex') : path.resolve(ROOT, process.env.MDR_STAGING_DIR || 'release/staging-0.2.0.noindex') /* integrate r7: MDR_STAGING_DIR */;
const ONLY = process.argv.slice(2);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_OFFK_TMP || os.tmpdir(), 'offk-ticks-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app = null, page = null;
async function quit() {
  if (!app) return;
  const a = app; app = null;
  const pid = a.process()?.pid;
  try { await Promise.race([a.evaluate(({ app: x }) => { setTimeout(() => x.exit(0), 20); }), sleep(3000)]); } catch { /* gone */ }
  if (pid) for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch { break; } if (i === 25) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } } await sleep(150); }
  await Promise.race([a.close().catch(() => {}), sleep(3000)]);
}
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await quit(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(3); }, 110_000);
const pad = (i) => String(i).padStart(3, '0');
const DOC = `# Ticks\n\n${Array.from({ length: 100 }, (_, i) => `- [ ] task${pad(i)} with $x_{${i}}^2+\\frac{1}{${i + 1}}$ and words`).join('\n')}\n\nend\n`;
async function launch() {
  const f = path.join(TMP, 'ticks.md'); fs.writeFileSync(f, DOC);
  app = await electron.launch({ args: [DIR, f, `--user-data-dir=${path.join(TMP, 'prof')}`], timeout: 30000 });
  page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('.mdr-preview input[type=checkbox]').length >= 100, null, { timeout: 15000 }).catch(() => {});
  await sleep(1200);
  await page.evaluate(() => {
    window.__offkToasts = [];
    new MutationObserver(() => { for (const t of document.querySelectorAll('.mdr-toast')) { const s = t.textContent.trim(); if (s !== t.__last) { t.__last = s; window.__offkToasts.push(s); } } }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}
// the whole source through CodeMirror's own state is not reachable without hooks: select-all + copy is not wanted
// (clipboard), so the editor is put in a tall state and the visible lines are read after scrolling through.
async function source() {
  return page.evaluate(async () => {
    const sc = document.querySelector('.cm-scroller'); const keep = sc.scrollTop; const seen = new Map();
    for (let y = 0; y <= sc.scrollHeight; y += Math.max(200, sc.clientHeight - 100)) {
      sc.scrollTop = y; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const l of document.querySelectorAll('.cm-content .cm-line')) { const m = l.textContent.match(/task(\d{3})/); if (m) seen.set(m[1], l.textContent.slice(0, 7)); }
    }
    sc.scrollTop = keep; return Object.fromEntries(seen);
  });
}
async function boxPoint(n) {
  return page.evaluate((k) => { const li = [...document.querySelectorAll('.mdr-preview li')].filter((x) => x.textContent.includes(`task${k}`)).pop(); const b = li && li.querySelector("input[type=checkbox]"); if (!b) return null; let r = b.getBoundingClientRect(); if (!(r.top > 0 && r.bottom < innerHeight)) { b.scrollIntoView({ block: "center" }); r = b.getBoundingClientRect(); } return { x: r.left + r.width / 2, y: r.top + r.height / 2, inView: r.top > 0 && r.bottom < innerHeight }; }, n);
}
async function scrollPreviewTo(n) {
  await page.evaluate((k) => { const li = [...document.querySelectorAll('.mdr-preview li')].find((x) => x.textContent.includes(`task${k}`)); li.scrollIntoView({ block: 'center' }); }, n);
  await sleep(500);
}
const out = (k, o) => console.log(`OBS ${k} ${JSON.stringify(o)}`);
function judge(before, after, clicked, editedTask) {
  const flips = Object.keys(after).filter((k) => before[k] !== after[k]);
  return { flips: flips.sort().join(','), wrong: flips.filter((k) => !clicked.includes(k) && k !== editedTask).join(','), missed: clicked.filter((k) => !flips.includes(k)).join(',') };
}

const CASES = {};
for (const gap of [100, 150, 200]) {
  CASES[`series-${gap}`] = async () => {
    await scrollPreviewTo('040');
    const before = await source();
    const clicked = ['038', '040', '042', '044'];
    const t = [];
    for (const k of clicked) { const p = await boxPoint(k); await page.mouse.click(p.x, p.y); t.push(Date.now()); await sleep(gap); }
    const shownSoon = await page.evaluate((ks) => ks.map((k) => [...document.querySelectorAll('.mdr-preview li')].find((x) => x.textContent.includes(`task${k}`)).querySelector('input').checked ? 1 : 0).join(''), clicked);
    await sleep(1500);
    const after = await source();
    out(`series-${gap}`, { ...judge(before, after, clicked), shownSoon, toasts: await page.evaluate(() => window.__offkToasts) });
  };
}
const EDITS = {
  // type a character in the middle of task050's line text, in the editor
  'mid-text': async () => { await clickEditorLine('task050', 20); await page.keyboard.insertText('Q'); return '050'; },
  // insert a new line above task050 (Enter at the start of task049's line end)
  'line-above': async () => { await clickEditorLine('task049', 9999); await page.keyboard.press('Enter'); await page.keyboard.insertText('- [ ] inserted'); return null; },
  // two task lines inserted above as one change (insertText with line feeds)
  'two-above': async () => { await clickEditorLine('task049', 9999); await page.keyboard.insertText('\n- [ ] newA\n- [ ] newB'); return null; },
  // the line above duplicated (Shift-Alt-Down)
  'dup-above': async () => { await clickEditorLine('task049', 9999); await page.keyboard.press('Shift+Alt+ArrowDown'); return null; },
  // the line below moved up above task050 (Alt-Up on task051)
  'swap-below-up': async () => { await clickEditorLine('task051', 9999); await page.keyboard.press('Alt+ArrowUp'); return '051'; },
  // a typed then undone insertion above (two steps)
  'undo-above': async () => { await clickEditorLine('task048', 9999); await page.keyboard.insertText('\n- [ ] tmp'); await sleep(30); await page.keyboard.press('Meta+z'); return null; },
  // delete the line above (task049) by selecting it and Backspace
  'delete-above': async () => { await clickEditorLine('task049', 9999); await page.keyboard.press('Shift+Home'); await page.keyboard.press('Shift+Home'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); return '049'; },
};
async function clickEditorLine(tok, col) {
  await page.evaluate((k) => { const sc = document.querySelector('.cm-scroller'); const l = [...document.querySelectorAll('.cm-content .cm-line')].find((x) => x.textContent.includes(k)); if (l) l.scrollIntoView({ block: 'center' }); else sc.scrollTop = sc.scrollHeight / 2; }, tok);
  await sleep(250);
  const p = await page.evaluate(([k, c]) => { const l = [...document.querySelectorAll('.cm-content .cm-line')].find((x) => x.textContent.includes(k)); const r = l.getBoundingClientRect(); return { x: c > 999 ? r.right - 2 : r.left + 4, y: r.top + r.height / 2 }; }, [tok, col]);
  await page.mouse.click(p.x, p.y);
  if (col > 999) await page.keyboard.press('End'); else { await page.keyboard.press('Home'); for (let i = 0; i < col; i++) await page.keyboard.press('ArrowRight'); }
}
for (const [kind, fn] of Object.entries(EDITS)) for (const delay of [0, 40, 100]) {
  CASES[`edit-${kind}-${delay}`] = async () => {
    await scrollPreviewTo('050');
    const before = await source();
    const edited = await fn();
    if (delay) await sleep(delay);
    const p = await boxPoint('050');
    if (!p) { out(`edit-${kind}-${delay}`, { noBox: true, items: await page.evaluate(() => [...document.querySelectorAll('.mdr-preview li')].filter((x) => /task05/.test(x.textContent)).map((x) => x.textContent.slice(0, 20))) }); return; }
    const hitEl = await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? e.tagName + ' ' + ((e.closest('li') || {}).textContent || '').slice(0, 10) : null; }, p);
    await page.mouse.click(p.x, p.y);
    await sleep(1500);
    const after = await source();
    const j = judge(before, after, ['050'], edited);
    out(`edit-${kind}-${delay}`, { ...j, line050: after['050'], toasts: await page.evaluate(() => window.__offkToasts), inView: p.inView, hitEl });
    // undo order: Cmd-Z in the editor twice
  };
}
CASES['multi-click'] = async () => {
  await scrollPreviewTo('040');
  const before = await source();
  let p = await boxPoint('038'); await page.mouse.dblclick(p.x, p.y); await sleep(600);
  p = await boxPoint('040'); await page.mouse.click(p.x, p.y, { clickCount: 3, delay: 0 }); await sleep(600);
  p = await boxPoint('042'); await page.mouse.click(p.x, p.y); await sleep(60); await page.mouse.click(p.x, p.y); await sleep(600);
  p = await boxPoint('044'); await page.mouse.click(p.x, p.y, { modifiers: ['Meta'] }); await sleep(300); await page.mouse.click(p.x, p.y, { modifiers: ['Shift'] }); await sleep(300); await page.mouse.click(p.x, p.y, { modifiers: ['Alt'] }); await sleep(600);
  const after = await source();
  out('multi-click', { b: ['038', '040', '042', '044'].map((k) => before[k] + '>' + after[k]).join(' '), title: await page.evaluate(() => document.title), toasts: await page.evaluate(() => window.__offkToasts), boxes: await page.evaluate(() => ['038', '040', '042', '044'].map((k) => [...document.querySelectorAll('.mdr-preview li')].filter((x) => x.textContent.includes('task' + k)).pop().querySelector('input').checked ? 1 : 0).join('')) });
};
CASES['mod-click'] = async () => {
  await scrollPreviewTo('040');
  const before = await source();
  const mods = { '036': ['Meta'], '038': ['Shift'], '040': ['Alt'], '042': ['Control'], '044': ['Meta', 'Shift'] };
  const r = {};
  for (const [k, m] of Object.entries(mods)) {
    const p = await boxPoint(k); await page.mouse.click(p.x, p.y, { modifiers: m }); await sleep(700);
    r[k] = { mods: m.join('+'), box: await page.evaluate((kk) => [...document.querySelectorAll('.mdr-preview li')].filter((x) => x.textContent.includes('task' + kk)).pop().querySelector('input').checked ? 1 : 0, k), focus: await page.evaluate(() => { const a = document.activeElement; return a ? a.tagName + (a.closest('.cm-editor') ? '@editor' : a.closest('.mdr-preview') ? '@preview' : '') : null; }), wins: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) };
    await page.keyboard.press('Escape'); await sleep(100);
  }
  const after = await source();
  for (const k of Object.keys(mods)) r[k].src = before[k] + '>' + after[k];
  out('mod-click', { r, toasts: await page.evaluate(() => window.__offkToasts) });
};
CASES['probe-line-above'] = async () => {
  await scrollPreviewTo('050');
  if (process.env.OFFK_SRC) await source();
  await EDITS['line-above']();
  const t0 = Date.now(); const samples = [];
  while (Date.now() - t0 < 1500) { samples.push(await page.evaluate(() => { const lis = document.querySelectorAll('.mdr-preview li').length; const w = [...document.querySelectorAll('.mdr-preview li')].filter((x) => /task05/.test(x.textContent)).length; return `${lis}/${w}`; })); await sleep(50); }
  const lines = await page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).filter((l) => /task04[89]|task05[01]|inserted/.test(l)));
  const prev = await page.evaluate(() => { const li = [...document.querySelectorAll('.mdr-preview li')].find((x) => /inserted/.test(x.textContent)); return li ? li.outerHTML.slice(0, 200) : null; });
  out('probe-line-above', { title: await page.evaluate(() => document.title), focus: await page.evaluate(() => document.activeElement?.className?.toString().slice(0, 30)), nLi: await page.evaluate(() => document.querySelectorAll('.mdr-preview li').length), pv: await page.evaluate(() => (document.querySelector('.mdr-preview')?.textContent || '').length), samples: samples.join(' '), lines, prev, pScroll: await page.evaluate(() => document.querySelector('.mdr-preview').scrollTop) });
};
try {
  for (const [name, fn] of Object.entries(CASES)) {
    if (ONLY.length && !ONLY.some((o) => name.startsWith(o))) continue;
    await launch();
    try { await fn(); } catch (e) { out(name, { threw: String(e).split('\n')[0] }); }
    await quit();
  }
} finally {
  clearTimeout(KILL);
  await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
}
