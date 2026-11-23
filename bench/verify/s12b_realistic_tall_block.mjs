// s12b — realistic variant of s12: a normal document (medium.md) with one 2000-line fence and one
// 1500-line paragraph inserted mid-way. Scroll the preview into the middle of each tall block and
// sample for 4 s: the block must stay mounted. Also: editor-driven sync (cursor in the middle of the
// fence in split mode). Run: node bench/verify/s12b_realistic_tall_block.mjs
import { launch, open, settle, makeChecker, report, sleep, fetchTestDoc } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();

async function sampleBlockAtLine(line, ms, every = 100) {
  return page.evaluate(async ({ line, ms, every }) => {
    const out = [];
    const p = window.__mdr.app.preview;
    const b = p.blockAtLine(line);
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const el = document.querySelector(`.md-block[data-id="${b.id}"]`);
      out.push({ t: Math.round(performance.now() - t0), pending: el?.classList.contains('is-pending'), slow: el?.classList.contains('is-slow'), len: el?.textContent.length ?? -1, scrollTop: Math.round(p.el.scrollTop), blockH: Math.round(el?.getBoundingClientRect().height ?? 0), H: p.el.clientHeight });
      await new Promise((r) => setTimeout(r, every));
    }
    return { id: b.id, index: b.index, startLine: b.startLine, lineCount: b.lineCount, samples: out };
  }, { line, ms, every });
}
const summarise = (r) => {
  const s = r.samples;
  // A block that was never mounted (far outside the window) needs one request→render→mount round trip after
  // scrollToLine; samples taken before its first mount are latency, not eviction. Count "empty" only after the
  // block has been mounted once, and require that first mount within 1 s (a block that never mounts still fails).
  const isEmpty = (x) => x.pending || x.len === 0;
  let firstMounted = s.findIndex((x) => !isEmpty(x));
  const mountedAt = firstMounted < 0 ? null : s[firstMounted].t;
  const empty = firstMounted < 0 ? s.length : s.slice(firstMounted).filter(isEmpty).length + (mountedAt > 1000 ? 1 : 0);
  let transitions = 0;
  for (let i = Math.max(1, firstMounted); i < s.length; i++) if (s[i].pending !== s[i - 1].pending) transitions++;
  return { id: r.id, index: r.index, startLine: r.startLine, lineCount: r.lineCount, samples: s.length, mountedAt, empty, transitions, screens: +(s[0].blockH / s[0].H).toFixed(1), first: s[0], last: s[s.length - 1] };
};

try {
  await open(page, '?mode=split');
  await settle(page, 30000);
  const medium = await fetchTestDoc('medium.md');
  const lines = medium.split('\n');
  const fence = ['```ts', ...Array.from({ length: 2000 }, (_, i) => `export const v${i} = ${i}; // line ${i}`), '```'];
  const para = Array.from({ length: 1500 }, (_, i) => `Paragraph line ${i} lorem ipsum dolor sit amet 中文内容`);
  const at1 = 5000, at2 = 12000;
  const doc = [...lines.slice(0, at1), '', ...fence, '', ...lines.slice(at1, at2), '', ...para, '', ...lines.slice(at2)].join('\n');
  const fenceMid = at1 + 2 + 1000; // 1-based line in the middle of the fence
  const paraMid = at2 + fence.length + 2 + 2 + 750;
  await page.evaluate(async (d) => { await window.__mdr.loadText(d, 'tall-real.md'); }, doc);
  let s = await settle(page, 90000);
  C.check('doc settles', s.ok, s);
  const fl = await page.evaluate((l) => { const ed = window.__mdr.app.editor; return ed.view.state.doc.line(l).text; }, fenceMid);
  C.check('fence middle line is code', /export const v/.test(fl), fl);

  for (const [label, line] of [['2000-line fence', fenceMid], ['1500-line paragraph', paraMid]]) {
    // preview-driven scroll into the middle of the block
    await page.evaluate((l) => { window.__mdr.app.preview.scrollToLine(l, 0, 'instant'); }, line);
    const r = await sampleBlockAtLine(line, 4000);
    const sum = summarise(r);
    C.measure(`[${label}] block height in screens`, sum.screens, 'informational', true);
    C.check(`[${label}] preview scrolled into its middle: block stays mounted for 4 s`, sum.empty === 0, sum);
    if (sum.empty) console.log('  timeline:', r.samples.filter((_, i) => i % 4 === 0).map((x) => `${x.t}:${x.pending ? 'EMPTY' : 'ok'}`).join(' '));
    // editor-driven: cursor into the middle of the block (scroll sync follows), then a keystroke
    await page.evaluate((l) => { const ed = window.__mdr.app.editor; ed.gotoLine(l, 3); ed.focus(); }, line);
    await page.keyboard.type('Q', { delay: 0 });
    await settle(page, 60000);
    const r2 = await sampleBlockAtLine(line, 3000);
    const sum2 = summarise(r2);
    C.check(`[${label}] after typing in its middle (editor-driven sync): block mounted at the end`, sum2.last.pending === false && sum2.last.len > 0, sum2);
    if (sum2.last.pending) console.log('  timeline:', r2.samples.filter((_, i) => i % 4 === 0).map((x) => `${x.t}:${x.pending ? 'EMPTY' : 'ok'}`).join(' '));
    // what does the user see: is the visible area of the preview blank?
    const blank = await page.evaluate(() => {
      const el = window.__mdr.app.preview.el;
      const r = el.getBoundingClientRect();
      const pts = [0.2, 0.5, 0.8].map((f) => document.elementFromPoint(r.left + r.width / 2, r.top + r.height * f));
      return pts.map((e) => e ? e.tagName + '.' + e.className : null);
    });
    C.check(`[${label}] elements under the preview viewport are content (not the empty wrapper)`, blank.every((x) => x && !/md-block is-pending/.test(x) && !/mdr-preview__body/.test(x)), blank);
  }

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s12b realistic tall block', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
