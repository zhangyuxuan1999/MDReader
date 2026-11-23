// bench/verify/trace.mjs — Chromium-trace based main-thread accounting (the MessageChannel monitor in
// common.mjs over-counts: a gap between two message turns also contains vsync waits, so it reports
// ~30 ms "busy" per key even on a 1k-line document). Here every renderer main-thread RunTask is read
// from a trace; windows are delimited by User-Timing marks the script places (performance.mark('vt:…')).
//
//   await startTrace(browser, page);   // page must call performance.mark('vt:start') afterwards
//   … drive the page, placing performance.mark('vt:key') etc …
//   const tr = await stopTrace(browser); // { tasks:[{ts,dur,kids}], marks:{name:[ts…]} } (ms, trace clock)
//   perWindow(tr.tasks, tr.marks['vt:key'], 100) → [{busy, longest, n}] per mark window
import { fmt } from './common.mjs';

const CATS = ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'v8.execute', 'blink'];
const CHILD_NAMES = new Set(['EventDispatch', 'FunctionCall', 'TimerFire', 'FireAnimationFrame', 'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'Layerize', 'Commit', 'RunMicrotasks', 'HitTest', 'HandlePostMessage', 'v8.callFunction', 'v8.run', 'ResizeObserver', 'MinorGC', 'MajorGC', 'GCEvent', 'V8.GCScavenger', 'XHRLoad']);

export async function startTrace(browser, page, path = new URL('./.trace.json', import.meta.url).pathname) {
  await page.evaluate(() => performance.mark('vt:pre'));
  await browser.startTracing(page, { path, screenshots: false, categories: CATS });
  await page.evaluate(() => performance.mark('vt:start'));
}

export async function stopTrace(browser) {
  const buf = await browser.stopTracing();
  const ev = JSON.parse(buf.toString()).traceEvents;
  const allMarks = ev.filter((e) => e.cat?.includes('blink.user_timing') && typeof e.name === 'string' && e.name.startsWith('vt:'));
  if (!allMarks.length) throw new Error('trace has no vt: user-timing marks');
  const { pid, tid } = allMarks.find((m) => m.name === 'vt:start') ?? allMarks[0];
  const marks = {};
  for (const m of allMarks) if (m.pid === pid && m.tid === tid) (marks[m.name] ??= []).push(m.ts / 1000);
  for (const k in marks) marks[k].sort((a, b) => a - b);
  const main = ev.filter((e) => e.pid === pid && e.tid === tid && e.ph === 'X' && typeof e.dur === 'number');
  // Chromium emits the SAME top-level task under both names; keeping both double-counted every busy
  // interval (a 60-key P5 run: p95 36.7 → 19.9 ms). De-duplicate on (ts, dur).
  const seenTask = new Set();
  const raw = main
    .filter((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask')
    .sort((a, b) => a.ts - b.ts)
    .filter((e) => { const k = `${e.ts}:${e.dur}`; if (seenTask.has(k)) return false; seenTask.add(k); return true; });
  const kids = main.filter((e) => CHILD_NAMES.has(e.name)).sort((a, b) => a.ts - b.ts);
  const tasks = raw.map((t) => ({ ts: t.ts / 1000, dur: t.dur / 1000, end: (t.ts + t.dur) / 1000, _ts: t.ts, _end: t.ts + t.dur }));
  // attach dominant direct children for explanation
  let j = 0;
  for (const t of tasks) {
    while (j < kids.length && kids[j].ts < t._ts) j++;
    const inside = [];
    for (let k = j; k < kids.length && kids[k].ts < t._end; k++) inside.push(kids[k]);
    const direct = inside.filter((k) => !inside.some((o) => o !== k && o.ts <= k.ts && o.ts + o.dur >= k.ts + k.dur && o.dur > k.dur));
    t.kids = direct.sort((a, b) => b.dur - a.dur).slice(0, 5).map((k) => `${k.name}${k.args?.data?.type ? '(' + k.args.data.type + ')' : ''}${k.args?.data?.functionName ? '(' + k.args.data.functionName + ')' : ''} ${(k.dur / 1000).toFixed(1)}`);
  }
  return { tasks, marks, pid, tid };
}

/** For each stamp i, the window [stamp_i, stamp_{i+1}) (last one: stamp + tailMs). Busy = sum of RunTask
 *  time overlapping the window; longest = longest single task starting in the window. */
export function perWindow(tasks, stamps, tailMs) {
  const out = [];
  for (let i = 0; i < stamps.length; i++) {
    const from = stamps[i], to = i + 1 < stamps.length ? stamps[i + 1] : from + tailMs;
    let busy = 0, longest = 0, n = 0, longestTask = null, prevEnd = -Infinity;
    for (const t of tasks) {
      if (t.end <= from) continue;
      if (t.ts >= to) break;
      const s = Math.max(t.ts, from, prevEnd), e = Math.min(t.end, to);
      if (e > s) busy += e - s;       // union, never a sum: a residual duplicate must not count twice
      prevEnd = Math.max(prevEnd, e);
      n++;
      if (t.ts >= from && t.dur > longest) { longest = t.dur; longestTask = t; }
    }
    out.push({ busy, longest, n, longestTask, from, to });
  }
  return out;
}

export function tasksBetween(tasks, from, to) {
  return tasks.filter((t) => t.ts >= from && t.ts < to);
}

export const describeTask = (t) => (t ? `${fmt(t.dur)} ms [${t.kids.join(', ')}]` : 'n/a');
