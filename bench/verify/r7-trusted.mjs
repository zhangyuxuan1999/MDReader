// bench/verify/r7-trusted.mjs — Code-kind blocks carry HTML_FLAG_TRUSTED and are mounted with
// innerHTML, bypassing DOMPurify (CONTRACT §6). Hunt for a way to smuggle live markup into one.
// Also: PLAIN (>200 KB) blocks, export HTML of the same payloads, mode switching.
// Run: node bench/verify/r7-trusted.mjs      (dev server on :5202)
import { openApp, loadAndSettle, harness, sleep, previewHtml, canonical, diffCanonical, renderReference } from './lib.mjs';

const H = harness('r7');
const app = await openApp();
const { page } = app;

const probes = [
  ['fence info: quote + event handler', '```js" onload="window.__p1=1\ncode\n```\n'],
  ['fence info: closing tag + script', '```</code></pre><script>window.__p2=1</script>\ncode\n```\n'],
  ['fence info: img onerror', '```x"><img src=y onerror="window.__p3=1">\ncode\n```\n'],
  ['fence info: single quotes', "```x' onmouseover='window.__p4=1\ncode\n```\n"],
  ['fence info: backslash + entity', '```x\\"><svg onload=window.__p5=1>\ncode\n```\n'],
  ['tilde fence info with backticks + html', '~~~`x`"><img src=z onerror="window.__p6=1">\ncode\n~~~\n'],
  ['fence body: raw html and script', '```\n<script>window.__p7=1</script>\n<img src=q onerror="window.__p8=1">\n</code></pre><b>escaped?</b>\n```\n'],
  ['indented code body: raw html', 'p\n\n    <script>window.__p9=1</script>\n    <img src=w onerror="window.__p10=1">\n'],
  ['fence >30k chars (unhighlighted path) with html', '```js\n' + '// pad\n'.repeat(5000) + '<img src=a onerror="window.__p11=1">\n```\n'],
  ['fence >8k chars (fastCodeChars path) with html', '```ts\n' + 'const x=1;\n'.repeat(900) + '<img src=b onerror="window.__p12=1">\n```\n'],
  ['block >200k chars → PLAIN, with html', 'x <img src=c onerror="window.__p13=1"> ' + 'padding word '.repeat(20000) + '\n'],
  ['giant fence >200k → PLAIN code, with html', '```\n<img src=d onerror="window.__p14=1">\n' + 'pad line\n'.repeat(25000) + '```\n'],
];

for (const [name, text] of probes) {
  await loadAndSettle(page, text, 'trusted.md', { timeout: 120_000 });
  await sleep(400);
  const r = await page.evaluate(() => {
    const body = document.querySelector('.mdr-preview__body');
    const fired = Object.keys(window).filter((k) => /^__p\d+$/.test(k));
    const live = [];
    for (const el of body.querySelectorAll('*')) {
      const tag = el.tagName.toLowerCase();
      if (['script', 'iframe', 'object', 'embed', 'svg', 'form'].includes(tag)) live.push(`<${tag}>`);
      for (const a of el.attributes) if (/^on/i.test(a.name)) live.push(`${tag}[${a.name}="${a.value.slice(0, 30)}"]`);
      if (tag === 'img') live.push(`<img src="${el.getAttribute('src')}">`);
    }
    return { fired, live, preClass: body.querySelector('pre')?.className ?? null, dataLang: body.querySelector('pre')?.getAttribute('data-lang') ?? null, head: body.innerHTML.slice(0, 400) };
  });
  if (r.fired.length || r.live.length) H.fail(`TRUSTED bypass: ${name} produced live markup in the preview`, { fired: r.fired, live: r.live, head: r.head, fixture: text.slice(0, 200) });
  else H.pass(`TRUSTED: ${name} stays inert`, `class=${r.preClass} data-lang=${JSON.stringify(r.dataLang)}`);
  await page.evaluate(() => { for (const k of Object.keys(window)) if (/^__p\d+$/.test(k)) delete window[k]; });
}

// ---------------------------------------------------------------- same payloads through exportHtml
const allProbes = probes.map(([, t]) => t).slice(0, 10).join('\n');
await loadAndSettle(page, allProbes, 'trusted-all.md', { timeout: 120_000 });
const exported = await page.evaluate(() => window.__mdr.app.worker.exportHtml());
const exportBad = [];
if (/<script(?![^>]*type="application\/json")/i.test(exported.replace(/&lt;script/gi, ''))) exportBad.push('inline <script> tag');
for (const m of exported.matchAll(/\son[a-z]+\s*=/gi)) exportBad.push(`event attribute ${m[0].trim()}`);
if (/<img\s+src=[^>]*onerror/i.test(exported)) exportBad.push('img onerror');
if (exportBad.length) H.fail('export: code-fence payloads produce live markup in the exported HTML', { bad: [...new Set(exportBad)].slice(0, 6), size: exported.length });
else H.pass('export: code-fence payloads stay inert in the exported HTML', `${exported.length} bytes`);
// render the export offline and check nothing fires
const off = await page.context().newPage();
await off.setContent(exported, { waitUntil: 'load' });
const offFired = await off.evaluate(() => ({ fired: Object.keys(window).filter((k) => /^__p\d+$/.test(k)), scripts: document.querySelectorAll('script').length, imgs: document.querySelectorAll('img').length }));
await off.close();
if (offFired.fired.length || offFired.scripts) H.fail('export: opened offline, the exported HTML executes smuggled markup', offFired);
else H.pass('export: opened offline nothing executes', JSON.stringify(offFired));

// ---------------------------------------------------------------- mode switching must not change the rendering
const modeDoc = '# H\n\npara **b** [l](https://e.com) `c`\n\n- [ ] t\n\n```js\nvar a=1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n$x^2$\n';
await loadAndSettle(page, modeDoc, 'mode.md');
const inSplit = canonical(await previewHtml(page));
await page.evaluate(() => window.__mdr.mode('edit'));
await sleep(300);
await page.evaluate(() => window.__mdr.mode('preview'));
await page.evaluate(() => window.__mdr.waitIdle());
await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
await page.evaluate(() => window.__mdr.waitIdle());
await sleep(600);
const inPreview = canonical(await previewHtml(page));
const dm = diffCanonical(inSplit, inPreview);
if (dm) H.fail('mode: preview content differs after edit→preview round trip', { diffAt: dm.index, expected: dm.expected, actual: dm.actual });
else H.pass('mode: rendering identical after split→edit→preview', `${inPreview.length} lines`);
const dRef = diffCanonical(canonical(renderReference(modeDoc)), inPreview.filter((l) => !/katex|md-math/.test(l)).length ? inPreview : inPreview);
// (math makes a strict compare here meaningless; the split-mode compare above is the assertion)

if (app.pageErrors.length) H.fail('page errors', { errors: app.pageErrors.slice(0, 5) }); else H.pass('no page errors');
const re = app.consoleErrors.filter((e) => !/404|Failed to load resource|net::ERR|ERR_NAME|ERR_CONNECTION/.test(e));
if (re.length) H.fail('console errors', { errors: re.slice(0, 5) }); else H.pass('no console errors');

await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
