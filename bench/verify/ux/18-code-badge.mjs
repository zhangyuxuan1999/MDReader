// bench/verify/ux/18-code-badge.mjs — the code-fence language badge (lead decision 2, final round).
//
// The badge used to be a `float: right` `::before` INSIDE `pre.md-code`. That element is the fence's
// horizontal scroller: `white-space: pre` lines ignore the float, so the badge was painted straight over
// the code glyphs, and because it lived in the scrolled content it travelled into the middle of the line
// as soon as the user scrolled right. The preview now lifts every `pre.md-code[data-lang]` into a
// `div.md-codewrap` at mount time and paints the badge from that wrapper (outside the scroller), and the
// fence reserves a line of `padding-top` for it. A block-level sticky fallback keeps the badge readable
// in the standalone HTML export, which reuses this stylesheet with the worker's raw markup.
// Run: MDR_UX_BASE=http://localhost:5231 node bench/verify/ux/18-code-badge.mjs
import { launch, open, loadText, check, finish, sleep, getFailures } from './lib.mjs';

const OUT = '/Users/zyx/LocalDocuments/MDReader/bench/verify/ux/shots';
const doc = [
  '# T', '',
  '```ts',
  'interface Block { id: number; startLine: number; lineCount: number; kind: BlockKind; hashLo: number; hashHi: number }',
  'const x = 1;',
  '```', '',
  '- 列表里的代码：', '',
  '  ```python',
  '  def f(a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y, z): return a',
  '  ```', '',
  '```',
  'no language here, badge must be absent',
  '```', '',
].join('\n');

/** Geometry of every fence plus the box its badge paints into. */
const fences = () => page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview pre.md-code'), (pre) => {
  const wrap = pre.parentElement;
  const wrapped = wrap.classList.contains('md-codewrap');
  const badge = getComputedStyle(wrapped ? wrap : pre, wrapped ? '::after' : '::before');
  const code = pre.querySelector('code');
  const pr = pre.getBoundingClientRect(), cr = code.getBoundingClientRect();
  return {
    lang: pre.dataset.lang ?? null,
    wrapped,
    wrapLang: wrapped ? wrap.dataset.lang : null,
    badge: badge.content,
    badgePosition: badge.position,
    overflowing: pre.scrollWidth > pre.clientWidth + 1,
    scrollLeft: Math.round(pre.scrollLeft),
    // px of clear space above the first code line — where the badge lives, so it cannot cover a glyph
    reserved: Math.round(cr.top - pr.top),
    wrapRight: Math.round((wrapped ? wrap : pre).getBoundingClientRect().right),
  };
}));

const { browser, page, errors } = await launch();
try {
  await open(page, '?mode=split');
  await loadText(page, doc, 'badge.md');
  await sleep(600);

  const before = await fences();
  console.log('unscrolled:', JSON.stringify(before));
  await page.screenshot({ path: `${OUT}/code-badge-unscrolled.png` });

  const withLang = before.filter((f) => f.lang);
  check('every fence with a language is lifted into a .md-codewrap carrying that language',
    withLang.length === 2 && withLang.every((f) => f.wrapped && f.wrapLang === f.lang), JSON.stringify(withLang));
  check('the badge renders from the wrapper', withLang.every((f) => f.badge === `"${f.lang}"`), JSON.stringify(withLang.map((f) => f.badge)));
  check('the fence reserves a clear line above the code, so the badge covers no glyph',
    withLang.every((f) => f.reserved >= 18), JSON.stringify(withLang.map((f) => f.reserved)));
  check('a fence with no language gets no wrapper and no badge',
    before.some((f) => !f.lang && !f.wrapped && f.badge === 'none'), JSON.stringify(before.filter((f) => !f.lang)));
  check('the wide fences really overflow (the scroll test below is meaningful)',
    withLang.every((f) => f.overflowing), JSON.stringify(withLang.map((f) => f.overflowing)));

  // Scroll every fence fully to the right: a badge painted from the wrapper cannot move.
  await page.evaluate(() => { for (const p of document.querySelectorAll('.mdr-preview pre.md-code')) p.scrollLeft = 99999; });
  await sleep(250);
  const after = await fences();
  console.log('scrolled:  ', JSON.stringify(after));
  await page.screenshot({ path: `${OUT}/code-badge-scrolled.png` });
  const ts = after.find((f) => f.lang === 'ts');
  const box = await page.evaluate(() => {
    const r = document.querySelector('.mdr-preview pre.md-code[data-lang="ts"]').getBoundingClientRect();
    return { x: Math.round(r.x) - 10, y: Math.round(r.y) - 12, width: Math.round(r.width) + 20, height: Math.round(r.height) + 24 };
  });
  await page.screenshot({ path: `${OUT}/code-badge-scrolled-zoom.png`, clip: box });

  check('the fences were actually scrolled right', ts.scrollLeft > 100, `scrollLeft ${ts.scrollLeft}`);
  check('the badge box does not move with the code', after.every((f, i) => f.wrapRight === before[i].wrapRight && f.reserved === before[i].reserved),
    JSON.stringify(after.map((f) => [f.wrapRight, f.reserved])));

  // The standalone HTML export reuses preview.css with the worker's RAW markup (no mount step, so no
  // wrapper): the fallback badge must still take a line of its own and stay put while the fence scrolls.
  const exp = await page.evaluate(() => {
    const host = document.createElement('div');
    host.className = 'mdr-preview';
    host.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:300px;overflow:auto';
    host.innerHTML = '<article class="mdr-preview__body markdown-body"><section class="md-block"><pre class="md-code" data-lang="ts"><code>' +
      'const aVeryLongLineOfCodeThatDefinitelyOverflowsTheContainerWidthAndThenSome = 1;\nconst b = 2;</code></pre></section></article>';
    document.body.appendChild(host);
    const pre = host.querySelector('pre'), code = pre.querySelector('code');
    const before = getComputedStyle(pre, '::before');
    const reserved = () => Math.round(code.getBoundingClientRect().top - pre.getBoundingClientRect().top);
    const a = reserved();
    pre.scrollLeft = 9999;
    const out = { content: before.content, display: before.display, position: before.position, reserved: a, reservedAfter: reserved(), scrollLeft: Math.round(pre.scrollLeft) };
    host.remove();
    return out;
  });
  console.log('export fallback:', JSON.stringify(exp));
  check('export fallback: the badge is a block of its own, sticky, and reserves space',
    exp.content === '"ts"' && exp.display === 'block' && exp.position === 'sticky' && exp.reserved >= 18 && exp.reserved === exp.reservedAfter,
    JSON.stringify(exp));

  check('no console / page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
} catch (e) {
  check('script completed', false, e instanceof Error ? e.stack : String(e));
} finally {
  await browser.close();
  finish('18 code badge', errors);
  process.exit(getFailures() ? 1 : 0);
}
