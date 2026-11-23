// bench/verify/v5-chb-j1.mjs — challenge-b (round 4): variations of J1 / P-A (a paste leaves no placeholder; pasting over
// a selection that is the whole text of a link, bold, italic, strikethrough, inline code, a heading, an item or a cell
// puts the text INSIDE it; no empty inline element and no [](url) is written). The selection is the element's whole
// text (programmatic, exactly its text node; or a double click for one word). Checks: right after the paste the session
// DOM holds no U+200B (KaTeX left out); the source equals the expected one; no `[](`, `****`, `~~~~`, empty code or
// zero-width character is written; Esc then ⌘Z gives the original back byte for byte.
// Run: MDR_PORT=5486 node bench/verify/v5-chb-j1.mjs [case-prefix ...]   Writes nothing into the tree.
process.env.MDR_SCRATCH = process.env.MDR_SCRATCH || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v5-chb/lib';
const { sleep, globalTimeout, J, check, summary, openAt, prepare, requireServer } = await import('./v4-sesb-lib.mjs');

const only = process.argv.slice(2);
const CP = Number(process.env.MDR_PORT || 5486);
await requireServer(CP);
const ZW = String.fromCharCode(0x200b), BOM = String.fromCharCode(0xfeff);
const show = (t) => J(t.split(ZW).join('<ZW>'));
const B = await openAt(CP);
const { page } = B;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), B.close);

/** Starts a session by a click on `needle`, then selects exactly the text of the first element matching `css` whose
 *  text is `text` (dbl: a double click on it instead). */
async function selectEl(css, text, dbl, clickNeedle) {
  const pt = await page.evaluate(({ css, text, clickNeedle }) => {
    const root = document.querySelector('.mdr-preview');
    const tw = document.createTreeWalker(root, 4);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const i = n.data.indexOf(clickNeedle);
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1);
      const b = r.getBoundingClientRect();
      return { x: b.left + 1, y: b.top + b.height / 2 };
    }
    return null;
  }, { css, text, clickNeedle });
  if (!pt) throw new Error('no ' + clickNeedle);
  await page.mouse.click(pt.x, pt.y);
  await sleep(300);
  if (!(await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing')))) throw new Error('no session');
  if (dbl) {
    const p = await page.evaluate(({ css, text }) => {
      const e = Array.from(document.querySelectorAll('.mdr-preview .is-editing ' + css)).find((x) => x.textContent === text);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, { css, text });
    if (!p) throw new Error('no element ' + css);
    await page.mouse.dblclick(p.x, p.y);
  } else {
    const ok = await page.evaluate(({ css, text }) => {
      const e = Array.from(document.querySelectorAll('.mdr-preview .is-editing ' + css)).find((x) => x.textContent === text);
      if (!e) return false;
      const r = document.createRange();
      const tw = document.createTreeWalker(e, 4);
      const first = tw.nextNode(); let last = first;
      for (let n = tw.nextNode(); n; n = tw.nextNode()) last = n;
      r.setStart(first, 0); r.setEnd(last, last.data.length);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return true;
    }, { css, text });
    if (!ok) throw new Error('no element ' + css);
  }
  await sleep(150);
  return page.evaluate(() => getSelection().toString());
}
const domZw = () => page.evaluate(() => {
  const e = document.querySelector('.mdr-preview .is-editing');
  if (!e) return -1;
  const tw = document.createTreeWalker(e, 4);
  let n = 0;
  for (let t = tw.nextNode(); t; t = tw.nextNode()) {
    if (t.parentElement.closest('.katex, [data-mdr-ui]')) continue;
    for (const c of t.data) if (c.charCodeAt(0) === 0x200b || c.charCodeAt(0) === 0xfeff) n++;
  }
  return n;
});
const emptyEls = () => page.evaluate(() => {
  const e = document.querySelector('.mdr-preview .is-editing');
  if (!e) return [];
  return Array.from(e.querySelectorAll('a, strong, em, b, i, s, del, code')).filter((x) => !x.closest('.katex') && x.textContent.split(String.fromCharCode(0x200b)).join('').split(String.fromCharCode(0xfeff)).join('') === '' && !x.querySelector('img, .md-math')).map((x) => x.tagName);
});
const bad = (src) => src.includes(ZW) || src.includes(BOM) || src.includes('[](') || src.includes('****') || src.includes('~~~~') || /(^|[^`])``([^`]|$)/.test(src) || /\*\*\s*\*\*/.test(src);

// [name, doc, css, element text, click needle, paste text, expected source | null (only the universal checks), dbl]
const C = [
  ['link-word', 'see [word](http://a.com/) end\n\nnext\n', 'a', 'word', 'see', 'NEW', 'see [NEW](http://a.com/) end\n\nnext\n'],
  ['link-word-dbl', 'see [word](http://a.com/) end\n\nnext\n', 'a', 'word', 'see', 'NEW', 'see [NEW](http://a.com/) end\n\nnext\n', true],
  ['link-two-words', 'see [two words](http://a.com/) end\n\nnext\n', 'a', 'two words', 'see', 'X Y', 'see [X Y](http://a.com/) end\n\nnext\n'],
  ['link-line-start', '[word](http://a.com/) end\n\nnext\n', 'a', 'word', 'end', 'NEW', '[NEW](http://a.com/) end\n\nnext\n'],
  ['link-line-end', 'see [word](http://a.com/)\n\nnext\n', 'a', 'word', 'see', 'NEW', 'see [NEW](http://a.com/)\n\nnext\n'],
  ['link-line-start-typed', '[word](http://a.com/) end\n\nnext\n', 'a', 'word', 'end', 'NEW', '[NEW](http://a.com/) end\n\nnext\n'],
  ['link-line-start-1', '[word](http://a.com/) end\n\nnext\n', 'a', 'word', 'end', 'N', '[N](http://a.com/) end\n\nnext\n'],
  ['link-line-start-1-typed', '[word](http://a.com/) end\n\nnext\n', 'a', 'word', 'end', 'N', '[N](http://a.com/) end\n\nnext\n'],
  ['link-item-start', '- [word](http://a.com/) end\n- two\n', 'a', 'word', 'end', 'NEW', '- [NEW](http://a.com/) end\n- two\n'],
  ['link-item-start-typed', '- [word](http://a.com/) end\n- two\n', 'a', 'word', 'end', 'NEW', '- [NEW](http://a.com/) end\n- two\n'],
  ['link-cell-start', '| a | b |\n|---|---|\n| [word](http://a.com/) x | d |\n', 'a', 'word', 'd', 'NEW', '| a | b |\n|---|---|\n| [NEW](http://a.com/) x | d |\n'],
  ['link-after-break', 'first  \n[word](http://a.com/) end\n\nnext\n', 'a', 'word', 'end', 'NEW', 'first  \n[NEW](http://a.com/) end\n\nnext\n'],
  ['bold-line-start-typed', '**bold** b\n\nnext\n', 'strong', 'bold', 'b', 'NEW', '**NEW** b\n\nnext\n'],
  ['code-line-start', '`code` b\n\nnext\n', 'code', 'code', 'b', 'NEW', '`NEW` b\n\nnext\n'],
  ['italic-line-start', '*ital* b\n\nnext\n', 'em', 'ital', 'b', 'NEW', '*NEW* b\n\nnext\n'],
  ['link-heading-start', '# [word](http://a.com/) end\n\nnext\n', 'a', 'word', 'end', 'NEW', '# [NEW](http://a.com/) end\n\nnext\n'],
  ['link-quote-start', '> [word](http://a.com/) end\n\nnext\n', 'a', 'word', 'end', 'NEW', '> [NEW](http://a.com/) end\n\nnext\n'],
  ['link-only', '[word](http://a.com/)\n\nnext\n', 'a', 'word', 'word', 'NEW', '[NEW](http://a.com/)\n\nnext\n'],
  ['link-in-item', '- see [word](http://a.com/) end\n- two\n', 'a', 'word', 'see', 'NEW', '- see [NEW](http://a.com/) end\n- two\n'],
  ['link-in-heading', '# see [word](http://a.com/) end\n\nnext\n', 'a', 'word', 'see', 'NEW', '# see [NEW](http://a.com/) end\n\nnext\n'],
  ['link-in-cell', '| a | b |\n|---|---|\n| see [word](http://a.com/) | d |\n', 'a', 'word', 'see', 'NEW', '| a | b |\n|---|---|\n| see [NEW](http://a.com/) | d |\n'],
  ['link-in-quote', '> see [word](http://a.com/) end\n\nnext\n', 'a', 'word', 'see', 'NEW', '> see [NEW](http://a.com/) end\n\nnext\n'],
  ['link-title', 'see [word](http://a.com/ "T") end\n\nnext\n', 'a', 'word', 'see', 'NEW', 'see [NEW](http://a.com/ "T") end\n\nnext\n'],
  ['bold-link', 'see [**bw**](http://a.com/) end\n\nnext\n', 'strong', 'bw', 'see', 'NEW', 'see [**NEW**](http://a.com/) end\n\nnext\n'],
  ['link-bold', 'see **[lw](http://a.com/)** end\n\nnext\n', 'a', 'lw', 'see', 'NEW', 'see **[NEW](http://a.com/)** end\n\nnext\n'],
  ['bold', 'a **bold** b\n\nnext\n', 'strong', 'bold', 'a', 'NEW', 'a **NEW** b\n\nnext\n'],
  ['bold-dbl', 'a **bold** b\n\nnext\n', 'strong', 'bold', 'a', 'NEW', 'a **NEW** b\n\nnext\n', true],
  ['italic', 'a *ital* b\n\nnext\n', 'em', 'ital', 'a', 'NEW', 'a *NEW* b\n\nnext\n'],
  ['strike', 'a ~~gone~~ b\n\nnext\n', 's, del', 'gone', 'a', 'NEW', 'a ~~NEW~~ b\n\nnext\n'],
  ['code', 'a `code` b\n\nnext\n', 'code', 'code', 'a', 'NEW', 'a `NEW` b\n\nnext\n'],
  ['code-backtick', 'a `code` b\n\nnext\n', 'code', 'code', 'a', 'x`y', null],
  ['bold-line-start', '**bold** b\n\nnext\n', 'strong', 'bold', 'b', 'NEW', '**NEW** b\n\nnext\n'],
  ['bold-in-cell', '| a | b |\n|---|---|\n| **bold** | d |\n', 'strong', 'bold', 'd', 'NEW', '| a | b |\n|---|---|\n| **NEW** | d |\n'],
  ['link-paras', 'see [word](http://a.com/) end\n\nnext\n', 'a', 'word', 'see', 'P1\n\nP2', null],
  ['bold-paras', 'a **bold** b\n\nnext\n', 'strong', 'bold', 'a', 'P1\n\nP2', null],
  ['link-blank', 'see [word](http://a.com/) end\n\nnext\n', 'a', 'word', 'see', '\n\n', null],
  ['bold-blank', 'a **bold** b\n\nnext\n', 'strong', 'bold', 'a', '\n\n', null],
  ['link-space', 'see [word](http://a.com/) end\n\nnext\n', 'a', 'word', 'see', ' ', null],
  ['link-math', 'see [word](http://a.com/) $x$ end\n\nnext\n', 'a', 'word', 'see', 'NEW', 'see [NEW](http://a.com/) $x$ end\n\nnext\n'],
  ['two-links', 'see [aa](http://a.com/)[bb](http://b.com/) end\n\nnext\n', 'a', 'bb', 'see', 'NEW', 'see [aa](http://a.com/)[NEW](http://b.com/) end\n\nnext\n'],
  ['autolink', 'see <http://a.com/> end\n\nnext\n', 'a', 'http://a.com/', 'see', 'NEW', null],
];
let nbad = 0;
try {
  for (const [name, doc, css, text, needle, paste, want, dbl] of C) {
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    try {
      await prepare(B, doc);
      const selText = await selectEl(css, text, !!dbl, needle);
      if (name.endsWith('-typed')) await page.keyboard.type(paste);
      else { await page.evaluate((t) => navigator.clipboard.writeText(t), paste); await page.keyboard.press('Meta+v'); }
      await sleep(250);
      const zw = await domZw();
      const empties = await emptyEls();
      await sleep(300);
      await page.keyboard.press('Escape');
      await B.settle(500);
      const src = await B.source();
      const ok = zw === 0 && empties.length === 0 && !bad(src) && (want === null || src === want);
      if (!check(name, ok, `sel=${J(selText)} domZwAfterPaste=${zw} emptyEls=${J(empties)} src=${show(src)}${want !== null && src !== want ? ' want=' + J(want) : ''}`)) nbad++;
      for (let k = 0; k < 10 && (await B.source()) !== doc; k++) {
        await page.evaluate(() => window.__mdr.app.editor.view.focus());
        await page.keyboard.press('Meta+z'); await sleep(150);
      }
      const back = await B.source();
      if (!check(name + ':undo', back === doc, `after undo=${show(back)}`)) nbad++;
    } catch (err) { check(name, false, 'error ' + (err && err.message)); nbad++; }
  }
} finally {
  summary();
  clearTimeout(stop);
  await B.close();
}
process.exit(nbad ? 1 : 0);
