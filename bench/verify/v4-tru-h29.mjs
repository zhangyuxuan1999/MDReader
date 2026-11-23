// bench/verify/v4-tru-h29.mjs — verify-trust (stage 2d re-verification, round 3): H29 variations. Times what a click
// on a hostile block costs before a session starts — unsupportedReason, the baseline serialization (serializeBlock,
// editing hints) and the fidelity gate (baselineFaithful) — in real Chromium, for blocks of ~60,000 characters (the
// MAX_EDIT_CHARS limit) built from many repeated shapes, and at a quarter of that size to show the growth (linear:
// about 4x; quadratic: about 16x). Not a performance record (the machine is loaded): a shape over 100 ms or with a
// growth far above 4x is reported with its numbers.
//   MDR_PORT=5433 node bench/verify/v4-tru-h29.mjs [shape-filter]
// Needs this tree's dev server on MDR_PORT. Writes nothing. Global timeout 110 s.
import { chromium } from '@playwright/test';

const PORT = Number(process.env.MDR_PORT) || 5433;
const filter = process.argv[2] ?? '';
let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 110_000);

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/?mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  const out = await page.evaluate(async (filter) => {
    const [md, math, seg, san, cp, ser, fid, types] = await Promise.all([
      import('/src/worker/md.ts'), import('/src/worker/math.ts'), import('/src/worker/segmenter.ts'), import('/src/preview/sanitize.ts'),
      import('/src/preview/createPreview.ts'), import('/src/preview/serialize.ts'), import('/src/preview/fidelity.ts'), import('/src/shared/types.ts'),
    ]);
    await math.loadMath();
    const mdk = md.createMarkdown(types.DEFAULT_RENDER_OPTIONS);
    mdk.enableMath();
    const C = (n) => String.fromCharCode(n);
    const rep = (s, n) => s.repeat(Math.max(1, Math.floor(n / s.length)));
    const SHAPES = {
      'em-spaces': (n) => `a *x${rep(' ', n)}y* b`,
      'em-tabs': (n) => `a *x${rep('\t', n)}y* b`,
      'em-nbsp': (n) => `a *x${rep(C(0xa0), n)}y* b`,
      'em-idsp': (n) => `a *x${rep(C(0x3000), n)}y* b`,
      'math-spaces': (n) => `a $x${rep(' ', n)}y$ b`,
      'math-nl-block': (n) => `$$\nx${rep(' \n', n)}y\n$$`,
      'math-backslash-space': (n) => `a $x${rep('\\ ', n)}y$ b`,
      'strong-spaces-end': (n) => `a **x${rep(' ', n)}** b`,
      'nested-em': (n) => rep('*a **b ', n),
      'stars': (n) => 'x ' + rep('*', n) + ' y',
      'underscores': (n) => 'x ' + rep('_', n) + ' y',
      'backslashes': (n) => 'x ' + rep('\\', n) + ' y',
      'dollars': (n) => 'x ' + rep('$', n) + ' y',
      'dollar-digit': (n) => 'x ' + rep('$1 ', n) + ' y',
      'backticks': (n) => 'x ' + rep('`', n) + ' y',
      'brackets': (n) => 'x ' + rep('[', n) + ' y',
      'link-runs': (n) => rep('[a](b) ', n),
      'lt-amp': (n) => 'x ' + rep('&lt;&amp;', n) + ' y',
      'entities': (n) => rep('&#32;', n),
      'zwsp': (n) => 'x' + rep(C(0x200b), n) + 'y',
      'soft-breaks': (n) => rep('a\n', n),
      'hard-breaks': (n) => rep('a  \n', n),
      'backslash-breaks': (n) => rep('a\\\n', n),
      'code-fence-blank': (n) => '```\n' + rep('\n', n) + 'x\n```',
      'code-fence-spaces': (n) => '```\n' + rep(' ', n) + 'x\n```',
      'inline-code-spaces': (n) => 'a `x' + rep(' ', n) + 'y` b',
      'list-items': (n) => rep('- a\n', n),
      'task-items': (n) => rep('- [ ] a\n', n),
      'nested-list': (n) => Array.from({ length: Math.floor(n / 40) }, (_, i) => '  '.repeat(i % 10) + '- item ' + i).join('\n'),
      'table-rows': (n) => '| a | b |\n|---|---|\n' + rep('| x | y |\n', n),
      'table-cell-spaces': (n) => '| a | b |\n|---|---|\n| x' + rep(' ', n) + 'y | z |',
      'quote-lines': (n) => rep('> a\n', n),
      'heading-spaces': (n) => '# a' + rep(' ', n) + 'b',
      'raw-span-runs': (n) => rep('<span>a</span>', n),
      'raw-br-runs': (n) => 'a' + rep('<br>', n) + 'b',
      'mixed-ws': (n) => 'a *x' + rep(' \t' + C(0xa0), n) + 'y* b',
      'em-ws-then-punct': (n) => 'a *x' + rep(' ', n) + '.*',
      'one-word': (n) => rep('a', n),
      'link-text-spaces': (n) => `a [x${rep(' ', n)}y](https://e.example/) b`,
      'raw-sup-spaces': (n) => `a <sup>x${rep(' ', n)}y</sup> b`,
      'em-in-link-spaces': (n) => `a [*x${rep(' ', n)}y*](https://e.example/) b`,
      'del-spaces': (n) => `a ~~x${rep(' ', n)}y~~ b`,
      'em-newline-runs': (n) => `a *x${rep(' \n', n)}y* b`,
      'backslash-pairs': (n) => 'x ' + rep('\\\\ ', n) + ' y',
      'backtick-pairs': (n) => 'x ' + rep('`` ', n) + ' y',
      'backslash-end': (n) => 'x ' + rep('\\', n),
    };
    const res = [];
    for (const [name, make] of Object.entries(SHAPES)) {
      if (filter && !name.includes(filter)) continue;
      const row = { name };
      for (const n of [15000, 58000]) {
        let src = make(n);
        if (src.length > 59900) src = src.slice(0, 59900);
        const s = seg.segmentAll(src.split('\n'));
        const kind = s.length ? s[0].kind : types.BlockKind.Prose;
        const r = mdk.renderBlock(src, { references: {} });
        const w = document.createElement('section');
        w.className = 'md-block';
        document.body.appendChild(w);
        if (r.flags & types.HTML_FLAG_TRUSTED) w.innerHTML = r.html; else w.replaceChildren(san.sanitizeToFragment(r.html) ?? '');
        cp.wrapCodeFences(w);
        const hints = { ...(ser.sourceStyleHints ? ser.sourceStyleHints(src) : {}), editing: true };
        const t0 = performance.now();
        let why = null;
        try { why = ser.unsupportedReason(w, src); } catch (e) { why = 'threw ' + e; }
        const t1 = performance.now();
        let base = null;
        try { base = ser.serializeBlock(w, kind, hints); } catch (e) { base = null; why = (why ?? '') + ' serialize threw ' + e; }
        const t2 = performance.now();
        let ok = null;
        try { ok = base === null ? null : fid.baselineFaithful(w, kind, base); } catch (e) { ok = 'threw ' + e; }
        const t3 = performance.now();
        w.remove();
        row[n] = { len: src.length, plain: !!(r.flags & types.HTML_FLAG_PLAIN), reason: why, guard: +(t1 - t0).toFixed(1), ser: +(t2 - t1).toFixed(1), gate: +(t3 - t2).toFixed(1), faithful: ok };
      }
      res.push(row);
    }
    return res;
  }, filter);
  let bad = 0;
  for (const r of out) {
    const a = r[15000], b = r[58000];
    const tot = (x) => x.guard + x.ser + x.gate;
    const growth = tot(a) > 2 ? tot(b) / tot(a) : 0;
    const flag = tot(b) > 100 || growth > 9;
    if (flag) bad++;
    console.log(`${flag ? 'SLOW' : 'ok  '}  ${r.name.padEnd(22)} n=${b.len} plain=${b.plain} reason=${b.reason} guard ${b.guard} ms, serialize ${b.ser} ms, gate ${b.gate} ms (faithful ${b.faithful}); at n=${a.len}: ${tot(a).toFixed(1)} ms; growth x${growth.toFixed(1)}`);
  }
  console.log(`${bad} shape(s) over 100 ms or growing faster than linear`);
  process.exitCode = bad ? 1 : 0;
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  process.exitCode = 2;
} finally {
  clearTimeout(killer);
  try { await browser?.close(); } catch { /* */ }
}
