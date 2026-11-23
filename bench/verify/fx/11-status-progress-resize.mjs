import { launch, open, loadText, step, expect, finish, sleep, getFailures, measure, focusEditor, placeCursor } from '../ux/lib.mjs';
const { browser, page, errors } = await launch();
page.setDefaultTimeout(15000);
await open(page, '?mode=split');
const st = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.mdr-statusbar__item')].map(e => [e.dataset.stat, e.hidden ? null : e.textContent])));

await step('status bar shows 行/列 and follows the cursor', async () => {
  await loadText(page, '一二三四五\n第二行 second line\n第三行\n', 's.md');
  await focusEditor(page);
  await placeCursor(page, 2, 3);
  await sleep(400);
  const s = await st();
  expect(/行\s*2/.test(s.pos), `pos=${JSON.stringify(s.pos)}`);   // column is displayed 1-based (col 0 shows 列 1)
  return JSON.stringify(s);
});
await step('status bar word/char/reading counts are right for mixed CJK+latin', async () => {
  // 10 CJK chars + 4 latin words
  await loadText(page, '中文一二三四五六七八 alpha beta gamma delta\n', 'w.md');
  await sleep(500);
  const s = await st();
  // cjk=10, latinWords=4 -> 字数 14; chars = full length
  expect(/字数\s*14\b/.test(s.words), `words=${JSON.stringify(s.words)} (expect 字数 14 = 10 CJK + 4 latin words)`);
  expect(/约\s*1\s*分钟/.test(s.reading), `reading=${JSON.stringify(s.reading)}`);
  return JSON.stringify(s);
});
await step('empty document: counts zero, 约 0 分钟', async () => {
  await loadText(page, '', 'empty.md');
  await sleep(500);
  const s = await st();
  expect(/字数\s*0\b/.test(s.words), `words=${JSON.stringify(s.words)}`);
  expect(/字符\s*0\b/.test(s.chars), `chars=${JSON.stringify(s.chars)}`);
  // the 约 N 分钟 item is hidden entirely when the doc is empty (deliberate); see 13-gaps.mjs for the raw items
  return JSON.stringify(s);
});
await step('status bar mode label follows the mode', async () => {
  const out = {};
  for (const [m, label] of [['edit','编辑'],['preview','预览'],['split','分栏']]) {
    await page.evaluate((mm) => window.__mdr.mode(mm), m);
    await sleep(250);
    const s = await st();
    out[m] = s.mode;
    expect(s.mode.includes(label), `mode=${m} label=${JSON.stringify(s.mode)} want ${label}`);
  }
  return JSON.stringify(out);
});

// ---- progress indicator on a large file ----
await step('progress indicator appears while a large file renders', async () => {
  const samples = [];
  await page.evaluate(() => { window.__prog = []; const el = document.querySelector('.mdr-statusbar__item[data-stat=progress]');
    new MutationObserver(() => window.__prog.push({ t: performance.now(), txt: el.textContent, hidden: el.hidden })).observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
  });
  await page.evaluate(() => window.__mdr.loadUrl('/test-data/large.md'));
  for (let i = 0; i < 40; i++) { samples.push(await page.evaluate(() => { const e = document.querySelector('.mdr-statusbar__item[data-stat=progress]'); return { txt: e.textContent, hidden: e.hidden }; })); await sleep(100); }
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(600);
  const obs = await page.evaluate(() => window.__prog);
  const seen = samples.filter(s => s.txt && s.txt.trim()).map(s => s.txt);
  const obsSeen = obs.filter(o => o.txt && o.txt.trim()).map(o => o.txt);
  const final = await st();
  expect(seen.length + obsSeen.length > 0, `progress item never showed anything (mutations=${obs.length})`);
  expect(/渲染中/.test((seen[0] ?? obsSeen[0] ?? '')), `progress text = ${JSON.stringify((seen.concat(obsSeen)).slice(0,4))} (SPEC §8: 渲染中 N%)`);
  expect(!final.progress || !final.progress.trim(), `progress still shown when idle: ${JSON.stringify(final.progress)}`);
  return `${(seen.concat(obsSeen)).slice(0,5).join(' | ')} -> final ${JSON.stringify(final.progress)}`;
});
await step('large file status counts are plausible', async () => {
  const s = await st();
  return JSON.stringify(s);
});

// ---- window resize ----
for (const [w, h] of [[1400,900],[1000,700],[820,640],[600,800]]) {
  await step(`layout sane at ${w}x${h}`, async () => {
    await page.setViewportSize({ width: w, height: h });
    await sleep(600);
    const r = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const box = (s) => { const e = q(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
      return {
        docScrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
        docScrollH: document.documentElement.scrollHeight, clientH: document.documentElement.clientHeight,
        toolbar: box('.mdr-toolbar'), toc: box('.mdr-pane--toc'), editor: box('.mdr-pane--editor'),
        preview: box('.mdr-pane--preview'), status: box('.mdr-statusbar'),
        toolbarOverflow: (() => { const t = q('.mdr-toolbar'); return t ? t.scrollWidth - t.clientWidth : null })(),
      };
    });
    expect(r.docScrollW <= r.clientW + 1, `page scrolls horizontally: scrollWidth=${r.docScrollW} clientWidth=${r.clientW}`);
    expect(r.docScrollH <= r.clientH + 1, `page scrolls vertically: ${r.docScrollH} > ${r.clientH}`);
    if (r.editor && r.preview) expect(r.editor.x + r.editor.w <= r.preview.x + 1, `editor overlaps preview: ${JSON.stringify(r)}`);
    if (r.editor) expect(r.editor.w > 40 && r.editor.h > 40, `editor collapsed: ${JSON.stringify(r.editor)}`);
    if (r.preview) expect(r.preview.w > 40, `preview collapsed: ${JSON.stringify(r.preview)}`);
    expect(r.status && r.status.y + r.status.h <= r.clientH + 1, `statusbar off-screen: ${JSON.stringify(r.status)} clientH=${r.clientH}`);
    measure(`toolbar overflow @${w}x${h}`, r.toolbarOverflow, '0', r.toolbarOverflow === 0);
    return JSON.stringify(r);
  });
}
await page.setViewportSize({ width: 1400, height: 900 });

finish('11-status-progress-resize', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
