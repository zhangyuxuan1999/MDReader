// bench/electron/v5-atp-desk.mjs — probe-activation (0.2.0 stage 2e), desktop side: the same task-checkbox
// activations as bench/verify/v5-atp-probes.mjs in a real Electron window, on one shell directory at a time:
//   MDR_ATP_DIR=<scratch>/atp node bench/electron/v5-atp-desk.mjs <base|cand|both> <a11y|tree|q1|q2zoom|q4> [...]
//   (both: base, then cand, in child processes; MDR_ATP_ZOOMS=0.8,1.25 limits the zoom factors, MDR_ATP_TASK the task)
//   base = release/baseline-0.1.1.noindex; cand = <MDR_ATP_DIR>/app (a production build of the stable snapshot of round 4
//   + its electron/ + package.json, see the ledger entry of probe-activation; that snapshot was deleted at the release of
//   0.2.0: for a run now, a build of the tree or of the frozen copy of 0.2.0, test/fixtures/src-0.2.0, with electron/).
// q1: AXPress (bench/electron/v5-atp-ax.swift, compiled to <MDR_ATP_DIR>/v5-atp-ax) on each task checkbox, the raw
//     label's checkbox and text, the wrapping label's text, a link and (cand) the switch's toolbar button; 3 times each.
// q2zoom: webContents.setZoomFactor 0.8 ... 2, the 73-point grid of v5-atp-lib.mjs at each factor (page.mouse).
// q4: Tab then Space, and Space after a refused label click.
// a11y: app.setAccessibilitySupportEnabled(true) in the test instance (what VoiceOver running causes); give it before q1.
// Launches only through ./_electron.mjs with a profile under MDR_ATP_DIR/prof; the switch is off in the candidate
// (localStorage mdr.previewEdit = "0" written by a first launch, then a relaunch with the same profile; asserted).
// One instance at a time; app.exit(0) at the end (the document is dirty). Global timeout MDR_ATP_TIMEOUT (110 s).
import { electron } from './_electron.mjs';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOC, recorderSource, fmtEv, srcDiff, statesStr, replayTests, runGrid, gridSummary, sleep } from '../verify/v5-atp-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATP = process.env.MDR_ATP_DIR || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/atp';
const AX = path.join(ATP, 'v5-atp-ax');
const [target, ...cases] = process.argv.slice(2);
if (target === 'both') {   // one command, both builds, one instance at a time
  const { spawnSync } = await import('node:child_process');
  for (const t of ['base', 'cand']) spawnSync(process.execPath, [fileURLToPath(import.meta.url), t, ...cases], { stdio: 'inherit', timeout: Number(process.env.MDR_ATP_TIMEOUT || 110_000) + 15_000 });
  process.exit(0);
}
// MDR_ATP_CAND_SHELL: any other candidate shell directory (dist/ + electron/ + package.json) built from the snapshot
const SHELL = target === 'base' ? path.join(ROOT, 'release/baseline-0.1.1.noindex') : target === 'cand' ? (process.env.MDR_ATP_CAND_SHELL || path.join(ATP, 'app')) : null;
if (!SHELL || !fs.existsSync(path.join(SHELL, 'electron/main.mjs'))) { console.log('usage: v5-atp-desk.mjs base|cand <case...>'); process.exit(64); }
const JSON_OUT = process.env.MDR_ATP_JSON || '';
let app = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await quit(); process.exit(3); }, Number(process.env.MDR_ATP_TIMEOUT || 110_000));

async function quit() {
  if (!app) return;
  const a = app; app = null;
  const pid = a.process()?.pid;
  try { await Promise.race([a.evaluate(({ app: x }) => { setTimeout(() => x.exit(0), 20); }), sleep(2000)]); } catch { /* gone */ }
  for (let i = 0; i < 40 && pid; i++) { try { process.kill(pid, 0); } catch { break; } await sleep(100); }
  await Promise.race([a.close().catch(() => {}), sleep(2000)]);
}

const prof = path.join(ATP, 'prof', `${target}-${process.pid}`);
fs.mkdirSync(prof, { recursive: true });
const docDir = path.join(ATP, 'docs');
fs.mkdirSync(docDir, { recursive: true });
const docPath = path.join(docDir, `atp-${target}-${process.pid}.md`);
fs.writeFileSync(docPath, DOC, 'utf8');

async function launch(withDoc) {
  app = await electron.launch({ args: [SHELL, ...(withDoc ? [docPath] : []), `--user-data-dir=${prof}`], timeout: 30000 });
  const page = await app.firstWindow({ timeout: 20000 });
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(500);
  return page;
}

// ---- 1. the switch: write the preference, relaunch with the same profile
{
  const p0 = await launch(false);
  await p0.evaluate(() => localStorage.setItem('mdr.previewEdit', '0'));
  await sleep(300);
  await quit();
  await sleep(500);
}
const page = await launch(true);
await page.waitForFunction(() => /ATP probe/.test(document.querySelector('.mdr-preview')?.textContent || ''), null, { timeout: 15000 });
await sleep(600);
const sw = await page.evaluate(() => ({ pressed: document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? 'absent', stored: localStorage.getItem('mdr.previewEdit') }));
console.log(`[${target}] switch ${JSON.stringify(sw)} zoom=${await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())}`);
if (target === 'cand' ? sw.pressed !== 'false' : sw.pressed !== 'absent') { console.log('FAIL switch state'); await quit(); process.exit(4); }
await page.evaluate(recorderSource());
const pid = app.process().pid;

const source = () => page.evaluate(() => Array.from(document.querySelectorAll('.cm-content .cm-line')).map((l) => l.textContent).join('\n'));
const states = () => page.evaluate(() => Object.fromEntries(['alpha', 'beta', 'gamma', 'wrapped', 'raw'].map((n) => [n, window.__atpBox(n)?.checked ? 1 : 0])));
const clearEv = () => page.evaluate(() => { window.__atpEv.length = 0; });
const evs = () => page.evaluate(() => window.__atpEv.slice());
const textPoint = (needle, k = 2) => page.evaluate(({ needle, k }) => {
  const root = document.querySelector('.mdr-preview');
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = n.data.indexOf(needle);
    if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i + k); r.setEnd(n, i + k + 1);
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }
  return null;
}, { needle, k });
const original = await source();
if (!original.includes('- [ ] alpha task')) { console.log('FAIL editor does not show the document'); await quit(); process.exit(4); }
/** A neutral click on the intro paragraph (clears the candidate's pressOn / keyOn). */
async function neutral() { const p = await textPoint('Intro paragraph', 4); await page.mouse.click(p.x, p.y); await sleep(150); }
/** Back to the file's text: undo in the editor until the source is the original again. */
async function reset() {
  for (let i = 0; i < 6 && (await source()) !== original; i++) {
    await page.click('.cm-content', { position: { x: 30, y: 5 } }).catch(() => {});
    await page.keyboard.press('Meta+z');
    await sleep(350);
  }
  await neutral();
  return (await source()) === original;
}
function ax(args) {
  return new Promise((res) => execFile(AX, [String(pid), ...args], { timeout: 30000 }, (err, stdout, stderr) => res({ code: err ? (err.code ?? 'err') : 0, out: (stdout + stderr).trim() })));
}
const results = [];
function report(name, r) {
  console.log(`${name} [${target}] ${JSON.stringify(r)}`);
  results.push({ case: name, build: target, ...r });
  if (JSON_OUT) fs.appendFileSync(JSON_OUT, JSON.stringify({ case: name, build: target, ...r }) + '\n');
}

try {
  for (const c of cases) {
    if (c === 'a11y') {
      // what Chromium does when VoiceOver runs: full accessibility support. AXManualAccessibility alone (set by the
      // helper) leaves Electron 44 in a mode where AXPress returns success and does nothing (measured).
      await app.evaluate(({ app: a }) => a.setAccessibilitySupportEnabled(true));
      await sleep(1500);
      console.log(`[${target}] accessibility support: ${await app.evaluate(({ app: a }) => a.isAccessibilitySupportEnabled())}`);
    }
    if (c === 'tree') {
      const full = await app.evaluate(({ app: a }) => a.isAccessibilitySupportEnabled());
      const r = await ax(['tree', '500']);
      fs.writeFileSync(path.join(ATP, `axtree-${target}-${full ? 'full' : 'manual'}.txt`), r.out);
      const lines = r.out.split('\n').filter((l) => /AXCheckBox|AXLink|toggle|预览可编辑|label words|raw label/.test(l));
      report('q1:tree', { code: r.code, lines: lines.slice(0, 30) });
    }
    if (c === 'q1') {
      // [name, role, text, nth, up, which box the press is about]
      const targets = [
        ['task-alpha', 'AXCheckBox', 'task-list-item-checkbox', 0, 0, 'alpha'],
        ['task-beta-wraps', 'AXCheckBox', 'task-list-item-checkbox', 1, 0, 'beta'],
        ['task-gamma-quote', 'AXCheckBox', 'task-list-item-checkbox', 2, 0, 'gamma'],
        ['task-wrapped-in-label', 'AXCheckBox', 'task-list-item-checkbox', 3, 0, 'wrapped'],
        ['raw-checkbox', 'AXCheckBox', 'rawbox', 0, 0, 'raw'],
        ['label-text-wrapping-task', 'AXStaticText', '=label words here', 0, 0, 'wrapped'],
        ['label-element-wrapping-task', 'AXStaticText', '=label words here', 0, 1, 'wrapped'],
        ['raw-label-text', 'AXStaticText', '= raw label text', 0, 0, 'raw'],
        ['link', 'AXLink', 'plain link', 0, 0, null],
        ...(target === 'cand' ? [['switch-button', '*', '预览可编辑', 0, 0, null]] : []),
      ];
      for (const [name, role, text, nth, up, box] of targets) {
        const reps = [];
        for (let rep = 0; rep < 3; rep++) {
          const fresh = await reset();
          await page.evaluate((b) => { window.__atpWatch = b; }, box);
          await clearEv();
          const s0 = await source(), st0 = await states();
          const url0 = page.url();
          const r = await ax(['press', role, text, String(nth), String(up)]);
          await sleep(700);
          const s1 = await source(), st1 = await states();
          const ev = await evs();
          const sw1 = await page.evaluate(() => ({ pressed: document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? 'absent', stored: localStorage.getItem('mdr.previewEdit'), editable: document.querySelectorAll('.mdr-preview [contenteditable="true"]').length, active: document.activeElement?.tagName }));
          const boxDesc = box === 'raw' ? 'input[checkbox].raw@label' : box === 'wrapped' ? 'input[checkbox].task{wrapped}@label' : box ? `input[checkbox].task{${box}}` : null;
          reps.push({ rep, fresh, ax: r.out.replace(/\n/g, ' || ').slice(0, 900), src: srcDiff(s0, s1), changed: Object.keys(st1).filter((k) => st1[k] !== st0[k]).join(',') || '-', url: page.url() === url0 ? 'same' : page.url(), switch: sw1, tests: boxDesc ? JSON.stringify(replayTests(ev, boxDesc)) : null, evs: fmtEv(ev) });
          if (name === 'switch-button' && sw1.pressed === 'true') {   // put the switch back off through the same press
            const r2 = await ax(['press', role, text, String(nth), String(up)]);
            await sleep(500);
            reps.at(-1).switchBack = { ax: r2.out.split('\n').at(-1), pressed: await page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed')) };
          }
        }
        report(`q1:${name}`, { reps });
      }
    }
    if (c === 'q2zoom') {
      const factors = (process.env.MDR_ATP_ZOOMS || '0.8,0.9,1,1.1,1.25,1.5,2').split(',').map(Number);
      const task = process.env.MDR_ATP_TASK || 'alpha';
      for (const f of factors) {
        await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), f);
        await sleep(600);
        await reset();
        const z = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
        await page.evaluate((t) => { window.__atpWatch = t; }, task);
        const R = await page.evaluate((t) => { const b = window.__atpBox(t); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }, task);
        const dpr = await page.evaluate(() => devicePixelRatio);
        const recs = await runGrid({ page, source, idle: () => sleep(120), boxDesc: `input[checkbox].task{${task}}` }, task, R);
        const sum = gridSummary(recs);
        report(`q2:zoom-${f}-${task}`, { zoom: z, dpr, rect: [R.l, R.t, R.r, R.b].map((v) => +v.toFixed(3)).join(','), ...sum, recs });
      }
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    }
    if (c === 'q4') {
      for (const [name, steps] of [
        ['tab-space', [['text', 'Intro paragraph'], ['key', 'Tab'], ['key', 'Space']]],
        ['label-then-space', [['text', 'label words'], ['key', 'Space']]],
        ['text-tab-space', [['text', 'alpha task'], ['key', 'Tab'], ['key', 'Space']]],
      ]) {
        await reset();
        await clearEv();
        const s0 = await source(), st0 = await states();
        const log = [];
        for (const [k, a] of steps) {
          if (k === 'text') { const p = await textPoint(a, 2); await page.mouse.click(p.x, p.y); }
          else await page.keyboard.press(a);
          await sleep(300);
          log.push(`${k}(${a})->${await page.evaluate(() => { const e = document.activeElement; const li = e?.closest?.('li'); return (e?.tagName || '?') + (li ? '{' + li.textContent.trim().slice(0, 10) + '}' : ''); })}`);
        }
        await sleep(400);
        const s1 = await source(), st1 = await states();
        const ev = await evs();
        report(`q4:${name}`, { src: srcDiff(s0, s1), changed: Object.keys(st1).filter((k) => st1[k] !== st0[k]).join(',') || '-', steps: log.join(' ; '), evs: fmtEv(ev.filter((e) => e.type !== 'pointerup' && e.type !== 'mouseup')) });
      }
    }
  }
} catch (e) {
  console.log(`ERROR ${String(e && e.stack || e).slice(0, 600)}`);
} finally {
  await quit();
  clearTimeout(killer);
  fs.rmSync(docPath, { force: true });
  await sleep(500);
  fs.rmSync(prof, { recursive: true, force: true });
}
process.exit(0);
