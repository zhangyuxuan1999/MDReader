// bench/verify/v6-vr-entity.mjs — verify-review (stage 2f, after fix round 5): an invisible character the source writes
// as a character reference (&#x2060; &#x202e; &#xad; &#x200b; …) in text, an image's alt, a link's title or a raw HTML
// attribute; with 预览可编辑 on, a click at the end of "words" starts a session, "X" is typed, Esc ends it. Expected:
// the reference stays (or the character is written escaped); observed (FAIL): the raw invisible character replaces it.
// Run: MDR_PORT=<candidate build with ?perf=1 hooks, or a dev server> node bench/verify/v6-vr-entity.mjs [filter]
// (MDR_RUNS, default 1). Writes nothing into the tree. Global timeout 100 s. Characters are built from code points.
import { chromium } from '@playwright/test';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = process.argv[2] || '';
const RUNS = Number(process.env.MDR_RUNS || 1);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CASES = [
  ['text-wj', 'Lead a&#x2060;b here\nsecond line words\n'],
  ['text-rlo', 'Lead a&#x202e;b here\nsecond line words\n'],
  ['text-shy', 'Lead a&shy;b here\nsecond line words\n'],
  ['alt-shy', 'Lead ![a&#xad;b](e.png) here\nsecond line words\n'],
  ['title-zwsp', 'Lead [t](https://e.example/p "a&#x200b;b") here\nsecond line words\n'],
  ['rawimg-zwsp', 'Lead <img src="x&#x200b;y.png" width="20"> here\nsecond line words\n'],
  ['item-filler', '- Lead a&#x3164;b here\n  second line words\n- two\n'],
];
// invisible code points (built from numbers): C0/C1 controls, SHY, CGJ, ALM, Hangul fillers, Khmer inherent vowels, Mongolian FVS,
// ZW* and bidi marks, word joiner .. invisible operators, U+3164, variation selectors, BOM, U+FFA0, tag characters
const INVIS_RANGES = [[0x0, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xe0000, 0xe0fff]];
const INVIS = { test: (c) => { const n = c.codePointAt(0); return n !== 0x0a && INVIS_RANGES.some(([a, b]) => n >= a && n <= b); } };
let bad = 0;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await page.goto(`http://localhost:${port}/?perf=1&mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  // the ?perf=1 overlay sits over the preview's right side and takes clicks: out of the way
  await page.addStyleTag({ content: '[class*="mdr-perf"] { visibility: hidden !important; pointer-events: none !important; }' });
  for (const [name, doc] of CASES) {
    if (filter && !name.includes(filter)) continue;
    for (let run = 0; run < RUNS; run++) {
      // (filler first: with ?perf=1 the overlay covers the top right of the preview)
      await page.evaluate(([t]) => window.__mdr.loadText('# Entity\n\nfiller one\n\nfiller two\n\nfiller three\n\nfiller four\n\n' + t, 'entity.md'), [doc]);
      await page.evaluate(() => window.__mdr.waitIdle());
      await sleep(1500);
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
      await sleep(450);
      let live = await page.evaluate(() => !!document.querySelector('.md-block.is-editing'));
      if (!live) { await sleep(700); await page.mouse.click(p.x, p.y); await sleep(450); live = await page.evaluate(() => !!document.querySelector('.md-block.is-editing')); }
      const toast = await page.evaluate(() => Array.from(document.querySelectorAll('[class*=toast]')).map((t) => t.textContent).filter(Boolean).join('|'));
      // the caret after "words" by the selection API (an unterminated RLO shows the rest of the line right to left)
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
      await sleep(250);
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.__mdr.waitIdle());
      await sleep(400);
      const out = (await page.evaluate(() => window.__mdr.app.getText())).replace(/^[\s\S]*filler four\n\n/, '');
      const typed = out.includes('wordsX');
      const raw = Array.from(out).filter((c) => INVIS.test(c)).map((c) => c.codePointAt(0).toString(16));
      const fail = typed && raw.length > 0;
      if (fail) bad++;
      const showS = (s) => JSON.stringify(s.replace(/[^\x20-\x7e\n]/gu, (c) => '<' + c.codePointAt(0).toString(16) + '>'));
      console.log(`${fail ? 'FAIL' : typed ? 'ok  ' : 'n/a '} ${name} run${run} session=${live}${live ? '' : ' toast=' + JSON.stringify(toast)} typed=${typed} rawInvisible=[${raw.join(',')}] doc=${showS(doc)} source=${showS(out)}`);
    }
  }
} finally { await browser.close(); clearTimeout(killer); }
console.log(`RESULT ${bad === 0 ? 'PASS' : 'FAIL'} bad=${bad}`);
process.exit(bad === 0 ? 0 : 1);
