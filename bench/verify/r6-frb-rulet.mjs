// bench/verify/r6-frb-rulet.mjs — fix-refs-b (0.2.0 stage 2g, fix round 6): rule T (CONTRACT §11, Checkpoint H) and B3 on
// the real path in Chromium. For each block: load a document, click the block's text, type X after its last "words",
// Esc, read the source. A block whose raw HTML the sanitizer changes (or whose Markdown link lost its URL to it) must start
// no session, show the toast 此块请在源码中编辑 and keep its source byte for byte; a block with raw HTML the sanitizer
// leaves alone, and the B3 blocks (the no-break-space reference in an alt, a title, a raw attribute), must be edited with
// only the typed X added. Prints one line per case and "RESULT bad=<n> of <cases>".
// Run: MDR_PORT=<dev server of the tree> node bench/verify/r6-frb-rulet.mjs [filter]   (T_MS: global timeout, default 110000)
// Writes nothing into the tree. Characters are built from code points.
import { chromium } from '@playwright/test';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = process.argv[2] ?? '';
const T_MS = Number(process.env.T_MS ?? 110000);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, T_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (s) => (s == null ? 'null' : JSON.stringify(s.replace(/[^\x20-\x7e\n]/gu, (c) => '<' + c.codePointAt(0).toString(16) + '>')));
// [name, block source, 'refused' | 'edited', the written source when an existing normalisation applies]
const CASES = [
  ['onclick', 'Para <span onclick="f()">s</span> words end text', 'refused'],
  ['script', 'Para <script>f()</script> words end text', 'refused'],
  ['iframe', 'Para <iframe src="https://player.example/v"></iframe> words end text', 'refused'],
  ['js-href', 'Para <a href="javascript:f()">s</a> words end text', 'refused'],
  ['rel', 'Para <a href="https://e.example/" rel="nofollow">l</a> words end text', 'refused'],
  ['trimmed-title', 'Para <span title=" a ">s</span> words end text', 'refused'],
  ['form', 'Para <form>a</form> words end text', 'refused'],
  ['pi', 'Para <?x y?> words end text', 'refused'],
  ['pseudo-tag', 'Para the <url> decision words end text', 'refused'],
  ['obsidian-link', 'Para [x](obsidian://open) words end text', 'refused'],
  ['kbd', 'Para <kbd>k</kbd> words end text', 'edited'],
  ['sub-sup', 'Para H<sub>2</sub>O x<sup>2</sup> words end text', 'edited'],
  ['br', 'Para a<br>b words end text', 'edited', 'Para a  \nb wordsX end text'],   // (<br> as two spaces: an existing normalisation)
  ['mark', 'Para <mark>m</mark> words end text', 'edited'],
  ['abbr', 'Para <abbr title="t">a</abbr> words end text', 'edited'],
  ['span-class', 'Para <span class="note">x</span> words end text', 'edited'],
  ['span-style', 'Para <span style="color:red">x</span> words end text', 'edited'],
  ['img-width', 'Para <img src="i.png" width="30"> words end text', 'edited'],
  ['a-title', 'Para <a href="https://e.example/" title="t">l</a> words end text', 'edited', 'Para [l](https://e.example/ "t") wordsX end text'],   // (an existing normalisation)
  ['autolink', 'Para <https://e.example/x> words end text', 'edited'],
  ['https-link', 'Para [x](https://e.example/) words end text', 'edited'],
  ['b3-alt', 'Para ![a&nbsp;b](i.png) words end text', 'edited'],
  ['b3-link-title', 'Para [t](https://e.example/p "a&nbsp;b") words end text', 'edited'],
  ['b3-image-title', 'Para ![i](i.png "a&nbsp;b") words end text', 'edited'],
  ['b3-raw-attr', 'Para <span title="a&nbsp;b">t</span> words end text', 'edited'],
].filter((c) => c[0].includes(filter));

let bad = 0;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await page.goto(`http://localhost:${port}/?perf=1&mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  await page.addStyleTag({ content: '[class*="mdr-perf"] { visibility: hidden !important; pointer-events: none !important; }' });
  for (const [name, para, want, norm] of CASES) {
    await page.keyboard.press('Escape');
    const doc = `# Rule T\n\nfiller\n\n${para}\n\nlast paragraph\n`;
    await page.evaluate(([t]) => window.__mdr.loadText(t, 'rulet.md'), [doc]);
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(900);
    // the toasts of the case before go first (each one lives 2 s): only this case's toast counts
    await page.evaluate(() => { for (const t of document.querySelectorAll('.mdr-toast')) t.remove(); });
    const at = await page.evaluate(() => {
      const root = window.__mdr.app.preview.el;
      const tw = document.createTreeWalker(root, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf('end text'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 2); const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; } }
      return null;
    });
    if (!at) { bad++; console.log(`BAD        ${name}: no text to click`); continue; }
    await page.mouse.click(at.x, at.y);
    await sleep(450);
    const started = await page.evaluate(() => {
      const el = document.querySelector('.md-block.is-editing');
      if (!el) return false;
      const tw = document.createTreeWalker(el, 4);
      let last = null;
      for (let n = tw.nextNode(); n; n = tw.nextNode()) if (n.data.includes('words')) last = n;
      if (!last) return false;
      const r = document.createRange(); r.setStart(last, last.data.lastIndexOf('words') + 5); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return true;
    });
    if (started) await page.keyboard.type('X');
    await sleep(500);
    const toast = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-toast')).some((t) => (t.textContent ?? '').includes('此块请在源码中编辑')));
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(400);
    const out = (await page.evaluate(() => window.__mdr.app.getText())).replace(/^# Rule T\n\nfiller\n\n/, '').replace(/\n\nlast paragraph\n$/, '');
    const wantOut = want === 'refused' ? para : norm ?? para.replace(/words end text$/, 'wordsX end text');
    const ok = want === 'refused' ? !started && toast && out === para : started && !toast && out === wantOut;
    if (!ok) bad++;
    console.log(`${ok ? 'ok ' : 'BAD'}        ${name} (${want}): started=${started} toast=${toast} source=${show(out)}${ok ? '' : ' want=' + show(wantOut)}`);
  }
} finally { await browser.close(); clearTimeout(killer); }
console.log(`RESULT bad=${bad} of ${CASES.length}`);
process.exit(bad === 0 ? 0 : 1);
