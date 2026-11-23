// bench/verify/r6-int-rulet.mjs — integrate (0.2.0 stage 2g, fix round 6): rule T (CONTRACT §11, Checkpoint H) for the
// blocks the integrator added to it, on the real path in Chromium (the procedure of bench/verify/r6-frb-rulet.mjs): a
// Markdown title or alt the sanitizer trims or removes, and raw HTML next to a reference link whose definition (in another
// block) has a scheme the sanitizer takes, must start no session, show the toast 此块请在源码中编辑 and keep the source;
// ordinary titled links, images and anchors stay editable. Prints one line per case and "RESULT bad=<n> of <cases>".
// Run: MDR_PORT=<dev server of the tree> node bench/verify/r6-int-rulet.mjs [filter]   (T_MS: global timeout, default 110000)
// Writes nothing into the tree.
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
  ['md-title-xml', 'Para [x](https://e.example/ "a-->b") words end text', 'refused'],
  ['md-title-trim', 'Para [x](https://e.example/ " a ") words end text', 'refused'],
  ['img-title-xml', 'Para ![i](i.png "a]>b") words end text', 'refused'],
  ['img-alt-xml', 'Para ![a-->b](i.png) words end text', 'refused'],
  ['ref-scheme-raw', 'Para <kbd>k</kbd> [x][r] words end text', 'refused', null, '[r]: obsidian://open'],
  ['ref-scheme-md', 'Para [x][r] words end text', 'refused', null, '[r]: obsidian://open'],
  ['md-title', 'Para [x](https://e.example/ "a title") words end text', 'edited'],
  ['img-alt-title', 'Para ![an alt](i.png "t") words end text', 'edited'],
  ['anchor', 'Para <a name="n">t</a> words end text', 'edited'],
  ['ref-https-raw', 'Para <kbd>k</kbd> [x][r] words end text', 'edited', 'Para <kbd>k</kbd> [x](https://e.example/) wordsX end text', '[r]: https://e.example/'],   // (a reference link written inline: accepted, Checkpoint H)
  ['formula', 'Para $x^2$ and *em* words end text', 'edited'],
].filter((c) => c[0].includes(filter));

let bad = 0;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await page.goto(`http://localhost:${port}/?perf=1&mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  await page.addStyleTag({ content: '[class*="mdr-perf"] { visibility: hidden !important; pointer-events: none !important; }' });
  for (const [name, para, want, norm, defs] of CASES) {
    await page.keyboard.press('Escape');
    const doc = `# Rule T\n\nfiller\n\n${para}\n\nlast paragraph\n` + (defs ? `\n${defs}\n` : '');
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
    const out = (await page.evaluate(() => window.__mdr.app.getText())).replace(defs ? `\n${defs}\n` : '\u0000', '').replace(/^# Rule T\n\nfiller\n\n/, '').replace(/\n\nlast paragraph\n$/, '');
    const wantOut = want === 'refused' ? para : norm ?? para.replace(/words end text$/, 'wordsX end text');
    const ok = want === 'refused' ? !started && toast && out === para : started && !toast && out === wantOut;
    if (!ok) bad++;
    console.log(`${ok ? 'ok ' : 'BAD'}        ${name} (${want}): started=${started} toast=${toast} source=${show(out)}${ok ? '' : ' want=' + show(wantOut)}`);
  }
} finally { await browser.close(); clearTimeout(killer); }
console.log(`RESULT bad=${bad} of ${CASES.length}`);
process.exit(bad === 0 ? 0 : 1);
