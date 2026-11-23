// bench/verify/fix2-t-flag.mjs — fix-trust (stage 2b), U10 (a)(b)(d) end to end in the browser: a block whose raw HTML
// carries a name the app reserves gets data-mdr-x on its wrapper (worker flag -> createPreview), an ordinary block does
// not, and no data-md / data-md-block / data-mdr-* attribute reaches the block DOM.
// Run from the project root with a dev server already up:  MDR_PORT=5303 node bench/verify/fix2-t-flag.mjs
// Global timeout 60 s.
import { openBrowser, check, finish } from './inline-verify-lib.mjs';

const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 60_000);
const blocks = [
  ['forged data-md', 'Fix <span data-md="[x](https://evil.example)" style="display:none">.</span> here', true],
  ['forged data-mdr-ui', 'Keep <span data-mdr-ui>THIS</span> text', true],
  ['forged data-l (html block)', '<div data-l="0">\n\nblock\n\n</div>', true],
  ['forged class via &#109;', 'Math <span class="&#109;d-math">x</span>', true],
  ['forged DATA-MD-BLOCK', 'Up <b DATA-MD-BLOCK>y</b>', true],
  ['code span (not markup)', 'Text `<span data-md="x">` code', false],
  ['ordinary html', 'Plain <span class="note" data-x="1">ok</span> html', false],
  ['ordinary paragraph', 'Just words.', false],
];
const doc = blocks.map((b) => b[1]).join('\n\n') + '\n';

const B = await openBrowser();
const { page } = B;
let code = 1;
try {
  await B.boot('mode=split');
  await B.loadDoc(doc, 'flag.md');
  const got = await page.evaluate((needles) => {
    const pv = window.__mdr.app.preview;
    const text = window.__mdr.app.getText().split('\n');
    return needles.map((n) => {
      const line = text.findIndex((l) => l.includes(n)) + 1;
      const el = pv.elementOfBlock(pv.blockAtLine(line).id);
      if (!el) return null;
      const wrap = el.closest('.md-block') ?? el;
      const bad = Array.from(wrap.querySelectorAll('*')).flatMap((e) => Array.from(e.attributes).map((a) => a.name)
        .filter((a) => /^data-(md|md-block|mdr-.*)$/i.test(a)));
      return { x: wrap.hasAttribute('data-mdr-x'), bad };
    });
  }, blocks.map((b) => b[1].split('\n')[0]));
  blocks.forEach(([name, , want], i) => {
    const g = got[i];
    check(`${name}: wrapper data-mdr-x ${want}`, !!g && g.x === want, JSON.stringify(g));
    check(`${name}: no reserved attribute inside the block`, !!g && g.bad.length === 0, JSON.stringify(g && g.bad));
  });
  check('no page errors', B.pageErrors.length === 0, B.pageErrors.slice(0, 3).join(' | '));
  code = 0;
} catch (err) {
  console.log('ERROR', err && err.stack ? err.stack : err);
} finally {
  finish();
  await B.browser.close().catch(() => {});
  clearTimeout(killer);
  process.exit(code);
}
