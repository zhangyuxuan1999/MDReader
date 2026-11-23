// s21 — pathological *structures* not covered by s09: unclosed <pre>/<!--/$$ at line 1,
// ref-definition churn, huge inline-$ density, 500-level nesting, 6 MB single line,
// 10k-column table, no-trailing-newline + EOF typing.
// Run: node bench/verify/s21_patho_structures.mjs
import { launch, open, settle, structureCheck, latencyStats, longTasks, toasts, makeChecker, report, sleep, previewSnapshot, diffSnapshots, loadText } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();

const GENS = {
  unclosedPre: () => '<pre>\n' + 'line of raw html text\n'.repeat(30000),
  unclosedComment: () => '<!--\n' + '# H\n\npara\n\n'.repeat(20000),
  unclosedMath: () => '$$\n' + 'x^2 + y^2 = z^2\n'.repeat(30000),
  dollarStorm: () => { let s = ''; for (let i = 0; i < 200; i++) s += 'Price $' + i + ' and $ ' + 'a $ b $ c $ d $ '.repeat(50) + '\n\n'; return s; },
  nested500: () => { let s = ''; for (let i = 0; i < 500; i++) s += '  '.repeat(i) + `- level ${i}\n`; return s; },
  quote200: () => { let s = ''; for (let i = 1; i <= 200; i++) s += '>'.repeat(i) + ' q\n'; return s; },
  line6MB: () => 'x'.repeat(6 * 1024 * 1024),
  wideTable: () => { const n = 2000; return '|' + Array.from({ length: n }, (_, i) => `c${i}`).join('|') + '|\n|' + Array.from({ length: n }, () => '---').join('|') + '|\n|' + Array.from({ length: n }, (_, i) => `v${i}`).join('|') + '|\n'; },
  noTrailingNl: () => '# A\n\npara one\n\n- a\n- b\n\nlast line without newline',
};

async function scenario(name, opts = {}) {
  const tag = `[${name}]`;
  const eb = log.consoleErrors.length, pb = log.pageErrors.length, rb = log.restarts;
  await page.evaluate(() => { window.__longTasks.length = 0; window.__lat.length = 0; });
  const t0 = Date.now();
  const gen = await page.evaluate(async ({ name, src }) => {
    const fn = new Function('return (' + src + ')')();
    const text = fn();
    const a = performance.now();
    await window.__mdr.loadText(text, name + '.md');
    return { len: text.length, loadMs: +(performance.now() - a).toFixed(0) };
  }, { name, src: GENS[name].toString() });
  const s = await settle(page, opts.settleMs ?? 90000);
  const settleMs = Date.now() - t0;
  C.check(`${tag} settles (${gen.len} chars)`, s.ok, s);
  C.measure(`${tag} loadText main ms / to-idle ms`, `${gen.loadMs} / ${settleMs}`, opts.idleTarget ?? '< 20000', settleMs < (opts.idleMax ?? 20000));
  const sc = await structureCheck(page);
  C.check(`${tag} structure tiles`, sc.problems.length === 0, sc);
  C.check(`${tag} no .md-error blocks`, sc.errors === 0, sc);
  // Type at a fixed place and measure latency
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(1, 0); window.__lat.length = 0; });
  await page.keyboard.type('ZZ', { delay: 0 });
  const lat = await latencyStats(page);
  C.measure(`${tag} input latency max (ms)`, lat.max ?? 0, '< 100', (lat.max ?? 0) < 100);
  const s2 = await settle(page, opts.settleMs ?? 90000);
  C.check(`${tag} settles after typing`, s2.ok, s2);
  const sc2 = await structureCheck(page);
  C.check(`${tag} structure tiles after typing`, sc2.problems.length === 0, sc2);
  const lt = await longTasks(page);
  C.measure(`${tag} long tasks count/max (ms)`, `${lt.count}/${lt.max}`, 'max < 200', lt.max < 200);
  C.check(`${tag} no console/page errors, no restart`, log.consoleErrors.length === eb && log.pageErrors.length === pb && log.restarts === rb,
    { c: log.consoleErrors.slice(eb, eb + 3), p: log.pageErrors.slice(pb, pb + 3), r: log.restarts - rb });
  return sc2;
}

try {
  await open(page, '?mode=split');
  await settle(page);

  for (const n of ['unclosedPre', 'unclosedComment', 'unclosedMath', 'dollarStorm', 'nested500', 'quote200', 'wideTable', 'noTrailingNl']) {
    await scenario(n);
  }
  // 6 MB single line separately with a bigger budget
  await scenario('line6MB', { idleMax: 30000, settleMs: 120000 });

  // ---- typing at EOF of a document without a trailing newline
  await page.evaluate(async () => { await window.__mdr.loadText('# A\n\npara one\n\n- a\n- b\n\nlast line without newline', 'nl.md'); });
  await settle(page);
  await page.evaluate(() => { const e = window.__mdr.app.editor; e.gotoLine(e.lineCount(), 999); });
  await page.keyboard.type(' TAIL', { delay: 0 });
  let s = await settle(page);
  C.check('EOF typing settles', s.ok, s);
  const txt = await page.evaluate(() => window.__mdr.app.editor.getText());
  C.check('EOF typing lands at the very end', txt.endsWith('newline TAIL'), JSON.stringify(txt.slice(-30)));
  const incr = await previewSnapshot(page);
  await loadText(page, txt, 'fresh.md');
  await settle(page);
  const fresh = await previewSnapshot(page);
  C.check('EOF typing: incremental preview === fresh render', diffSnapshots(incr, fresh).length === 0, diffSnapshots(incr, fresh));

  // ---- reference-definition churn: 3000 paragraphs that use [ref]
  await page.evaluate(async () => {
    let t = '[ref]: https://example.com/one "One"\n\n';
    for (let i = 0; i < 3000; i++) t += `Paragraph ${i} links to [ref] and more text.\n\n`;
    await window.__mdr.loadText(t, 'refs.md');
  });
  s = await settle(page, 90000);
  C.check('[refs] settles', s.ok, s);
  let href = await page.evaluate(async () => {
    await window.__mdr.app.preview.mountAll();
    const a = document.querySelectorAll('.md-block a[href]');
    return a.length ? a[a.length - 1].getAttribute('href') : null;
  });
  C.check('[refs] links resolve to the definition', href === 'https://example.com/one', href);
  // now edit the definition
  await page.evaluate(() => { window.__mdr.app.editor.view.dispatch({ changes: { from: 0, to: 36, insert: '[ref]: https://example.com/TWO "Two"' } }); });
  await page.evaluate(() => { window.__longTasks.length = 0; });
  s = await settle(page, 90000);
  C.check('[refs] settles after editing the definition', s.ok, s);
  const lt = await longTasks(page);
  C.measure('[refs] long tasks after ref edit (count/max ms)', `${lt.count}/${lt.max}`, 'max < 200', lt.max < 200);
  href = await page.evaluate(async () => {
    await window.__mdr.app.preview.mountAll();
    const a = document.querySelectorAll('.md-block a[href]');
    return a.length ? a[a.length - 1].getAttribute('href') : null;
  });
  C.check('[refs] every block re-rendered with the new definition', href === 'https://example.com/TWO', href);
  const sc = await structureCheck(page);
  C.check('[refs] structure tiles after ref edit', sc.problems.length === 0, sc);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
} finally {
  report('s21 pathological structures', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
