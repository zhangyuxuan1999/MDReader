// bench/verify/v4-tru-diff.mjs — verify-trust (stage 2d re-verification, round 3): attacks the U15 claim in REAL
// Chromium: "whenever an element that comes from raw HTML carries a reserved attribute name (data-l, data-lang,
// data-md…, data-mdr…) or a class token starting with md- / mdr- in the block DOM, the block wrapper has data-mdr-x".
//
// How worker-emitted names are told from document-supplied ones (no pairing, no one-letter twins): every block is
// rendered twice with the worker's own markdown-it instance (src/worker/md.ts createMarkdown, math on):
//   1. the real rendering (its HTML and its HTML_FLAG_RESERVED flag, which createPreview turns into data-mdr-x);
//   2. an instrumented copy whose html_inline / html_block rules wrap the raw token text in private-use markers and
//      whose html_block data-l injection is marked as the worker's own. The markers are stripped again and the
//      result must equal (1) byte for byte (else the block counts as "instrumentation mismatch").
// In (2) every reserved name INSIDE A WORKER TAG (outside the raw regions; worker text is escaped, so every `<` there
// starts a worker tag) is respelled neutrally (data-l → data-q, data-lang → data-qang, class md-x → qd-x). The
// neutralized HTML is mounted exactly like a block (sanitizeToFragment = DOMPurify on Chromium's parser). Any reserved
// name left in that DOM was not written by the worker's renderer: it came from document characters (raw HTML, or
// escaped Markdown text read as markup). Worker markup swallowed into a document tag shows as an attribute whose name
// starts with `<` on an element that also carries a neutralized name ("absorbed").
// A BYPASS is a block whose real flag is NOT set while its neutralized DOM has a document-supplied reserved name or
// absorbed worker markup. The pre-round-3 scan (src/worker/md.ts of a snapshot taken before round 3) ran on the same
// blocks as a positive control of the detector (it is known to miss RAWTEXT / comment shapes).
// fix-pre (round 7, CONTRACT §11 Checkpoint I): that snapshot was deleted at the release of 0.2.0; the control scan is now
// the frozen copy of the released 0.2.0 (test/fixtures/src-0.2.0/worker/md.ts), which has round 3's repair: oldMiss counts
// the blocks the released scan misses (0 expected, as for the tree), and docNames (blocks with document-supplied names)
// is the evidence that the detector sees names. A block whose neutralized HTML makes the sanitizer throw (DOMPurify on a
// processing instruction named form; the app shows such a block as the render-error box, rule SAN) is counted as `threw`
// (with whether the real HTML throws too) instead of ending the run; check(doc) called without `tolerant` still throws
// (bench/verify/v6-ro-trudiff-find.mjs relies on that).
//
// Needs this tree's dev server on MDR_PORT (never started or stopped here).
//   MDR_PORT=5433 node bench/verify/v4-tru-diff.mjs [documents=20000] [seed=1]     (V4_MODE=1: tags left open, more mutation)
// Prints totals and every bypass (up to 30). Exit 0 = no bypass, 1 = bypass found, 2 = error. Global timeout 110 s.
import { chromium } from '@playwright/test';

const PORT = Number(process.env.MDR_PORT) || 5433;
const N = Number(process.argv[2] ?? 20000);
const SEED = Number(process.argv[3] ?? 1);
const CORPUS = process.env.V4_CORPUS ?? '';   // optional: a JSON file (array of documents) instead of the generator
let browser = null;
let killer = null;

export async function setupPage(page) {
  return page.evaluate(async () => {
    const [md, math, seg, san, types, gen, oldMd, oldMath] = await Promise.all([
      import('/src/worker/md.ts'), import('/src/worker/math.ts'), import('/src/worker/segmenter.ts'),
      import('/src/preview/sanitize.ts'), import('/src/shared/types.ts'), import('/bench/verify/v4-tru-gen.mjs'),
      import('/test/fixtures/src-0.2.0/worker/md.ts'), import('/test/fixtures/src-0.2.0/worker/math.ts'),
    ]);
    if (!(await math.loadMath()) || !(await oldMath.loadMath())) return 'math did not load';
    const O = types.DEFAULT_RENDER_OPTIONS;
    const real = md.createMarkdown(O); real.enableMath();
    const old = oldMd.createMarkdown(O); old.enableMath();
    const ins = md.createMarkdown(O); ins.enableMath();
    const ch = (n) => String.fromCharCode(n);
    const RO = ch(0xe000), RC = ch(0xe001), WO = ch(0xe002), WC = ch(0xe003);
    const FIRST_TAG = /^(\s*<[a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])/;
    ins.md.renderer.rules.html_inline = (t, i) => RO + t[i].content + RC;
    ins.md.renderer.rules.html_block = (t, i) => {
      const k = t[i];
      const c = k.map ? k.content.replace(FIRST_TAG, `$1${WO} data-l="${k.map[0]}"${WC}`) : k.content;
      return RO + c + RC;
    };
    const MARK = new RegExp("[" + RO + "-" + WC + "]", "g");
    const neutralTag = (tag) => tag
      .replace(/(\s)data-lang=/g, '$1data-qang=')
      .replace(/(\s)data-l=/g, '$1data-q=')
      .replace(/(\sclass=")([^"]*)"/g, (_m, a, v) => a + v.split(' ').map((t) => t.replace(/^md(r?)-/, 'qd$1-')).join(' ') + '"');
    const neutralWorker = (s) => s.replace(/<[^>]*>/g, neutralTag);
    const neutralize = (html) => {
      let out = '';
      let i = 0;
      while (i < html.length) {
        const ro = html.indexOf(RO, i);
        const end = ro < 0 ? html.length : ro;
        out += neutralWorker(html.slice(i, end));
        if (ro < 0) break;
        const rc = html.indexOf(RC, ro + 1);
        let raw = html.slice(ro + 1, rc < 0 ? html.length : rc);
        raw = raw.replace(new RegExp(`${WO}([^${WC}]*)${WC}`, 'g'), (_m, w) => w.replace(' data-l=', ' data-q='));
        out += raw;
        i = rc < 0 ? html.length : rc + 1;
      }
      return out;
    };
    const RES_ATTR = /^data-(?:l|lang|md.*)$/is;
    const RES_CLASS = /^mdr?-/i;
    const domCheck = (frag) => {
      const found = [];
      let absorbed = false;
      const walk = (root) => {
        for (const e of Array.from(root.querySelectorAll('*'))) {
          let lt = false, q = false;
          for (const a of Array.from(e.attributes)) {
            const n = a.name.toLowerCase();
            if (RES_ATTR.test(n)) found.push(`<${e.localName}> @${n}="${a.value.slice(0, 20)}"`);
            if (n.includes('<')) lt = true;
            if (n === 'data-q' || n === 'data-qang') q = true;
          }
          for (const t of Array.from(e.classList)) {
            if (RES_CLASS.test(t)) found.push(`<${e.localName}> .${t}`);
            if (/^qdr?-/.test(t)) q = true;
          }
          if (lt && q) absorbed = true;
          if (e.localName === 'template' && e.content) walk(e.content);
        }
      };
      walk(frag);
      return { found, absorbed };
    };
    const hasRaw = (tokens) => tokens.some((t) => t.type === 'html_inline' || t.type === 'html_block' || (t.children && hasRaw(t.children)));
    const check = (doc, tolerant = false) => {
      const text = doc.replace(/\r\n?/g, '\n');
      const lines = text.split('\n');
      const env0 = { references: {} };
      try { real.md.parse(text, env0); } catch { /* */ }
      const refs = env0.references ?? {};
      const res = [];
      for (const s of seg.segmentAll(lines)) {
        const src = lines.slice(s.start, s.start + s.count).join('\n');
        const a = real.renderBlock(src, { references: refs });
        const b = ins.renderBlock(src, { references: refs });
        const flagged = (a.flags & types.HTML_FLAG_RESERVED) !== 0;
        const trusted = (a.flags & types.HTML_FLAG_TRUSTED) !== 0;
        let raw = false;
        try { raw = hasRaw(real.md.parse(src, { references: refs })); } catch { /* */ }
        if (b.html.replace(MARK, '') !== a.html) { res.push({ src, mismatch: true }); continue; }
        if (trusted || (a.flags & types.HTML_FLAG_PLAIN)) { res.push({ src, flagged, raw, found: [], absorbed: false, oldFlagged: false }); continue; }
        let frag;
        try { frag = san.sanitizeToFragment(neutralize(b.html)); } catch (e) {
          if (!tolerant) throw e;
          let realThrows = false;
          try { san.sanitizeToFragment(a.html); } catch { realThrows = true; }
          res.push({ src, threw: true, realThrows, msg: String(e && e.message) }); continue;
        }
        if (!frag) { res.push({ src, nullFrag: true, flagged, html: a.html.slice(0, 200) }); continue; }
        const { found, absorbed } = domCheck(frag);
        const oldFlagged = (old.renderBlock(src, { references: refs }).flags & types.HTML_FLAG_RESERVED) !== 0;
        res.push({ src, flagged, raw, found, absorbed, oldFlagged });
      }
      return res;
    };
    window.__v4tru = { gen, check };
    return 'ok';
  });
}

async function main() {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/?mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  const setup = await setupPage(page);
  if (setup !== 'ok') throw new Error(setup);
  let corpus = null;
  if (CORPUS) corpus = JSON.parse((await import('node:fs')).readFileSync(CORPUS, 'utf8'));
  const total = corpus ? corpus.length : N;
  const T = { documents: 0, blocks: 0, rawBlocks: 0, flagged: 0, rawUnflagged: 0, docNames: 0, bypass: 0, oldMiss: 0, mismatch: 0, flaggedNoRaw: 0, nullFrag: 0, threw: 0, threwNeutralOnly: 0 };
  const bypasses = [], oldMisses = [], mism = [], fpNoRaw = [];
  const t0 = Date.now();
  const CHUNK = corpus ? 200 : 1000;
  for (let from = 0; from < total; from += CHUNK) {
    if (Date.now() - t0 > 95_000) { console.log(`time budget: stopped after ${from} documents`); break; }
    const part = await page.evaluate(({ seed, from, n, docs, mode }) => {
      const { gen, check } = window.__v4tru;
      const r = gen.rng(seed + from * 7919);
      const out = { documents: 0, blocks: 0, rawBlocks: 0, flagged: 0, rawUnflagged: 0, docNames: 0, bypass: 0, oldMiss: 0, mismatch: 0, flaggedNoRaw: 0 };
      const byp = [], om = [], mm = [], fp = [];
      for (let i = 0; i < n; i++) {
        const doc = docs ? docs[i] : gen.generate(r, mode);
        out.documents++;
        for (const b of check(doc, true)) {
          out.blocks++;
          if (b.threw) { out.threw = (out.threw ?? 0) + 1; if (!b.realThrows) out.threwNeutralOnly = (out.threwNeutralOnly ?? 0) + 1; if (mm.length < 3) mm.push("THREW (" + b.msg + ", the real HTML throws too: " + b.realThrows + "): " + b.src.slice(0, 300)); continue; }
          if (b.nullFrag) { out.nullFrag = (out.nullFrag ?? 0) + 1; if (mm.length < 3) mm.push("NULL FRAGMENT: " + JSON.stringify(b)); continue; }
          if (b.mismatch) { out.mismatch++; if (mm.length < 3) mm.push(b.src.slice(0, 300)); continue; }
          if (b.raw) out.rawBlocks++;
          if (b.flagged) out.flagged++;
          if (b.flagged && !b.raw) { out.flaggedNoRaw++; if (fp.length < 5) fp.push(b.src.slice(0, 200)); }
          if (b.raw && !b.flagged) out.rawUnflagged++;
          const named = b.found.length > 0 || b.absorbed;
          if (named) out.docNames++;
          if (named && !b.flagged) { out.bypass++; if (byp.length < 30) byp.push({ src: b.src, found: b.found, absorbed: b.absorbed }); }
          if (named && !b.oldFlagged) { out.oldMiss++; if (om.length < 3) om.push({ src: b.src.slice(0, 200), found: b.found.slice(0, 3) }); }
        }
      }
      return { out, byp, om, mm, fp };
    }, { seed: SEED, from, n: Math.min(CHUNK, total - from), docs: corpus ? corpus.slice(from, from + CHUNK) : null, mode: Number(process.env.V4_MODE ?? 0) });
    for (const k of Object.keys(T)) T[k] += part.out[k] ?? 0;
    bypasses.push(...part.byp); oldMisses.push(...part.om); mism.push(...part.mm); fpNoRaw.push(...part.fp);
  }
  console.log(`v4-tru-diff: ${JSON.stringify(T)} seed ${SEED}, ${Date.now() - t0} ms, page errors ${errors.length}`);
  for (const m of oldMisses.slice(0, 5)) console.log('CONTROL (missed by the released 0.2.0 scan):', JSON.stringify(m));
  for (const m of mism.slice(0, 3)) console.log('MISMATCH', JSON.stringify(m));
  for (const m of fpNoRaw.slice(0, 5)) console.log('FLAGGED WITHOUT RAW HTML', JSON.stringify(m));
  for (const b of bypasses.slice(0, 30)) console.log('BYPASS', JSON.stringify(b));
  for (const e of errors.slice(0, 5)) console.log('PAGE ERROR', e);
  console.log(T.bypass === 0 ? 'RESULT PASS (no bypass)' : `RESULT FAIL (${T.bypass} bypassing blocks)`);
  return T.bypass === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  killer = setTimeout(async () => {
    console.log('GLOBAL TIMEOUT');
    try { await browser?.close(); } catch { /* */ }
    process.exit(3);
  }, 110_000);
  try {
    process.exitCode = await main();
  } catch (e) {
    console.log('ERROR', e?.stack ?? e);
    process.exitCode = 2;
  } finally {
    clearTimeout(killer);
    try { await browser?.close(); } catch { /* */ }
  }
}
