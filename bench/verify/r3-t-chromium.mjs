// bench/verify/r3-t-chromium.mjs — fix-trust (stage 2d, round 3): the U15 differential (CONTRACT §11, H1) in real
// Chromium instead of jsdom: the same seeded generator (bench/verify/r3-t-gen.mjs), the same pipeline (the real
// segmenter, the worker's markdown-it instance with math, sanitizeToFragment = DOMPurify on Chromium's own HTML
// parser, wrapCodeFences), the same reserved-vs-neutral signature comparison as test/r3-t-reserved-diff.test.ts.
// Asserts: no block whose DOM carries a document-supplied reserved name is left unflagged. Also counts what the
// round-2 scan would have missed. fix-pre (round 7, CONTRACT §11 Checkpoint I): the snapshot of that scan was deleted at
// the release of 0.2.0; the control scan is now the frozen copy of the released 0.2.0 (test/fixtures/src-0.2.0), so
// `oldMissed` is what 0.2.0 misses (0, as the tree), and `planted` > 0 is the evidence that the detector sees names.
//
// Needs a dev server of this tree already running on MDR_PORT (never started or stopped here).
//   MDR_PORT=5401 node bench/verify/r3-t-chromium.mjs [documents=20000] [seed=4242]
// Headless Chromium, global timeout 100 s, the browser is closed in finally.
import { chromium } from '@playwright/test';

const PORT = Number(process.env.MDR_PORT) || 5401;
const N = Number(process.argv[2] ?? 20000);
const SEED = Number(process.argv[3] ?? 4242);
let browser = null;
const killer = setTimeout(async () => {
  console.log('GLOBAL TIMEOUT');
  try { await browser?.close(); } catch { /* */ }
  process.exit(3);
}, 100_000);

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/?mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  const setup = await page.evaluate(async () => {
    const [md, math, seg, san, cp, types, gen, oldMd, oldMath] = await Promise.all([
      import('/src/worker/md.ts'), import('/src/worker/math.ts'), import('/src/worker/segmenter.ts'),
      import('/src/preview/sanitize.ts'), import('/src/preview/createPreview.ts'), import('/src/shared/types.ts'),
      import('/bench/verify/r3-t-gen.mjs'), import('/test/fixtures/src-0.2.0/worker/md.ts'),
      import('/test/fixtures/src-0.2.0/worker/math.ts'),
    ]);
    if (!(await math.loadMath()) || !(await oldMath.loadMath())) return 'math did not load';
    const mdk = md.createMarkdown(types.DEFAULT_RENDER_OPTIONS);
    mdk.enableMath();
    const old = oldMd.createMarkdown(types.DEFAULT_RENDER_OPTIONS);
    old.enableMath();
    const RES_ATTR = /^data-(?:l|lang|md.*)$/s;
    const RES_CLASS = /^mdr?-/i;
    const signature = (w) => {
      const out = [];
      const walk = (e, path) => {
        let i = 0;
        for (const c of Array.from(e.children)) {
          const p = `${path}/${i++}${c.localName}`;
          for (const a of Array.from(c.attributes)) {
            const n = a.name.toLowerCase();
            if (RES_ATTR.test(n)) out.push(n === 'data-lang' ? `${p}@${n}` : `${p}@${n}=${a.value}`);
          }
          for (const t of Array.from(c.classList)) if (RES_CLASS.test(t)) out.push(`${p}.${t}`);
          walk(c, p);
        }
      };
      walk(w, '');
      return out;
    };
    const mount = (doc, withOld) => {
      const lines = doc.replace(/\r\n?/g, '\n').split('\n');
      return seg.segmentAll(lines).map((s) => {
        const src = lines.slice(s.start, s.start + s.count).join('\n');
        const r = mdk.renderBlock(src, { references: {} });
        const w = document.createElement('section');
        w.className = 'md-block';
        w.replaceChildren(san.sanitizeToFragment(r.html));
        cp.wrapCodeFences(w);
        const oldFlagged = withOld ? (old.renderBlock(src, { references: {} }).flags & types.HTML_FLAG_RESERVED) !== 0 : false;
        return { src, flagged: (r.flags & types.HTML_FLAG_RESERVED) !== 0, oldFlagged, sig: signature(w) };
      });
    };
    const extra = (a, b) => {
      const left = new Map();
      for (const s of b) left.set(s, (left.get(s) ?? 0) + 1);
      const out = [];
      for (const s of a) { const n = left.get(s) ?? 0; if (n > 0) left.set(s, n - 1); else out.push(s); }
      return out;
    };
    window.__r3t = { gen, mount, extra };
    return 'ok';
  });
  if (setup !== 'ok') throw new Error(setup);

  const totals = { documents: 0, blocks: 0, planted: 0, flagged: 0, fp: 0, missed: 0, oldMissed: 0, mismatch: 0 };
  const missed = [];
  const t0 = Date.now();
  const CHUNK = 2000;
  for (let from = 0; from < N; from += CHUNK) {
    const part = await page.evaluate(({ seed, from, n }) => {
      const { gen, mount, extra } = window.__r3t;
      const r = gen.rng(seed);
      for (let i = 0; i < from; i++) gen.generate(r);                 // the same stream as one long run
      const t = { documents: 0, blocks: 0, planted: 0, flagged: 0, fp: 0, missed: 0, oldMissed: 0, mismatch: 0 };
      const miss = [];
      for (let i = 0; i < n; i++) {
        const [a, b] = gen.generate(r);
        t.documents++;
        const ra = mount(a, true), rb = mount(b, false);
        if (ra.length !== rb.length) { t.mismatch++; continue; }
        ra.forEach((blk, j) => {
          t.blocks++;
          const x = extra(blk.sig, rb[j].sig);
          if (blk.flagged) t.flagged++;
          if (x.length) {
            t.planted++;
            if (!blk.flagged) { t.missed++; if (miss.length < 10) miss.push(`${JSON.stringify(blk.src)} → ${x.join(' ')}`); }
            if (!blk.oldFlagged) t.oldMissed++;
          } else if (blk.flagged) t.fp++;
        });
      }
      return { t, miss };
    }, { seed: SEED, from, n: Math.min(CHUNK, N - from) });
    for (const k of Object.keys(totals)) totals[k] += part.t[k];
    missed.push(...part.miss);
    console.log(`… ${from + Math.min(CHUNK, N - from)} documents, ${Date.now() - t0} ms`);
  }
  console.log(`r3-t chromium: ${JSON.stringify(totals)} seed ${SEED}, ${Date.now() - t0} ms, page errors ${errors.length}`);
  for (const m of missed) console.log(`MISSED ${m}`);
  console.log(totals.missed === 0 && totals.mismatch === 0 && totals.planted > 0 ? 'RESULT PASS' : 'RESULT FAIL');
  process.exitCode = totals.missed === 0 && totals.mismatch === 0 ? 0 : 1;
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  process.exitCode = 2;
} finally {
  clearTimeout(killer);
  try { await browser?.close(); } catch { /* */ }
}
