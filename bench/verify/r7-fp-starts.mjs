// bench/verify/r7-fp-starts.mjs — fix-pre (round 7, H2; CONTRACT §11 Checkpoint I "the start set"): a differential of
// session starts, the tree against the released 0.2.0 build. Two pages side by side, both with 预览可编辑 on:
//   tree: this tree's dev server (MDR_PORT, default 5468), base: the released dist served by `vite preview` (MDR_BASE_PORT,
//   default 5469; release/baseline-0.2.0.noindex/dist). Both are opened with ?perf=1 (the build has its test hooks only
//   there) and the perf overlay is hidden: it sits over the preview and takes clicks meant for a block.
// Every block of every document is clicked on the real path (mouse press and release on its first ordinary text, as
// fix2-g-walk does; a block without one: its first image / rule / cell / item / paragraph) on both sides; a session
// started = a wrapper .is-editing within 400 ms; then Escape. A block is COMPARED when the click point hits that block on
// both sides; it is a DIFFERENCE when a session starts on one side only. Also counted: a source changed by click + Escape.
//   MDR_PORT=5468 MDR_BASE_PORT=5469 node bench/verify/r7-fp-starts.mjs gen <documents> <seed> [from]
//   MDR_PORT=5468 MDR_BASE_PORT=5469 MDR_SAMPLE=150 node bench/verify/r7-fp-starts.mjs walk [doc,doc...]
// gen: the trust generator (bench/verify/v4-tru-gen.mjs generate(rng(seed + i * 7919))), documents from..from+n-1.
// walk: the corpus of the fidelity walk (fix2-g-walk's default list), at most MDR_SAMPLE blocks per file, evenly spread.
// Prints totals and every difference (up to 40); MDR_OUT = JSON with all of it. Exit 0 = no difference, 1 = difference,
// 2 = error. Global timeout MDR_TIMEOUT ms (default 1 500 000); writes nothing in the tree.
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { generate, rng } from './v4-tru-gen.mjs';

const PORT = Number(process.env.MDR_PORT) || 5468;
const BASE_PORT = Number(process.env.MDR_BASE_PORT) || 5469;
const MODE = process.argv[2] || 'gen';
const ROOT = new URL('../../', import.meta.url).pathname;
const SAMPLE = Number(process.env.MDR_SAMPLE ?? 150);
const KIND = ['Prose', 'Heading', 'Code', 'Table', 'List', 'Quote', 'Html', 'Math', 'Hr'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let docs = [];
if (MODE === 'gen') {
  const n = Number(process.argv[3] ?? 1000), seed = Number(process.argv[4] ?? 1), from = Number(process.argv[5] ?? 0);
  for (let i = from; i < from + n; i++) docs.push([`gen:${seed}:${i}`, generate(rng(seed + i * 7919), 0)]);
} else {
  const list = (process.argv[3] ?? 'README.md,docs/CONTRACT.md,docs/SPEC.md,docs/FINDINGS-inline-r1.md,docs/WIP-inline-edit.md,docs/FINDINGS-0.2.0-r1.md,test-data/small.md,test-data/medium.md').split(',');
  docs = list.map((f) => [f, readFileSync(ROOT + f, 'utf8')]);
}

const out = { mode: MODE, argv: process.argv.slice(2), docs: docs.length, blocks: 0, compared: 0, startedBoth: 0, refusedBoth: 0, diffs: [], noHit: 0, noPoint: 0, wrote: [], reloads: 0, byKind: {} };
const dump = () => { if (process.env.MDR_OUT) try { writeFileSync(process.env.MDR_OUT, JSON.stringify(out, null, 1)); } catch { /* */ } };
let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); dump(); try { await browser?.close(); } catch { /* */ } process.exit(3); }, Number(process.env.MDR_TIMEOUT ?? 1_500_000));

async function openSide(port) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e?.message ?? e)));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const boot = async () => {
    await page.goto(`http://localhost:${port}/?mode=split&perf=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
    await page.addStyleTag({ content: '.mdr-perf { display: none !important; }' });
    await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable?.(true));
  };
  await boot();
  return { page, errs, boot };
}
const load = (s, text) => s.page.evaluate(async ({ t }) => {
  window.__mdr.app.preview.endEditSession?.();
  window.__mdr.loadText(t, 'd.md');
  await window.__mdr.waitIdle();
}, { t: text });
const blocksOf = (s) => s.page.evaluate(() => {
  const pv = window.__mdr.app.preview;
  const n = window.__mdr.app.editor.view.state.doc.lines;
  const text = window.__mdr.app.getText().split('\n');
  const outB = [];
  let l = 1;
  while (l <= n) {
    const b = pv.blockAtLine(l);
    if (!b) break;
    if (text.slice(b.startLine - 1, b.startLine - 1 + b.lineCount).some((x) => x.trim() !== '')) outB.push({ startLine: b.startLine, lineCount: b.lineCount, kind: b.kind });
    l = b.startLine + Math.max(1, b.lineCount);
  }
  return outB;
});
/** Brings the block at `line` into view without scrollToLine (no navigation anchor), waits for its fresh mount and returns
 *  a click point on its first ordinary text (or its first image / rule / cell / item / paragraph), with what it hits. */
const pointOf = (s, line) => s.page.evaluate(async (line) => {
  const pv = window.__mdr.app.preview;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const wrap = () => pv.elementOfBlock(pv.blockAtLine(line).id);
  const sc = pv.el;
  for (let k = 0; k < 4; k++) {
    let w = wrap();
    if (!w) { pv.scrollToLine(line, 0, 'instant'); await new Promise((r) => setTimeout(r, 650)); w = wrap(); }
    if (w) {
      const r = w.getBoundingClientRect(), box = sc.getBoundingClientRect();
      if (r.top < box.top + 20 || r.top > box.top + box.height * 0.6) sc.scrollTop += r.top - (box.top + box.height / 3);
    }
    for (let i = 0; i < 120; i++) {
      const e = wrap();
      if (e && !e.classList.contains('is-stale') && !e.classList.contains('is-pending') && e.getBoundingClientRect().height > 0) break;
      await raf();
    }
    await raf(); await raf();
    const el = wrap();
    if (!el) continue;
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentElement;
        if (!p || p.closest('a[href], .md-math, .katex, [data-mdr-ui], .md-code__lang, button, label, summary, .md-codewrap > :not(pre)')) return 2;
        if (!n.data.trim()) return 2;
        return 1;
      },
    });
    let pt = null;
    for (let n = tw.nextNode(); n && !pt; n = tw.nextNode()) {
      let i = n.data.search(/\S/);
      if (i > 0 && /[\udc00-\udfff]/.test(n.data[i])) i--;
      const rg = document.createRange();
      rg.setStart(n, i); rg.setEnd(n, Math.min(n.data.length, i + (/[\ud800-\udbff]/.test(n.data[i]) ? 2 : 1)));
      const rc = rg.getClientRects()[0] ?? rg.getBoundingClientRect();
      if (rc.width > 0 && rc.height > 0) pt = { x: rc.left + Math.min(2, rc.width / 2), y: rc.top + rc.height / 2 };
    }
    if (!pt) {
      const t = el.querySelector('.md-math, img, hr, td, th, li, p, pre, h1, h2, h3, h4, h5, h6');
      const rc = t?.getBoundingClientRect();
      if (rc && rc.width > 0 && rc.height > 0) pt = { x: rc.left + Math.min(4, rc.width / 2), y: rc.top + rc.height / 2 };
    }
    if (!pt) return { none: true, flagged: el.hasAttribute('data-mdr-x') };
    const box = sc.getBoundingClientRect();
    if (pt.y < box.top + 4 || pt.y > box.bottom - 4) continue;
    const hit = document.elementFromPoint(pt.x, pt.y);
    return { ...pt, hits: !!(hit && el.contains(hit)), flagged: el.hasAttribute('data-mdr-x') };
  }
  return { none: true, flagged: false };
}, line);
async function clickOne(s, line) {
  const pt = await pointOf(s, line);
  if (pt.none || !pt.hits) return { pt, started: null };
  const before = await s.page.evaluate(() => { getSelection().removeAllRanges(); return window.__mdr.app.getText(); });
  await s.page.mouse.click(pt.x, pt.y);
  let started = false;
  for (let i = 0; i < 10 && !started; i++) { await sleep(40); started = await s.page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing')); }
  await s.page.keyboard.press('Escape');
  const after = await s.page.evaluate(async () => { window.__mdr.app.preview.endEditSession?.(); await window.__mdr.waitIdle(); return window.__mdr.app.getText(); });
  return { pt, started, wrote: after !== before ? { before, after } : null };
}

try {
  browser = await chromium.launch({ headless: true });
  const T = await openSide(PORT);
  const B = await openSide(BASE_PORT);
  const t0 = Date.now();
  for (let d = 0; d < docs.length; d++) {
    const [name, text] = docs[d];
    for (const s of [T, B]) {
      const ok = await s.page.evaluate(() => !!window.__mdr).catch(() => false);
      if (!ok) { out.reloads++; await s.boot(); }
    }
    await Promise.all([load(T, text), load(B, text)]);
    const [bt, bb] = await Promise.all([blocksOf(T), blocksOf(B)]);
    if (JSON.stringify(bt) !== JSON.stringify(bb)) { out.diffs.push({ doc: name, what: 'structure differs', tree: bt, base: bb }); continue; }
    let list = bt;
    if (list.length > SAMPLE && MODE !== 'gen') { const step = list.length / SAMPLE; list = Array.from({ length: SAMPLE }, (_, i) => list[Math.floor(i * step)]); }
    for (const b of list) {
      out.blocks++;
      const [rt, rb] = await Promise.all([clickOne(T, b.startLine), clickOne(B, b.startLine)]);
      const k = KIND[b.kind] ?? String(b.kind);
      const bk = (out.byKind[k] ??= { compared: 0, started: 0, refused: 0 });
      if (rt.pt.none && rb.pt.none) { out.noPoint++; continue; }
      if (rt.started === null || rb.started === null) { out.noHit++; if (out.noHit <= 20) console.log('NOHIT', name, b.startLine, k, JSON.stringify(rt.pt), JSON.stringify(rb.pt)); continue; }
      out.compared++; bk.compared++;
      if (rt.started && rb.started) { out.startedBoth++; bk.started++; }
      else if (!rt.started && !rb.started) { out.refusedBoth++; bk.refused++; }
      else {
        const src = text.split('\n').slice(b.startLine - 1, b.startLine - 1 + b.lineCount).join('\n');
        out.diffs.push({ doc: name, line: b.startLine, kind: k, tree: rt.started, base: rb.started, flagged: [rt.pt.flagged, rb.pt.flagged], src: src.slice(0, 400) });
      }
      for (const [side, r] of [['tree', rt], ['base', rb]]) if (r.wrote) out.wrote.push({ doc: name, line: b.startLine, side, before: r.wrote.before.slice(0, 300), after: r.wrote.after.slice(0, 300) });
      // a click + Escape that changed the document: reload it on both sides before the next block
      if (rt.wrote || rb.wrote) await Promise.all([load(T, text), load(B, text)]);
    }
    if ((d + 1) % 100 === 0 || d === docs.length - 1) {
      console.log(`[${d + 1}/${docs.length}] ${Math.round((Date.now() - t0) / 1000)} s blocks ${out.blocks} compared ${out.compared} started-both ${out.startedBoth} refused-both ${out.refusedBoth} DIFF ${out.diffs.length} noHit ${out.noHit} noPoint ${out.noPoint} wrote ${out.wrote.length}`);
      dump();
    }
  }
  console.log('RESULT', JSON.stringify({ docs: out.docs, blocks: out.blocks, compared: out.compared, startedBoth: out.startedBoth, refusedBoth: out.refusedBoth, diffs: out.diffs.length, noHit: out.noHit, noPoint: out.noPoint, wrote: out.wrote.length, reloads: out.reloads, byKind: out.byKind }));
  for (const x of out.diffs.slice(0, 40)) console.log('DIFF', JSON.stringify(x));
  for (const x of out.wrote.slice(0, 10)) console.log('WROTE', JSON.stringify(x));
  console.log(`page errors: tree ${T.errs.length} base ${B.errs.length} ${[...T.errs, ...B.errs].slice(0, 3).join(' | ')}`);
  dump();
  process.exitCode = out.diffs.length ? 1 : 0;
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  dump();
  process.exitCode = 2;
} finally {
  clearTimeout(killer);
  try { await browser?.close(); } catch { /* */ }
}
