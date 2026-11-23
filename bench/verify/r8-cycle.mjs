// bench/verify/r8-cycle.mjs — rendering stability across eviction / remount / document switches,
// plus extreme-shape documents. Run: node bench/verify/r8-cycle.mjs   (dev server on :5202)
import { openApp, loadAndSettle, previewHtml, renderReference, canonical, diffCanonical, harness, sleep } from './lib.mjs';

const H = harness('r8');
const app = await openApp();
const { page } = app;

// ---------------------------------------------------------------- 1. scroll far away and back: content must return identical
const doc = Array.from({ length: 700 }, (_, i) =>
  `## Section ${i}\n\npara ${i} with **bold**, [link](https://e.com/${i}) and \`code${i}\`.\n\n- [ ] task ${i}\n- item ${i}\n\n\`\`\`js\nvar v${i} = ${i};\n\`\`\`\n\n| a${i} | b |\n|---|---|\n| 1 | 2 |\n`).join('\n');
await loadAndSettle(page, doc, 'cycle.md', { timeout: 120_000 });
const before = canonical(await previewHtml(page));
// scroll to the end, wait for eviction passes, scroll back, remount everything
for (let i = 0; i < 6; i++) {
  await page.evaluate((f) => { const p = window.__mdr.app.preview; p.el.scrollTop = p.el.scrollHeight * f; }, i / 5);
  await sleep(700);
}
await page.evaluate(() => { window.__mdr.app.preview.el.scrollTop = 0; });
await sleep(900);
await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
await page.evaluate(() => window.__mdr.waitIdle());
await page.waitForFunction(() => document.querySelectorAll('.md-block.is-pending, .md-block.is-stale').length === 0, null, { timeout: 120_000 });
await sleep(600);
const after = canonical(await previewHtml(page));
const dc = diffCanonical(before, after);
if (dc) H.fail('eviction: content differs after scrolling away and remounting', { diffAt: dc.index, expected: dc.expected, actual: dc.actual, beforeLines: before.length, afterLines: after.length });
else H.pass('eviction: content identical after a full scroll cycle + mountAll', `${after.length} canonical lines`);
const dref = diffCanonical(canonical(renderReference(doc)), after);
if (dref) H.fail('eviction: remounted content differs from markdown-it', { diffAt: dref.index, expected: dref.expected, actual: dref.actual });
else H.pass('eviction: remounted content equals markdown-it');

// ---------------------------------------------------------------- 2. document switches must not leak previous content
const docs = [
  ['A', '# Alpha\n\nalpha body\n\n- [ ] a1\n'],
  ['B', '# Beta\n\n```py\nprint("beta")\n```\n\n| b | b |\n|---|---|\n| 1 | 2 |\n'],
  ['C', ''],
  ['D', '# Delta\n\n$x^2$ and [r][d]\n\n[d]: https://e.com/d\n'],
];
for (let round = 0; round < 3; round++) {
  for (const [n, t] of docs) {
    await loadAndSettle(page, t, `${n}.md`);
    const got = canonical(await previewHtml(page));
    const exp = canonical(renderReference(t));
    const d = n === 'D' ? null : diffCanonical(exp, got); // D has math (no math in the plain reference)
    const leak = await page.evaluate(() => document.querySelector('.mdr-preview__body').textContent);
    const others = docs.filter(([m]) => m !== n).map(([m]) => ({ A: 'alpha body', B: 'print("beta")', C: null, D: 'Delta' })[m]).filter(Boolean);
    const leaked = others.filter((s) => leak.includes(s));
    if (d) H.fail(`docswitch round ${round}: ${n} renders wrong after a switch`, { diffAt: d.index, expected: d.expected, actual: d.actual });
    else if (leaked.length) H.fail(`docswitch round ${round}: ${n} preview still shows content from another document`, { leaked, text: leak.slice(0, 200) });
    else if (round === 2) H.pass(`docswitch: ${n} clean after 3 rounds`);
  }
}

// ---------------------------------------------------------------- 3. extreme shapes
const extremes = [
  ['500-column table', '| ' + Array.from({ length: 500 }, (_, i) => `c${i}`).join(' | ') + ' |\n|' + '---|'.repeat(500) + '\n| ' + Array.from({ length: 500 }, (_, i) => i).join(' | ') + ' |\n'],
  ['one 200k-char cell', '| a | b |\n|---|---|\n| ' + 'x'.repeat(200_000) + ' | y |\n'],
  ['1 MB single line of CJK, no newline', '中文'.repeat(250_000)],
  ['10k inline links in one paragraph', Array.from({ length: 10_000 }, (_, i) => `[l${i}](https://e.com/${i})`).join(' ') + '\n'],
  ['5k nested emphasis', '*'.repeat(2000) + 'x' + '*'.repeat(2000) + '\n'],
];
for (const [name, text] of extremes) {
  try {
    const t0 = Date.now();
    await loadAndSettle(page, text, 'x.md', { timeout: 180_000 });
    const ms = Date.now() - t0;
    const info = await page.evaluate(() => ({
      blocks: document.querySelectorAll('.md-block').length,
      tds: document.querySelectorAll('.mdr-preview__body td').length,
      as: document.querySelectorAll('.mdr-preview__body a').length,
      plain: document.querySelectorAll('.md-plain, .md-code--plain').length,
      len: document.querySelector('.mdr-preview__body').textContent.length,
      err: document.querySelectorAll('.md-error').length,
    }));
    H.measure(`extreme: ${name} load → mounted`, `${ms} ms`, 'informational', true);
    if (info.err) H.fail(`extreme: ${name} produced .md-error blocks`, info);
    else H.pass(`extreme: ${name}`, JSON.stringify(info));
  } catch (e) { H.fail(`extreme: ${name} (exception / timeout)`, { error: String(e).slice(0, 300) }); }
}

if (app.pageErrors.length) H.fail('page errors', { errors: app.pageErrors.slice(0, 5) }); else H.pass('no page errors');
const re = app.consoleErrors.filter((e) => !/404|Failed to load resource|net::ERR/.test(e));
if (re.length) H.fail('console errors', { errors: re.slice(0, 5) }); else H.pass('no console errors');

await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
