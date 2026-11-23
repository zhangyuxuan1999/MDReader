// s13 — follow-ups: (a) replace-all leaves N blocks .is-stale after idle — are any of them MOUNTED
// (visible outdated content)? (b) does the「大文件」info toast auto-dismiss (4 s)? (c) CPU-profile
// attribution of the long task when loading 50k headings; (d) same for a 6 MB paste; (e) do the
// wrappers appear after undo of select-all+delete (s03 saw domBlocks=0 right after idle)?
// Run: node bench/verify/s13_followups.mjs
import { launch, open, settle, structureCheck, longTasks, toasts, makeChecker, report, sleep, fetchTestDoc, loadText } from './_lib.mjs';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const { browser, page, log } = await launch();
const C = makeChecker();
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 250 });

async function profiled(fn) {
  await cdp.send('Profiler.start');
  await fn();
  const { profile } = await cdp.send('Profiler.stop');
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const self = new Map();
  const incl = new Map();
  const key = (n) => `${n.callFrame.functionName || '(anon)'} ${(n.callFrame.url || '').replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '')}:${n.callFrame.lineNumber}`;
  const samples = profile.samples, deltas = profile.timeDeltas;
  for (let i = 0; i < samples.length; i++) {
    const dt = (deltas[i] || 0) / 1000;
    let id = samples[i];
    const n = byId.get(id);
    const k = key(n);
    self.set(k, (self.get(k) || 0) + dt);
    const seen = new Set();
    while (id !== undefined) {
      const kk = key(byId.get(id));
      if (!seen.has(kk)) { seen.add(kk); incl.set(kk, (incl.get(kk) || 0) + dt); }
      id = parent.get(id);
    }
  }
  const top = (m, filter, n = 10) => Array.from(m.entries()).filter(([k]) => filter(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(0)}ms ${k}`);
  return { selfTop: top(self, () => true), inclApp: top(incl, (k) => /src\//.test(k) && !/\(root\)|\(program\)/.test(k), 14) };
}

try {
  await open(page, '?mode=split');
  await settle(page, 30000);

  // (a) replace-all stale blocks
  let doc = '';
  for (let i = 0; i < 1000; i++) doc += `xx Title ${i}\n\nParagraph ${i} with some text and a foo token.\n\n- item ${i}\n\n`;
  await loadText(page, doc, 'replace.md');
  await settle(page, 60000);
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(3000, 0); window.__mdr.app.editor.focus(); });
  await sleep(500);
  await page.keyboard.press(`${MOD}+f`);
  const panel = page.locator('.cm-search');
  await panel.waitFor({ timeout: 5000 });
  await panel.locator('input[name=search]').fill('xx ');
  await panel.locator('input[name=replace]').fill('# ');
  await panel.locator('button[name=replaceAll]').click();
  let s = await settle(page, 60000);
  await sleep(1000);
  const st = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('.md-block'));
    const el = window.__mdr.app.preview.el; const r = el.getBoundingClientRect();
    const ms = all.filter((b) => b.classList.contains('is-stale') && !b.classList.contains('is-pending'));
    const vis = ms.filter((b) => { const br = b.getBoundingClientRect(); return br.bottom > r.top && br.top < r.bottom; });
    return { stale: all.filter((b) => b.classList.contains('is-stale')).length, mountedStale: ms.length, visibleStale: vis.length, sample: ms.slice(0, 3).map((b) => ({ id: b.dataset.id, text: b.textContent.slice(0, 40) })) };
  });
  C.check('(a) replace-all + idle + 1 s: no mounted block left .is-stale', st.mountedStale === 0, st);
  C.check('(a) replace-all + idle + 1 s: no visible block left .is-stale', st.visibleStale === 0, st);
  await page.keyboard.press('Escape');

  // (b) toast auto-dismiss
  await page.evaluate(async () => { await window.__mdr.loadText('x'.repeat(1000000), 'line.md'); });
  await sleep(300);
  let t = await toasts(page);
  C.check('(b) large-doc toast shown on a 1 MB line', t.some((x) => x.includes('大文件')), t);
  await sleep(5000);
  t = await toasts(page);
  C.check('(b) large-doc toast auto-dismissed after 5 s', !t.some((x) => x.includes('大文件')), t);
  await settle(page, 60000);

  // (c) 50k headings load: profile
  await page.evaluate(() => { window.__longTasks.length = 0; });
  const prof = await profiled(async () => {
    await page.evaluate(async () => { let t = ''; for (let i = 0; i < 50000; i++) t += `${'#'.repeat(1 + (i % 6))} Heading ${i}\n`; await window.__mdr.loadText(t, 'h.md'); });
    await settle(page, 60000);
    await sleep(800);
  });
  let lt = await longTasks(page);
  C.measure('(c) 50k headings load: long tasks count / max ms', `${lt.count}/${lt.max}`, 'P4-like: longest < 120 ms', lt.max < 120);
  console.log('(c) self-time top:\n  ' + prof.selfTop.join('\n  '));
  console.log('(c) inclusive app functions:\n  ' + prof.inclApp.join('\n  '));

  // (d) 6 MB paste on medium.md: profile
  await page.evaluate(async (t) => { await window.__mdr.loadText(t, 'medium.md'); }, await fetchTestDoc('medium.md'));
  await settle(page, 60000);
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(10000, 0); window.__longTasks.length = 0; });
  const prof2 = await profiled(async () => {
    await page.evaluate(() => {
      const unit = '## Pasted heading\n\nA pasted paragraph with **bold**, `code`, 中文 and a [link](https://example.com).\n\n- one\n- two\n  - nested\n\n```ts\nexport const x: number = 42;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n';
      let text = ''; while (text.length < 6 * 1024 * 1024) text += unit;
      const view = window.__mdr.app.editor.view;
      view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.paste' });
    });
    await settle(page, 120000);
    await sleep(800);
  });
  lt = await longTasks(page);
  C.measure('(d) 6 MB paste: long tasks count / max ms', `${lt.count}/${lt.max}`, 'informational', true);
  console.log('(d) self-time top:\n  ' + prof2.selfTop.join('\n  '));
  console.log('(d) inclusive app functions:\n  ' + prof2.inclApp.join('\n  '));

  // (e) wrappers after undo of select-all + delete on medium.md
  await page.evaluate(async (t) => { await window.__mdr.loadText(t, 'medium.md'); }, await fetchTestDoc('medium.md'));
  await settle(page, 60000);
  await page.evaluate(() => { window.__mdr.app.editor.focus(); });
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press('Delete');
  await settle(page, 30000);
  await page.keyboard.press(`${MOD}+z`);
  s = await settle(page, 60000);
  const sc0 = await structureCheck(page);
  await sleep(1000);
  const sc1 = await structureCheck(page);
  // Dormant chunks hold no wrappers (P13 fix): the bound, not equality, is the invariant.
  C.check('(e) after undo: wrappers created within 1 s of idle', sc1.domBlocks > 0 && sc1.domBlocks <= sc1.blocks, { atIdle: { blocks: sc0.blocks, dom: sc0.domBlocks }, after1s: { blocks: sc1.blocks, dom: sc1.domBlocks } });
  const vp = await page.evaluate(() => { const el = window.__mdr.app.preview.el; const r = el.getBoundingClientRect(); let p = 0, n = 0; for (const b of el.querySelectorAll('.md-block')) { const br = b.getBoundingClientRect(); if (br.bottom < r.top || br.top > r.bottom) continue; n++; if (b.classList.contains('is-pending')) p++; } return { pending: p, total: n, scrollTop: el.scrollTop }; });
  C.check('(e) after undo: visible blocks mounted', vp.total > 0 && vp.pending === 0, vp);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s13 follow-ups', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
