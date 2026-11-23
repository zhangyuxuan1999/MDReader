// bench/verify/ux/17-tail-sync.mjs — the document tail (lead decision 1, final round).
//
// The preview is the only pane with a scroll-past-end region. It used to be `100vh`, which meant
//   (a) a preview at maximum scroll showed ~3 % document and ~97 % blank, and
//   (b) in split mode, once the preview entered that blank tail the editor — which has no tail at all —
//       could not follow it any more: the drift reached 28 lines at f = 1.0 on a 240-line document.
// The fix is a modest tail (`padding-bottom: max(48px, 20vh)`) plus two rules in scrollSync: a follower
// target is clamped to the follower's scroll range, and the preview's position is read AS A MASTER with
// its own tail taken out, so inside the tail the editor stays on the last full screen of content.
//
// What this script measures, for f = 0.85 … 1.0 of the preview's scroll range with the preview as master:
//   drift        |editor top block − preview top block| — the gate, ≤ 1 block
//   rawDrift     the same in lines against the preview's unclamped topVisible() (reported, not gated:
//                inside the tail the preview genuinely reports lines the editor can never show)
//   fill         share of the pane that holds document at maximum scroll
// Run: MDR_UX_BASE=http://localhost:5231 node bench/verify/ux/17-tail-sync.mjs
import { launch, open, loadText, step, expect, check, measure, finish, sleep, getFailures } from './lib.mjs';

const { browser, page, errors } = await launch();

/** 240 lines of mixed content, the document of the original finding. */
const doc = (() => {
  const out = ['# 尾部同步', ''];
  for (let i = 0; i < 58; i++) {
    out.push(`## 小节 ${i}`, '', `第 ${i} 段正文，中文与 English mixed content 用来撑出真实的行高。`, '');
  }
  return out.join('\n');
})();

const geom = () => page.evaluate(() => {
  const pv = window.__mdr.app.preview;
  const el = pv.el;
  const b = pv.blockAtLine(0x7fffffff);
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    maxScroll: el.scrollHeight - el.clientHeight,
    padBottom: parseFloat(getComputedStyle(el).paddingBottom),
    contentBottom: pv.lineToScrollTop(b.startLine + b.lineCount - 1, 1),
    blocks: pv.blockCount(),
  };
});

/** Sets the preview (as master) to `f` of its scroll range and reports how the editor followed. */
async function probe(f) {
  await page.evaluate((f) => {
    const el = window.__mdr.app.preview.el;
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    el.scrollTop = (el.scrollHeight - el.clientHeight) * f;
  }, f);
  await sleep(700);
  return page.evaluate(() => {
    const { editor, preview } = window.__mdr.app;
    const el = preview.el;
    const b = preview.blockAtLine(0x7fffffff);
    const contentBottom = preview.lineToScrollTop(b.startLine + b.lineCount - 1, 1);
    const maxContentTop = Math.max(0, contentBottom - el.clientHeight);
    const ed = editor.topVisible();
    const raw = preview.topVisible();
    // What the preview's top edge means once its trailing padding is taken out (what scrollSync follows).
    const eff = preview.scrollTopToLine(Math.min(el.scrollTop, maxContentTop));
    const blockOf = (line) => preview.blockAtLine(line).index;
    return {
      scrollTop: Math.round(el.scrollTop),
      inTail: el.scrollTop > maxContentTop + 1,
      ed: ed.line, raw: raw.line, eff: eff.line,
      rawDriftLines: Math.abs(ed.line - raw.line),
      driftLines: Math.abs(ed.line - eff.line),
      drift: Math.abs(blockOf(ed.line) - blockOf(eff.line)),
    };
  });
}

try {
  await open(page, '?mode=split');
  await loadText(page, doc, 'tail.md');
  await sleep(800);

  const g = await geom();
  await step('tail geometry', async () => JSON.stringify(g));
  // max(48px, 20vh) of a 900 px viewport = 180 px. The old value was 100vh (= 900 px).
  check('the trailing padding is a modest fixed one, not a full viewport',
    g.padBottom > 40 && g.padBottom <= Math.max(48, 0.25 * 900),
    `padding-bottom ${g.padBottom}px, viewport 900px`);

  // (A) preview as master through the tail: the editor must stay within one block.
  for (const f of [0.85, 0.9, 0.95, 0.99, 1.0]) {
    const p = await probe(f);
    console.log(`  f=${f}`, JSON.stringify(p));
    measure(`preview→editor drift @f=${f} (blocks)`, p.drift, '<= 1', p.drift <= 1);
    if (f >= 0.9) {
      check(`f=${f}: editor within 1 block of the preview's content position`, p.drift <= 1, JSON.stringify(p));
    }
  }

  // (B) at maximum scroll the pane must still be mostly document, not blank.
  await page.evaluate(() => { const el = window.__mdr.app.preview.el; el.scrollTop = el.scrollHeight; });
  await sleep(300);
  const fill = await page.evaluate(() => {
    const pv = window.__mdr.app.preview, el = pv.el;
    const b = pv.blockAtLine(0x7fffffff);
    const contentBottom = pv.lineToScrollTop(b.startLine + b.lineCount - 1, 1);
    return Math.round(100 * Math.min(1, Math.max(0, contentBottom - el.scrollTop) / el.clientHeight));
  });
  measure('document share of the pane at maximum scroll (%)', fill, '>= 70', fill >= 70);

  // (C) the other direction: the editor at its own end must not leave the preview short.
  await page.evaluate(() => {
    const sd = window.__mdr.app.editor.view.scrollDOM;
    sd.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    sd.scrollTop = sd.scrollHeight;
  });
  await sleep(800);
  const back = await page.evaluate(() => {
    const { editor, preview } = window.__mdr.app;
    const el = preview.el;
    const ed = editor.topVisible();
    const blockOf = (line) => preview.blockAtLine(line).index;
    return {
      ed: ed.line, pv: preview.topVisible().line,
      drift: Math.abs(blockOf(ed.line) - blockOf(preview.topVisible().line)),
      atEnd: el.scrollTop >= el.scrollHeight - el.clientHeight - 2,
      scrollTop: Math.round(el.scrollTop),
    };
  });
  check('editor at its end: preview within 1 block', back.drift <= 1, JSON.stringify(back));

  // (D) a document shorter than the pane must not become scrollable at all.
  await loadText(page, '# 标题\n\n正文一。\n\n正文二。\n', 'short.md');
  await sleep(500);
  const short = await geom();
  check('a document shorter than the pane cannot be scrolled into a blank pane',
    short.maxScroll <= 1, JSON.stringify(short));

  check('no console / page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
} catch (e) {
  check('script completed', false, e instanceof Error ? e.stack : String(e));
} finally {
  await browser.close();
  finish('17 tail sync', errors);
  process.exit(getFailures() ? 1 : 0);
}
