// bench/verify/v6-von-urlb.mjs — verify-on (0.2.0 stage 2f, fix round 5 verification): rule "J19 extended" in the
// browser with URLs as real documents hold them (the unit form is test/v6-von-urls.test.ts). Each block holds several
// links (percent-encoded CJK paths, queries with %20 and &, %2F, a CJK fragment, %28%29, an escaped ZWSP / NBSP /
// U+3000, a data: image, mailto: with an encoded subject, a long URL), in a paragraph, a list, a quote, a table and a
// heading; the session types X before the first link, right after a link and on another line, then Esc. Checks: the
// source equals the document with only the X's added (byte for byte), the href / src list after the re-render equals
// the one before, no invisible character the document did not hold.
// Run: MDR_PORT=5482 MDR_BASE_PORT=5483 node bench/verify/v6-von-urlb.mjs        (MDR_PERFQ=1 for a production build)
// Global timeout T_MS (default 110 s). Writes nothing into the tree.
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, clickText, sessionOn, invisibleExtra, none } from './v5-ptr-lib.mjs';

const CJK = 'https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87';
const Q = 'https://example.com/search?q=hello%20world&lang=zh-CN&x=1%262';
const SL = 'https://example.com/a%2Fb/c';
const FR = 'https://example.com/page#%E7%AC%AC2%E8%8A%82';
const PA = 'https://example.com/file%281%29.pdf';
const ZWE = 'https://example.com/a%E2%80%8Bb%C2%A0c%E3%80%80d';
const DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MAIL = 'mailto:a@example.com?subject=Hi%20there%E4%BD%A0';
const LONG = 'https://example.com/' + Array.from({ length: 40 }, (_, k) => `s${k}%E4%B8%AD%20`).join('/');
const DOCS = {
  para: `See [tx](${CJK}) here and <${Q}> and ${SL} and ![im](${DATA})\nsecond [f](${FR} "t") line ${PA} and <${ZWE}> words\n\nnext\n`,
  list: `- See [tx](${ZWE}) here\n- [m](${MAIL}) and ${CJK} and ![i](${PA})\n- third <${LONG}> words\n\nnext\n`,
  quote: `> See ![tx](${SL}) here [l](${Q})\n>\n> [z](${ZWE}) second words\n\nnext\n`,
  table: `| See [tx](${CJK}) here | <${ZWE}> |\n|---|---|\n| ${Q} | [d](${FR}) words |\n\nnext\n`,
  heading: `## See [tx](${ZWE}) here <${CJK}> words\n\nnext\n`,
};
const urls = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-preview a[href], .mdr-preview img[src]')].map((e) => e.getAttribute(e.tagName === 'A' ? 'href' : 'src')));
const caret = (page, needle, k, after) => page.evaluate(({ needle, k, after }) => {
  const el = document.querySelector('.mdr-preview .is-editing');
  if (after) {
    const a = [...el.querySelectorAll('a')].find((x) => x.textContent === needle);
    const t = a?.nextSibling;
    if (!t || t.nodeType !== 3) throw new Error('after: ' + needle);
    getSelection().setBaseAndExtent(t, 1, t, 1);    // after the space that follows the link
    return;
  }
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('.md-math, [data-mdr-ui], a') ? 2 : 1) });
  for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(needle); if (i >= 0) { getSelection().setBaseAndExtent(n, i + k, n, i + k); return; } }
  throw new Error('caret ' + needle);
}, { needle, k, after });

let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 110_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, !!process.env.MDR_PERFQ);
  const { page } = A;
  for (const [n, doc] of Object.entries(DOCS)) {
    for (const place of ['before', 'after', 'other']) {
      const name = `${n}/${place}`;
      try {
        await prepare(A, doc);
        const u0 = await urls(page);
        await clickText(page, 'words', 2); await sleep(400);
        const live = await sessionOn(page);
        let exp;
        if (place === 'before') { await caret(page, 'See ', 0, false); exp = doc.replace('See ', 'XSee '); }
        else if (place === 'after') { await caret(page, 'tx', 0, true); exp = doc.replace(' here', ' Xhere'); }
        else { await caret(page, 'words', 5, false); exp = doc.replace('words', 'wordsX'); }
        await page.keyboard.type('X'); await A.settle(300);
        await page.keyboard.press('Escape'); await A.settle(350);
        const src = await A.source();
        const u1 = await urls(page);
        const inv = invisibleExtra(src, doc);
        check(name, live && src === exp && J(u0) === J(u1) && none(inv), `live=${live} exact=${src === exp} hrefSame=${J(u0) === J(u1)} inv=${J(inv)}${src === exp ? '' : ' src=' + show(src) + ' exp=' + show(exp)}`);
      } catch (e) { check(name, false, 'threw ' + String(e?.message ?? e).split('\n')[0]); }
    }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
