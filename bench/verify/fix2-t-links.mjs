// bench/verify/fix2-t-links.mjs — fix-trust (stage 2b), S3 renderer side (G37): no link in a document changes the
// app page. Run from the project root with a dev server already up:  MDR_PORT=5303 node bench/verify/fix2-t-links.mjs
// Clicks (mouse, middle button, Enter on a focused link) SVG links to a relative path, to index.html, protocol-
// relative, xlink:href, an image-map area, an HTML link to an unknown scheme, an https link, a #anchor, and ⌘-clicks
// links inside an edit session; after each: location.href and the document text stay, and only http(s) / mailto
// links ask for an external open (window.open is recorded, an HTML https link may open its own new window: its
// navigation request is recorded and aborted). Global timeout 90 s.
import { openBrowser, check, note, sleep, finish, BASE } from './inline-verify-lib.mjs';

const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 90_000);
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
const doc = [
  '# Links',
  '',
  '<svg width="300" height="24"><a href="nonexistent.md"><text x="2" y="18" font-size="16">SVG-REL</text></a></svg>',
  '',
  '<svg width="300" height="24"><a href="index.html"><text x="2" y="18" font-size="16">SVG-INDEX</text></a></svg>',
  '',
  `<svg width="300" height="24"><a href="//localhost:${new URL(BASE).port}/index.html"><text x="2" y="18" font-size="16">SVG-PROTOREL</text></a></svg>`,
  '',
  '<svg width="300" height="24" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="other.md"><text x="2" y="18" font-size="16">SVG-XLINK</text></a></svg>',
  '',
  '<svg width="300" height="24"><a href="https://example.com/svg"><text x="2" y="18" font-size="16">SVG-HTTPS</text></a></svg>',
  '',
  `<img src="${GIF}" usemap="#m1" width="120" height="24" alt="MAP"><map name="m1"><area shape="rect" coords="0,0,120,24" href="nonexistent.md" alt="AREA"></map>`,
  '',
  'Para with [ftp link](ftp://example.com/f) and [sms link](sms:123) and [web link](https://example.com/w) and [top](#links) end.',
  '',
  'Tail paragraph to edit.',
  '',
].join('\n');

const B = await openBrowser();
const { page, context } = B;
const popups = [];       // every navigation a page other than the app page started (a new tab or window)
const popupNavs = [];    // the same, consumed per case: an HTML https link opens through the browser's own new window
context.on('request', (r) => {
  if (!r.isNavigationRequest()) return;
  let other = true;       // a navigation request issued before its frame exists is the first one of a new page
  try { other = r.frame().page() !== page; } catch { /* frame not created yet: a new page */ }
  if (other) { popups.push(r.url()); popupNavs.push(r.url()); }
});
context.on('page', (p) => { setTimeout(() => p.close().catch(() => {}), 200); });
await context.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
let code = 1;
try {
  await B.boot('mode=split');
  await page.evaluate(() => {
    window.__opened = [];
    window.__fix2tMarker = 1;
    const orig = window.open.bind(window);
    window.open = (u, ...rest) => { window.__opened.push(String(u)); return null; };
    window.__origOpen = orig;
  });
  await B.loadDoc(doc, 'links.md');
  const href0 = await page.evaluate(() => location.href);
  const state = async () => ({
    href: await page.evaluate(() => location.href),
    alive: await page.evaluate(() => window.__fix2tMarker === 1),   // false after any reload or navigation
    src: await page.evaluate(() => window.__mdr?.app.getText()),
    opened: (await page.evaluate(() => (window.__opened || []).splice(0))).concat(popupNavs.splice(0)),
  });
  const rectOf = (sel, text) => page.evaluate(({ sel, text }) => {
    const els = Array.from(document.querySelectorAll(`.mdr-preview ${sel}`));
    const e = text ? els.find((x) => x.textContent.includes(text)) : els[0];
    if (!e) return null;
    e.scrollIntoView({ block: 'center' });
    const r = e.getBoundingClientRect();
    return { x: r.left + Math.min(8, r.width / 2), y: r.top + r.height / 2 };
  }, { sel, text });

  const cases = [
    ['svg relative', 'svg text', 'SVG-REL', []],
    ['svg index.html', 'svg text', 'SVG-INDEX', []],
    ['svg protocol-relative', 'svg text', 'SVG-PROTOREL', []],
    ['svg xlink:href', 'svg text', 'SVG-XLINK', []],
    ['svg https', 'svg text', 'SVG-HTTPS', ['https://example.com/svg']],
    ['image-map area', 'img[usemap]', null, []],
    ['html ftp:', 'a', 'ftp link', []],
    ['html sms:', 'a', 'sms link', []],
    ['html https', 'a', 'web link', ['https://example.com/w']],
    ['html #anchor', 'a', 'top', []],
  ];
  for (const [name, sel, text, want] of cases) {
    for (const how of ['click', 'middle', 'enter']) {
      if (how === 'enter' && sel === 'img[usemap]') continue;
      const pt = await rectOf(sel, text);
      if (!pt) { check(`${name} ${how}: element found`, false); continue; }
      if (how === 'click') await page.mouse.click(pt.x, pt.y);
      else if (how === 'middle') await page.mouse.click(pt.x, pt.y, { button: 'middle' });
      else {
        const focused = await page.evaluate(({ sel, text }) => {
          const els = Array.from(document.querySelectorAll(`.mdr-preview ${sel}`));
          const e = text ? els.find((x) => x.textContent.includes(text)) : els[0];
          const link = e && e.closest('a');
          if (!link) return false;
          link.focus();
          return document.activeElement === link;
        }, { sel, text });
        if (!focused) { note(`${name} enter`, 'link not focusable, skipped'); continue; }
        await page.keyboard.press('Enter');
      }
      await sleep(350);
      await page.evaluate(() => window.__mdr?.app.preview.endEditSession?.()).catch(() => {});
      const s = await state();
      const ok = s.alive && s.href === href0 && s.src === doc && JSON.stringify(s.opened) === JSON.stringify(want);
      check(`${name} ${how}: page stays, text stays, opened ${JSON.stringify(want)}`, ok,
        `href=${s.href} alive=${s.alive} srcSame=${s.src === doc} opened=${JSON.stringify(s.opened)}`);
      if (!s.alive || s.href !== href0) { await B.boot('mode=split', false); await page.evaluate(() => { window.__opened = []; window.__fix2tMarker = 1; window.open = (u) => { window.__opened.push(String(u)); return null; }; }); await B.loadDoc(doc, 'links.md'); }
    }
  }

  // ⌘-click inside an edit session: only the https link opens.
  for (const [text, want] of [['ftp link', []], ['sms link', []], ['web link', ['https://example.com/w']]]) {
    await B.clickLine(15, 'first', 'Para');
    await sleep(150);
    const ed = await B.editing();
    const pt = await rectOf('a', text);
    await page.keyboard.down('Meta');
    await page.mouse.click(pt.x, pt.y);
    await page.keyboard.up('Meta');
    await sleep(300);
    await page.evaluate(() => window.__mdr.app.preview.endEditSession());
    await sleep(200);
    const s = await state();
    check(`session ⌘-click ${text}: page stays, opened ${JSON.stringify(want)}`, s.alive && s.href === href0 && JSON.stringify(s.opened) === JSON.stringify(want),
      `session=${!!ed} href=${s.href} opened=${JSON.stringify(s.opened)} srcSame=${s.src === doc}`);
  }
  const asked = new Set(['https://example.com/w', 'https://example.com/svg']);
  check('no other page navigated anywhere but an expected external URL', popups.every((u) => asked.has(u)), JSON.stringify(popups));
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
