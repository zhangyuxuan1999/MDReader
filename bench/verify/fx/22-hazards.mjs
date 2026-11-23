import { launch, open, loadText, step, expect, finish, sleep, getFailures, focusEditor, getText, lineText, placeCursor, cursor } from '../ux/lib.mjs';
const { browser, page, errors } = await launch();
page.setDefaultTimeout(10000);
await open(page, '?mode=split');

await step('heading command on a list line produces sane markdown', async () => {
  await loadText(page, '- 项目一\n', 'h.md');
  await focusEditor(page); await placeCursor(page, 1, 4);
  await page.keyboard.press('Meta+1');
  const l = await lineText(page, 1);
  const rendered = await page.evaluate(async () => { window.__mdr.app.registry.run('view.mountAll'); await new Promise(r => setTimeout(r, 700));
    return document.querySelector('.mdr-preview .md-block')?.innerHTML?.slice(0, 120); });
  await loadText(page, '> 引用一\n', 'h2.md');
  await focusEditor(page); await placeCursor(page, 1, 3);
  await page.keyboard.press('Meta+2');
  const q = await lineText(page, 1);
  expect(!/^#\s*-\s/.test(l) && !/^#+\s*>/.test(q),
    `Mod-1 on "- 项目一" produced ${JSON.stringify(l)} (preview: ${JSON.stringify(rendered)}) and Mod-2 on "> 引用一" produced ${JSON.stringify(q)} — the heading prefix is stacked in front of the existing block marker instead of replacing/ respecting it`);
  return JSON.stringify({ l, q, rendered });
});
await step('Mod-Shift-x on a plain line', async () => {
  await loadText(page, '普通一行\n', 'h.md');
  await focusEditor(page); await placeCursor(page, 1, 2);
  await page.keyboard.press('Meta+Shift+x');
  await sleep(200);
  return JSON.stringify(await lineText(page, 1));
});
await step('Mod-Shift-x on a plain list item (no checkbox yet)', async () => {
  await loadText(page, '- 甲\n', 'h.md');
  await focusEditor(page); await placeCursor(page, 1, 3);
  await page.keyboard.press('Meta+Shift+x');
  await sleep(200);
  return JSON.stringify(await lineText(page, 1));
});

// ---- stale-preview hazard: click a checkbox while the preview has not yet caught up ----
await step('checkbox click immediately after inserting lines above toggles the RIGHT line', async () => {
  await loadText(page, '标题行\n\n- [ ] 甲\n- [ ] 乙\n- [ ] 丙\n', 's.md');
  await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
  await sleep(800);
  // insert 3 lines at the very top, then click the 2nd checkbox as fast as possible
  await page.evaluate(() => {
    const v = window.__mdr.app.editor.view;
    v.dispatch({ changes: { from: 0, insert: '新行一\n新行二\n新行三\n' } });
  });
  const boxes = page.locator('.mdr-preview input[type=checkbox]');
  await boxes.nth(1).click({ force: true });
  await sleep(1200);
  const lines = (await getText(page)).split('\n');
  const checked = lines.map((l, i) => ({ i: i + 1, l })).filter(x => x.l.includes('[x]'));
  expect(checked.length === 1, `expected exactly one checked item, got ${JSON.stringify(checked)}`);
  expect(checked[0].l.includes('乙'), `wrong item toggled: ${JSON.stringify(checked)} — full doc ${JSON.stringify(lines)}`);
  return JSON.stringify(checked);
});
await step('Alt+click immediately after an edit above lands on the right line', async () => {
  await loadText(page, 'A\n\nB\n\nC 目标段落\n\nD\n', 's.md');
  await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
  await sleep(800);
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: 0, insert: '新\n\n' } }); });
  await sleep(50);
  const t = await page.evaluate(() => { const e = [...document.querySelectorAll('.mdr-preview p')].find(p => p.textContent.includes('目标段落')); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, h: r.height }; });
  await page.keyboard.down('Alt'); await page.mouse.click(t.x + 6, t.y + t.h / 2); await page.keyboard.up('Alt');
  await sleep(800);
  const c = await cursor(page);
  const line = await lineText(page, c.line);
  expect(line.includes('目标段落'), `cursor landed on line ${c.line} = ${JSON.stringify(line)} (expected the 目标段落 line, now line 7)`);
  return `line ${c.line}: ${JSON.stringify(line)}`;
});

// ---- gutter drag to the extremes ----
await step('gutter cannot collapse a pane to an unusable width', async () => {
  await loadText(page, '# g\n\n内容\n', 'g.md');
  const drag = async (dx) => {
    const g = await page.locator('.mdr-gutter').boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 + dx, g.y + g.height / 2, { steps: 15 });
    await page.mouse.up();
    await sleep(400);
    return page.evaluate(() => ({ ed: Math.round(document.querySelector('.mdr-pane--editor').getBoundingClientRect().width),
      pv: Math.round(document.querySelector('.mdr-pane--preview').getBoundingClientRect().width),
      split: localStorage.getItem('mdr.split') }));
  };
  const left = await drag(-2000);
  const right = await drag(+2000);
  expect(left.ed >= 80, `dragging fully left leaves the editor ${left.ed}px wide (${JSON.stringify(left)}) — unusable and the gutter may be unreachable`);
  expect(right.pv >= 80, `dragging fully right leaves the preview ${right.pv}px wide (${JSON.stringify(right)})`);
  // and it must be recoverable
  const back = await drag(-400);
  expect(back.pv > right.pv, `could not drag back: ${JSON.stringify(right)} -> ${JSON.stringify(back)}`);
  return `left=${JSON.stringify(left)} right=${JSON.stringify(right)} back=${JSON.stringify(back)}`;
});
await step('double-clicking the gutter (or dblclick) does not break layout', async () => {
  const g = await page.locator('.mdr-gutter').boundingBox();
  await page.mouse.dblclick(g.x + g.width / 2, g.y + g.height / 2);
  await sleep(400);
  const r = await page.evaluate(() => ({ ed: Math.round(document.querySelector('.mdr-pane--editor').getBoundingClientRect().width),
    pv: Math.round(document.querySelector('.mdr-pane--preview').getBoundingClientRect().width) }));
  expect(r.ed > 40 && r.pv > 40, JSON.stringify(r));
  return JSON.stringify(r);
});
finish('22-hazards', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
