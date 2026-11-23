// bench/verify/v4-tru-prof.mjs — verify-trust: CPU profile of one serializer entry point on one hostile block in real
// Chromium (CDP Profiler), to name the function a slow H29 shape spends its time in.
//   MDR_PORT=5433 node bench/verify/v4-tru-prof.mjs <shape: backslashes|backticks|custom> [n=40000] [what: serialize|guard|gate]
// Prints the 12 functions with the most self time (url:line). Writes nothing. Global timeout 100 s.
import { chromium } from '@playwright/test';

const PORT = Number(process.env.MDR_PORT) || 5433;
const shape = process.argv[2] ?? 'backslashes';
const N = Number(process.argv[3] ?? 40000);
const what = process.argv[4] ?? 'serialize';
let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 100_000);
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/?mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  await page.evaluate(async ({ shape, N }) => {
    const [md, math, seg, san, ser, fid, types] = await Promise.all([
      import('/src/worker/md.ts'), import('/src/worker/math.ts'), import('/src/worker/segmenter.ts'), import('/src/preview/sanitize.ts'),
      import('/src/preview/serialize.ts'), import('/src/preview/fidelity.ts'), import('/src/shared/types.ts'),
    ]);
    await math.loadMath();
    const mdk = md.createMarkdown(types.DEFAULT_RENDER_OPTIONS); mdk.enableMath();
    const src = shape === 'backticks' ? 'x ' + '`'.repeat(N) + ' y' : shape === 'backslashes' ? 'x ' + '\\'.repeat(N) + ' y' : shape;
    const r = mdk.renderBlock(src, { references: {} });
    const w = document.createElement('section'); w.className = 'md-block'; document.body.appendChild(w);
    w.replaceChildren(san.sanitizeToFragment(r.html));
    const kind = seg.segmentAll(src.split('\n'))[0].kind;
    window.__prof = { w, kind, src, ser, fid, hints: { ...ser.sourceStyleHints(src), editing: true } };
  }, { shape, N });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const ms = await page.evaluate((what) => {
    const p = window.__prof;
    const t0 = performance.now();
    if (what === 'guard') p.ser.unsupportedReason(p.w, p.src);
    else if (what === 'gate') p.fid.baselineFaithful(p.w, p.kind, p.ser.serializeBlock(p.w, p.kind, p.hints));
    else p.ser.serializeBlock(p.w, p.kind, p.hints);
    return performance.now() - t0;
  }, what);
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map();
  const dt = profile.timeDeltas ?? [];
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    const f = n.callFrame;
    const key = `${f.functionName || '(anon)'} ${f.url.replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '')}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  console.log(`${shape} n=${N} ${what}: ${ms.toFixed(1)} ms`);
  for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${v.toFixed(1).padStart(8)} ms  ${k}`);
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  process.exitCode = 2;
} finally {
  clearTimeout(killer);
  try { await browser?.close(); } catch { /* */ }
}
