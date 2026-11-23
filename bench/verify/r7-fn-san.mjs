// bench/verify/r7-fn-san.mjs — fix-san (round 7), rule SAN (CONTRACT §11, Round-7 decisions) in real Chromium, through the
// app (window.__mdr.loadText, the real worker and preview). A block whose sanitization throws (DOMPurify on a processing
// instruction named "form") must show as the render-error block (.md-error: notice + the block's HTML as text), every
// other block must mount as usual, no error may reach the page, and nothing of the block's HTML may be markup in the DOM.
//   MDR_PORT=5462 [MDR_BASE_PORT=<released 0.2.0 dist>] node bench/verify/r7-fn-san.mjs <part>
// parts: cases   — 30 documents, switch off; with MDR_BASE_PORT each block that does not throw is compared with the
//                  baseline's innerHTML, and the baseline must throw exactly where the candidate shows the error block
//        typed   — the throwing text arrives in a later update, typed with the keyboard into the editor; then removed
//        giant   — 20 000 paragraphs with five throwing blocks and one ~600 kB raw-HTML block that throws (giant path)
//        on      — switch on: a click on an error block starts no session (toast 此块请在源码中编辑, source unchanged)
// Prints one line per case and "RESULT <part> bad=<n> of <m>". Global timeout T_MS (default 110000). Writes nothing.
import { chromium } from '@playwright/test';

const T_MS = Number(process.env.T_MS ?? 110000);
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, T_MS);
const PORT = process.env.MDR_PORT || '5462';
const BASE = process.env.MDR_BASE_PORT || '';
const PART = process.argv[2] || 'cases';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOTICE = '渲染此段落时出错：';

// [name, middle Markdown, throws?]
const CASES = [
  ['p-block', '<p><?form></p>', true],
  ['div-block', '<div><?form></div>', true],
  ['div-upper-attr', '<div><?FORM x="1"></div>', true],
  ['div-mixed-text', '<div>text <?Form ?> more</div>', true],
  ['inline', 'a <?form ?> b words', true],
  ['inline-upper-data', 'a <?FORM data ?> b', true],
  ['inline-closed-tight', 'a <?form?> b', true],
  ['list-item', '- one\n- two <?form ?> x\n- three', true],
  ['ordered-item', '1. one <?form ?>\n2. two', true],
  ['table-cell', '| a | b |\n| --- | --- |\n| <?form ?> | y |', true],
  ['quote', '> quoted <?form ?> text', true],
  ['quote-list', '> - item <?form ?>', true],
  ['heading', '## Head <?form ?> x', true],
  ['emphasis', '**bold <?form ?>** and *em*', true],
  ['link-text', '[a <?form ?> b](https://e.example/)', true],
  ['table-html', '<table><tr><td><?form></td></tr></table>', true],
  ['list-html', '<ul><li><?form></li></ul>', true],
  ['math-inline', '<math><mi><?form ?></mi></math>', true],
  ['select-inline', '<select><?form ?></select>', true],
  ['math-unclosed-pi', '<math><mi><?form></mi></math>', false],   // (not an html_block start, and `<?form>` without `?>` is text)
  ['select-unclosed-pi', '<select><?form></select>', false],
  ['two-pis', '<p><?form><?form></p>', true],
  ['markup-inside', '<div><?form><img src="x" onerror="window.__pwned=1"><b>MARKUP</b><script>window.__pwned=2</script></div>', true],
  ['pi-own-block', '<?form?>', false],
  ['pi-own-block-open', '<?form ?>\nline two', false],
  ['not-form-name', '<div><?forms></div>', false],
  ['not-form-input', '<div><?input></div>', false],
  ['php', 'a <?php echo 1 ?> b', false],
  ['code-span', 'see `<?form ?>` here', false],
  ['fence', '```html\n<p><?form></p>\n```', false],
  ['escaped', 'a \\<?form ?> b', false],
  ['plain-raw', '<p>plain raw html</p>', false],
];

async function openPage(browser, port, edit) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 800 } });
  await ctx.addInitScript((v) => { try { localStorage.setItem('mdr.previewEdit', v); } catch { /* */ } }, edit ? '1' : '0');
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e && e.message)));
  await page.goto(`http://localhost:${port}/?mode=split&perf=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  await page.addStyleTag({ content: '[class*="mdr-perf"] { visibility: hidden !important; pointer-events: none !important; }' });
  return { ctx, page, errs };
}

async function load(page, text, settle = 400) {
  await page.evaluate((t) => window.__mdr.loadText(t, 'san.md'), text);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(settle);
}

/** Every block: text, innerHTML, and for an error block its parts; plus markup that must never be there. */
const snapshot = (page) => page.evaluate((NOTICE) => {
  const blocks = Array.from(document.querySelectorAll('.mdr-preview .md-block')).map((b) => {
    const e = b.querySelector('.md-error');
    let wellFormed = null;
    if (e) {
      const tags = Array.from(b.querySelectorAll('*'), (x) => x.tagName).join(',');
      const p = e.querySelector('p'), pre = e.querySelector('pre');
      wellFormed = b.childElementCount === 1 && tags === 'DIV,P,PRE' && !!p && p.textContent.startsWith(NOTICE) && !!pre && /<\?form/i.test(pre.textContent)
        && Array.from(b.querySelectorAll('*')).every((x) => Array.from(x.childNodes).every((c) => c.nodeType === 1 || c.nodeType === 3));
    }
    return { text: (b.textContent || '').trim(), html: b.innerHTML, err: !!e, wellFormed, pending: b.classList.contains('is-pending') };
  });
  const leaked = Array.from(document.querySelectorAll('.mdr-preview b')).some((b) => b.textContent === 'MARKUP')
    || !!document.querySelector('.mdr-preview img[onerror], .mdr-preview script') || window.__pwned !== undefined;
  return { blocks, leaked };
}, NOTICE);

async function partCases(browser) {
  const cand = await openPage(browser, PORT, false);
  const base = BASE ? await openPage(browser, BASE, false) : null;
  let bad = 0;
  try {
    for (const [name, mid, throws] of CASES) {
      const doc = `before para\n\n${mid}\n\nafter para\n`;
      const e0 = cand.errs.length, b0 = base ? base.errs.length : 0;
      await load(cand.page, doc);
      const c = await snapshot(cand.page);
      const errs = cand.errs.slice(e0);
      let b = null, bErrs = [];
      if (base) { await load(base.page, doc); b = await snapshot(base.page); bErrs = base.errs.slice(b0); }
      const why = [];
      if (errs.length) why.push('page errors ' + JSON.stringify(errs));
      if (c.leaked) why.push('markup of the block in the DOM');
      if (c.blocks.length < 3 || c.blocks[0].text !== 'before para' || c.blocks[c.blocks.length - 1].text !== 'after para') why.push('neighbours ' + JSON.stringify(c.blocks.map((x) => x.text)));
      if (c.blocks.some((x) => x.pending)) why.push('a block still pending');
      const nErr = c.blocks.filter((x) => x.err).length;
      if (throws && nErr !== 1) why.push(`error blocks ${nErr}, want 1`);
      if (!throws && nErr !== 0) why.push(`error blocks ${nErr}, want 0`);
      if (c.blocks.some((x) => x.err && !x.wellFormed)) why.push('error block not well formed');
      if (b) {
        if (throws !== (bErrs.length > 0)) why.push(`baseline threw ${bErrs.length} time(s)`);
        if (b.blocks.length !== c.blocks.length) why.push(`block count ${c.blocks.length} vs baseline ${b.blocks.length}`);
        else if (bErrs.length === 0) for (let i = 0; i < c.blocks.length; i++) if (c.blocks[i].html !== b.blocks[i].html) why.push(`block ${i} differs from the baseline`);
        else for (let i = 0; i < c.blocks.length; i++) if (!c.blocks[i].err && b.blocks[i].text !== '' && c.blocks[i].html !== b.blocks[i].html) why.push(`block ${i} differs from the baseline`);
      }
      if (why.length) bad++;
      const errBlock = c.blocks.find((x) => x.err);
      console.log(`${why.length ? 'BAD' : 'ok '} ${name} (throws=${throws}): blocks ${c.blocks.length}${errBlock ? ' error ' + JSON.stringify(errBlock.text.slice(0, 90)) : ''}${b ? ` | baseline errors ${bErrs.length} texts ${JSON.stringify(b.blocks.map((x) => x.text.slice(0, 20)))}` : ''}${why.length ? ' | ' + why.join('; ') : ''}`);
    }
  } finally { await cand.ctx.close(); if (base) await base.ctx.close(); }
  return [bad, CASES.length];
}

async function partTyped(browser) {
  const { ctx, page, errs } = await openPage(browser, PORT, false);
  let bad = 0, n = 0;
  try {
    for (const [name, line, typed] of [['paragraph', 'middle text here', ' <?form ?> tail'], ['list item', '- item one', ' <?FORM ?>'], ['table cell', '| c <?form', ' ?> | d |']]) {
      n++;
      const doc = name === 'table cell' ? `before para\n\n| a | b |\n| --- | --- |\n${line}\n\nafter para\n` : `before para\n\n${line}\n\nafter para\n`;
      await load(page, doc);
      const e0 = errs.length;
      const ok1 = await page.evaluate((l) => {
        const v = window.__mdr.app.editor.view; const at = v.state.doc.toString().indexOf(l) + l.length;
        v.dispatch({ selection: { anchor: at } }); v.focus(); return at > 0;
      }, line);
      await page.keyboard.type(typed, { delay: 25 });
      await page.evaluate(() => window.__mdr.waitIdle()); await sleep(700);
      const s1 = await snapshot(page);
      const mid = s1.blocks.filter((x) => x.err);
      const why = [];
      if (!ok1) why.push('no caret place');
      if (mid.length !== 1 || !mid[0].wellFormed) why.push('after typing: error blocks ' + mid.length);
      if (s1.blocks[0].text !== 'before para' || s1.blocks[s1.blocks.length - 1].text !== 'after para') why.push('neighbours after typing ' + JSON.stringify(s1.blocks.map((x) => x.text)));
      for (let k = 0; k < typed.length; k++) await page.keyboard.press('Backspace');
      await page.evaluate(() => window.__mdr.waitIdle()); await sleep(700);
      const s2 = await snapshot(page);
      if (s2.blocks.some((x) => x.err)) why.push('error block left after the text was removed');
      if (!s2.blocks.some((x) => x.text.includes(name === 'table cell' ? 'c <?form' : line.replace(/^- /, '')))) why.push('block not rendered again ' + JSON.stringify(s2.blocks.map((x) => x.text)));
      const src = await page.evaluate(() => window.__mdr.app.getText());
      if (src !== doc) why.push('source ' + JSON.stringify(src));
      if (errs.length > e0) why.push('page errors ' + JSON.stringify(errs.slice(e0)));
      if (s1.leaked || s2.leaked) why.push('markup leaked');
      if (why.length) bad++;
      console.log(`${why.length ? 'BAD' : 'ok '} typed ${name}: error ${JSON.stringify(mid[0]?.text.slice(0, 70) ?? null)}${why.length ? ' | ' + why.join('; ') : ''}`);
    }
  } finally { await ctx.close(); }
  return [bad, n];
}

async function partGiant(browser) {
  const { ctx, page, errs } = await openPage(browser, PORT, false);
  let bad = 0;
  try {
    const parts = [];
    const at = new Set([0, 7000, 13000, 19999, 4321]);
    for (let i = 0; i < 20000; i++) parts.push(at.has(i) ? `Para ${i} with <?form ?> inside.` : `Para ${i} text.`);
    const cjk = String.fromCharCode(0x6c49).repeat(199000 - 40);
    parts.splice(10000, 0, `<div>${cjk.slice(0, 100000)}<?form>${cjk.slice(100000)}</div>`);
    const doc = parts.join('\n\n') + '\n';
    const t0 = Date.now();
    await page.evaluate((t) => window.__mdr.loadText(t, 'giant.md'), doc);
    await page.evaluate(() => window.__mdr.waitIdle());
    const mounted = await page.evaluate(() => Promise.race([window.__mdr.app.preview.mountAll().then(() => true), new Promise((r) => setTimeout(() => r(false), 60000))]));
    await sleep(1500);
    const r = await page.evaluate((NOTICE) => {
      const bs = Array.from(document.querySelectorAll('.mdr-preview .md-block'));
      const errsB = bs.filter((b) => b.querySelector('.md-error'));
      return {
        blocks: bs.length, empty: bs.filter((b) => !(b.textContent || '').trim()).length, pending: bs.filter((b) => b.classList.contains('is-pending')).length,
        errors: errsB.map((b) => { const t = b.querySelector('.md-error pre').textContent; return { notice: b.querySelector('.md-error p').textContent.startsWith(NOTICE), len: t.length, head: t.slice(0, 40) }; }),
        last: (bs[bs.length - 1]?.textContent || '').trim(),
      };
    }, NOTICE);
    const why = [];
    if (!mounted) why.push('mountAll did not resolve in 60 s');
    if (r.blocks !== 20001) why.push(`blocks ${r.blocks}`);
    if (r.empty || r.pending) why.push(`empty ${r.empty} pending ${r.pending}`);
    if (r.errors.length !== 6 || !r.errors.every((e) => e.notice)) why.push('error blocks ' + JSON.stringify(r.errors));
    if (!r.errors.some((e) => e.len > 190000)) why.push('the giant block is not among them');
    if (r.last !== 'Para 19999 with  inside.' && !r.errors.some((e) => e.head.includes('Para 19999'))) why.push('last block ' + JSON.stringify(r.last.slice(0, 60)));
    if (errs.length) why.push('page errors ' + JSON.stringify(errs.slice(0, 3)));
    if (why.length) bad++;
    console.log(`${why.length ? 'BAD' : 'ok '} giant: ${r.blocks} blocks, ${r.errors.length} error blocks (${r.errors.map((e) => e.len).join(', ')} chars of HTML as text), empty ${r.empty}, pending ${r.pending}, ${Date.now() - t0} ms${why.length ? ' | ' + why.join('; ') : ''}`);
  } finally { await ctx.close(); }
  return [bad, 1];
}

async function partOn(browser) {
  const { ctx, page, errs } = await openPage(browser, PORT, true);
  let bad = 0, n = 0;
  try {
    for (const mid of ['a <?form ?> b words end text', '<div><?form></div>', '- item <?form ?> end text']) {
      n++;
      const doc = `before para\n\n${mid}\n\nafter para\n`;
      await page.keyboard.press('Escape');
      await load(page, doc, 900);
      await page.evaluate(() => { for (const t of document.querySelectorAll('.mdr-toast')) t.remove(); });
      const e0 = errs.length;
      const at = await page.evaluate(() => {
        const pre = document.querySelector('.mdr-preview .md-error pre');
        if (!pre) return null;
        const b = pre.getBoundingClientRect();
        return { x: b.left + 20, y: b.top + Math.min(8, b.height / 2) };
      });
      const why = [];
      if (!at) { why.push('no error block'); }
      else {
        await page.mouse.click(at.x, at.y);
        await sleep(500);
        const started = await page.evaluate(() => !!document.querySelector('.md-block.is-editing'));
        if (started) await page.keyboard.type('X');
        await sleep(400);
        const toast = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-toast')).some((t) => (t.textContent ?? '').includes('此块请在源码中编辑')));
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.__mdr.waitIdle()); await sleep(300);
        const src = await page.evaluate(() => window.__mdr.app.getText());
        if (started) why.push('a session started');
        if (!toast) why.push('no toast');
        if (src !== doc) why.push('source ' + JSON.stringify(src));
      }
      if (errs.length > e0) why.push('page errors ' + JSON.stringify(errs.slice(e0)));
      if (why.length) bad++;
      console.log(`${why.length ? 'BAD' : 'ok '} on ${JSON.stringify(mid)}${why.length ? ' | ' + why.join('; ') : ': refused with the toast, source unchanged'}`);
    }
    // an ordinary neighbour still starts a session
    n++;
    await page.keyboard.press('Escape');
    await load(page, 'before para words\n\na <?form ?> b\n\nafter para\n', 900);
    const at = await page.evaluate(() => {
      const root = window.__mdr.app.preview.el; const tw = document.createTreeWalker(root, 4);
      for (let t = tw.nextNode(); t; t = tw.nextNode()) { const i = t.data.indexOf('words'); if (i >= 0) { const r = document.createRange(); r.setStart(t, i + 1); r.setEnd(t, i + 2); const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; } }
      return null;
    });
    let ok = false;
    if (at) { await page.mouse.click(at.x, at.y); await sleep(500); ok = await page.evaluate(() => !!document.querySelector('.md-block.is-editing')); }
    await page.keyboard.press('Escape');
    if (!ok) bad++;
    console.log(`${ok ? 'ok ' : 'BAD'} on: the paragraph before the error block starts a session`);
  } finally { await ctx.close(); }
  return [bad, n];
}

const browser = await chromium.launch({ headless: true });
let res = [1, 0];
try {
  res = PART === 'cases' ? await partCases(browser) : PART === 'typed' ? await partTyped(browser) : PART === 'giant' ? await partGiant(browser) : await partOn(browser);
} catch (e) { console.log('ERROR', e && e.stack || e); res = [res[0] || 1, res[1]]; }
finally { clearTimeout(KILL); await browser.close().catch(() => {}); }
console.log(`RESULT ${PART} bad=${res[0]} of ${res[1]}`);
process.exitCode = res[0] ? 1 : 0;
