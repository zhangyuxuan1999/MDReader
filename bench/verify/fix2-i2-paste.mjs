// bench/verify/fix2-i2-paste.mjs — fix-session-2: decision U8 (G6) in a real Chromium session.
// For each case: a session on "abc", a paste dispatched as a ClipboardEvent (what the session's handler reads),
// then: the paste handler's own time, the longest task in the 1.5 s after it (the frame flush that serializes
// and writes the block), serializeBlock alone on the block afterwards, and the flush of one more keystroke.
// Refusal cases: nothing inserted (DOM and source unchanged) and the toast 「粘贴的内容太长，请在源码编辑器中粘贴」.
// Run: MDR_PORT=5312 node bench/verify/fix2-i2-paste.mjs [filter]      (needs a Vite on MDR_PORT; leaves it running)
import { openB, sleep, globalTimeout, J, check, results } from './v2-ses-lib.mjs';

const filter = process.argv[2] ?? '';
const B = await openB();
const stop = globalTimeout(110_000, B.close);
const { page } = B;

const TOAST = '粘贴的内容太长，请在源码编辑器中粘贴';
const lineText = (n, len) => { const a = []; for (let i = 0; i < n; i++) a.push(String(i).padStart(5, '0') + ' ' + 'w'.repeat(len - 6)); return a.join('\n'); };
// [name, doc, line, needle, text, expect: 'ok' | 'refused', where]
const C = [
  ['one-line-55000', 'abc\n\nq\n', 1, 'abc', 'y'.repeat(55000), 'ok'],
  ['one-line-words-55000', 'abc\n\nq\n', 1, 'abc', 'lorem ipsum dolor sit amet, '.repeat(2000).slice(0, 55000), 'ok'],
  ['lines-1000x55', 'abc\n\nq\n', 1, 'abc', lineText(1000, 55).slice(0, 55000), 'ok'],
  ['code-1000x55', 'p\n\n```\nlet a;\n```\n\nq\n', 4, 'let', lineText(1000, 55).slice(0, 55000), 'ok'],
  ['paras-200', 'abc\n\nq\n', 1, 'abc', Array.from({ length: 200 }, (_, i) => `para ${i} ` + 'z'.repeat(40)).join('\n\n'), 'ok'],
  ['refuse-200k-lines', 'abc\n\nq\n', 1, 'abc', lineText(2600, 79), 'refused'],
  ['refuse-200k-one-line', 'abc\n\nq\n', 1, 'abc', 'y'.repeat(200 * 1024), 'refused'],
  ['refuse-61k-one-line', 'abc\n\nq\n', 1, 'abc', 'y'.repeat(61000), 'refused'],
  ['refuse-code-200k', 'p\n\n```\nlet a;\n```\n\nq\n', 4, 'let', lineText(2600, 79), 'refused'],
];

try {
  await B.boot('mode=split');
  for (const [name, doc, line, needle, text, want] of C) {
    if (filter && !name.includes(filter)) continue;
    // Other agents' saves reload the dev page (HMR): such a run is repeated once on a fresh page.
    for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 || !(await page.evaluate(() => !!window.__mdr).catch(() => false))) await B.boot('mode=split');
    const failsBefore = results.fail;
    try {
      await B.loadDoc(doc);
      await B.clickLine(line, 'first', needle);
      await B.caretAt(needle, 'after');
      const before = await page.evaluate(() => document.querySelector('.mdr-preview .is-editing')?.innerHTML ?? null);
      const r = await page.evaluate(async (text) => {
        const tasks = [];
        const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) tasks.push(e.duration); });
        try { po.observe({ type: 'longtask', buffered: false }); } catch { /* */ }
        const toasts = [];
        const mo = new MutationObserver(() => { for (const t of document.querySelectorAll('.mdr-toast, [class*="toast"]')) toasts.push(t.textContent); });
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const t0 = performance.now();
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        document.activeElement.dispatchEvent(ev);
        const handler = performance.now() - t0;
        // the frames after the paste: the longest gap between two animation frames
        let maxGap = 0, last = performance.now();
        const end = performance.now() + 1500;
        while (performance.now() < end) {
          await new Promise((res) => requestAnimationFrame(res));
          const now = performance.now();
          maxGap = Math.max(maxGap, now - last);
          last = now;
        }
        po.disconnect(); mo.disconnect();
        return { handler, prevented: ev.defaultPrevented, maxGap, longest: tasks.length ? Math.max(...tasks) : 0, toasts: [...new Set(toasts)] };
      }, text);
      await B.settle(300);
      const src = await B.source();
      if (want === 'refused') {
        const after = await page.evaluate(() => document.querySelector('.mdr-preview .is-editing')?.innerHTML ?? null);
        const ok = src === doc && after === before && r.toasts.some((t) => t && t.includes(TOAST)) && r.handler < 100;
        check(name, ok, `src unchanged=${src === doc} dom unchanged=${after === before} toast=${J(r.toasts)} handler=${r.handler.toFixed(1)} ms`);
        break;
      }
      const arrived = src.replace(/  \n/g, '\n').includes(text.split('\n\n')[0].slice(0, 2000)) && src.length >= text.length;
      // serializeBlock alone, on the block the caret is in now
      const ser = await page.evaluate(async (line) => {
        const m = await import('/src/preview/serialize.ts');
        const el = document.querySelector('.mdr-preview .is-editing');
        if (!el) return null;
        const t = performance.now();
        const md = m.serializeBlock(el, Number(window.__mdr.app.preview.blockAtLine(line)?.kind ?? 0), { editing: true });
        return { ms: performance.now() - t, len: md.length };
      }, line);
      // one more keystroke: the frame that flushes it
      const key = await page.evaluate(async () => {
        const tasks = [];
        const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) tasks.push(e.duration); });
        try { po.observe({ type: 'longtask', buffered: false }); } catch { /* */ }
        const te = performance.now();
        document.execCommand('insertText', false, 'Z');
        const exec = performance.now() - te;
        let maxGap = 0, last = performance.now();
        const end = performance.now() + 1000;
        while (performance.now() < end) {
          await new Promise((res) => requestAnimationFrame(res));
          const now = performance.now();
          maxGap = Math.max(maxGap, now - last);
          last = now;
        }
        po.disconnect();
        return { exec, maxGap, longest: tasks.length ? Math.max(...tasks) : 0 };
      });
      await B.settle(300);
      const src2 = await B.source();
      const blocked = Math.max(r.maxGap, r.longest) + r.handler;
      // the flush of the keystroke is the frame after the browser's own insertion (measured apart: in a single
      // unbroken 55 000-character word Chrome's own typing costs seconds — layout, not the session)
      const keyMs = key.maxGap;
      const ok = arrived && src2.includes('Z') && blocked <= 500 && keyMs <= 100 + 17;
      check(name, ok, `handler=${r.handler.toFixed(1)} ms, after-paste longest frame/task=${Math.max(r.maxGap, r.longest).toFixed(0)} ms (budget 500 incl. handler: ${blocked.toFixed(0)}), serializeBlock alone=${ser ? ser.ms.toFixed(0) + ' ms/' + ser.len + ' chars' : 'n/a'}, next key: browser insertText ${key.exec.toFixed(0)} ms, flush frame ${keyMs.toFixed(0)} ms (budget 100), arrived=${arrived}, src ${src2.length} chars`);
    } catch (e) {
      if (attempt === 0 && /context was destroyed|reading 'app'|navigation/.test(e.message)) continue;
      check(name, false, 'threw ' + e.message.split('\n')[0]);
    }
    void failsBefore;
    break;
    }
  }
  console.log('errors', J(B.pageErrors.slice(0, 3)), J(B.consoleErrors.slice(0, 3)));
} finally { console.log(`${results.pass}/${results.pass + results.fail} passed; fails: ${results.fails.join(' ')}`); stop(); await B.close(); }
