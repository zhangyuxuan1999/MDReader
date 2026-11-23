// bench/verify/r6-cr-swap.mjs — challenge-refs (0.2.0 stage 2g, fix round 6): the hole of rule S and of THE GUARD found
// at unit level (test/r6-cr-holes.test.ts, verdict REVEAL-SWAP): a block whose source holds a character that is not
// plainly visible both RAW in a place the rendering does not show and the session drops (the leading or trailing
// whitespace markdown-it trims off a table cell; an attribute or an element the sanitizer removes) and as a REFERENCE
// elsewhere. S1 counts it as not hidden (shown 1, raw 1), the guard sees as many raw ones before and after, and the
// session writes the reference as the raw character. In the app: click the block, type X after the last "words", Esc,
// read the source. Prints, per case, whether the reference is still in the source (KEPT) or the raw character took its
// place (REVEALED), and the guard's console lines.
// Run: MDR_PORT=<dev server> node bench/verify/r6-cr-swap.mjs [filter]   (T_MS: global timeout, default 110000)
// Writes nothing into the tree. Characters are built from code points.
import { chromium } from '@playwright/test';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = process.argv[2] ?? '';
const T_MS = Number(process.env.T_MS ?? 110000);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, T_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = (...cps) => String.fromCodePoint(...cps);
const show = (s) => (s == null ? 'null' : JSON.stringify(s.replace(/[^\x20-\x7e\n]/gu, (c) => '<' + c.codePointAt(0).toString(16) + '>')));
const IDSP = C(0x3000), SHY = C(0xad), ZWJ = C(0x200d), RLO = C(0x202e), EMSP = C(0x2003), LRM = C(0x200e);
// [name, block source, the reference that must stay]
const CASES = [
  ['cell-start-u3000', `| h | k |\n| --- | --- |\n| ${IDSP}a y&#x3000;z words | end text |`, 'y&#x3000;z'],
  ['cell-end-u3000', `| h | k |\n| --- | --- |\n| a y&#12288;z words${IDSP} | end text |`, 'y&#12288;z'],
  ['cell-start-emsp', `| h | k |\n| --- | --- |\n| ${EMSP}a y&emsp;z words | end text |`, 'y&emsp;z'],
  ['cell-other-cell', `| h | k |\n| --- | --- |\n| ${IDSP}a | y&#x3000;z words end text |`, 'y&#x3000;z'],
  ['onclick-shy', `Para <span onclick="c${SHY}d">s</span> y&shy;z words end text`, 'y&shy;z'],
  ['script-zwj', `Para <script>c${ZWJ}d</script> y&zwj;z words end text`, 'y&zwj;z'],
  ['js-href-rlo', `Para <a href="javascript:c${RLO}d">s</a> y&#x202E;z words end text`, 'y&#x202E;z'],
  ['iframe-lrm', `Para <iframe src="x${LRM}y"></iframe> y&lrm;z words end text`, 'y&lrm;z'],
].filter((c) => c[0].includes(filter));

let revealed = 0;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  const guard = [];
  page.on('console', (m) => { if (m.text().includes('the write guard refused')) guard.push(m.text()); });
  await page.goto(`http://localhost:${port}/?perf=1&mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  await page.addStyleTag({ content: '[class*="mdr-perf"] { visibility: hidden !important; pointer-events: none !important; }' });
  for (const [name, para, ref] of CASES) {
    guard.length = 0;
    await page.keyboard.press('Escape');
    const doc = `# Swap\n\nfiller\n\n${para}\n\nlast paragraph\n`;
    await page.evaluate(([t]) => window.__mdr.loadText(t, 'swap.md'), [doc]);
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(900);
    const at = await page.evaluate(() => {
      const root = window.__mdr.app.preview.el;
      const tw = document.createTreeWalker(root, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf('end text'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 2); const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; } }
      return null;
    });
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
    const toast = await page.evaluate(() => document.body.innerText.includes('此块请在源码中编辑'));
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(500);
    const out = (await page.evaluate(() => window.__mdr.app.getText())).replace(/^# Swap\n\nfiller\n\n/, '').replace(/\n\nlast paragraph\n$/, '');
    const verdict = !started ? 'no-session' : out === para ? 'unchanged' : out.includes(ref) ? 'KEPT' : 'REVEALED';
    if (verdict === 'REVEALED') revealed++;
    console.log(`${verdict.padEnd(10)} ${name}: guard=${guard.length} toast=${toast} source=${show(out)}`);
  }
} finally { await browser.close(); clearTimeout(killer); }
console.log(`RESULT revealed=${revealed} of ${CASES.length}`);
process.exit(revealed === 0 ? 0 : 1);
