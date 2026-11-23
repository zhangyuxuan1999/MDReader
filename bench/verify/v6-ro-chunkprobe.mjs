// bench/verify/v6-ro-chunkprobe.mjs — regress-off (stage 2f, round 5): does the candidate (production build, switch
// OFF: localStorage mdr.previewEdit = "0" before start, ?perf=1 or not) ever request the lazy editing chunk during
// the gestures of a v5-offc-probes key probe? Opens the page exactly as bench/verify/v5-offc-lib.mjs open() does and
// records every request whose URL holds "inlineEdit-" with the step that was running.
//   MDR_PORT=5467 node bench/verify/v6-ro-chunkprobe.mjs [runs=3] [--pref 0|null|1] [--perf]
// Prints one line per run: requests per step. Exit 1 when a run with pref 0 requested the chunk. Global timeout 110 s.
import { open, loadDoc, DOC_ALL, pointOf, must, clickAt, sleep } from './v5-offc-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, Number(process.env.MDR_TIMEOUT || 110_000));
const args = process.argv.slice(2);
const runs = Number(args.find((a) => /^\d+$/.test(a)) || 3);
const pi = args.indexOf('--pref');
const pref = pi >= 0 ? (args[pi + 1] === 'null' ? null : args[pi + 1]) : '0';
let bad = 0;
try {
  for (let r = 0; r < runs; r++) {
    let step = 'boot';
    const hits = [];
    const B = await open(Number(process.env.MDR_PORT || 5467), { pref }).catch((e) => { throw e; });
    try {
      B.page.on('request', (q) => { if (q.url().includes('inlineEdit-')) hits.push(step); });
      // the boot itself happened before the listener: check the performance entries too
      const bootHit = await B.page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('inlineEdit-')).length);
      if (bootHit) hits.push('boot(' + bootHit + ')');
      step = 'loadDoc'; await loadDoc(B, DOC_ALL); await sleep(300);
      step = 'type';
      const p = await must(await pointOf(B.page, 'Clickhere', 0, 'left', '.cm-content'), 'editor');
      await clickAt(B.page, p); await sleep(120); await B.page.keyboard.press('End'); await B.page.keyboard.type(' QQ'); await B.idle(200);
      step = 'click';
      const q = await must(await pointOf(B.page, 'Clickhere', 3), 'preview');
      await clickAt(B.page, q); await sleep(700);
      for (const k of ['a', 'Enter', 'Backspace', 'Delete', 'Tab']) { step = 'key:' + k; await B.page.keyboard.press(k); await sleep(700); }
      step = 'idle'; await sleep(4500);
      const total = await B.page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('inlineEdit-')).length);
      console.log(`run ${r} pref=${pref}: hits=${JSON.stringify(hits)} perfEntries=${total} url=${B.page.url()}`);
      if (pref === '0' && (hits.length || total)) bad++;
    } finally { await B.close(); }
  }
} catch (e) { console.log('ERROR', e && e.message); process.exitCode = 2; }
finally { clearTimeout(KILL); }
console.log(bad ? `RESULT FAIL ${bad}/${runs} runs requested the chunk` : `RESULT PASS 0/${runs}`);
if (bad) process.exitCode = 1;
