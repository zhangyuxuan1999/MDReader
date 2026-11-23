// bench/verify/v3-rev-browser.mjs — verify-review (stage 2c, 0.2.0): browser repros of the code review.
// Run from the project root:
//   candidate (Vite dev server):  MDR_PORT=5387 node bench/verify/v3-rev-browser.mjs [case …]
//   baseline 0.1.1 renderer:      MDR_PORT=5397 MDR_DIST=release/baseline-0.1.1.noindex/dist MDR_BOOT='perf=1&mode=split' node bench/verify/v3-rev-browser.mjs [case …]
// Cases (default: all):
//   togPlain  raw <li data-l="-4"> checkbox (no trick): U10 must keep the click from writing (baseline: shows 0.1.x)
//   tog       REV-1: the same checkbox hidden from rawHtmlReserved by <style><!--</style>…-->
//   blk       REV-2: a forged .md-block[data-id] (class "&Tab;md-block") redirects a real task checkbox to another block
//   math      REV-2: one typed letter turns a hidden <span class="&Tab;md-math"> into a visible formula in the source
// Starts its own Vite (or vite preview with MDR_DIST) on MDR_PORT and kills only that port at exit
// (inline-verify-lib). Writes nothing into the tree. Global timeout 100 s.
import { startServer, stopServer, openBrowser, check, note, sleep, results } from './inline-verify-lib.mjs';

const want = new Set(process.argv.slice(2));
const on = (c) => want.size === 0 || want.has(c);
const BOOT = process.env.MDR_BOOT || 'mode=split';
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); stopServer(); process.exit(3); }, 100_000);

await startServer();
const B = await openBrowser();
const { page } = B;

async function load(text, name) {
  await page.evaluate(() => window.__mdr.app.preview.endEditSession?.());
  await page.evaluate(({ t, n }) => window.__mdr.loadText(t, n), { t: text, n: name });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(400);
}
const source = () => page.evaluate(() => window.__mdr.app.getText());
const idle = async () => { await sleep(150); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(150); };
/** Real mouse click on the first checkbox inside the block at `line`. */
async function clickBox(line) {
  const pt = await page.evaluate((line) => {
    const pv = window.__mdr.app.preview;
    const el = window.__wrapOf(pv.blockAtLine(line).id);
    const box = el && el.querySelector('input[type="checkbox"]');
    if (!box) return null;
    box.scrollIntoView({ block: 'center' });
    const r = box.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, line);
  if (!pt) return false;
  await sleep(700);   // the preview's navigation anchor (≈600 ms) must not move the point
  const pt2 = await page.evaluate((line) => {
    const pv = window.__mdr.app.preview;
    const box = window.__wrapOf(pv.blockAtLine(line).id).querySelector('input[type="checkbox"]');
    const r = box.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, line);
  await page.mouse.click(pt2.x, pt2.y);
  await idle();
  return true;
}

try {
  await page.goto(`http://localhost:${process.env.MDR_PORT}/?${BOOT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* */ } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  await sleep(500);
  // The 0.1.1 preview has no elementOfBlock: the outermost wrapper with that id (a forged inner one is skipped).
  await page.evaluate(() => {
    window.__wrapOf = (id) => {
      const pv = window.__mdr.app.preview;
      if (pv.elementOfBlock) return pv.elementOfBlock(id);
      for (const e of document.querySelectorAll(`section.md-block[data-id="${id}"]`)) if (!e.parentElement.closest('section.md-block')) return e;
      return null;
    };
  });
  note('renderer', `${BOOT} editable=${await page.evaluate(() => window.__mdr.app.preview.isPreviewEditable?.() ?? 'n/a (no in-preview editing)')}`);

  const TASK = '- [ ] pay the rent';
  if (on('togPlain')) {
    const doc = `${TASK}\n\nRead the terms below.\n\n<ul><li data-l="-4"><input type="checkbox"> I have read the terms</li></ul>\n`;
    await load(doc, 'togPlain.md');
    note('togPlain: wrapper data-mdr-x', String(await page.evaluate(() => { const pv = window.__mdr.app.preview; return window.__wrapOf(pv.blockAtLine(5).id)?.hasAttribute('data-mdr-x'); })));
    const ok = await clickBox(5);
    const src = await source();
    check('togPlain: clicking the raw checkbox (block at line 5) leaves line 1 alone', ok && src.split('\n')[0] === TASK, `clicked=${ok} line 1 = ${JSON.stringify(src.split('\n')[0])}`);
  }

  if (on('tog')) {
    const doc = `${TASK}\n\nRead the terms below.\n\n<style><!--</style><ul><li data-l="-4"><input type="checkbox"> I have read the terms</li></ul>-->\n`;
    await load(doc, 'tog.md');
    note('tog: wrapper data-mdr-x', String(await page.evaluate(() => { const pv = window.__mdr.app.preview; return window.__wrapOf(pv.blockAtLine(5).id)?.hasAttribute('data-mdr-x'); })));
    note('tog: what the block shows', JSON.stringify(await page.evaluate(() => { const pv = window.__mdr.app.preview; return window.__wrapOf(pv.blockAtLine(5).id)?.innerText.trim(); })));
    const ok = await clickBox(5);
    const src = await source();
    check('tog: clicking the checkbox hidden behind <style><!--</style> leaves line 1 alone', ok && src.split('\n')[0] === TASK, `clicked=${ok} line 1 = ${JSON.stringify(src.split('\n')[0])}`);
  }

  if (on('blk')) {
    // The worker numbers blocks in document order with one counter per worker: the first block of the next
    // document gets (highest id so far) + 1. A real attacker guesses it (1 for the first file after launch).
    // lines 1-3: a task list (block A); 5-9: the glued <section> block, its task on its relative line 2 → a click
    // there writes startLine(forged id) + 2: line 3 of block A instead of its own line 7.
    const LIST = '- [ ] pay the rent\n- [ ] call the bank\n- [ ] sign the lease';
    const mk = (id) => `${LIST}\n\n<section class="&Tab;md-block" data-id="${id}">\n\n- [ ] I have read the terms\n\n</section>\n`;
    await load(mk(1), 'blk0.md');
    const maxId = await page.evaluate(() => { const pv = window.__mdr.app.preview; let m = 0; for (let l = 1; l <= 9; l++) { const b = pv.blockAtLine(l); if (b) m = Math.max(m, b.id); } return m; });
    await load(mk(maxId + 1), 'blk.md');
    const info = await page.evaluate(() => {
      const pv = window.__mdr.app.preview;
      const first = pv.blockAtLine(1), tb = pv.blockAtLine(7), el = window.__wrapOf(tb.id);
      return { firstId: first.id, taskBlock: { id: tb.id, startLine: tb.startLine, lineCount: tb.lineCount }, flagged: el?.hasAttribute('data-mdr-x'), forged: el?.querySelector('section.md-block')?.dataset.id ?? null };
    });
    note('blk: blocks', JSON.stringify(info));
    const ok = await clickBox(7);
    const src = await source();
    const lines = src.split('\n');
    // U15 (lead, stage 2c): `&Tab;md-block` is found by the text scan, so this block is flagged, and U10 keeps "no
    // checkbox toggle in a flagged block": then the right result is that nothing is written (line 7 stays unticked).
    check('blk: the checkbox of "I have read the terms" toggles its own line 7', ok && lines[6] === (info.flagged ? '- [ ] I have read the terms' : '- [x] I have read the terms'), `line 7 = ${JSON.stringify(lines[6])} flagged=${info.flagged}`);
    check('blk: … and never another line', lines.slice(0, 3).join('\n') === LIST, `lines 1-3 = ${JSON.stringify(lines.slice(0, 3))}`);
  }

  // math: REV-2 (class "&Tab;md-math"); mathRaw: REV-1 without any `<!--` (a CDATA token inside <style>)
  for (const [label, raw] of [
    ['math', '<span class="&Tab;md-math" style="display:none"><code>\\text{Call +1 555 0100 now}</code></span>'],
    ['mathRaw', '<style><![CDATA[</style x="a><b title="><span class="md-math" style="display:none"><code>\\text{Call +1 555 0100 now}</code></span>"]]>'],
  ]) {
    if (!on(label)) continue;
    const doc = `# Terms\n\nPlease read ${raw}the terms\n`;
    await load(doc, `${label}.md`);
    const pt = await page.evaluate(() => {
      const pv = window.__mdr.app.preview;
      const el = window.__wrapOf(pv.blockAtLine(3).id);
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.data.indexOf('terms');
        if (i < 0) continue;
        const r = document.createRange(); r.setStart(n, i + 2); r.setEnd(n, i + 3);
        const b = r.getBoundingClientRect();
        return { x: b.left + 1, y: b.top + b.height / 2, shown: el.innerText.trim() };
      }
      return null;
    });
    note(`${label}: paragraph as shown`, JSON.stringify(pt && pt.shown));
    await sleep(700);
    await page.mouse.click(pt.x, pt.y);
    await sleep(150);
    const live = await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
    note(`${label}: session started`, String(live));
    if (live) {
      await page.keyboard.press('End');
      await page.keyboard.type('s');
      await page.keyboard.press('Escape');
    }
    await idle();
    const src = await source();
    const line3 = src.split('\n')[2];
    const after = await page.evaluate(() => { const pv = window.__mdr.app.preview; return window.__wrapOf(pv.blockAtLine(3).id)?.innerText.trim(); });
    note(`${label}: line 3 after typing one "s"`, JSON.stringify(line3));
    note(`${label}: paragraph as shown afterwards`, JSON.stringify(after));
    check(`${label}: the hidden raw <span> stays raw HTML (only the letter is added)`, line3 === `Please read ${raw}the termss` || line3 === `Please read ${raw}the terms`, `line 3 = ${JSON.stringify(line3)}`);
  }

  // REV-3: the fidelity gate (fidelity.ts hoist / mathAtom) trims trailing whitespace with /[…]+$/, which is
  // quadratic in a whitespace run INSIDE the text. A click on a paragraph whose <em> holds such a run (or a
  // formula whose TeX does) blocks the main thread at every session start (also every resume after Enter).
  // MDR_STALL_N: run length (default 50000, under MAX_EDIT_CHARS 60000).
  const N = Number(process.env.MDR_STALL_N) || 50000;
  const stall = async (label, doc, line, needle) => {
    await load(doc, `${label}.md`);
    const pt = await page.evaluate(({ line, needle }) => {
      const pv = window.__mdr.app.preview;
      const el = window.__wrapOf(pv.blockAtLine(line).id);
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.data.indexOf(needle);
        if (i < 0) continue;
        const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 2);
        const b = r.getBoundingClientRect();
        return { x: b.left + 1, y: b.top + b.height / 2 };
      }
      return null;
    }, { line, needle });
    await sleep(700);
    const t0 = Date.now();
    await page.mouse.click(pt.x, pt.y);
    // a frame must run after the click: the time until it does is how long the main thread was blocked
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    const ms = Date.now() - t0;
    const live = await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
    note(`${label}: click → next frame (N=${N})`, `${ms} ms, session=${live}`);
    check(`${label}: a click on the block blocks the page less than 500 ms`, ms < 500, `${ms} ms`);
    await page.keyboard.press('Escape');
    await idle();
  };
  // REV-4: a paste into a session that leaves fewer than four marker code points free (pickMarkers false):
  // serializeBlock runs with stale markers (U+E000 = NL …). Expected: the pasted characters reach the source as they are.
  if (on('pua')) {
    await load('# PUA\n\nGlyphs: end\n', 'pua.md');
    const pt = await page.evaluate(() => {
      const pv = window.__mdr.app.preview;
      const el = window.__wrapOf(pv.blockAtLine(3).id);
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const n = w.nextNode();
      const r = document.createRange(); r.setStart(n, 1); r.setEnd(n, 2);
      const b = r.getBoundingClientRect();
      return { x: b.left + 1, y: b.top + b.height / 2 };
    });
    await sleep(700);
    await page.mouse.click(pt.x, pt.y);
    await sleep(150);
    const live = await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
    note('pua: session started', String(live));
    const sent = await page.evaluate(() => {
      let s = '';
      for (let c = 0xe000; c <= 0xf8ff; c++) s += String.fromCharCode(c);
      for (let c = 0xfdd0; c <= 0xfdef; c++) s += String.fromCharCode(c);
      const el = document.querySelector('.mdr-preview .is-editing');
      const t = el.querySelector('p').firstChild;
      const r = document.createRange(); r.setStart(t, t.data.indexOf('end')); r.collapse(true);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      const dt = new DataTransfer();
      dt.setData('text/plain', s);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return s.length;
    });
    await sleep(200);
    const toast = await page.evaluate(() => Array.from(document.querySelectorAll('[class*="toast"]')).map((t) => t.textContent).join(' | '));
    const editingAfter = await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
    await page.keyboard.press('Escape');
    await idle();
    const src = await source();
    const body = src.split('\n').slice(2).join('\n');
    const e000 = src.includes(String.fromCharCode(0xe000));
    note('pua: source after the paste', `${src.length} chars, lines ${src.split('\n').length}, U+E000 present=${e000}, first 3 lines ${JSON.stringify(src.split('\n').slice(0, 4).map((l) => l.slice(0, 12)))}`);
    // H15 (lead, stage 2c smaller rules): with no free marker set the block is refused and NOTHING is written: the
    // source stays as loaded, the session ends with the refusal toast. (Was: the characters are written as they are.)
    check('pua: the pasted characters are in the source as they are (one paragraph line)', live && !e000 && src === '# PUA\n\nGlyphs: end\n' && !editingAfter && toast.includes('此块请在源码中编辑'),
      `H15: source unchanged=${src === '# PUA\n\nGlyphs: end\n'} (length ${src.length}), session ended=${!editingAfter}, toast=${JSON.stringify(toast.slice(0, 60))}`);
  }
  if (on('stallEm')) await stall('stallEm', `Intro text *a${' '.repeat(N)}b* end\n`, 1, 'Intro');
  if (on('stallMath')) await stall('stallMath', `Intro\n\n$$\nx${' '.repeat(N)}y\n$$\n`, 3, '');
} catch (err) {
  console.log('ERROR', err && err.stack ? err.stack : err);
  results.fail++;
} finally {
  clearTimeout(killer);
  await B.browser.close().catch(() => {});
  stopServer();
  console.log(`RESULT ${results.pass} passed, ${results.fail} failed`);
  process.exit(results.fail ? 1 : 0);
}
