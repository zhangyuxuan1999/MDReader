// bench/verify/r5-ca-escapes.mjs — challenge-atoms (stage 2f, fix round 5): N2 / rule "J19 extended" in Chromium, switch
// ON (the dev server's default with nothing stored), for the two spellings test/r5-ca-escapes.test.ts found unprotected:
// an invisible character written as an HTML entity inside a link destination or an image source, and the same href
// written once with the raw character and once percent-escaped in one block. A click at the end of "words" starts a
// session, X is typed, Esc ends it. Expected: the number of raw invisible characters in the source is unchanged (the
// entity or the escape stays). Observed on the tree: the raw character is written.
// Run: MDR_PORT=5465 node bench/verify/r5-ca-escapes.mjs [case-filter]   (runs: MDR_RUNS, default 1)
// Writes nothing into the tree. Global timeout 100 s. Derived from bench/verify/v5-rev-autolink.mjs (its click and caret
// placement unchanged).
import { chromium } from '@playwright/test';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = process.argv[2] || '';
const RUNS = Number(process.env.MDR_RUNS || 1);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Z = String.fromCharCode(0x200b);
const CASES = [
  ['ent-zwsp-dest', 'See [x](https://e.example/a&#x200B;b) here\nsecond line words\n'],
  ['ent-nbsp-dest', 'See [x](https://e.example/a&nbsp;b) here\nsecond line words\n'],
  ['ent-bom-dest', 'See [x](https://e.example/a&#xFEFF;b) here\nsecond line words\n'],
  ['ent-idsp-img', 'See ![i](https://e.example/a&#x3000;b.png) here\nsecond line words\n'],
  ['ent-rlo-item', '- See [x](https://e.example/a&#x202E;b) here\n- second line words\n'],
  ['dup-zwsp', 'See [a](https://e.example/a' + Z + 'b) and [b](https://e.example/a%E2%80%8Bb) here\nsecond line words\n'],
  ['dup-bare-auto', 'See https://e.example/a' + Z + 'b and <https://e.example/a%E2%80%8Bb> here\nsecond line words\n'],
];
const invisible = (s) => Array.from(s).filter((c) => !/^[\p{L}\p{N}\p{P}\p{S}]$/u.test(c) && c !== " " && c !== "\n").length;
let bad = 0;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await page.goto(`http://localhost:${port}/?mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  for (const [name, doc] of CASES) {
    if (filter && !name.includes(filter)) continue;
    for (let run = 0; run < RUNS; run++) {
      await page.evaluate(([t]) => window.__mdr.loadText(t, 'rev1.md'), [doc]);
      await page.evaluate(() => window.__mdr.waitIdle());
      await sleep(700);
      const p = await page.evaluate(() => {
        const root = window.__mdr.app.preview.el;
        const tw = document.createTreeWalker(root, 4);
        for (let n = tw.nextNode(); n; n = tw.nextNode()) {
          const i = n.data.indexOf('words');
          if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 4); r.setEnd(n, i + 5); const b = r.getBoundingClientRect(); return { x: b.right - 1, y: b.top + b.height / 2 }; }
        }
        return null;
      });
      if (!p) { console.log(name, 'no target'); bad++; continue; }
      await page.mouse.click(p.x, p.y);
      await sleep(300);
      const live = await page.evaluate(() => !!document.querySelector('.md-block.is-editing'));
      // fix-atoms (round 5), harness repair: the click point above assumes left-to-right text; an unterminated U+202E in
      // the rendered link text (bare-rlo) shows the rest of the paragraph right to left, so the click lands before the
      // last letter. The session started by the click; the caret goes after "words" by the selection API.
      await page.evaluate(() => {
        const el = document.querySelector('.md-block.is-editing');
        if (!el) return;
        const tw = document.createTreeWalker(el, 4);
        for (let n = tw.nextNode(); n; n = tw.nextNode()) {
          const i = n.data.indexOf('words');
          if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 5); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return; }
        }
      });
      await page.keyboard.type('X');
      await sleep(200);
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.__mdr.waitIdle());
      await sleep(400);
      const out = await page.evaluate(() => window.__mdr.app.getText());
      const kept = invisible(out) === invisible(doc);
      const typed = out.includes('wordsX');
      const codes = Array.from(out).filter((c) => c.charCodeAt(0) > 126).map((c) => c.charCodeAt(0).toString(16)); const show = (x) => JSON.stringify(x.replace(/[^\x20-\x7e\n]/g, (c) => '<' + c.codePointAt(0).toString(16) + '>'));
      const ok = kept && typed;
      if (!ok) bad++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} run${run} session=${live} typed=${typed} invisibleCount doc=${invisible(doc)} out=${invisible(out)} nonAscii=[${codes.join(',')}] source=${show(out)}`);
    }
  }
  console.log(`${bad} failing`);
} finally {
  clearTimeout(killer);
  await browser.close();
}
