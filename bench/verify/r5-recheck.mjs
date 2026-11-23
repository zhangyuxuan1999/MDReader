// bench/verify/r5-recheck.mjs — re-checks the r4 failures with correct methodology.
// Run: node bench/verify/r5-recheck.mjs      (dev server on :5202)
import { openApp, loadAndSettle, previewHtml, renderReference, canonical, diffCanonical, harness, enableMathReference } from './lib.mjs';

const H = harness('r5');
await enableMathReference(); // reference now has the app's own $ rules + real KaTeX
const app = await openApp();
const { page } = app;

// ---- 1. math in table / heading / list, compared against the math-enabled reference
for (const [name, text] of [
  ['math in heading/table/list', '# Heading with $a+b$\n\n- item $c^2$\n\n| $x$ | y |\n|---|---|\n| $$z$$ | w |\n'],
  ['math + currency in the same table', '| l | c | r | n |\n| :-- | :-: | --: | --- |\n| <b>B</b> | $x$ | $5 | 中文 |\n'],
  ['math in a quote inside a list', '- > $\\alpha$ in quote\n\n  $$\\beta$$\n'],
  ['math spanning a table cell boundary', '| a $x | y$ b |\n|---|---|\n| 1 | 2 |\n'],
]) {
  await loadAndSettle(page, text, 'm.md');
  const d = diffCanonical(canonical(renderReference(text)), canonical(await previewHtml(page)));
  if (d) H.fail(`math-ref: ${name}: preview != markdown-it+math`, { fixture: text, diffAt: d.index, expected: d.expected, actual: d.actual });
  else H.pass(`math-ref: ${name}`);
}

// ---- 2. data-l on a fence: SPEC says token.map[0] = the fence OPENER line. Verify with alt+click.
const dlDoc = ['# H1', '', 'para one', 'para one cont', '', '- a', '- b', '  - c', '', '> q1', '> q2', '', '```js', 'x();', 'y();', '```', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', 'last para'].join('\n');
await loadAndSettle(page, dlDoc, 'datal.md');
const clicks = await page.evaluate(async () => {
  const out = [];
  const targets = [
    ['h1', 'h1'], ['para', 'p'], ['li', 'li'], ['quote p', 'blockquote p'], ['pre', 'pre'], ['table', 'table'], ['last p', '.md-block:last-child p'],
  ];
  for (const [label, sel] of targets) {
    const el = document.querySelector('.mdr-preview__body ' + sel);
    if (!el) { out.push({ label, missing: true }); continue; }
    let line = null;
    const off = window.__mdr.app.bus.on('nav:gotoLine', (e) => { line = e.line; });
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    await new Promise((r) => setTimeout(r, 60));
    off();
    out.push({ label, line, text: el.textContent.trim().slice(0, 24) });
  }
  return out;
});
const srcLines = dlDoc.split('\n');
const expectLine = { 'h1': 1, 'para': 3, 'li': 6, 'quote p': 10, 'pre': 13, 'table': 18, 'last p': 22 };
const bad = clicks.filter((c) => c.line !== expectLine[c.label]);
console.log('alt+click →', JSON.stringify(clicks), 'src:', JSON.stringify(srcLines.map((l, i) => `${i + 1}:${l}`)));
if (bad.length) H.fail('alt+click: preview element maps to the wrong source line', { bad, expected: expectLine });
else H.pass('alt+click: every element maps to its source line', JSON.stringify(clicks.map((c) => `${c.label}=${c.line}`)));

// ---- 3. task toggle: re-query the checkbox before each click (no stale nodes)
const taskDoc = '- [ ] first [ ] second on same line\n- item without task\n\n1. [ ] outer\n\n   - [x] inner done\n\n     more para\n\n2. [ ] outer2\n';
await loadAndSettle(page, taskDoc, 'task2.md');
const n = await page.evaluate(() => document.querySelectorAll('.mdr-preview__body input[type=checkbox]').length);
const results = [];
for (let i = 0; i < n; i++) {
  const before = await page.evaluate(() => window.__mdr.app.getText());
  await page.evaluate((idx) => document.querySelectorAll('.mdr-preview__body input[type=checkbox]')[idx].click(), i);
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => window.__mdr.app.getText());
  const b = before.split('\n'), a = after.split('\n');
  const diff = a.map((l, j) => (l === b[j] ? null : { j: j + 1, from: b[j], to: l })).filter(Boolean);
  results.push({ i, diff });
}
console.log('toggles:', JSON.stringify(results));
const badT = results.filter((r) => r.diff.length !== 1);
if (badT.length) H.fail('task toggle: a checkbox click did not flip exactly one source line', { bad: badT, checkboxes: n, doc: taskDoc });
else H.pass('task toggle: each of the checkboxes flips exactly one line', `${n} checkboxes`);
const ft = (await page.evaluate(() => window.__mdr.app.getText())).split('\n');
if (ft[0] === '- [x] first [ ] second on same line') H.pass('task toggle: only the first marker on the line flips');
else H.fail('task toggle: wrong marker flipped on a line with two "[ ]"', { line: ft[0] });

// ---- 4. checkbox round trip: click every box twice, source must return to the original
await loadAndSettle(page, taskDoc, 'task3.md');
for (let round = 0; round < 2; round++)
  for (let i = 0; i < n; i++) {
    await page.evaluate((idx) => document.querySelectorAll('.mdr-preview__body input[type=checkbox]')[idx].click(), i);
    await page.waitForTimeout(200);
  }
const rt = await page.evaluate(() => window.__mdr.app.getText());
if (rt === taskDoc) H.pass('task toggle: full round trip restores the exact source');
else H.fail('task toggle: round trip does not restore the source', { expected: taskDoc, actual: rt });
// and the rendered checkbox states must match the source
const st = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview__body input[type=checkbox]')).map((c) => c.checked));
const expSt = taskDoc.split('\n').filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(l)).map((l) => /\[[xX]\]/.test(l));
if (JSON.stringify(st) === JSON.stringify(expSt)) H.pass('task toggle: checkbox states match the source after the round trip');
else H.fail('task toggle: rendered checkbox states disagree with the source', { rendered: st, expected: expSt });

if (app.pageErrors.length) H.fail('page errors', { errors: app.pageErrors.slice(0, 5) }); else H.pass('no page errors');
const re = app.consoleErrors.filter((e) => !/404|Failed to load resource|net::ERR/.test(e));
if (re.length) H.fail('console errors', { errors: re.slice(0, 5) }); else H.pass('no console errors');

await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
