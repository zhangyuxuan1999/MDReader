// bench/verify/v3-rev-links.mjs — verify-review (stage 2c, 0.2.0): G37 renderer side (S3) by variation.
// Every activation of a link a document carries must leave the page where it is: no navigation, no reload, no
// new page except the one allowed path (an HTML <a> the sanitizer marked target=_blank to http/https/mailto/tel).
// Run from the project root:
//   candidate:  MDR_PORT=5387 node bench/verify/v3-rev-links.mjs
//   baseline:   MDR_PORT=5397 MDR_DIST=release/baseline-0.1.1.noindex/dist MDR_BOOT='perf=1&mode=split' node bench/verify/v3-rev-links.mjs
// Each case loads one document, activates the link (left click, middle click, or focus + Enter), and records the
// page URL, popups and window.open calls. Starts its own server on MDR_PORT, kills only that port. Timeout 100 s.
import { startServer, stopServer, openBrowser, check, note, sleep, results } from './inline-verify-lib.mjs';

const BOOT = process.env.MDR_BOOT || 'mode=split';
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); stopServer(); process.exit(3); }, 100_000);
await startServer();
const B = await openBrowser();
const { page, context } = B;
const popups = [];   // Page objects (their URL is read at check time: a fresh popup reports '' at first)
context.on('page', (p) => popups.push(p));

async function boot() {
  await page.goto(`http://localhost:${process.env.MDR_PORT}/?${BOOT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  await sleep(400);
  await page.evaluate(() => {
    window.__opened = [];
    const real = window.open;
    window.open = function (u, t, f) { window.__opened.push(String(u)); return null; };
    window.__realOpen = real;
    window.__booted = performance.timeOrigin;
  });
}
async function load(text) {
  await page.evaluate(() => window.__mdr.app.preview.endEditSession?.());
  await page.evaluate((t) => window.__mdr.loadText(t, 'links.md'), text);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(500);
}

// [name, document, CSS selector of the element to activate, how, allowed window.open / popup URL prefix or null]
const CASES = [
  ['svg a href (relative .md)', '<svg width="200" height="40"><a href="other.md"><text x="5" y="20">svg link</text></a></svg>\n', 'svg text', 'click', null],
  ['svg a xlink:href (relative)', '<svg width="200" height="40" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="other.md"><text x="5" y="20">xlink</text></a></svg>\n', 'svg text', 'click', null],
  ['svg a href #anchor', '# Top\n\n<svg width="200" height="40"><a href="#top"><text x="5" y="20">to top</text></a></svg>\n', 'svg text', 'click', null],
  ['svg a app:// (middle button)', '<svg width="200" height="40"><a href="app://mdreader/index.html"><text x="5" y="20">app</text></a></svg>\n', 'svg text', 'middle', null],
  ['svg a https (Enter on focus)', '<svg width="200" height="40"><a href="https://example.com/svg" tabindex="0"><text x="5" y="20">ext</text></a></svg>\n', 'svg a', 'enter', 'https://example.com/svg'],
  ['area in an image map', '<map name="m"><area shape="rect" coords="0,0,200,60" href="other.md"></map><img usemap="#m" width="200" height="60" alt="map" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">\n', 'img[usemap]', 'click', null],
  ['html a relative, target _self', '<a href="other.md" target="_self">rel self</a>\n', 'a', 'click', null],
  ['html a #fragment with target _blank', '# Top\n\n<a href="#top" target="_blank">frag blank</a>\n', 'a', 'click', null],
  ['html a protocol-relative', '[proto](//example.com/x)\n', 'a', 'click', null],
  ['markdown link https (allowed path)', '[ext](https://example.com/md)\n', 'a', 'click', 'https://example.com/md'],
  ['html a https, middle button', '[ext](https://example.com/mid)\n', 'a', 'middle', 'https://example.com/mid'],
  ['html a with nested svg a', '<a href="https://example.com/outer" target="_blank"><svg width="200" height="40"><a href="other.md"><text x="5" y="20">nested</text></a></svg></a>\n', 'svg text', 'click', null],
];

try {
  await boot();
  note('renderer', BOOT);
  for (const [name, doc, sel, how, allowed] of CASES) {
    await load(doc);
    const before = page.url();
    const origin = await page.evaluate(() => window.__booted);
    popups.length = 0;
    await page.evaluate(() => { window.__opened = []; });
    const pt = await page.evaluate((sel) => {
      const el = document.querySelector(`.mdr-preview ${sel}`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + Math.min(8, r.width / 2), y: r.top + Math.min(8, r.height / 2) };
    }, sel);
    if (!pt) { check(`${name}: element present`, false, sel); continue; }
    if (how === 'click') await page.mouse.click(pt.x, pt.y);
    else if (how === 'middle') await page.mouse.click(pt.x, pt.y, { button: 'middle' });
    else {
      await page.evaluate((sel) => document.querySelector(`.mdr-preview ${sel}`).focus(), sel);
      await page.keyboard.press('Enter');
    }
    await sleep(700);
    let after = '', sameDoc = false, opened = [];
    try {
      after = page.url();
      sameDoc = (await page.evaluate(() => window.__booted)) === origin;
      opened = await page.evaluate(() => window.__opened);
    } catch (e) { after = `(page gone: ${e.message})`; }
    if (!Array.isArray(opened)) { opened = []; sameDoc = false; }   // the page was replaced (the stub is gone)
    const popupUrls = [];
    for (const p of popups) { try { await p.waitForURL(/./, { timeout: 3000 }); } catch { /* */ } popupUrls.push(p.url()); await p.close().catch(() => {}); }
    // A middle-click popup of the allowed link reports '' in headless Chromium (a background tab): counted as allowed.
    const unexpected = [...opened, ...popupUrls].filter((u) => !(allowed && (u.startsWith(allowed) || u === '')) && u !== 'about:blank');
    const urlSame = after.replace(/#.*$/, '') === before.replace(/#.*$/, '') && !/#/.test(after.slice(before.length));
    check(`${name} [${how}]: page stays, nothing unexpected opens`, urlSame && sameDoc && unexpected.length === 0,
      `url ${JSON.stringify(before)} → ${JSON.stringify(after)} sameDoc=${sameDoc} window.open=${JSON.stringify(opened)} popups=${JSON.stringify(popupUrls)}`);
    if (!sameDoc || !urlSame) { await boot(); }
  }
} catch (err) {
  console.log('ERROR', err && err.stack ? err.stack : err);
  results.fail++;
} finally {
  clearTimeout(killer);
  await B.browser.close().catch(() => {});
  stopServer();
  console.log(`RESULT ${results.pass} passed, ${results.fail} failed`);
  process.exit(results.fail ? 1 : 0);
}
