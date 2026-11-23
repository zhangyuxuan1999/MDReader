import { launch, open, loadText, step, expect, finish, sleep, getFailures, measure, focusEditor } from '../ux/lib.mjs';
const { browser, page, errors } = await launch({ colorScheme: 'dark' });
page.setDefaultTimeout(10000);
await page.addInitScript(() => localStorage.setItem('mdr.theme', 'dark'));
await open(page, '?mode=split');
await loadText(page, '# 标题\n\n正文 body text 一二三。\n\n```ts\nconst x: number = 1; // 注释\n```\n\n> 引用\n', 'c.md');
await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
await sleep(800);

const audit = await page.evaluate(() => {
  const lum = (c) => { const [r,g,b] = c; const f = (v) => { v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
  const parse = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(',').map(Number); return { rgb: [p[0],p[1],p[2]], a: p.length > 3 ? p[3] : 1 }; };
  const effBg = (el) => { let e = el; while (e) { const b = parse(getComputedStyle(e).backgroundColor); if (b && b.a > 0.5) return b.rgb; e = e.parentElement; } return [255,255,255]; };
  const ratio = (fg, bg) => { const a = lum(fg), b = lum(bg); const [hi, lo] = a > b ? [a,b] : [b,a]; return (hi+0.05)/(lo+0.05); };
  const out = [];
  const sels = ['.mdr-statusbar__item', '.mdr-toc__item', '.mdr-preview p', '.mdr-preview h1', '.mdr-preview blockquote',
    '.mdr-preview pre code', '.mdr-preview .hljs-comment', '.mdr-preview .hljs-keyword', '.mdr-preview .hljs-string',
    '.cm-content', '.cm-gutterElement', '.mdr-toolbar__btn'];
  for (const s of sels) {
    const el = document.querySelector(s); if (!el) { out.push({ sel: s, missing: true }); continue; }
    const cs = getComputedStyle(el); const fg = parse(cs.color); if (!fg) continue;
    const bg = effBg(el);
    out.push({ sel: s, fg: cs.color, bg: `rgb(${bg.join(',')})`, ratio: +ratio(fg.rgb, bg).toFixed(2), size: cs.fontSize });
  }
  return out;
});
console.log('DARK contrast:');
for (const a of audit) console.log(' ', JSON.stringify(a));

// find-panel theming in dark
await focusEditor(page);
await page.keyboard.press('Meta+f');
await sleep(500);
const panel = await page.evaluate(() => {
  const p = document.querySelector('.cm-panel.cm-search');
  const g = (e) => { const s = getComputedStyle(e); return { tag: e.tagName, txt: (e.textContent||e.placeholder||'').slice(0,8), color: s.color, bg: s.backgroundColor, border: s.borderColor, appearance: s.appearance }; };
  return { panelBg: getComputedStyle(p).backgroundColor, panelColor: getComputedStyle(p).color,
           controls: [...p.querySelectorAll('button, input')].map(g) };
});
console.log('find panel (dark):', JSON.stringify(panel, null, 1));

await step('[dark] find/replace panel controls follow the dark tokens', async () => {
  const lum = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const [r,g,b] = m[1].split(',').map(Number); return 0.2126*r+0.7152*g+0.0722*b; };
  const light = panel.controls.filter(c => c.bg && c.bg !== 'rgba(0, 0, 0, 0)' && (lum(c.bg) ?? 0) > 170);
  expect(light.length === 0,
    `in dark theme these find-panel controls still use a light/UA-default background: ${JSON.stringify(light)} (panel bg ${panel.panelBg})`);
});
await step('[dark] no text below WCAG AA 4.5:1 (3:1 for large text)', async () => {
  const bad = audit.filter(a => !a.missing && a.ratio < (parseFloat(a.size) >= 18.66 ? 3 : 4.5));
  for (const a of audit) if (!a.missing) measure(`contrast ${a.sel}`, a.ratio, parseFloat(a.size) >= 18.66 ? '>= 3' : '>= 4.5', a.ratio >= (parseFloat(a.size) >= 18.66 ? 3 : 4.5));
  expect(bad.length === 0, `low contrast: ${JSON.stringify(bad)}`);
});
await browser.close();

// light theme pass
{
  const { browser, page, errors } = await launch({ colorScheme: 'light' });
  await page.addInitScript(() => localStorage.setItem('mdr.theme', 'light'));
  await open(page, '?mode=split');
  await loadText(page, '# 标题\n\n正文 body text。\n\n```ts\nconst x: number = 1; // 注释\n```\n', 'c.md');
  await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
  await sleep(800);
  const a2 = await page.evaluate(() => {
    const lum = (c) => { const f = (v) => { v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }; return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2]); };
    const parse = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(',').map(Number); return { rgb: [p[0],p[1],p[2]], a: p.length>3?p[3]:1 }; };
    const effBg = (el) => { let e = el; while (e) { const b = parse(getComputedStyle(e).backgroundColor); if (b && b.a > 0.5) return b.rgb; e = e.parentElement; } return [255,255,255]; };
    const ratio = (fg,bg) => { const x = lum(fg), y = lum(bg); const [h,l] = x>y?[x,y]:[y,x]; return (h+0.05)/(l+0.05); };
    return ['.mdr-statusbar__item','.mdr-toc__item','.mdr-preview p','.mdr-preview .hljs-comment','.mdr-preview .hljs-keyword','.mdr-preview .hljs-string','.cm-gutterElement','.mdr-toolbar__btn']
      .map(s => { const el = document.querySelector(s); if (!el) return { sel: s, missing: true }; const cs = getComputedStyle(el); const fg = parse(cs.color); const bg = effBg(el);
        return { sel: s, fg: cs.color, bg: `rgb(${bg.join(',')})`, ratio: +ratio(fg.rgb,bg).toFixed(2), size: cs.fontSize }; });
  });
  console.log('LIGHT contrast:'); for (const a of a2) console.log(' ', JSON.stringify(a));
  await step('[light] no text below WCAG AA', async () => {
    const bad = a2.filter(a => !a.missing && a.ratio < (parseFloat(a.size) >= 18.66 ? 3 : 4.5));
    for (const a of a2) if (!a.missing) measure(`contrast(light) ${a.sel}`, a.ratio, parseFloat(a.size) >= 18.66 ? '>= 3' : '>= 4.5', a.ratio >= (parseFloat(a.size) >= 18.66 ? 3 : 4.5));
    expect(bad.length === 0, `low contrast: ${JSON.stringify(bad)}`);
  });
  finish('15-contrast', errors);
  await browser.close();
}
process.exit(getFailures() ? 1 : 0);
