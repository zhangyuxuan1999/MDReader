// bench/verify/r5-fa-recreate.mjs — fix-atoms (stage 2f, fix round 5): the ATOM AUDIT of P-G (CONTRACT §11, Round-4
// verification decisions). For every kind of element / attribute / live property serialize.ts reads to produce Markdown
// that is not the element's visible text, a block holding it in the SECOND of two line containers (list items, quote
// paragraphs, a list in a quote, a paragraph pair of one item) is opened in a session (switch on, the tree's dev server),
// the browser joins the two containers (Backspace at the start of the second one by default; Delete at the end of the
// first with `del`), and the session DOM is dumped before and after: every atom element with its attributes, whether
// KaTeX's annotation is there, a checkbox's checked property and attribute, and whether the node is still the one the
// session prepared (false: Chromium re-created it from markup). Then Esc, and the source must hold each atom's Markdown
// byte for byte, no style attribute, no raw HTML where Markdown stood, no U+200B. Prints one RESULT line per case.
// Run: MDR_PORT=5461 node bench/verify/r5-fa-recreate.mjs [name-regex] [--verbose]   (exit 1 on a failure)
// Global timeout 115 s (T_MS). Writes nothing into the tree. Invisible characters are built from code points.
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, clickText, sessionOn } from './v5-ptr-lib.mjs';

const filter = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '';
const VERBOSE = process.argv.includes('--verbose');
const ZW = String.fromCharCode(0x200b);
// [name, doc, needle in the 2nd container (or the 1st with del), keys, Markdown that must survive verbatim, expected source]
const CASES = [
  ['math-inline-item', '- one\n- Lead $x$ two\n\nnext\n', 'two', 'bs', ['$x$'], '- oneLead $x$ two\n\nnext\n'],
  ['math-frac-item', '- one\n- Lead $\\frac{a}{b}$ two\n\nnext\n', 'two', 'bs', ['$\\frac{a}{b}$'], '- oneLead $\\frac{a}{b}$ two\n\nnext\n'],
  // (a display formula is on a line of its own: the caret goes to the start of the line that holds "Lead")
  ['math-display-quote', '> one\n>\n> Lead $$x^2$$ two\n\nnext\n', 'Lead', 'bs', ['$$x^2$$'], '> oneLead $$x^2$$ two\n\nnext\n'],
  ['math-error-item', '- one\n- Lead $\\frac{$ two\n\nnext\n', 'two', 'bs', ['$\\frac{$'], null],
  ['math-del-item', '- one\n- Lead $x$ two\n\nnext\n', 'one', 'del', ['$x$'], '- oneLead $x$ two\n\nnext\n'],
  ['image-item', '- one\n- Lead ![i](x.png) two\n\nnext\n', 'two', 'bs', ['![i](x.png)'], '- oneLead ![i](x.png) two\n\nnext\n'],
  ['image-title-quote', '> one\n>\n> Lead ![i](x.png "t") two\n\nnext\n', 'two', 'bs', ['![i](x.png "t")'], null],
  ['image-in-link-item', '- one\n- Lead [![i](x.png)](http://e.x/) two\n\nnext\n', 'two', 'bs', ['[![i](x.png)](http://e.x/)'], null],
  ['task-own-and-moved', '- [x] one\n- [ ] two\n\nnext\n', 'two', 'bs', ['- [x] one'], '- [x] one two\n\nnext\n'],
  ['task-moved-ticked', '- [ ] one\n- [x] two\n\nnext\n', 'one', 'del', ['- [ ] one'], '- [ ] one two\n\nnext\n'],
  ['raw-kbd-item', '- one\n- Lead <kbd>K</kbd> two\n\nnext\n', 'two', 'bs', ['<kbd>K</kbd>'], '- oneLead <kbd>K</kbd> two\n\nnext\n'],
  ['raw-span-class-item', '- one\n- Lead <span class="c">s</span> two\n\nnext\n', 'two', 'bs', ['<span class="c">s</span>'], null],
  ['raw-span-style-item', '- one\n- Lead <span style="color:red">r</span> two\n\nnext\n', 'two', 'bs', ['<span style="color:red">r</span>'], null],
  ['raw-img-width-item', '- one\n- Lead <img src="x.png" width="10"> two\n\nnext\n', 'two', 'bs', ['<img src="x.png" width="10">'], null],
  ['raw-sup-quote', '> one\n>\n> Lead x<sup>2</sup> two\n\nnext\n', 'two', 'bs', ['<sup>2</sup>'], null],
  ['link-item', '- one\n- Lead [l](http://e.x/) two\n\nnext\n', 'two', 'bs', ['[l](http://e.x/)'], '- oneLead [l](http://e.x/) two\n\nnext\n'],
  ['autolink-item', '- one\n- Lead <http://e.x/a> two\n\nnext\n', 'two', 'bs', ['<http://e.x/a>'], null],
  ['bare-url-item', '- one\n- Lead http://e.x/a two\n\nnext\n', 'two', 'bs', ['http://e.x/a'], null],
  ['escaped-url-item', '- one\n- Lead http://e.x/a%E2%80%8Bb two\n\nnext\n', 'two', 'bs', ['http://e.x/a%E2%80%8Bb'], null],
  // (entities are text: the serializer writes the character where it reads back the same, K5; not an atom)
  ['entity-item', '- one\n- Lead &amp; &copy; &lt;b&gt; two\n\nnext\n', 'two', 'bs', [], null],
  ['code-item', '- one\n- Lead `c d` two\n\nnext\n', 'two', 'bs', ['`c d`'], '- oneLead `c d` two\n\nnext\n'],
  ['format-item', '- one\n- Lead **b** *e* ~~d~~ two\n\nnext\n', 'two', 'bs', ['**b**', '*e*', '~~d~~'], '- oneLead **b** *e* ~~d~~ two\n\nnext\n'],
  // (a hard break ends the paragraph Chromium moves: the break of the moved item stays where it was; one in the
  // receiving item survives)
  ['hardbreak-item', '- one  \n  more\n- Lead a\\\n  b two\n\nnext\n', 'Lead', 'bs', ['one  \n  more'], null],
  ['pre-in-item', '- one\n\n  ```js\n  x = 1\n  ```\n- Lead two\n\nnext\n', 'Lead', 'bs', ['```js'], null],
  ['heading-enter-bs', '## Lead $x$ head\n\nnext\n', 'Lead', 'enterbs', ['$x$'], '## Lead $x$ head\n\nnext\n'],
  ['para-enter-bs-image', 'Lead ![i](x.png) and $y$ words.\n\nnext\n', 'Lead', 'enterbs', ['![i](x.png)', '$y$'], 'Lead ![i](x.png) and $y$ words.\n\nnext\n'],
  ['quote-list-item', '> - one\n> - Lead $x$ two\n\nnext\n', 'two', 'bs', ['$x$'], '> - oneLead $x$ two\n\nnext\n'],
  ['loose-item-paras', '- one\n\n  Lead $x$ two\n\nnext\n', 'two', 'bs', ['$x$'], null],
];

const SEL = '.md-math, img, input, kbd, sup, a, code, br, pre, strong, em, del, span, font';
/** Every atom element of the session block (KaTeX's own markup left out), as data. `mark`: remember the nodes. */
const dump = (page, mark) => page.evaluate(({ SEL, mark }) => {
  const w = document.querySelector('.mdr-preview .is-editing');
  if (!w) return null;
  const els = Array.from(w.querySelectorAll(SEL)).filter((e) => !e.parentElement?.closest('.md-math') && !e.closest('[data-mdr-ui]'));
  if (mark) window.__r5fa = els;
  const before = window.__r5fa || [];
  return {
    html: w.innerHTML.length > 4000 ? w.innerHTML.length + ' chars' : w.innerHTML.replace(/<span class="katex">[\s\S]*?<\/span><\/span><\/span>/g, '<katex/>'),
    keptOfBefore: before.filter((e) => e.isConnected && w.contains(e)).length + '/' + before.length,
    atoms: els.map((e) => ({
      tag: e.tagName.toLowerCase() + (e.classList.contains('md-math') ? '.md-math' : ''),
      attrs: Array.from(e.attributes).filter((a) => a.name !== 'class' || !e.classList.contains('md-math')).map((a) => a.name + '=' + a.value.slice(0, 60)),
      annotation: e.classList.contains('md-math') ? !!e.querySelector('annotation') : undefined,
      mathml: e.classList.contains('md-math') ? !!e.querySelector('math') : undefined,
      checked: e.tagName === 'INPUT' ? [e.checked, e.hasAttribute('checked')] : undefined,
      same: before.includes(e),
    })),
  };
}, { SEL, mark });

let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  const { page } = A;
  for (const [name, doc, needle, how, atoms, want] of CASES) {
    if (filter && !new RegExp(filter).test(name)) continue;
    try {
      await prepare(A, doc);
      await clickText(page, needle, how === 'del' ? needle.length - 1 : 1); await sleep(350);
      await page.keyboard.press(how === 'del' ? 'End' : 'Home'); await sleep(120);
      const live = await sessionOn(page);
      const before = await dump(page, true);
      if (how === 'del') await page.keyboard.press('Delete');
      else if (how === 'enterbs') { await page.keyboard.press('Enter'); await sleep(250); await page.keyboard.press('Backspace'); }
      else await page.keyboard.press('Backspace');
      await sleep(400);
      const after = await dump(page, false);
      await A.settle(150);
      await page.keyboard.press('Escape'); await A.settle(250);
      const src = await A.source();
      const lost = atoms.filter((m) => !src.includes(m));
      const ok = live && lost.length === 0 && !/style=/.test(src.replace(/<span style="color:red">/g, '')) && !src.includes(ZW)
        && (want === null || src === want) && !/<img src="x\.png" alt/.test(src);
      const recreated = after ? after.atoms.filter((a) => !a.same).map((a) => a.tag) : null;
      check(name, ok, `live=${live} lost=${J(lost)} src=${show(src)} recreated=${J(recreated)} kept=${after?.keptOfBefore}`);
      console.log(`RESULT ${name} ${J({ before: before?.atoms, after: after?.atoms })}`);
      if (VERBOSE) console.log(`  DOM before ${J(before?.html)}\n  DOM after  ${J(after?.html)}`);
    } catch (e) { check(name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
