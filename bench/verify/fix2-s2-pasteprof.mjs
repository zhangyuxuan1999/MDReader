// bench/verify/fix2-s2-pasteprof.mjs — fix-serial-2 (stage 2b, G6): CPU profile of the keystroke after a large
// single-line paste into a paragraph session (v2-ses-bigpaste.mjs prose1), top functions by self time. Needs a
// running Vite on MDR_PORT (5311). Usage (background): MDR_PORT=5311 node bench/verify/fix2-s2-pasteprof.mjs <KB> [char]
process.env.MDR_SCRATCH = process.env.MDR_SCRATCH || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/fix2-s2';
const { openB, globalTimeout } = await import('./v2-ses-lib.mjs');

const KB = Number(process.argv[2] ?? 20);
const ch = process.argv[3] ?? 'y';
const B = await openB();
const stop = globalTimeout(Number(process.env.T ?? 100_000), B.close);
const { page } = B;
try {
  await B.boot('mode=split');
  await B.loadDoc('abc\n\nq\n');
  await B.clickLine(1, 'first', 'abc');
  await B.caretAt('abc');
  const text = ch.repeat(KB * 1024);
  const blocked = await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const t = performance.now();
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return performance.now() - t;
  }, text);
  console.log(`paste handler ${Math.round(blocked)} ms`);
  await B.settle(300);
  const cdp = await B.getCdp();
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const t1 = Date.now();
  await page.keyboard.type('Z');
  await B.settle(200);
  console.log(`one more key: ${Date.now() - t1} ms`);
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = profile.timeDeltas;
  const counts = new Map();
  for (let i = 0; i < profile.samples.length; i++) counts.set(profile.samples[i], (counts.get(profile.samples[i]) ?? 0) + (dt[i] ?? 0));
  for (const [id, us] of counts) {
    const n = byId.get(id);
    const f = n.callFrame;
    const key = `${f.functionName || '(anon)'} ${f.url.replace(/^.*\/src\//, 'src/').replace(/\?.*$/, '')}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + us);
  }
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  for (const [k, us] of top) console.log(`${(us / 1000).toFixed(1).padStart(9)} ms  ${k}`);
  // inclusive time per src/ function: walk parents
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const incl = new Map();
  for (const [id, us] of counts) {
    const seen = new Set();
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
      const f = byId.get(cur).callFrame;
      if (!f.url.includes('/src/')) continue;
      const key = `${f.functionName || '(anon)'} ${f.url.replace(/^.*\/src\//, 'src/').replace(/\?.*$/, '')}:${f.lineNumber + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      incl.set(key, (incl.get(key) ?? 0) + us);
    }
  }
  console.log('--- inclusive (src/)');
  for (const [k, us] of [...incl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${(us / 1000).toFixed(1).padStart(9)} ms  ${k}`);
} catch (e) { console.log('ERR', e.message.split('\n')[0]); } finally { stop(); await B.close(); }
