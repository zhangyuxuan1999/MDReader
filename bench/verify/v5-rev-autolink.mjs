// bench/verify/v5-rev-autolink.mjs — verify-review (0.2.0 round 4): REV-1 in Chromium, switch ON (the dev server's
// default with nothing stored). A paragraph holding a bare URL or an autolink with a percent-escaped invisible
// character; a click at the end of "words" on its second line starts a session, "X" is typed, Esc ends it. Expected:
// the URL's bytes unchanged ("%E2%80%8B" stays an escape); observed: the escape is replaced by the raw character.
// Run: MDR_PORT=5487 node bench/verify/v5-rev-autolink.mjs [case-filter]   (runs: MDR_RUNS, default 1)
// Writes nothing into the tree. Global timeout 100 s.
import { chromium } from '@playwright/test';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = process.argv[2] || '';
const RUNS = Number(process.env.MDR_RUNS || 1);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CASES = [
  ['bare-zwsp', 'See https://e.example/?q=a%E2%80%8Bb here\nsecond line words\n', '%E2%80%8B'],
  ['auto-zwsp', 'See <https://e.example/?q=a%E2%80%8Bb> here\nsecond line words\n', '%E2%80%8B'],
  ['bare-rlo', 'See https://e.example/?q=a%E2%80%AEb here\nsecond line words\n', '%E2%80%AE'],
  ['bare-idsp', 'See https://www.example.com/search?q=%E4%B8%AD%E6%96%87%E3%80%80%E8%AF%8D here\nsecond line words\n', '%E3%80%80'],
  ['auto-nbsp', 'See <https://e.example/?q=a%C2%A0b> here\nsecond line words\n', '%C2%A0'],
  ['control-ascii', 'See https://e.example/?q=a%20b here\nsecond line words\n', '%20'],
];
let bad = 0;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await page.goto(`http://localhost:${port}/?mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  for (const [name, doc, esc] of CASES) {
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
      const kept = out.includes(esc);
      const typed = out.includes('wordsX');
      const codes = Array.from(out).filter((c) => c.charCodeAt(0) > 126).map((c) => c.charCodeAt(0).toString(16));
      const ok = kept && typed;
      if (!ok && !name.startsWith('control')) bad++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} run${run} session=${live} typed=${typed} escapeKept=${kept} nonAscii=[${codes.join(',')}] source=${JSON.stringify(out)}`);
    }
  }
  console.log(`${bad} failing`);
} finally {
  clearTimeout(killer);
  await browser.close();
}
