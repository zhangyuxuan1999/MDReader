// bench/verify/v3-app-g.mjs — verify-app (0.2.0 stage 2c): r1 variations on the web build.
//   G14: a session-end write while the editor has the focus must keep the user's editor selection
//        (a range on another line, a caret inside the rewritten line, a double-click word, a line above).
//   G7 (app side): the close question (beforeunload), the stored draft and export see an emptied block's
//        deletion and text typed 0 ms ago.
//   G15: ⌘A in a session of other block kinds (list, code, table, emptied block); ⌘A ⌘A then Delete must
//        not touch the document; a drag out of the session block extends across blocks and copies.
// Needs a renderer on MDR_PORT (candidate: npx vite --port 5383 --strictPort). Writes nothing into the tree.
// Run: MDR_PORT=5383 node bench/verify/v3-app-g.mjs [case-prefix] [runs]
import { openBrowser, step, assert, finish, sleep, BASE } from './v2-app-lib.mjs';

await (await import('./v2-app-lib.mjs')).ensureServer();   // starts vite on MDR_PORT when nothing answers there (stopped at exit)
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const only = process.argv[2] ?? '';
const RUNS = Number(process.argv[3] ?? 1);
const t = (name, fn) => (only && !name.startsWith(only) ? Promise.resolve() : step(name, fn));
const B = await openBrowser();
const { page, context } = B;
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const DOC = ['# 标题', '', '甲段落文字。', '', '乙段落文字。', '', '丙段落文字一二三。', ''].join('\n');
const L = (doc, needle) => doc.split('\n').findIndex((l) => l.includes(needle)) + 1;
async function startIn(doc, needle) {
  await B.clickLine(L(doc, needle), 'first', needle.slice(0, 2));
  await B.caretAt(needle);
  assert(await B.editing(), 'no session');
}
const editorPoint = (line, col) => page.evaluate(({ line, col }) => {
  const v = window.__mdr.app.editor.view;
  const l = v.state.doc.line(line);
  const c = v.coordsAtPos(Math.min(l.to, l.from + col));
  return { x: c.left + 1, y: (c.top + c.bottom) / 2 };
}, { line, col });
const lineOf = (s, needle) => s.split('\n').find((l) => l.includes(needle));
async function compose(text) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  await sleep(120);
  return cdp;
}
const drafts = () => page.evaluate(async () => new Promise((res) => {
  const r = indexedDB.open('keyval-store');
  r.onsuccess = () => {
    const db = r.result; const out = {};
    try {
      const c = db.transaction('keyval', 'readonly').objectStore('keyval').openCursor();
      c.onsuccess = () => { const cur = c.result; if (!cur) { res(out); db.close(); return; } if (String(cur.key).startsWith('mdr.draft:')) out[String(cur.key).slice(10)] = String(cur.value?.text); cur.continue(); };
      c.onerror = () => res(out);
    } catch { res(out); }
  };
  r.onerror = () => res({});
}));
async function emptyEditing() {
  await page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const r = document.createRange(); r.selectNodeContents(el.querySelector('p') ?? el);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.keyboard.press('Backspace');
}

try {
  await B.boot('mode=split');
  for (let run = 1; run <= RUNS; run++) {
    await t(`G14a run ${run}: IME open in 乙, drag-select 丙段落 in the editor, type Q → "Q文字一二三。"`, async () => {
      await B.loadDoc(DOC);
      await startIn(DOC, '乙段落文字。');
      const cdp = await compose('ni');
      const a = await editorPoint(7, 0), b = await editorPoint(7, 3);
      await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up();
      await sleep(150);
      await page.keyboard.type('Q');
      await B.settle(300);
      await cdp.detach().catch(() => {});
      const s = await B.source();
      assert(lineOf(s, '文字一二三') === 'Q文字一二三。', `丙 line: ${JSON.stringify(s)}`);
      return `乙 line ${JSON.stringify(lineOf(s, '乙'))}`;
    });
    await t(`G14b run ${run}: IME open at the end of 乙, click in the editor inside 乙's own line after 乙段落, type Q`, async () => {
      await B.loadDoc(DOC);
      await startIn(DOC, '乙段落文字。');
      const cdp = await compose('ni');
      const a = await editorPoint(5, 3);
      await page.mouse.click(a.x, a.y);
      await sleep(150);
      await page.keyboard.type('Q');
      await B.settle(300);
      await cdp.detach().catch(() => {});
      const s = await B.source();
      const l = lineOf(s, '乙');
      assert(l === '乙段落Q文字。ni' || l === '乙段落Q文字。', `乙 line: ${JSON.stringify(s)}`);
      return JSON.stringify(l);
    });
    await t(`G14c run ${run}: IME open in 甲, double-click 标题 in the editor (word), type Q → "# Q"`, async () => {
      await B.loadDoc(DOC);
      await startIn(DOC, '甲段落文字。');
      const cdp = await compose('ni');
      const a = await editorPoint(1, 3);
      await page.mouse.dblclick(a.x, a.y);
      await sleep(150);
      await page.keyboard.type('Q');
      await B.settle(300);
      await cdp.detach().catch(() => {});
      const s = await B.source();
      assert(s.split('\n')[0] === '# Q', `line 1: ${JSON.stringify(s)}`);
      return `甲 line ${JSON.stringify(lineOf(s, '甲'))}`;
    });
    await t(`G14d run ${run}: emptied 乙 (deletion pending), click in the editor at the end of 丙, type Q`, async () => {
      await B.loadDoc(DOC);
      await startIn(DOC, '乙段落文字。');
      await emptyEditing();
      const line = (await B.source()).split('\n').findIndex((l) => l.includes('丙')) + 1;
      const a = await editorPoint(line, 99);
      await page.mouse.click(a.x, a.y);
      await sleep(150);
      await page.keyboard.type('Q');
      await B.settle(300);
      const s = await B.source();
      assert(s === '# 标题\n\n甲段落文字。\n\n丙段落文字一二三。Q\n', `source ${JSON.stringify(s)}`);
    });
  }

  await t('G7a emptied block, beforeunload at 0 ms on a clean doc → the page asks', async () => {
    await B.loadDoc(DOC, 'g7a.md');
    await startIn(DOC, '乙段落文字。');
    await emptyEditing();
    const r = await page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return { prevented: e.defaultPrevented, rv: e.returnValue };
    });
    const s = await B.source();
    assert(r.prevented || r.rv === false, `not asked: ${JSON.stringify(r)} src ${JSON.stringify(s)}`);
    return JSON.stringify(r);
  });
  await t('G7b typed X 0 ms ago, beforeunload on a clean doc → the page asks', async () => {
    await B.loadDoc(DOC, 'g7b.md');
    await startIn(DOC, '乙段落文字。');
    await page.keyboard.type('X');
    const r = await page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return { prevented: e.defaultPrevented, rv: e.returnValue };
    });
    assert(r.prevented || r.rv === false, `not asked: ${JSON.stringify(r)}`);
  });
  await t('G7c emptied block: the stored draft (after the debounce) has no 乙 and no extra blank line', async () => {
    await B.loadDoc(DOC, 'g7c.md');
    await startIn(DOC, '乙段落文字。');
    await emptyEditing();
    await sleep(1800);
    const d = await drafts();
    const mine = d['text:g7c.md'];
    assert(mine === '# 标题\n\n甲段落文字。\n\n丙段落文字一二三。\n', `draft ${JSON.stringify(d)}`);
    await page.keyboard.type('N');
    await sleep(1800);
    const d2 = (await drafts())['text:g7c.md'];
    assert(d2 === '# 标题\n\n甲段落文字。\n\nN\n\n丙段落文字一二三。\n', `draft after N ${JSON.stringify(d2)}`);
    await B.esc();
  });
  await t('G7d type E and export HTML at 0 ms: the export has E', async () => {
    await B.loadDoc(DOC, 'g7d.md');
    await startIn(DOC, '乙段落文字。');
    await page.keyboard.type('E');
    const dlP = page.waitForEvent('download', { timeout: 6000 }).catch(() => null);
    await page.evaluate(() => window.__mdr.app.registry.run('file.exportHtml'));
    const dl = await dlP;
    assert(dl, 'no download');
    const html = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
    assert(html.includes('乙段落文字。E'), 'E missing in export');
    assert(!/contenteditable|is-editing/.test(html.slice(html.indexOf('<body'))), 'session markup in export');
  });

  const selLen = () => page.evaluate(() => getSelection().toString().length);
  const LIST = ['# 标题', '', '- 项一', '- 项二', '- 项三', '', '```', 'code line', '```', '', '| a | b |', '|---|---|', '| 格一 | 格二 |', '', '尾段。', ''].join('\n');
  for (const [name, needle, want1] of [['list', '项二', '项一项二项三'], ['code', 'code line', 'codeline'], ['cell', '格一', null]]) {
    await t(`G15-${name}: ⌘A in a session selects the block, ⌘A again the whole preview, then Backspace changes nothing`, async () => {
      await B.loadDoc(LIST);
      await startIn(LIST, needle);
      await page.keyboard.press('Meta+a'); await sleep(120);
      const s1 = await page.evaluate(() => getSelection().toString().replace(/\s+/g, ''));
      const ed1 = !!(await B.editing());
      await page.keyboard.press('Meta+a'); await sleep(150);
      const n2 = await selLen();
      const all2 = await page.evaluate(() => { const x = getSelection().toString(); return x.includes('标题') && x.includes('尾段'); });
      const ed2 = !!(await B.editing());
      await page.keyboard.press('Backspace'); await sleep(100);
      await page.keyboard.type('Z'); await B.settle(300);
      const src = await B.source();
      if (want1) assert(s1 === want1, `first ⌘A selected ${JSON.stringify(s1)}`);
      assert(ed1, 'first ⌘A ended the session');
      assert(!ed2 && all2, `second ⌘A: len ${n2} session ${ed2} whole ${all2}`);
      assert(src === LIST, `document changed after ⌘A ⌘A Backspace Z: ${JSON.stringify(src)}`);
      return `first=${JSON.stringify(s1)} second len=${n2}`;
    });
  }
  const KINDS = [
    ['heading', '# 大标题文字\n\n尾段。\n', '大标题'],
    ['quote', '> 引用文字一\n> 引用文字二\n\n尾段。\n', '引用文字一'],
    ['code-lang', '```js\nlet a = 1;\n```\n\n尾段。\n', 'let'],
    ['code-plain', '```\nplain code\n```\n\n尾段。\n', 'plain'],
    ['code-indent', '    indented code\n\n尾段。\n', 'indented'],
    ['math', '$$\nx^2\n$$\n\n尾段。\n', null],
    ['task', '- [ ] 任务甲\n- [x] 任务乙\n\n尾段。\n', '任务甲'],
  ];
  for (const [name, doc, needle] of KINDS) {
    if (!needle) continue;
    await t(`G15k-${name}: ⌘A ⌘A in a session → whole preview selected, session ended; source unchanged`, async () => {
      await B.loadDoc(doc);
      await B.clickLine(1, 'first', needle.slice(0, 2));
      assert(await B.editing(), 'no session');
      await page.keyboard.press('Meta+a'); await sleep(120);
      const s1 = await page.evaluate(() => getSelection().toString());
      await page.keyboard.press('Meta+a'); await sleep(150);
      const r = await page.evaluate(() => { const x = getSelection().toString(); return { whole: x.includes('尾段'), len: x.length, session: !!document.querySelector('.mdr-preview .is-editing') }; });
      await page.keyboard.press('Meta+a'); await sleep(150);
      const r3 = await page.evaluate(() => { const x = getSelection().toString(); return { whole: x.includes('尾段'), session: !!document.querySelector('.mdr-preview .is-editing') }; });
      await page.keyboard.press('Escape'); await B.settle(200);
      const src = await B.source();
      assert(src === doc, `source changed ${JSON.stringify(src)}`);
      assert(r.whole && !r.session, `second ⌘A: ${JSON.stringify(r)} (first ${JSON.stringify(s1)}) third ${JSON.stringify(r3)}`);
    });
  }
  await t('G15-ghost: ⌘A ⌘A in an emptied block, then Backspace and Z change nothing more', async () => {
    await B.loadDoc(DOC);
    await startIn(DOC, '乙段落文字。');
    await emptyEditing();
    await sleep(100);
    const after = await B.source();
    await page.keyboard.press('Meta+a'); await sleep(120);
    await page.keyboard.press('Meta+a'); await sleep(150);
    const n2 = await selLen();
    await page.keyboard.press('Backspace'); await sleep(100);
    await page.keyboard.type('Z'); await B.settle(300);
    const src = await B.source();
    assert(src === after || src === after.replace('甲段落文字。\n\n', '甲段落文字。\n\nZ\n\n'), `source ${JSON.stringify(src)} (after empty ${JSON.stringify(after)}) selLen ${n2}`);
    return `selLen ${n2} src ${JSON.stringify(src)}`;
  });
  await t('G15-dragout: start a session in 乙, type K, drag from inside 乙 down into 丙: K written, selection spans both, copy has both', async () => {
    await B.loadDoc(DOC);
    await startIn(DOC, '乙段落文字。');
    await page.keyboard.type('K');
    const a = await B.textPoint(5, 'first', '乙段');
    const b = await B.textPoint(7, 'first', '一二三');
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(b.x + 10, b.y, { steps: 8 }); await page.mouse.up();
    await sleep(200);
    const sel = await page.evaluate(() => getSelection().toString().replace(/\s+/g, ' '));
    await page.keyboard.press('Meta+c'); await sleep(150);
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch((e) => String(e)));
    await B.settle(300);
    const s = await B.source();
    assert(s.includes('乙段落文字。K'), `K lost ${JSON.stringify(s)}`);
    assert(/乙.*丙/.test(sel), `selection ${JSON.stringify(sel)}`);
    assert(/乙[\s\S]*丙/.test(clip), `clipboard ${JSON.stringify(clip)}`);
    return JSON.stringify(sel);
  });
} finally {
  console.log('pageErrors', JSON.stringify(B.pageErrors.slice(0, 5)));
  finish();
  await B.browser.close().catch(() => {});
  clearTimeout(KILL);
}
