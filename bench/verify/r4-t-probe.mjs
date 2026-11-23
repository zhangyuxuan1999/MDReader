// bench/verify/r4-t-probe.mjs — fix-trust r4: what distinguishes a click a <label> forwards to a checkbox from a
// click on the checkbox itself, in Chromium (plain page, no app). Prints, per gesture, the press target and the
// click event's target, isTrusted, detail, clientX/Y, pointerType, and whether the point lies in the box.
// Global timeout 60 s.
import { chromium } from '@playwright/test';

let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 60_000);
const HTML = `<!doctype html><body style="font:16px sans-serif">
<p id="para">Intro paragraph text here</p>
<label id="wrap">wrap label text <input type="checkbox" id="c1"> tail</label>
<p><label id="lfor" for="c2">for label text</label> ... <input type="checkbox" id="c2"></p>
<p><input type="checkbox" id="c3"> plain box</p>
<p><label id="ltab" tabindex="0" for="c4">focusable label</label> <input type="checkbox" id="c4"></p>
<p><label id="lsum"><details><summary id="sum">summary inside label</summary>x</details><input type="checkbox" id="c5"></label></p>
<p><label id="outer">outer <label id="inner">inner text <input type="checkbox" id="c6"></label></label></p>
<p><label id="lbtn"><a href="#x" id="lnk">link in label</a> <input type="checkbox" id="c7"></label></p>
</body>`;

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.setContent(HTML);
  await page.evaluate(() => {
    window.__log = [];
    const name = (t) => t ? (t.id || t.tagName) : null;
    for (const ty of ['pointerdown', 'mousedown', 'keydown', 'keyup', 'focusin']) {
      document.addEventListener(ty, (e) => window.__log.push({ ty, t: name(e.target), key: e.key }), true);
    }
    document.addEventListener('click', (e) => {
      const t = e.target;
      let inBox = null;
      if (t instanceof HTMLInputElement) {
        const r = t.getBoundingClientRect();
        inBox = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      }
      window.__log.push({ ty: 'click', t: name(t), trusted: e.isTrusted, detail: e.detail, x: e.clientX, y: e.clientY,
        pt: e.pointerType, ctor: e.constructor.name, inBox, screenX: e.screenX, active: name(document.activeElement) });
    }, true);
  });
  const center = async (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
  const clickAt = async (label, sel, off = 0) => {
    await page.evaluate(() => { window.__log = []; });
    const p = await center(sel);
    await page.mouse.click(p.x + off, p.y);
    console.log(label, JSON.stringify(await page.evaluate(() => window.__log)));
  };
  const keys = async (label, sel, k) => {
    await page.evaluate((s) => { document.querySelector(s).focus(); window.__log = []; }, sel);
    await page.keyboard.press(k);
    console.log(label, JSON.stringify(await page.evaluate(() => window.__log)));
  };
  await clickAt('wrap-label-text', '#wrap', -40);
  await clickAt('wrap-box-itself', '#c1');
  await clickAt('for-label', '#lfor');
  await clickAt('plain-box', '#c3');
  await clickAt('nested-inner', '#inner', -30);
  await clickAt('nested-outer', '#outer', -60);
  await keys('space-on-box', '#c3', 'Space');
  await keys('enter-on-box', '#c3', 'Enter');
  await keys('space-on-tab-label', '#ltab', 'Space');
  await keys('enter-on-tab-label', '#ltab', 'Enter');
  await keys('enter-on-summary-in-label', '#sum', 'Enter');
  await keys('space-on-summary-in-label', '#sum', 'Space');
  await keys('enter-on-link-in-label', '#lnk', 'Enter');
  // a double click on a label
  await page.evaluate(() => { window.__log = []; });
  { const p = await center('#lfor'); await page.mouse.dblclick(p.x, p.y); }
  console.log('dbl-for-label', JSON.stringify(await page.evaluate(() => window.__log.filter((x) => x.ty === 'click'))));
  console.log('states', JSON.stringify(await page.evaluate(() => [1, 2, 3, 4, 5, 6, 7].map((i) => document.getElementById('c' + i).checked))));
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  process.exitCode = 2;
} finally {
  clearTimeout(killer);
  try { await browser?.close(); } catch { /* */ }
}
