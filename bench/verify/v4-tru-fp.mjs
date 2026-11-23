// bench/verify/v4-tru-fp.mjs — verify-trust (stage 2d re-verification, round 3): the cost of the conservative U15
// scan on real Markdown (CONTRACT §11, K4). Every block of the given files goes through the worker's own markdown-it
// instance (src/worker/md.ts, math on) and the pre-round-3 one (since round 7: the released 0.2.0's, the control scan of
// v4-tru-diff.mjs setupPage, test/fixtures/src-0.2.0); per block it reports whether
// it holds raw HTML, whether either scan flags it, which U15 rule fired (the text rule or mayEndInTag, re-implemented
// verbatim from md.ts to name the reason), and whether its DOM really carries a document-supplied reserved name (the
// neutralized-DOM detector of bench/verify/v4-tru-diff.mjs). Must hold: 0 flagged blocks without raw HTML.
// Also checks a list of ordinary constructs (code spans, fences, autolinks, URLs that mention md- / data-l=).
//   MDR_PORT=5433 node bench/verify/v4-tru-fp.mjs [file ...]   (default: README.md docs/*.md test-data/small.md
//   test-data/medium.md and the first 1,000,000 characters of test-data/large.md)
// Needs this tree's dev server on MDR_PORT. Writes nothing. Global timeout 110 s.
import { chromium } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { setupPage } from './v4-tru-diff.mjs';

const PORT = Number(process.env.MDR_PORT) || 5433;
let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 110_000);

const args = process.argv.slice(2);
const files = args.length ? args : ['README.md', ...readdirSync('docs').filter((f) => f.endsWith('.md')).map((f) => 'docs/' + f), 'test-data/small.md', 'test-data/medium.md', 'test-data/large.md'];
const docs = files.map((f) => {
  let t = readFileSync(f, 'utf8');
  if (f.endsWith('large.md')) t = t.slice(0, 1_000_000);
  return { f, t };
});
const ORDINARY = [
  'Use the `md-math` class.', 'Set `data-l=3` on it.', '```md-math\nx\n```', '```js data-l=1\ncode\n```',
  'See <https://example.com/?data-l=1&x=md-y>.', 'Mail <md-team@example.com>.', 'https://example.com/md-guide?data-lang=en',
  'www.example.com/data-md', '[md-math](https://e.com/md-math "data-l=1")', '![md-block](md-block.png)', '# md-heading',
  '| md- | data-l |\n|---|---|\n| a | b |', 'A <br> then md-x.', 'Press <kbd>Ctrl</kbd> and md-.', 'x <b>bold</b> data-l=2',
  '<span>it\'s = \'fine</span>', 'Price $5, then 5$ each md-.', '- [ ] md-task\n- [x] data-l', '> quote md-x data-lang=y',
  'a<sup>2</sup> = b', 'H<sub>2</sub>O and it\'s', '<img src="a.png" alt="x"> md-', '<a href="https://e.com/?q=1">a = \'b</a>',
  '<details>\n<summary>md-math notes</summary>\n\ntext\n\n</details>', '<div>\nIt\'s = \'quoted\n</div>', '<p>x = "y</p>', '<!-- md-math -->',
  'text <!-- data-l --> text', '<div title="a">\n\nb\n\n</div>',
];

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/?mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  if ((await setupPage(page)) !== 'ok') throw new Error('setup failed');
  await page.evaluate(async () => {
    const [md, types] = await Promise.all([import('/src/worker/md.ts'), import('/src/shared/types.ts')]);
    const real = md.createMarkdown(types.DEFAULT_RENDER_OPTIONS);
    // verbatim copies of md.ts's private rules, only to name the reason
    const RESERVED_TEXT = /data-(?:lang|l)(?![a-z0-9_.:-])|data-md|(?<![a-z0-9_-])mdr?-/;
    const NUM_REF = /&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));?/g;
    const VALUE_OPEN = /=[\t\n\f\r ]*(["'])/g;
    const TAG_START = /<\/?[a-z]/i;
    const dec = (s) => (!s.includes('&#') ? s : s.replace(NUM_REF, (_m, h, d) => { const cp = h !== undefined ? parseInt(h, 16) : parseInt(d, 10); return !Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '?' : String.fromCodePoint(cp); }));
    const mayEnd = (html) => {
      const gt = html.lastIndexOf('>');
      if (TAG_START.test(gt < 0 ? html : html.slice(gt + 1))) return 'open-tag-after-last->';
      VALUE_OPEN.lastIndex = 0;
      for (let m = VALUE_OPEN.exec(html); m; m = VALUE_OPEN.exec(html)) {
        const at = VALUE_OPEN.lastIndex - 1;
        const close = html.indexOf(m[1], at + 1);
        if (close < 0) return 'unmatched-quote';
        if (at < gt && close > gt) return 'quote-across-last->';
      }
      return null;
    };
    const reasons = (src) => {
      const out = [];
      const walk = (ts) => { for (const t of ts) {
        if (t.type === 'html_block' || t.type === 'html_inline') {
          const m = RESERVED_TEXT.exec(dec(t.content).toLowerCase());
          if (m) out.push('text:' + m[0]);
          const e = mayEnd(t.content);
          if (e) out.push('tag:' + e);
        }
        if (t.children && t.type !== 'image') walk(t.children);
      } };
      try { walk(real.md.parse(src, { references: {} })); } catch { /* */ }
      return out;
    };
    window.__v4fp = { reasons };
  });
  const T = { files: 0, blocks: 0, raw: 0, flagged: 0, flaggedNoRaw: 0, oldFlagged: 0, newlyFlagged: 0, newlyFlaggedTrue: 0, newlyFlaggedFp: 0, flaggedFp: 0, threw: 0 };
  const why = {};
  const examples = [];
  for (const { f, t } of docs) {
    // (fix-pre, round 7: tolerant — a block whose neutralized HTML makes the sanitizer throw, DOMPurify on a processing
    // instruction named form such as the docs now quote, is counted as `threw`, not the end of the run; see v4-tru-diff.mjs)
    const r = await page.evaluate((doc) => window.__v4tru.check(doc, true).map((b) => ({ ...b, why: b.flagged ? window.__v4fp.reasons(b.src) : [] })), t);
    T.files++;
    let fileFp = 0;
    for (const b of r) {
      if (b.threw) { T.threw++; console.log(`THREW (${b.msg}, the real HTML throws too: ${b.realThrows}) in ${f}: ${JSON.stringify(b.src.slice(0, 160))}`); continue; }
      if (b.mismatch || b.nullFrag) continue;
      T.blocks++;
      if (b.raw) T.raw++;
      if (!b.flagged) continue;
      T.flagged++;
      if (!b.raw) T.flaggedNoRaw++;
      const truePos = b.found.length > 0 || b.absorbed;
      if (!truePos) { T.flaggedFp++; fileFp++; }
      if (b.oldFlagged) { T.oldFlagged++; continue; }
      T.newlyFlagged++;
      if (truePos) T.newlyFlaggedTrue++; else {
        T.newlyFlaggedFp++;
        for (const w of new Set(b.why.map((x) => x.split(':').slice(0, 2).join(':')))) why[w] = (why[w] ?? 0) + 1;
        if (examples.length < 12) examples.push({ f, why: b.why.slice(0, 3), src: b.src.slice(0, 160) });
      }
    }
    console.log(`${f}: ${r.length} blocks, flagged-without-a-real-name ${fileFp}`);
  }
  console.log('TOTALS', JSON.stringify(T));
  console.log('NEWLY FLAGGED (not by the control scan, the released 0.2.0), no real reserved name, by reason:', JSON.stringify(why));
  for (const e of examples) console.log('FP', JSON.stringify(e));
  const ord = await page.evaluate((list) => list.map((d) => ({ d, b: window.__v4tru.check(d).map((x) => ({ flagged: x.flagged, raw: x.raw, why: x.flagged ? window.__v4fp.reasons(x.src) : [] })) })), ORDINARY);
  for (const o of ord) console.log(`ORDINARY ${o.b.some((x) => x.flagged) ? 'FLAGGED' : 'ok     '} ${JSON.stringify(o.d)} ${JSON.stringify(o.b)}`);
  console.log(T.flaggedNoRaw === 0 ? 'RESULT PASS (no block without raw HTML flagged)' : 'RESULT FAIL');
  process.exitCode = T.flaggedNoRaw === 0 ? 0 : 1;
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  process.exitCode = 2;
} finally {
  clearTimeout(killer);
  try { await browser?.close(); } catch { /* */ }
}
