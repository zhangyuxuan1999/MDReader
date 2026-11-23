// bench/verify/v4-app-sel.mjs — verify-app (0.2.0 stage 2d re-verification). H22 / H16 variations and the
// clipboard after a preview selection, measured the same way on the candidate and on the 0.1.1 renderer.
// Prints RESULT lines (values, not verdicts) so that two runs can be diffed line by line.
//   Candidate:              MDR_PORT=5436 node bench/verify/v4-app-sel.mjs [filter]
//   Candidate, edit off:    MDR_EDIT=off MDR_PORT=5436 node bench/verify/v4-app-sel.mjs [filter]
//   Baseline 0.1.1 dist:    MDR_PERF=1 MDR_PORT=5446 node bench/verify/v4-app-sel.mjs [filter]
// MDR_MODE=preview runs in preview-only mode. Needs the renderer already listening (no server is started).
// Writes nothing into the tree.
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';
import { shimBaseline } from './v4-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const only = process.argv[2] ?? '';
const B = await openBrowser();
const { page, context } = B;
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const ZW = [0x200b, 0xfeff].map((c) => String.fromCharCode(c));
const probe = async (k, fn) => { if (only && !k.includes(only)) return; try { out(k, await fn()); } catch (e) { out(k, `ERROR ${String(e.message).split('\n')[0]}`); } };
const clip = () => page.evaluate(async (ZW) => {
  try {
    const items = await navigator.clipboard.read();
    const r = {};
    for (const it of items) for (const ty of it.types) r[ty] = await (await it.getType(ty)).text();
    const html = r['text/html'] ?? '';
    const plain = r['text/plain'] ?? null;
    return {
      plain,
      ce: /contenteditable|is-editing|data-mdr-ui|mdr-ghost|mdr-capture/i.test(html),
      zw: ZW.some((z) => (plain ?? '').includes(z) || html.includes(z)),
      htmlLen: html.length > 0,
    };
  } catch (e) { return `clip error ${e.message}`; }
}, ZW);
const clearClip = () => page.evaluate(async () => { try { await navigator.clipboard.writeText('<empty>'); } catch { /* */ } });
const session = () => page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
const selInfo = () => page.evaluate(() => {
  const s = getSelection().toString();
  return { len: s.length, head: s.slice(0, 12), tail: s.slice(-12) };
});
const FILL = (n, p) => Array.from({ length: n }, (_, i) => `${p}段落 ${i} 文字。\n`);
const KINDS = {
  para: ['一个普通段落 alpha beta。'],
  heading: ['## 二级标题 gamma'],
  list: ['- 列表项甲 one', '- 列表项乙 two'],
  task: ['- [ ] 任务甲 open', '- [x] 任务乙 done'],
  quote: ['> 引用的文字 quoted', '> 第二行 more'],
  codejs: ['```js', 'const alpha = 1;', 'let beta = 2;', '```'],
  codeplain: ['```', 'plain code line', '```'],
  codeblankend: ['```', 'code with blank end', '', '```'],
  codeindent: ['    indented code line', '    second indented'],
  table: ['| 列一 | 列二 |', '| --- | --- |', '| 单元 a | 单元 b |'],
  math: ['$$', 'x^2 + y^2', '$$'],
  inlinemathend: ['文字结尾是公式 $a+b$'],
  inlinemathstart: ['$c+d$ 开头是公式的段落'],
  image: ['图片在末尾 ![alt](data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==)'],
};
const docFor = (kind, pos) => {
  const blk = KINDS[kind].join('\n') + '\n';
  const parts = pos === 'first' ? [blk, '', ...FILL(4, '后')] : pos === 'last' ? [...FILL(4, '前'), blk] : [...FILL(3, '前'), blk, '', ...FILL(3, '后')];
  return parts.join('\n').replace(/\n{3,}/g, '\n\n');
};
const lineOf = (doc, kind) => doc.split('\n').findIndex((l) => l === KINDS[kind][0]) + 1;
async function clickInto(doc, kind) {
  const line = lineOf(doc, kind);
  await B.mountLine(line);
  let pt = await B.textPoint(line, 'first');
  if (!pt) {
    pt = await page.evaluate((line) => {
      const pv = window.__mdr.app.preview;
      const el = pv.elementOfBlock(pv.blockAtLine(line).id);
      const r = (el.querySelector('.katex-display, .katex, img, td, li, pre, p') ?? el).getBoundingClientRect();
      return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 };
    }, line);
  }
  await page.mouse.click(pt.x, pt.y);
  await sleep(250);
}

try {
  await B.boot(`mode=${process.env.MDR_MODE || 'split'}`);
  out('shim', await shimBaseline(page));
  if (process.env.MDR_EDIT === 'off') {
    await page.evaluate(() => window.__mdr.app.registry.run('view.togglePreviewEdit'));
    await sleep(200);
    out('previewEdit', await page.evaluate(() => localStorage.getItem('mdr.previewEdit')));
  }
  const reset = async (doc) => {
    await page.keyboard.press('Escape');
    await B.loadDoc(doc);
    await page.evaluate(() => { getSelection().removeAllRanges(); document.activeElement?.blur?.(); window.__mdr.app.preview.scrollToLine(1, 0, 'instant'); });
    await sleep(700);
    await clearClip();
  };

  // H22 family: Cmd-A twice from every kind of block at three positions, then Cmd-C.
  for (const kind of Object.keys(KINDS)) {
    for (const pos of ['first', 'middle', 'last']) {
      await probe(`AA ${kind} ${pos}`, async () => {
        const doc = docFor(kind, pos);
        await reset(doc);
        await clickInto(doc, kind);
        const s0 = await session();
        await page.keyboard.press('ControlOrMeta+a'); await sleep(150);
        const one = await selInfo();
        await page.keyboard.press('ControlOrMeta+a'); await sleep(500);
        const two = await selInfo();
        const s2 = await session();
        await page.keyboard.press('ControlOrMeta+c'); await sleep(200);
        const c = await clip();
        const src = (await B.source()) === doc;
        return { s0, oneLen: one.len, twoLen: two.len, twoHead: two.head, twoTail: two.tail, s2, clip: c.plain?.replace(/\s+/g, ' ').trim().slice(0, 30) + '…' + c.plain?.replace(/\s+/g, ' ').trim().slice(-30), clipLen: c.plain?.length, ce: c.ce, zw: c.zw, src };
      });
    }
  }
  // Cmd-A once in a session then Cmd-C: the copied block text (ZWSP / chrome must not leak).
  for (const kind of ['para', 'inlinemathstart', 'codejs', 'table', 'task', 'math']) {
    await probe(`A1C ${kind}`, async () => {
      const doc = docFor(kind, 'middle');
      await reset(doc);
      await clickInto(doc, kind);
      await page.keyboard.press('ControlOrMeta+a'); await sleep(150);
      await page.keyboard.press('ControlOrMeta+c'); await sleep(200);
      const c = await clip();
      return { session: await session(), plain: c.plain, ce: c.ce, zw: c.zw };
    });
  }
  // H16 family: after a click, Space / Shift+Space / End / Home / PageDown in the preview.
  const LONG = ['# 长文', '', ...FILL(120, '长')].join('\n');
  for (const key of ['Space', 'Shift+Space', 'End', 'Home', 'PageDown', 'ArrowDown']) {
    await probe(`K ${key}`, async () => {
      await reset(LONG);
      if (key === 'Home' || key === 'Shift+Space') {
        await page.evaluate(() => window.__mdr.app.preview.scrollToLine(120, 0, 'instant'));
        await sleep(700);
      }
      const line = await page.evaluate(() => window.__mdr.app.preview.topVisible().line + 6);
      const pt = await B.textPoint(line, 'first');
      await page.mouse.click(pt.x, pt.y); await sleep(250);
      const t0 = await page.evaluate(() => window.__mdr.app.preview.el.scrollTop);
      await page.keyboard.press(key); await sleep(500);
      const t1 = await page.evaluate(() => window.__mdr.app.preview.el.scrollTop);
      await B.settle(200);
      const s = await B.source();
      return { scrolled: Math.abs(t1 - t0) > 100 ? (t1 > t0 ? 'down' : 'up') : 'no', srcSame: s === LONG, session: await session() };
    });
  }
  // A click on the preview's empty area (outside every block), then Space.
  await probe('K space after click on preview padding', async () => {
    await reset(LONG);
    const pt = await page.evaluate(() => { const r = window.__mdr.app.preview.el.getBoundingClientRect(); return { x: r.right - 25, y: r.top + 200 }; });
    await page.mouse.click(pt.x, pt.y); await sleep(250);
    const t0 = await page.evaluate(() => window.__mdr.app.preview.el.scrollTop);
    await page.keyboard.press('Space'); await sleep(500);
    const t1 = await page.evaluate(() => window.__mdr.app.preview.el.scrollTop);
    return { scrolled: t1 - t0 > 100, srcSame: (await B.source()) === LONG, session: await session() };
  });
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  console.log('BASE', BASE);
}
