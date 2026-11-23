// bench/verify/r3-ib-empty-undo.mjs — fix-session-b (round 3): P1 / U22, an undo or redo into an empty document.
// Empty the only block (⌘A, Backspace: the deletion is written, U9), type Q (written as a new block, the session goes
// on there), then ⌘Z twice quickly: the first makes the document empty, the second must step back to the original.
// Then four more history keys and a typed character, each a quick human key press: every one must arrive (no key is
// queued and dropped by a resume that waits for a block of an empty document).
//   MDR_PORT=5411 node bench/verify/r3-ib-empty-undo.mjs [name-filter]          (exit code 1 on a failure)
import { openB, sleep, globalTimeout, J, check, summary, view, clickText } from './v3-ses-lib.mjs';

const filter = process.argv[2] || '';
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 110_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
async function waitSession(ms = 1500) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await view(page); if (v.editing && !v.capFocused) return v; await sleep(30); }
  return view(page);
}
/** The source once it equals `want` (polled for at most `ms`), else what it is then. */
async function sourceBecomes(want, ms) {
  const t = Date.now();
  let now = await B.source();
  while (now !== want && Date.now() - t < ms) { await sleep(20); now = await B.source(); }
  return { ok: now === want, now, ms: Date.now() - t };
}

const CASES = [
  // name, document, needle to click, the text the block is typed back as (U9 / U14 reinsert), gap between the two ⌘Z
  ['only-block', 'abc\n', 'abc', 'Q\n', 60],
  ['only-block-at-once', 'abc\n', 'abc', 'Q\n', 0],
  ['only-block-slow-second', 'abc\n', 'abc', 'Q\n', 400],
  ['leading-blank-line', '\nabc\n', 'abc', '\nQ\n', 60],
  ['only-heading', '# Head\n', 'Head', '# Q\n', 60],
];

let bad = 0;
try {
  await B.boot('mode=split');
  for (const [name, doc, needle, typed, gap] of CASES) {
    if (filter && !name.includes(filter)) continue;
    try {
      await B.loadDoc(doc);
      if ((await B.source()) !== doc) throw new Error('loaded ' + J(await B.source()));
      await sleep(650);
      await clickText(page, needle, needle.length - 1, { side: 'right' });
      if (!(await waitSession()).editing) throw new Error('no session');
      await page.keyboard.press('Meta+a');
      await page.keyboard.press('Backspace');
      await settle(700);                      // (a history group of its own: CodeMirror joins within 500 ms)
      const emptied = await B.source();
      await page.keyboard.type('Q');
      await settle(700);
      const afterQ = await B.source();
      const steps = [];
      // ⌘Z twice quickly: empty document, then the original (gap 0: the second key comes before the structure)
      await page.keyboard.press('Meta+z');
      let e1 = { ok: true, ms: 0, now: '' };
      let held = null;
      if (gap > 0) {
        e1 = await sourceBecomes('', 400);
        // nothing holds the keys of an empty document: no capture element with the focus, no resume
        await sleep(Math.min(gap, 150));
        held = (await view(page)).capFocused;
        await sleep(Math.max(0, gap - e1.ms - 150));
      }
      await page.keyboard.press('Meta+z');
      steps.push(['⌘Z ⌘Z', await sourceBecomes(doc, 600)]);
      // four more history keys, quick but human: every one arrives
      const more = [['Meta+Shift+z', ''], ['Meta+Shift+z', afterQ], ['Meta+z', ''], ['Meta+z', doc]];
      for (const [k, want] of more) {
        await sleep(120);
        await page.keyboard.press(k);
        steps.push([k, await sourceBecomes(want, 600)]);
      }
      // and a typed character goes into the restored block (after a click when the steps ran outside a session, U2)
      await sleep(120);
      if (!(await view(page)).editing) {
        await clickText(page, needle, needle.length - 1, { side: 'right' });
        await waitSession();
      }
      await page.keyboard.type('R');
      const t0 = Date.now();
      let src = await B.source();
      while (!src.includes('R') && Date.now() - t0 < 800) { await sleep(20); src = await B.source(); }
      const typedOk = src.includes('R') && src.replace('R', '') === doc;
      const v = await view(page);
      const stepsOk = steps.every(([, r]) => r.ok);
      const ok = emptied === '' && afterQ === typed && e1.ok && held !== true && stepsOk && typedOk;
      if (!check(name, ok, `emptied=${J(emptied)} afterQ=${J(afterQ)} firstUndo=${e1.ok ? e1.ms + 'ms' : 'FAIL ' + J(e1.now)} captureHeld=${held} `
        + steps.map(([k, r]) => `${k}:${r.ok ? r.ms + 'ms' : 'FAIL ' + J(r.now)}`).join(' ') + ` typedR=${J(src)} editing=${J(v.editing && v.editing.text)}`)) bad++;
    } catch (e) { bad++; check(name, false, 'threw ' + String(e.message).split('\n')[0]); }
    try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
  }
  console.log('pageErrors', J(B.pageErrors.slice(0, 3)), 'console', J(B.consoleErrors.filter((x) => !/DevTools|Download/.test(x)).slice(0, 3)));
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
