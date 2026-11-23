// bench/electron/v4-sesa-desk.mjs — verify-session-a: the SESA findings in the CANDIDATE DIRECTORY (built dist inside
// the project's Electron, no test hooks: driven through the DOM, the source read from the editor's lines, the saved
// bytes read from disk). Documents are temp files in MDR_SESA_TMP (default: the verifier's scratch dir).
//   MDR_APP_DIR=release/staging-0.2.0.noindex node bench/electron/v4-sesa-desk.mjs [case-prefix]
// Launch only through ./_electron.mjs (isolated profile, recent documents stubbed). Global timeout 110 s.
import { electron } from './_electron.mjs';
import { previewEditOn } from './r4-rel-switch.mjs'; // fix-release: 预览可编辑 is off by default without test hooks
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.resolve(ROOT, process.env.MDR_APP_DIR || 'release/staging-0.2.0.noindex');
const BASE_TMP = process.env.MDR_SESA_TMP || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v4-sesa';
fs.mkdirSync(BASE_TMP, { recursive: true });
const TMP = fs.mkdtempSync(path.join(BASE_TMP, 'desk-'));
const only = process.argv[2] ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
let pass = 0, fail = 0;
const res = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
let app = null;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await app?.evaluate(({ app: a }) => a.exit(0)); } catch { /* */ } process.exit(3); }, 110_000);
const write = (name, text) => { const p = path.join(TMP, name); fs.writeFileSync(p, text, 'utf8'); return p; };

try {
  app = await electron.launch({ args: [DIR] });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  for (let i = 0; i < 100 && !(await page.evaluate(() => !!document.querySelector('.cm-content')).catch(() => false)); i++) await sleep(100);
  await sleep(1500);
  // Release decision for 0.2.0 (CONTRACT §11): without test hooks 预览可编辑 is off until turned on; this script
  // needs it on and turns it on itself through the menu item (fix-release, bench/electron/r4-rel-switch.mjs).
  await previewEditOn(app, page);
  const src = () => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));
  const dialogs = () => page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
  const clickDialog = (label) => page.evaluate((label) => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === label); if (b) b.click(); return !!b; }, label);
  const editing = () => page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
  const openPath = async (p) => {
    await app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); }, p);
    const want = fs.readFileSync(p, 'utf8');
    for (let i = 0; i < 60; i++) {
      if ((await dialogs()).length) await clickDialog('丢弃');
      if ((await src().catch(() => '')) === want.replace(/\n$/, want.endsWith('\n') ? '\n' : '')) break;
      await sleep(100);
    }
    await sleep(800);
  };
  /** A real click on the right half of character k of `needle` in the preview; waits for the session. */
  async function session(needle, k = 1) {
    for (let i = 0; i < 3; i++) {
      const p = await page.evaluate(({ needle, k }) => {
        const w = document.createTreeWalker(document.querySelector('.mdr-preview'), NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('.katex-mathml, [data-mdr-ui]') ? 2 : 1) });
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          const i = n.data.indexOf(needle); if (i < 0) continue;
          const r = document.createRange(); r.setStart(n, i + k); r.setEnd(n, i + k + 1);
          const b = r.getBoundingClientRect(); return { x: b.right - 1, y: b.top + b.height / 2 };
        }
        return null;
      }, { needle, k });
      if (p) { await page.mouse.click(p.x, p.y); await sleep(300); }
      if (await editing()) return;
      await sleep(400);
    }
    throw new Error(`no session on ${needle}`);
  }
  /** Caret right after `needle` inside the session's editable text (formulas / KaTeX skipped). */
  const caretAfter = (needle) => page.evaluate((needle) => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('.md-math, .katex, [contenteditable="false"]') ? 2 : 1) });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle); if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i + needle.length); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true;
    }
    return false;
  }, needle);
  const keys = async (list) => { for (const k of list) { if (k === '|') await sleep(700); else if (k.length === 1) await page.keyboard.type(k); else await page.keyboard.press(k); await sleep(120); } await sleep(900); };
  const IMG = '![i](i.png)';
  const CASES = [
    ['SESA-1 undo-math-at-end (typing swallowed)', 'a1 b1 $x^2$\n\nzz\n', async () => { await session('b1'); await keys(['Meta+ArrowRight', 'Q', 'R', '|', 'Meta+z', '|', 'W', 'X']); }, 'a1 b1 $x^2$WX\n\nzz\n'],
    ['SESA-1 undo-newpara-after-math (typing swallowed)', 'a1 b1 $x^2$\n\nzz\n', async () => { await session('b1'); await keys(['Meta+ArrowRight', 'Enter', '|', 'n', 'e', 'w', '|', 'Meta+z', '|', 'W', 'X']); }, (s) => s === 'a1 b1 $x^2$WX\n\nzz\n' || s === 'a1 b1 $x^2$\n\nWX\n\nzz\n'],
    ['SESA-2 merge-math-end', 'a1 $x^2$\n\nb1 yy\n\nzz\n', async () => { await session('yy'); await keys(['Meta+ArrowLeft', 'Backspace', '|', 'Q']); }, 'a1 $x^2$Qb1 yy\n\nzz\n'],
    ['SESA-2 undo-after-math', 'a1 $x^2$ b1 yy\n\nzzz\n', async () => { await session('yy'); await caretAfter('b1'); await keys(['X', 'Y', '|', 'Meta+z', '|', 'Q']); }, 'a1 $x^2$ b1Q yy\n\nzzz\n'],
    ['SESA-3 math-in-bold', 'abc **$x$ b** y\n\nz\n', async () => { await session('abc'); await caretAfter('abc'); await keys(['Enter', '|', 'Z']); }, (s) => !s.includes('\\\n') && /^abc\n\n(Z\*\*|\*\*Z)\$x\$ b\*\* y\n\nz\n$/.test(s)],
    ['SESA-4 image-in-h2', `## abc ${IMG} y\n\nz\n`, async () => { await session('abc'); await caretAfter('abc'); await keys(['Enter', '|', 'Z']); }, `## abc\n\nZ${IMG} y\n\nz\n`],
    ['SESA-6 last-block-no-final-newline (saved bytes)', 'aaa\n\nxx para', async () => { await session('para'); await keys(['Meta+a', 'Backspace', '|', 'Escape', '|', 'Meta+s', '|']); }, 'DISK:aaa'],
    ['U18 gone alt-backspace (control)', 'aaa bb\n\nxx para\n\nzz\n', async () => { await session('para'); await keys(['Meta+a', 'Backspace', '|', 'Alt+Backspace', '|', 'Q']); }, 'aaa bbQ\n\nzz\n'],
    ['U21 math-space (control)', 'abc $x$ y\n\nz\n', async () => { await session('abc'); await caretAfter('abc'); await keys(['Enter', '|', 'Z']); }, 'abc\n\nZ$x$ y\n\nz\n'],
  ];
  let n = 0;
  for (const [name, doc, run, want] of CASES) {
    if (only && !name.startsWith(only)) continue;
    try {
      await page.keyboard.press('Escape').catch(() => {});
      const p = write(`c${n++}.md`, doc);
      await openPath(p);
      await run();
      let got = await src();
      let ok;
      if (typeof want === 'string' && want.startsWith('DISK:')) {
        got = fs.readFileSync(p, 'utf8');
        ok = got === want.slice(5);
      } else ok = typeof want === 'function' ? want(got) : got === want;
      res(name, ok, `observed=${J(got)}${ok ? '' : ' expected=' + (typeof want === 'function' ? '(see script)' : J(want.replace(/^DISK:/, '')))}`);
    } catch (e) { res(name, false, 'threw ' + String(e.message).split('\n')[0]); }
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(300);
  }
} finally {
  console.log(`${pass}/${pass + fail} passed`);
  clearTimeout(KILL);
  // app.close() can hang after the last window's session: bounded, then the process is ended with SIGKILL (no
  // full screen is ever entered here; a SIGKILL shows no crash dialog)
  const pid = (() => { try { return app?.process().pid; } catch { return undefined; } })();
  // (the last document is dirty: a window close would wait for the close question — app.exit skips it)
  try { await Promise.race([app?.evaluate(({ app: a }) => { setTimeout(() => a.exit(0), 50); }), sleep(3000)]); } catch { /* */ }
  await sleep(1500);
  if (pid) { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
  process.exitCode = fail ? 1 : 0;
}
