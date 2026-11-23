// bench/verify/analyze-trace.mjs — offline look at a trace written by trace-scenarios.mjs: for the
// key windows in the middle of the run, list every main-thread task ≥ 0.3 ms with its dominant
// children, and a histogram of the small tasks by dominant child so the "unattributed" busy time
// can be explained. Usage: node bench/verify/analyze-trace.mjs <trace.json> [windowIndex]
import { readFileSync } from 'node:fs';
const ev = JSON.parse(readFileSync(process.argv[2], 'utf8')).traceEvents;
const marks = ev.filter((e) => e.cat?.includes('blink.user_timing') && e.name === 'vkey').sort((a, b) => a.ts - b.ts);
const { pid, tid } = marks[0];
const main = ev.filter((e) => e.pid === pid && e.tid === tid && e.ph === 'X' && typeof e.dur === 'number');
const tasks = main.filter((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask').sort((a, b) => a.ts - b.ts);
const wi = Number(process.argv[3] ?? Math.floor(marks.length / 2));
const from = marks[wi].ts, to = marks[wi + 1]?.ts ?? from + 100000;
const inWin = tasks.filter((t) => t.ts >= from && t.ts < to);
const desc = (t) => {
  const kids = main.filter((e) => e !== t && e.ts >= t.ts && e.ts + e.dur <= t.ts + t.dur && e.name !== 'RunTask' && e.name !== 'ThreadControllerImpl::RunTask');
  // direct children only: those not contained in another kid
  const direct = kids.filter((k) => !kids.some((o) => o !== k && o.ts <= k.ts && o.ts + o.dur >= k.ts + k.dur && o.dur > k.dur));
  return direct.sort((a, b) => b.dur - a.dur).slice(0, 4).map((k) => `${k.name}${k.args?.data?.type ? '(' + k.args.data.type + ')' : ''}${k.args?.data?.functionName ? '(' + k.args.data.functionName + ')' : ''}${k.args?.data?.url ? '@' + String(k.args.data.url).replace(/^.*\//, '') : ''} ${(k.dur / 1000).toFixed(2)}`).join(', ');
};
console.log(`window ${wi}: ${((to - from) / 1000).toFixed(1)} ms, ${inWin.length} tasks, busy ${(inWin.reduce((a, t) => a + t.dur, 0) / 1000).toFixed(1)} ms`);
const big = inWin.filter((t) => t.dur >= 300);
for (const t of big) console.log(`  +${((t.ts - from) / 1000).toFixed(1)} ms  task ${(t.dur / 1000).toFixed(2)} ms: ${desc(t) || '(no children)'}`);
const small = inWin.filter((t) => t.dur < 300);
const hist = {};
for (const t of small) { const k = (desc(t).split(',')[0] || '(none)').replace(/ [\d.]+$/, ''); hist[k] = hist[k] ?? { n: 0, ms: 0 }; hist[k].n++; hist[k].ms += t.dur / 1000; }
console.log(`  small tasks (<0.3 ms): ${small.length}, total ${(small.reduce((a, t) => a + t.dur, 0) / 1000).toFixed(1)} ms`);
for (const [k, v] of Object.entries(hist).sort((a, b) => b[1].ms - a[1].ms).slice(0, 12)) console.log(`     ${v.ms.toFixed(2).padStart(6)} ms  n=${String(v.n).padStart(4)}  ${k}`);
