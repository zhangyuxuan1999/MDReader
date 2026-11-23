// bench/verify/ux/v-focus-colour.mjs — the tint itself: identical in both panes, subtle but visible,
// light AND dark; plus the two screenshots.
// Run: MDR_UX_BASE=http://localhost:5242 node bench/verify/ux/v-focus-colour.mjs
import { mkdirSync } from 'node:fs';
import { launch, open, step, expect, check, measure, sleep, getFailures } from './lib.mjs';

const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const parse = (s) => (s.match(/[\d.]+/g) ?? []).map(Number);
const over = (fg, bg) => { const a = fg[3] ?? 1; return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)); };
const lum = (c) => { const f = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

async function run(theme) {
  const { browser, page, errors } = await launch({ colorScheme: theme });
  await page.goto(`${process.env.MDR_UX_BASE ?? 'http://localhost:5242'}/?doc=/test-data/small.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 30000 });
  await page.evaluate(() => window.__mdr.waitIdle());
  await page.evaluate((t) => { window.__mdr.app.theme.set(t); }, theme);
  await sleep(600);

  // a preview click, so BOTH the preview .is-focus and the editor .cm-peerLine are on screen
  const pos = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.mdr-preview__body p')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 120 && r.bottom < innerHeight - 200; });
    const r = el.getBoundingClientRect(); return { x: r.left + 14, y: r.top + 6 };
  });
  await page.mouse.click(pos.x, pos.y);
  await sleep(400);

  const m = await page.evaluate(() => {
    const focus = document.querySelector('.mdr-preview__body .is-focus');
    const peer = document.querySelector('.cm-peerLine');
    const plainLine = [...document.querySelectorAll('.cm-content .cm-line')].find((e) => e !== peer && !e.classList.contains('cm-activeLine'));
    const plainP = [...document.querySelectorAll('.mdr-preview__body p')].find((e) => e !== focus);
    const cs = (e) => (e ? getComputedStyle(e) : null);
    return {
      token: getComputedStyle(document.documentElement).getPropertyValue('--mdr-focus-line').trim(),
      activeLineToken: getComputedStyle(document.documentElement).getPropertyValue('--mdr-active-line').trim(),
      focusBg: cs(focus)?.backgroundColor ?? null, focusShadow: cs(focus)?.boxShadow ?? null,
      focusBorder: cs(focus)?.borderTopWidth ?? null, focusRadius: cs(focus)?.borderTopLeftRadius ?? null,
      peerBg: cs(peer)?.backgroundColor ?? null,
      previewPaneBg: cs(document.querySelector('.mdr-preview'))?.backgroundColor ?? null,
      previewBodyBg: cs(document.querySelector('.mdr-preview__body'))?.backgroundColor ?? null,
      editorContentBg: cs(document.querySelector('.cm-content'))?.backgroundColor ?? null,
      editorBg: cs(document.querySelector('.cm-editor'))?.backgroundColor ?? null,
      rootBg: cs(document.body)?.backgroundColor ?? null,
      fg: cs(focus)?.color ?? null,
      plainLineBg: cs(plainLine)?.backgroundColor ?? null, plainPBg: cs(plainP)?.backgroundColor ?? null,
      focusCount: document.querySelectorAll('.is-focus').length,
      peerCount: document.querySelectorAll('.cm-peerLine').length,
    };
  });

  // pixel truth: sample the rendered tint vs the neighbouring untinted background
  const px = await page.evaluate(() => {
    const el = document.querySelector('.mdr-preview__body .is-focus');
    const r = el.getBoundingClientRect();
    return { tint: { x: Math.round(r.right - 8), y: Math.round(r.top + r.height / 2) },
             plain: { x: Math.round(r.right - 8), y: Math.round(r.bottom + 14) } };
  });
  const shot = await page.screenshot();
  const { createCanvas, loadImage } = await (async () => { try { return await import('canvas'); } catch { return {}; } })();
  let pixel = null;
  if (loadImage) {
    const img = await loadImage(shot);
    const c = createCanvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const get = (p) => [...g.getImageData(p.x, p.y, 1, 1).data].slice(0, 3);
    pixel = { tint: get(px.tint), plain: get(px.plain) };
  }

  const paneBg = parse(m.previewPaneBg)[3] === 0 ? parse(m.rootBg) : parse(m.previewPaneBg);
  const tintOnPane = over(parse(m.focusBg), paneBg);
  const alpha = parse(m.focusBg)[3] ?? 1;
  const cr = contrast(tintOnPane, paneBg);
  const delta = dE(tintOnPane, paneBg);
  const textCr = contrast(parse(m.fg), tintOnPane);

  await page.screenshot({ path: `${SHOTS}focus-line-${theme}.png` });
  await browser.close();
  return { theme, ...m, paneBg, tintOnPane: tintOnPane.map((v) => +v.toFixed(1)), alpha,
           contrastVsPane: +cr.toFixed(3), deltaRGB: +delta.toFixed(1), textContrastOnTint: +textCr.toFixed(2),
           pixel, errors };
}

const light = await run('light');
const dark = await run('dark');

for (const r of [light, dark]) {
  await step(`${r.theme}: exactly one tint per pane and both panes use the same colour`, async () => {
    expect(r.focusCount === 1, `.is-focus ${r.focusCount}`);
    expect(r.peerCount === 1, `.cm-peerLine ${r.peerCount}`);
    expect(r.focusBg === r.peerBg, `preview ${r.focusBg} != editor ${r.peerBg}`);
    expect(r.activeLineToken === r.token || r.activeLineToken === '', `--mdr-active-line (${r.activeLineToken}) != --mdr-focus-line (${r.token})`);
    return JSON.stringify({ token: r.token, focusBg: r.focusBg, peerBg: r.peerBg, activeLineToken: r.activeLineToken });
  });
  await step(`${r.theme}: subtle but visible (alpha, ΔRGB and contrast against the pane background)`, async () => {
    measure(`${r.theme} tint alpha`, r.alpha, '0.05 – 0.16 (subtle)', r.alpha >= 0.05 && r.alpha <= 0.16);
    measure(`${r.theme} tint contrast vs pane bg`, r.contrastVsPane, '1.02 – 1.30 (visible, not a highlight)', r.contrastVsPane >= 1.02 && r.contrastVsPane <= 1.30);
    measure(`${r.theme} ΔRGB tint vs pane bg`, r.deltaRGB, '>= 6 (perceptible)', r.deltaRGB >= 6);
    measure(`${r.theme} body text contrast ON the tint`, r.textContrastOnTint, '>= 4.5 (AA preserved)', r.textContrastOnTint >= 4.5);
    expect(r.focusBorder === '0px', `the focus element grew a border: ${r.focusBorder}`);
    return JSON.stringify({ paneBg: r.paneBg, tintOnPane: r.tintOnPane, shadow: r.focusShadow, radius: r.focusRadius, pixel: r.pixel });
  });
  check(`${r.theme}: no console / page errors`, r.errors.length === 0, r.errors.slice(0, 4).join(' | '));
}

console.log(`\nscreenshots: ${SHOTS}focus-line-light.png / focus-line-dark.png`);
console.log(JSON.stringify({ light: { token: light.token, pane: light.paneBg, tint: light.tintOnPane, cr: light.contrastVsPane, dE: light.deltaRGB },
                             dark: { token: dark.token, pane: dark.paneBg, tint: dark.tintOnPane, cr: dark.contrastVsPane, dE: dark.deltaRGB } }, null, 1));
console.log(`failures=${getFailures()}`);
process.exit(getFailures() ? 1 : 0);
