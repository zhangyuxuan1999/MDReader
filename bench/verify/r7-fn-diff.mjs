// bench/verify/r7-fn-diff.mjs — fix-san (round 7), rule SAN: "what the sanitizer returns for HTML that does not throw does
// not change by one byte", measured on the whole MOUNT path in real Chromium. Two pages, each with its own module graph
// (and so its own DOMPurify with its own hooks): OLD imports createPreview.ts + sanitize.ts of the released snapshot
// (test/fixtures/src-0.2.0, the frozen copy of the released 0.2.0), NEW imports those of the tree. Both render the same documents of the trust generator
// (bench/verify/v4-tru-gen.mjs, the seed scheme of bench/verify/v4-tru-diff.mjs) with the tree's worker renderer (src/worker
// is unchanged in round 7), mount every block through a real preview (applyStructure, mountAll, applyHtml on request),
// and the mounted wrapper of every block (its innerHTML and data-mdr-x) must be identical on both sides. Blocks whose
// sanitization throws are left out of both mounts and counted (the candidate shows them as the render-error block; see
// bench/verify/r7-fn-san.mjs); in the NEW page the tree's sanitizeToFragment output is also compared, as a string, with
// what OLD's returns.
//   MDR_PORT=5462 node bench/verify/r7-fn-diff.mjs [documents=20000] [seed=1] [from=0]
// Needs the tree's dev server on MDR_PORT. Prints totals and up to 10 differences. Exit 0 = identical, 1 = a difference,
// 2 = error. R7_CONTROL=1: a positive control (every 97th block of NEW altered: must be reported). Global timeout T_MS (default 110000; when it nears, it stops and prints how far it got).
import { chromium } from '@playwright/test';

const PORT = process.env.MDR_PORT || '5462';
const N = Number(process.argv[2] ?? 20000);
const SEED = Number(process.argv[3] ?? 1);
const FROM = Number(process.argv[4] ?? 0);
const T_MS = Number(process.env.T_MS ?? 110000);
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, T_MS);
const BATCH = 1000;   // (the documents of v4-tru-diff: its rng(seed + from * 7919) per 1000)

async function side(browser, root) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e && e.message)));
  await page.route(`http://localhost:${PORT}/__r7fn_blank`, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>' }));
  await page.goto(`http://localhost:${PORT}/__r7fn_blank`);
  const ok = await page.evaluate(async (root) => {
    const [cp, san, md, math, seg, types, proto, bus, gen] = await Promise.all([
      import(root + '/preview/createPreview.ts'), import(root + '/preview/sanitize.ts'),
      import('/src/worker/md.ts'), import('/src/worker/math.ts'), import('/src/worker/segmenter.ts'), import('/src/shared/types.ts'),
      import('/src/shared/protocol.ts'), import('/src/shared/bus.ts'), import('/bench/verify/v4-tru-gen.mjs'),
    ]);
    if (!(await math.loadMath())) return 'math did not load';
    const real = md.createMarkdown(types.DEFAULT_RENDER_OPTIONS); real.enableMath();
    const T = types;
    const hash = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16) + ':' + s.length; };
    const fragString = (f) => { const d = document.createElement('div'); d.append(f); return d.innerHTML; };
    /** Blocks of `n` documents from `from`, rendered; the ones the sanitizer throws on are marked. */
    const blocks = (seed, from, n) => {
      const r = gen.rng(seed + from * 7919);
      const out = [];
      for (let i = 0; i < n; i++) {
        const text = gen.generate(r, 0).replace(/\r\n?/g, '\n');
        const lines = text.split('\n');
        const env0 = { references: {} };
        try { real.md.parse(text, env0); } catch { /* */ }
        const refs = env0.references ?? {};
        for (const s of seg.segmentAll(lines)) {
          const src = lines.slice(s.start, s.start + s.count).join('\n');
          const a = real.renderBlock(src, { references: refs });
          let throws = false, sanitized = null;
          if (!(a.flags & (T.HTML_FLAG_TRUSTED | T.HTML_FLAG_PLAIN))) {
            try { sanitized = hash(fragString(san.sanitizeToFragment(a.html))); } catch { throws = true; }
          }
          out.push({ doc: from + i, kind: s.kind, count: s.count, html: a.html, flags: a.flags, throws, sanitized });
        }
      }
      return out;
    };
    let version = 0;
    /** Mounts the given blocks through a fresh preview and returns, per block, the hash of its wrapper. */
    const mount = async (list) => {
      const parent = document.createElement('div');
      parent.style.cssText = 'height:900px;width:1000px;display:flex;flex-direction:column';
      document.body.replaceChildren(parent);
      const payload = new Map();
      let pv = null;
      const answer = (ids) => queueMicrotask(() => {
        const items = ids.filter((id) => payload.has(id)).map((id) => ({ id, flags: payload.get(id).flags, payload: payload.get(id).html }));
        if (items.length) pv.applyHtml({ type: 'html', version, batch: proto.packHtml(items).batch });
      });
      pv = cp.createPreview({ parent, bus: bus.createBus(), request: answer, viewport: () => {}, resync: () => {} });
      version++;
      const arr = new Int32Array(list.length * T.BLOCK_STRIDE);
      let line = 1;
      list.forEach((b, i) => {
        const id = i + 1;
        payload.set(id, b);
        arr[i * T.BLOCK_STRIDE + T.B_ID] = id; arr[i * T.BLOCK_STRIDE + T.B_START] = line;
        arr[i * T.BLOCK_STRIDE + T.B_LINES] = b.count; arr[i * T.BLOCK_STRIDE + T.B_KIND] = b.kind;
        line += b.count;
      });
      const stats = { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: line - 1, readingMinutes: 0 };
      pv.applyStructure({ type: 'structure', version, blocks: arr, changed: Int32Array.from(list.map((_, i) => i + 1)), lineCount: line - 1, stats, outlineVersion: 1 });
      const done = await Promise.race([pv.mountAll().then(() => true), new Promise((r) => setTimeout(() => r(false), 30000))]);
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const w = pv.el.querySelector(`.md-block[data-id="${i + 1}"]`);
        out.push(w ? (w.hasAttribute('data-mdr-x') ? 'X' : '-') + w.innerHTML : null);
      }
      pv.dispose();
      return { done, out };
    };
    window.__r7 = {
      async batch(seed, from, n, full) {
        const list = blocks(seed, from, n);
        const kept = list.filter((b) => !b.throws);
        if (window.__r7control) kept.forEach((b, i) => { if (i % 97 === 0) b.html = b.html.replace('>', ' title="control">'); });
        const m = await mount(kept);
        return {
          done: m.done, blocks: list.length, throws: list.filter((b) => b.throws).map((b) => ({ doc: b.doc, html: b.html.slice(0, 160) })),
          sanitized: kept.map((b) => b.sanitized), mounted: m.out.map((s) => (s === null ? null : full ? s : hash(s))),
          src: full ? kept.map((b) => b.html) : null,
        };
      },
    };
    return 'ok';
  }, root);
  if (ok !== 'ok') throw new Error(root + ': ' + ok);
  return { page, errs };
}

let code = 2;
const browser = await chromium.launch({ headless: true });
try {
  const oldS = await side(browser, '/test/fixtures/src-0.2.0');
  const newS = await side(browser, '/src');
  if (process.env.R7_CONTROL) await newS.page.evaluate(() => { window.__r7control = true; });   // positive control: every 97th block altered
  const t0 = Date.now();
  const tot = { documents: 0, blocks: 0, mounted: 0, throws: 0, mountDiff: 0, sanitizeDiff: 0, notMounted: 0, unresolved: 0 };
  const diffs = [], throwsAt = [];
  let reached = FROM;
  for (let from = FROM; from < FROM + N; from += BATCH) {
    if (Date.now() - t0 > T_MS - 25000) { console.log(`time budget: stopped at document ${from}`); break; }
    const n = Math.min(BATCH, FROM + N - from);
    const [a, b] = await Promise.all([oldS.page.evaluate(([s, f, k]) => window.__r7.batch(s, f, k, false), [SEED, from, n]), newS.page.evaluate(([s, f, k]) => window.__r7.batch(s, f, k, false), [SEED, from, n])]);
    tot.documents += n; tot.blocks += b.blocks; tot.throws += b.throws.length; reached = from + n;
    if (!a.done || !b.done) tot.unresolved++;
    if (a.throws.length !== b.throws.length) { tot.sanitizeDiff++; diffs.push({ from, what: 'throw count', old: a.throws.length, new: b.throws.length }); }
    for (const t of b.throws) if (throwsAt.length < 10) throwsAt.push(t);
    let bad = false;
    for (let i = 0; i < Math.max(a.mounted.length, b.mounted.length); i++) {
      if (a.sanitized[i] !== b.sanitized[i]) { tot.sanitizeDiff++; bad = true; }
      if (a.mounted[i] === null || b.mounted[i] === null) { tot.notMounted++; bad = true; continue; }
      tot.mounted++;
      if (a.mounted[i] !== b.mounted[i]) { tot.mountDiff++; bad = true; }
    }
    if (bad && diffs.length < 10) {
      const [fa, fb] = await Promise.all([oldS.page.evaluate(([s, f, k]) => window.__r7.batch(s, f, k, true), [SEED, from, n]), newS.page.evaluate(([s, f, k]) => window.__r7.batch(s, f, k, true), [SEED, from, n])]);
      for (let i = 0; i < fb.mounted.length && diffs.length < 10; i++) if (fa.mounted[i] !== fb.mounted[i] || fa.sanitized[i] !== fb.sanitized[i]) diffs.push({ from, i, src: fb.src[i].slice(0, 200), old: (fa.mounted[i] ?? 'null').slice(0, 300), new: (fb.mounted[i] ?? 'null').slice(0, 300) });
    }
  }
  console.log(`r7-fn-diff: seed ${SEED} documents ${FROM}..${reached} ${JSON.stringify(tot)} ${Date.now() - t0} ms, page errors old ${oldS.errs.length} new ${newS.errs.length}`);
  for (const t of throwsAt) console.log('THROWS (left out of both mounts)', JSON.stringify(t));
  for (const d of diffs) console.log('DIFF', JSON.stringify(d));
  for (const e of [...oldS.errs, ...newS.errs].slice(0, 5)) console.log('PAGE ERROR', e);
  const same = tot.mountDiff === 0 && tot.sanitizeDiff === 0 && tot.notMounted === 0 && tot.unresolved === 0 && oldS.errs.length + newS.errs.length === 0;
  console.log(same ? 'RESULT PASS (identical)' : 'RESULT FAIL');
  code = same ? 0 : 1;
} catch (e) { console.log('ERROR', e && e.stack || e); code = 2; }
finally { clearTimeout(KILL); await browser.close().catch(() => {}); }
process.exitCode = code;
