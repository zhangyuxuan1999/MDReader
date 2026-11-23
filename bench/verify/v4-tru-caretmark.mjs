// bench/verify/v4-tru-caretmark.mjs — verify-trust (stage 2d re-verification, round 3): the serializer's caret marker
// collides with a code point that reaches the Markdown only through a decoded link destination / image source.
// pickMarkers() (src/preview/serialize.ts) picks NL / CARET / CELL / MARKUP among the private-use code points that
// do not occur in the block's innerHTML. An href / src is percent-encoded in the DOM (markdown-it normalizeLink), so
// a U+E001 in a link destination is NOT in innerHTML — but linkDest() decodes the percent-escapes again and writes
// the raw U+E001 into the Markdown. serializeBlockWithCaret() then finds that character first when it looks for
// CARET_MARK (U+E001), so after Enter the resume puts the caret on the link's line: the next typed character lands
// in the wrong place.
//   MDR_URL=http://localhost:5433/?mode=split node bench/verify/v4-tru-caretmark.mjs [runs=3]
// Each case: click right before "words", Enter, type "N", Escape. Expected: the source holds "\n\nNwords". Exit 1 when
// a case fails in any run. Writes nothing. Global timeout 110 s.
import { chromium } from '@playwright/test';

const URL0 = process.env.MDR_URL || 'http://localhost:5433/?mode=split';
const RUNS = Number(process.argv[2] ?? 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 110_000);
const C = (n) => String.fromCharCode(n);
const CASES = [
  ['raw-E001-in-link', 'See [x](https://e.com/?q=' + C(0xe001) + ') first line\nsecond line words\n'],
  ['pct-E001-in-link', 'See [x](https://e.com/?q=%EE%80%81) first line\nsecond line words\n'],
  ['pct-E001-in-image', 'See ![i](https://e.com/a%EE%80%81.png) first line\nsecond line words\n'],
  ['pct-E001-list-item', '- See [x](https://e.com/?q=%EE%80%81) first\n- second line words\n'],
  ['control-no-pua', 'See [x](https://e.com/?q=abc) first line\nsecond line words\n'],
];

async function one(page, doc) {
  await page.evaluate(() => window.__mdr.app.preview.endEditSession?.());
  await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable?.(true));
  await page.evaluate(({ t }) => window.__mdr.loadText(t, 'caret.md'), { t: doc });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(600);
  const pt = await page.evaluate(() => {
    const root = document.querySelector('.mdr-preview');
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf('words');
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1);
      const b = r.getBoundingClientRect();
      return { x: b.left + 0.5, y: b.top + b.height / 2 };
    }
    return null;
  });
  if (!pt) return 'words not shown';
  await page.mouse.click(pt.x, pt.y);
  await sleep(250);
  if (!(await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing')))) return 'no session';
  await page.keyboard.press('Enter');
  await sleep(400);
  await page.keyboard.type('N');
  await sleep(300);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(250);
  return page.evaluate(() => window.__mdr.app.getText());
}

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(URL0, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  let failing = 0;
  for (const [name, doc] of CASES) {
    const res = [];
    for (let k = 0; k < RUNS; k++) {
      const now = await one(page, doc);
      res.push(typeof now === 'string' && now.includes('Nwords') ? 'ok' : JSON.stringify(now).replace(new RegExp("[" + C(0xe000) + "-" + C(0xf8ff) + "]", "g"), (c) => `<U+${c.charCodeAt(0).toString(16).toUpperCase()}>`));
    }
    const bad = res.filter((r) => r !== 'ok').length;
    if (bad) failing++;
    console.log(`${bad ? 'FAIL' : 'PASS'}  ${name}  — ${RUNS - bad}/${RUNS} ok; ${res.filter((r) => r !== 'ok').slice(0, 1).join(' ')}`);
  }
  console.log(`${failing} failing`);
  process.exitCode = failing ? 1 : 0;
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  process.exitCode = 2;
} finally {
  clearTimeout(killer);
  try { await browser?.close(); } catch { /* */ }
}
