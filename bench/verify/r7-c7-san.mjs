// bench/verify/r7-c7-san.mjs — challenge-7 (round 7): attacks rule SAN (a block the sanitizer cannot take does not take the
// preview with it) with HTML the fixer's list (bench/verify/r7-fn-san.mjs) does not have: processing instructions of many
// names (form in odd spellings, form controls, php, xml, xml-stylesheet), at the start and the end of the document, split
// over blocks, inside svg / math / template / noscript / textarea / title / table foster parenting / details, CDATA,
// doctypes, unclosed comments, namespaced and custom elements, nested forms, form elements named like DOM properties.
// Through the app (window.__mdr.loadText), switch OFF, candidate = the tree's dev server (MDR_PORT), baseline = the released
// 0.2.0 dist under vite preview (MDR_BASE_PORT, opened with ?perf=1). Per document: page errors; the blocks around it
// mount; an error block (.md-error) is well formed (DIV > P + PRE, text only); nothing executable in the preview
// (script, iframe, object, embed, on* attributes, javascript: URLs, the planted MARKUP text as markup, window.__pwned);
// and every block that is not an error block is byte-identical (innerHTML) to the baseline's when the baseline mounted it.
//   MDR_PORT=5465 MDR_BASE_PORT=5475 node bench/verify/r7-c7-san.mjs [off|on]
// "on": switch ON in the candidate only: a click on every block whose text holds "<?" or an error block; a session that
// starts on an error block, a source change from click + Escape, or a page error is BAD.
// Global timeout T_MS (default 110 000). Writes nothing.
import { chromium } from '@playwright/test';

const T_MS = Number(process.env.T_MS ?? 110000);
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, T_MS);
const PORT = process.env.MDR_PORT || '5465';
const BASE = process.env.MDR_BASE_PORT || '';
const PART = process.argv[2] || 'off';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const XSS = '<img src="x" onerror="window.__pwned=1"><b>MARKUP</b><script>window.__pwned=2</script><a href="javascript:window.__pwned=3">j</a>';

const MIDS = [
  ['pi-form-nl', 'a <?form\n?> b'],
  ['pi-form-slash', 'a <?form/> b'],
  ['pi-form-dash', '<div><?form-x></div>'],
  ['pi-form-colon', '<div><?form:x></div>'],
  ['pi-fOrM', '<div><?fOrM></div>'],
  ['pi-input', '<div><?input></div>'],
  ['pi-select', '<div><?select></div>'],
  ['pi-button', '<div><?button></div>'],
  ['pi-textarea', '<div><?textarea></div>'],
  ['pi-fieldset', '<div><?fieldset></div>'],
  ['pi-output', '<div><?output></div>'],
  ['pi-object', '<div><?object></div>'],
  ['pi-img', '<div><?img></div>'],
  ['pi-php', '<div><?php echo 1; ?></div>'],
  ['pi-xml', '<div><?xml version="1.0"?></div>'],
  ['pi-xmlss', '<div><?xml-stylesheet href="x.css"?></div>'],
  ['pi-attributes', '<div><?attributes></div>'],
  ['pi-in-svg', '<svg><?form?></svg>'],
  ['pi-in-math', '<math><?form?></math>'],
  ['pi-in-template', '<template><?form></template>'],
  ['pi-in-noscript', '<noscript><?form></noscript>'],
  ['pi-in-textarea', '<textarea><?form></textarea>'],
  ['pi-in-title', '<title><?form></title>'],
  ['pi-in-table-foster', '<table><?form><tr><td>x</td></tr></table>'],
  ['pi-in-details', '<details><summary>s</summary><?form></details>'],
  ['pi-xss', `<div><?form>${XSS}</div>`],
  ['pi-xss-inline', `x <?form ?> ${XSS}`],
  ['pi-in-form', '<form><?form></form>'],
  ['nested-forms', '<form><form><form><input name="x"></form></form></form>'],
  ['form-clobber-attrs', '<form><input name="attributes"><input name="nodeName"><input name="removeChild"></form>'],
  ['form-clobber-nodetype', '<form id="f"><input name="nodeType"><input name="childNodes"><img name="textContent"></form>'],
  ['form-clobber-xss', `<form><input name="attributes">${XSS}</form>`],
  ['cdata', '<div><![CDATA[form]]></div>'],
  ['cdata-svg', '<svg><![CDATA[<?form?>]]></svg>'],
  ['doctype', '<!DOCTYPE form>'],
  ['doctype-inline', 'a <!DOCTYPE form> b'],
  ['comment-unclosed', '<div><!-- form'],
  ['comment-form', '<div><!--form--></div>'],
  ['namespaced', '<x:form>t</x:form>'],
  ['custom-el', '<form-x>t</form-x> <my-form>t</my-form>'],
  ['svg-form', '<svg><form><?form?></form></svg>'],
  ['math-annot', '<math><annotation-xml encoding="text/html"><?form?></annotation-xml></math>'],
  ['deep-nest', '<div>'.repeat(300) + '<?form>' + '</div>'.repeat(300)],
  ['escaped-entity', 'a &lt;?form ?&gt; b'],
  ['escaped-bs', 'a \\<?form ?> b'],
];
// [name, document] — the middle Markdown between two ordinary paragraphs, plus documents of their own shape
const DOCS = MIDS.map(([n, m]) => [n, `before para\n\n${m}\n\nafter para\n`]);
DOCS.push(['pi-doc-start', '<p><?form></p>\n\nafter para\n']);
DOCS.push(['pi-doc-end', 'before para\n\n<p><?form></p>']);
DOCS.push(['pi-doc-only', 'a <?form ?> b']);
DOCS.push(['pi-split-blocks', 'before para\n\n<div>\n<?form\n\nafter ?></div>\n\nafter para\n']);
DOCS.push(['pi-two-blocks', 'before para\n\n<div><?form></div>\n\nmiddle para\n\n- x <?FORM ?>\n\nafter para\n']);
DOCS.push(['pi-details-span', 'before para\n\n<details>\n\ninner <?form ?> para\n\n</details>\n\nafter para\n']);
DOCS.push(['pi-footnote', 'before para[^1]\n\n[^1]: note <?form ?> x\n\nafter para\n']);
DOCS.push(['pi-ref-title', 'before para [x][r]\n\n[r]: https://e.example/ "t <?form ?>"\n\nafter para\n']);
DOCS.push(['pi-math-block', 'before para\n\n$$\n<?form ?>\n$$\n\nafter para\n']);
DOCS.push(['pi-task', 'before para\n\n- [ ] task <?form ?>\n- [x] two\n\nafter para\n']);

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
async function load(page, text) {
  await page.evaluate((t) => { window.__pwned = undefined; return window.__mdr.loadText(t, 'san.md'); }, text);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(250);
}
const snapshot = (page) => page.evaluate(() => {
  const NOTICE = '渲染此段落时出错：';
  const blocks = Array.from(document.querySelectorAll('.mdr-preview .md-block')).map((b) => {
    const e = b.querySelector('.md-error');
    let wellFormed = null;
    if (e) {
      const tags = Array.from(b.querySelectorAll('*'), (x) => x.tagName).join(',');
      const p = e.querySelector('p'), pre = e.querySelector('pre');
      wellFormed = b.childElementCount === 1 && tags === 'DIV,P,PRE' && !!p && p.textContent.startsWith(NOTICE) && !!pre;
    }
    return { text: (b.textContent || '').trim(), html: b.innerHTML, err: !!e, wellFormed, pending: b.classList.contains('is-pending') };
  });
  const root = document.querySelector('.mdr-preview');
  const bad = [];
  for (const el of root.querySelectorAll('*')) {
    if (/^(SCRIPT|IFRAME|OBJECT|EMBED|FRAME|BASE|META|LINK)$/.test(el.tagName)) bad.push(el.tagName);
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name)) bad.push(el.tagName + '@' + a.name);
      if (/^\s*javascript:/i.test(a.value)) bad.push(el.tagName + '@' + a.name + '=js');
    }
    if (el.tagName === 'B' && el.textContent === 'MARKUP') bad.push('MARKUP');
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_PROCESSING_INSTRUCTION);
  if (walker.nextNode()) bad.push('PI node in the DOM');
  if (window.__pwned !== undefined) bad.push('pwned ' + window.__pwned);
  return { blocks, bad };
});

async function partOff(browser) {
  const cand = await openPage(browser, PORT, false);
  const base = BASE ? await openPage(browser, BASE, false) : null;
  let bad = 0;
  try {
    for (const [name, doc] of DOCS) {
      const e0 = cand.errs.length, b0 = base ? base.errs.length : 0;
      await load(cand.page, doc);
      const c = await snapshot(cand.page);
      const errs = cand.errs.slice(e0);
      let b = null, bErrs = [];
      if (base) { await load(base.page, doc); b = await snapshot(base.page); bErrs = base.errs.slice(b0); }
      const why = [];
      if (errs.length) why.push('page errors ' + JSON.stringify(errs.slice(0, 2)));
      if (c.bad.length) why.push('in DOM: ' + c.bad.join(','));
      if (/^before para/.test(doc) && c.blocks[0]?.text !== 'before para') why.push('first block ' + JSON.stringify(c.blocks[0]?.text));
      if (/after para\n$/.test(doc) && c.blocks[c.blocks.length - 1]?.text !== 'after para') why.push('last block ' + JSON.stringify(c.blocks[c.blocks.length - 1]?.text));
      if (c.blocks.some((x) => x.pending)) why.push('a block still pending');
      if (c.blocks.some((x) => x.err && !x.wellFormed)) why.push('error block not well formed');
      const nErr = c.blocks.filter((x) => x.err).length;
      if (b) {
        if (b.blocks.length !== c.blocks.length) why.push(`block count ${c.blocks.length} vs baseline ${b.blocks.length}`);
        else for (let i = 0; i < c.blocks.length; i++) {
          if (c.blocks[i].err) continue;
          if (bErrs.length && b.blocks[i].text === '' && b.blocks[i].html === '') continue;   // (the baseline left it empty)
          if (c.blocks[i].html !== b.blocks[i].html) why.push(`block ${i} differs from the baseline: ${JSON.stringify(c.blocks[i].html.slice(0, 80))} vs ${JSON.stringify(b.blocks[i].html.slice(0, 80))}`);
        }
        if (nErr > 0 && bErrs.length === 0) why.push(`error block(s) ${nErr} although the baseline threw nothing`);
        if (nErr === 0 && bErrs.length > 0) why.push(`baseline threw ${bErrs.length} but no error block`);
      }
      if (why.length) bad++;
      const eb = c.blocks.find((x) => x.err);
      console.log(`${why.length ? 'BAD' : 'ok '} ${name}: blocks ${c.blocks.length} err ${nErr} base-errors ${bErrs.length}${eb ? ' ' + JSON.stringify(eb.text.slice(0, 70)) : ''}${why.length ? ' | ' + why.join('; ') : ''}`);
    }
  } finally { await cand.ctx.close(); if (base) await base.ctx.close(); }
  return [bad, DOCS.length];
}

async function partOn(browser) {
  const cand = await openPage(browser, PORT, true);
  let bad = 0, n = 0;
  try {
    for (const [name, doc] of DOCS) {
      await load(cand.page, doc);
      const ids = await cand.page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview .md-block')).map((b, i) => ({ i, err: !!b.querySelector('.md-error'), pi: /<\?|<!/.test(b.textContent || '') })).filter((x) => x.err || x.pi).map((x) => x.i));
      for (const i of ids) {
        n++;
        const e0 = cand.errs.length;
        const src0 = await cand.page.evaluate(() => window.__mdr.app.getText());
        const pt = await cand.page.evaluate((k) => {
          const b = document.querySelectorAll('.mdr-preview .md-block')[k];
          b.scrollIntoView({ block: 'center' });
          const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
          let t; while ((t = w.nextNode())) if (t.data.trim()) break;
          const r = document.createRange();
          if (t) { r.setStart(t, 0); r.setEnd(t, Math.min(1, t.data.length)); } else r.selectNodeContents(b);
          const q = r.getBoundingClientRect();
          return { x: q.left + Math.min(3, q.width / 2), y: q.top + q.height / 2, err: !!b.querySelector('.md-error') };
        }, i);
        await sleep(700);
        await cand.page.mouse.click(pt.x, pt.y);
        await sleep(400);
        const st = await cand.page.evaluate((k) => {
          const b = document.querySelectorAll('.mdr-preview .md-block')[k];
          return { editing: !!document.querySelector('.md-block.is-editing'), self: !!b?.classList.contains('is-editing'), toast: Array.from(document.querySelectorAll('.mdr-toast__text')).map((e) => e.textContent).filter((t) => /源码中编辑/.test(t)).length };
        }, i);
        await cand.page.keyboard.press('End');
        await cand.page.keyboard.type('Q');
        await cand.page.keyboard.press('Escape');
        await sleep(400);
        const src1 = await cand.page.evaluate(() => window.__mdr.app.getText());
        const errs = cand.errs.slice(e0);
        const why = [];
        if (errs.length) why.push('page errors ' + JSON.stringify(errs.slice(0, 2)));
        if (pt.err && st.self) why.push('session on an error block');
        if (!st.editing && src1 !== src0) why.push('source changed without a session');
        if (pt.err && src1 !== src0) why.push('source changed on an error block');
        if (why.length) bad++;
        console.log(`${why.length ? 'BAD' : 'ok '} on ${name} block ${i}: err=${pt.err} session=${st.self} toast=${st.toast} changed=${src1 !== src0}${src1 !== src0 ? ' ' + JSON.stringify(src1.slice(0, 120)) : ''}${why.length ? ' | ' + why.join('; ') : ''}`);
      }
    }
  } finally { await cand.ctx.close(); }
  return [bad, n];
}

const browser = await chromium.launch({ headless: true });
let code = 0;
try {
  const [bad, n] = PART === 'on' ? await partOn(browser) : await partOff(browser);
  console.log(`RESULT ${PART} bad=${bad} of ${n}`);
  code = bad ? 1 : 0;
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  code = 2;
} finally {
  clearTimeout(KILL);
  await browser.close().catch(() => {});
}
process.exit(code);
