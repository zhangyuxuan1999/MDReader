// s32 — IME composition (the primary input method for the zh-CN target audience): drive real
// composition events through CDP (Input.imeSetComposition + Input.insertText) and verify the worker
// mirror / preview stay in sync, no edits are lost, and latency stays sane.
// Run: node bench/verify/s32_ime_composition.mjs
import { launch, open, settle, structureCheck, previewSnapshot, diffSnapshots, loadText, latencyStats, longTasks, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
try {
  await open(page, '?mode=split');
  await settle(page, 60000);
  await page.evaluate(async () => { await window.__mdr.loadText('# 标题\n\n第一段。\n\n- 列表项\n\n```js\nconst a = 1;\n```\n\n结尾段落。\n', 'ime.md'); });
  let s = await settle(page, 60000);
  C.check('base doc settles', s.ok, s);
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(3, 0); window.__mdr.app.editor.focus(); });

  const cdp = await page.context().newCDPSession(page);
  // One "word" of composition: pinyin buffer grows, then commits a CJK string.
  async function composeWord(pinyin, commit) {
    for (let i = 1; i <= pinyin.length; i++) {
      await cdp.send('Input.imeSetComposition', { text: pinyin.slice(0, i), selectionStart: i, selectionEnd: i });
      await sleep(8);
    }
    await cdp.send('Input.insertText', { text: commit });
    await sleep(8);
  }

  await page.evaluate(() => { window.__lat.length = 0; window.__longTasks.length = 0; });
  const words = [['ni', '你'], ['hao', '好'], ['shijie', '世界'], ['biaoti', '标题'], ['duanluo', '段落'], ['ceshi', '测试'], ['zhongwen', '中文'], ['shuru', '输入'], ['fa', '法'], ['wenben', '文本']];
  const t0 = Date.now();
  for (let r = 0; r < 6; r++) for (const [p, c] of words) await composeWord(p, c);
  const imeMs = Date.now() - t0;
  const expected = words.map(([, c]) => c).join('').repeat(6);
  C.measure('60 IME compositions wall (ms)', imeMs, 'informational', true);
  const lt = await longTasks(page);
  C.measure('long tasks during IME input (count/max ms)', `${lt.count}/${lt.max}`, 'max < 100', lt.max < 100);

  const txt = await page.evaluate(() => window.__mdr.app.editor.getText());
  const line3 = txt.split('\n')[2];
  C.check('IME commits landed in the editor, in order, nothing lost', line3 === expected + '第一段。', { got: line3.slice(0, 80), expected: (expected + '第一段。').slice(0, 80), gotLen: line3.length, expLen: expected.length + 5 });
  C.check('no dangling composition text left in the document', !/[a-z]{2,}/.test(line3), line3.slice(0, 120));

  s = await settle(page, 90000);
  C.check('worker settles after IME input', s.ok, s);
  let sc = await structureCheck(page);
  C.check('structure tiles after IME input', sc.problems.length === 0, sc);
  const incr = await previewSnapshot(page);
  await loadText(page, txt, 'fresh-ime.md');
  await settle(page, 90000);
  const fresh = await previewSnapshot(page);
  C.check('preview after IME input === fresh render of the same text', diffSnapshots(incr, fresh).length === 0, diffSnapshots(incr, fresh));

  // ---- composition that is cancelled (Escape-like: empty composition after a non-empty one)
  await page.evaluate(async () => { await window.__mdr.loadText('# 取消测试\n\nABC\n', 'cancel.md'); });
  await settle(page, 60000);
  await page.evaluate(() => { const e = window.__mdr.app.editor; e.gotoLine(3, 3); e.focus(); });
  await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
  await sleep(60);
  const during = await page.evaluate(() => window.__mdr.app.editor.getText());
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await sleep(60);
  await cdp.send('Input.insertText', { text: '' });
  await sleep(200);
  const afterCancel = await page.evaluate(() => window.__mdr.app.editor.getText());
  C.check('a cancelled composition leaves the document unchanged', afterCancel === '# 取消测试\n\nABC\n', { during: JSON.stringify(during), after: JSON.stringify(afterCancel) });
  s = await settle(page, 60000);
  C.check('settles after a cancelled composition', s.ok, s);
  sc = await structureCheck(page);
  C.check('structure tiles after a cancelled composition', sc.problems.length === 0, sc);

  // ---- IME inside a fenced code block + inside a long line
  await page.evaluate(async () => { await window.__mdr.loadText('```js\nconst s = "";\n```\n\n' + '长'.repeat(100000) + '\n', 'ime2.md'); });
  await settle(page, 90000);
  await page.evaluate(() => { const e = window.__mdr.app.editor; e.gotoLine(2, 12); e.focus(); window.__lat.length = 0; });
  for (const [p, c] of [['zhong', '中'], ['wen', '文'], ['zhu', '注'], ['shi', '释']]) await composeWord(p, c);
  const lat = await latencyStats(page);
  C.measure('IME latency max inside a fence next to a 100k-char line (ms)', lat.max ?? 0, '< 100', (lat.max ?? 0) < 100);
  s = await settle(page, 90000);
  C.check('settles after IME inside a fence', s.ok, s);
  const fenceLine = await page.evaluate(() => window.__mdr.app.editor.getText().split('\n')[1]);
  C.check('IME text landed inside the fence line', fenceLine.includes('中文注释'), fenceLine);
  sc = await structureCheck(page);
  C.check('structure tiles after IME inside a fence', sc.problems.length === 0, sc);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
} finally {
  report('s32 IME composition', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
