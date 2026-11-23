// bench/verify/v2-app-session.mjs — verify-app (0.2.0 stage 2a), JOB 1: an in-preview editing session against
// the rest of the app. Needs the candidate renderer already running (npx vite --port 5283 --strictPort).
// Run: MDR_PORT=5283 node bench/verify/v2-app-session.mjs [filter]
// Writes nothing into the tree. Global timeout 100 s.
import { openBrowser, check, note, step, assert, eq, finish, sleep } from './v2-app-lib.mjs';

await (await import('./v2-app-lib.mjs')).ensureServer();
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000);
const only = process.argv[2] ?? '';
const B = await openBrowser();
// web legacy save path (no File System Access API): ⌘S downloads
await B.context.addInitScript(() => { try { delete window.showSaveFilePicker; delete window.showOpenFilePicker; delete Window.prototype.showSaveFilePicker; delete Window.prototype.showOpenFilePicker; } catch { /* */ } });
const { page } = B;
const L = (doc, needle) => doc.split('\n').findIndex((l) => l.includes(needle)) + 1;
const t = (name, fn) => (only && !name.includes(only) ? Promise.resolve() : step(name, fn));
const DOC = ['# 标题', '', '甲段落文字。', '', '- [ ] 任务一', '- [ ] 任务二', '- [ ] 任务三', '', '乙段落文字。', ''].join('\n');

async function start(doc, needle) {
  await B.loadDoc(doc);
  await B.clickLine(L(doc, needle), 'first', needle.slice(0, 2));
  await B.caretAt(needle);
  assert(await B.editing(), 'no session');
}
async function selectAllInBlock() {
  await page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const r = document.createRange(); r.selectNodeContents(el.querySelector('p') ?? el);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
}
const boxPoint = (i) => page.evaluate((i) => {
  const b = document.querySelectorAll('.mdr-preview input[type="checkbox"]')[i];
  const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, i);

try {
  await B.boot('mode=split');

  for (const gap of [0, 40, 120]) {
    await t(`A1 emptied paragraph (pending deletion) then click checkbox 任务二 (down/up gap ${gap} ms) → 任务二 toggled, nothing else`, async () => {
      await start(DOC, '甲段落文字。');
      await selectAllInBlock();
      await page.keyboard.press('Backspace');
      await sleep(80);
      const p = await boxPoint(1);
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      if (gap) await sleep(gap);
      await page.mouse.up();
      await B.settle(400);
      const s = await B.source();
      const want = ['# 标题', '', '- [ ] 任务一', '- [x] 任务二', '- [ ] 任务三', '', '乙段落文字。', ''].join('\n');
      eq(s, want, 'source');
    });
  }

  for (const gap of [0, 40, 120]) {
    await t(`A1b paste two lines (hard break) into 甲 then click checkbox 任务二 (gap ${gap} ms)`, async () => {
      await start(DOC, '甲段落文字。');
      await page.evaluate(() => {
        const dt = new DataTransfer(); dt.setData('text/plain', 'X\nY\nZ');
        document.querySelector('.mdr-preview .is-editing').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      // no wait: the write is rAF-coalesced; the click's mousedown ends the session synchronously
      const p = await boxPoint(1);
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      if (gap) await sleep(gap);
      await page.mouse.up();
      await B.settle(400);
      const s = await B.source();
      const lines = s.split('\n');
      const t2 = lines.find((l) => l.includes('任务二'));
      const others = lines.filter((l) => /任务[一三]/.test(l));
      assert(t2 === '- [x] 任务二' && others.every((l) => l.startsWith('- [ ]')), `tasks: ${JSON.stringify(lines.filter((l) => l.includes('任务')))} | src=${JSON.stringify(s)}`);
    });
  }

  await t('A2 toolbar heading button (editor command) during a session → typed text kept, heading applied to the edited block', async () => {
    await start(DOC, '乙段落文字。');
    await page.keyboard.type('ABC');
    const btns = await page.evaluate(() => [...document.querySelectorAll('.mdr-toolbar button')].map((b) => b.dataset.cmd));
    const cmd = btns.find((c) => c && /heading|h2|edit\.h/.test(c));
    if (!cmd) return `no heading button (buttons: ${btns.join(',')})`;
    await page.click(`.mdr-toolbar button[data-cmd="${cmd}"]`);
    await B.settle(300);
    const s = await B.source();
    assert(s.includes('乙段落文字。ABC'), `typed text: ${JSON.stringify(s)}`);
    const line = s.split('\n').find((l) => l.includes('乙段落'));
    return `${cmd}: ${line}`;
  });

  await t('A3 window resize + splitter while typing in a session → text continues in the same block', async () => {
    await start(DOC, '乙段落文字。');
    await page.keyboard.type('一');
    await page.setViewportSize({ width: 900, height: 700 });
    await sleep(150);
    await page.keyboard.type('二');
    await page.setViewportSize({ width: 1400, height: 900 });
    await sleep(150);
    await page.keyboard.type('三');
    await B.settle(300);
    const s = await B.source();
    assert(s.includes('乙段落文字。一二三'), JSON.stringify(s));
    eq(!!(await B.editing()), true, 'session');
  });

  await t('A4 scroll the preview far away (held block evicted?) and type → text still in its block', async () => {
    const big = Array.from({ length: 400 }, (_, i) => `段落 ${i} 内容内容内容。`).join('\n\n') + '\n';
    await B.loadDoc(big);
    await B.clickLine(1, 'first', '段落');
    await B.caretAt('段落 0 内容内容内容。');
    await page.keyboard.type('A');
    await page.evaluate(() => { const p = window.__mdr.app.preview; p.el.dispatchEvent(new WheelEvent('wheel', { bubbles: true })); p.el.scrollTop = p.el.scrollHeight; });
    await sleep(600);
    await page.keyboard.type('B');
    await B.settle(400);
    const s = await B.source();
    eq(s.split('\n')[0], '段落 0 内容内容内容。AB', 'line 1');
    eq(s.length, big.length + 2, 'length');
  });

  await t('A5 theme toggle via toolbar + TOC toggle + palette open/close during a session → text intact', async () => {
    await start(DOC, '甲段落文字。');
    await page.keyboard.type('x');
    await page.keyboard.press('ControlOrMeta+Shift+L');
    await page.keyboard.type('y');
    await page.keyboard.press('ControlOrMeta+Shift+O');
    await page.keyboard.type('z');
    await B.settle(300);
    const s = await B.source();
    assert(s.includes('甲段落文字。xyz'), JSON.stringify(s.split('\n')[2]));
  });

  await t('A6 export HTML during a session: download has no contenteditable / capture / ZWSP / hint', async () => {
    await start(DOC, '甲段落文字。');
    await page.keyboard.type('导出');
    await page.keyboard.press('ControlOrMeta+e');   // open inline code with a collapsed caret (ZWSP in the DOM)
    await page.keyboard.type('code');
    const dl = page.waitForEvent('download', { timeout: 8000 });
    await page.evaluate(() => window.__mdr.app.registry.run('file.exportHtml'));
    const d = await dl;
    const path = await d.path();
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(path, 'utf8').replace(/<style[\s\S]*?<\/style>/g, '');
    const bad = ['contenteditable', 'mdr-preview__edit', 'is-editing', '​', 'data-mdr-o'].filter((x) => html.includes(x));
    assert(bad.length === 0, `export contains ${bad.join(', ')}`);
    assert(html.includes('导出<code>code</code>') || html.includes('导出'), 'typed text missing from export');
    return html.match(/甲段落[^<]*(<code>[^<]*<\/code>)?/)?.[0] ?? '';
  });

  await t('A7 Cmd-S (legacy download) with pending text typed 0 ms before: file has it; dirty marker clears', async () => {
    await start(DOC, '乙段落文字。');
    const dl = page.waitForEvent('download', { timeout: 8000 });
    await page.keyboard.type('存');
    await page.keyboard.press('ControlOrMeta+s');
    const d = await dl;
    const { readFileSync } = await import('node:fs');
    const txt = readFileSync(await d.path(), 'utf8');
    assert(txt.includes('乙段落文字。存'), JSON.stringify(txt));
    await B.settle(200);
    const title = await page.evaluate(() => document.title);
    return `title=${title}`;
  });

  await t('A8 Cmd-Z with focus in the palette input / TOC filter does not undo the document', async () => {
    await start(DOC, '乙段落文字。');
    await page.keyboard.type('撤');
    await B.esc();
    const before = await B.source();
    await page.keyboard.press('ControlOrMeta+Shift+P');
    await sleep(200);
    await page.keyboard.type('ab');
    await page.keyboard.press('ControlOrMeta+z');
    await sleep(200);
    const pal = await page.evaluate(() => document.activeElement?.value ?? null);
    const after = await B.source();
    await page.keyboard.press('Escape');
    eq(after, before, 'document after ⌘Z in palette');
    return `palette input after ⌘Z: ${JSON.stringify(pal)}`;
  });
} finally {
  finish();
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  if (B.consoleErrors.length) console.log('CONSOLE', B.consoleErrors.slice(0, 5).join('\n'));
}
