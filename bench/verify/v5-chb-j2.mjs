// bench/verify/v5-chb-j2.mjs — challenge-b (round 4): variations of J2 / P-A (no helper character leaves the session).
// A session on a block whose line starts with a formula (paragraph, after a hard break, item, nested item, task item,
// heading, quote, table cell, two in a row, inside bold), or with the ⌘E empty-code placeholder; then a copy or cut
// (⌘C / ⌘X, or document.execCommand as the edit menu's path) of ⌘A or of a Shift+arrow selection. Checks: text/plain
// and text/html on the clipboard hold no U+200B / U+FEFF; a cut writes no zero-width character into the source and
// ⌘Z gives the source back byte for byte; after Esc the preview DOM (KaTeX output left out) holds none.
// Run: MDR_PORT=5486 node bench/verify/v5-chb-j2.mjs [case-prefix ...]   Writes nothing into the tree.
process.env.MDR_SCRATCH = process.env.MDR_SCRATCH || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v5-chb/lib';
const { sleep, globalTimeout, J, check, summary, openAt, prepare, requireServer } = await import('./v4-sesb-lib.mjs');

const only = process.argv.slice(2);
const CP = Number(process.env.MDR_PORT || 5486);
await requireServer(CP);
const ZW = String.fromCharCode(0x200b), BOM = String.fromCharCode(0xfeff);
const hasZw = (t) => t.includes(ZW) || t.includes(BOM);
const show = (t) => J(t.split(ZW).join('<ZW>').split(BOM).join('<BOM>'));
const B = await openAt(CP);
const { page } = B;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), B.close);

async function clickOn(needle, k = 1) {
  const p = await page.evaluate(({ needle, k }) => {
    const root = document.querySelector('.mdr-preview');
    const tw = document.createTreeWalker(root, 4);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0 || n.parentElement.closest('.katex')) continue;
      const r = document.createRange(); r.setStart(n, i + k); r.setEnd(n, i + k + 1);
      const b = r.getBoundingClientRect();
      return { x: b.left + 1, y: b.top + b.height / 2 };
    }
    return null;
  }, { needle, k });
  if (!p) throw new Error('no text ' + needle);
  await page.mouse.click(p.x, p.y);
  await sleep(250);
  const ed = await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
  if (!ed) throw new Error('no session');
}
async function clip() {
  return page.evaluate(async () => {
    const out = { plain: '', html: '' };
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        if (it.types.includes('text/plain')) out.plain = await (await it.getType('text/plain')).text();
        if (it.types.includes('text/html')) out.html = await (await it.getType('text/html')).text();
      }
    } catch (e) { out.plain = 'ERR ' + e; }
    return out;
  });
}
const clearClip = () => page.evaluate(() => navigator.clipboard.writeText('<<none>>'));
const domZw = () => page.evaluate(() => {
  const root = document.querySelector('.mdr-preview');
  const tw = document.createTreeWalker(root, 4);
  let n = 0;
  for (let t = tw.nextNode(); t; t = tw.nextNode()) {
    if (t.parentElement.closest('.katex, [data-mdr-ui]')) continue;
    for (const c of t.data) if (c.charCodeAt(0) === 0x200b || c.charCodeAt(0) === 0xfeff) n++;
  }
  return n;
});

// [name, doc, needle to click, select: 'all' | 'line' (End, Shift+Home) | 'left5', action: 'copy' | 'cut' | 'menucopy' | 'menucut', pre-keys]
const DOCS = [
  ['para', '$x^2$ starts para\n\nnext\n', 'starts'],
  ['hardbreak', 'first line  \n$x$ second line\n\nnext\n', 'second'],
  ['item', '- $a$ item one\n- two\n\nnext\n', 'item one'],
  ['nested', '- top\n  - $b$ inner\n\nnext\n', 'inner'],
  ['task', '- [ ] $t$ task one\n- [ ] two\n\nnext\n', 'task one'],
  ['heading', '# $h$ heading text\n\nnext\n', 'heading'],
  ['quote', '> $q$ quote line\n\nnext\n', 'quote'],
  ['cell', '| a | b |\n|---|---|\n| $c$ cell | d |\n\nnext\n', 'cell'],
  ['two', '$a$ one  \n$b$ two\n\nnext\n', 'two'],
  ['bold', '**$x$ bold** rest\n\nnext\n', 'rest'],
  ['frac', '$\\frac{1}{2}$ half here\n\nnext\n', 'half'],
];
const C = [];
for (const [dn, doc, needle] of DOCS) {
  C.push([`${dn}-all-copy`, doc, needle, 'all', 'copy']);
  C.push([`${dn}-line-copy`, doc, needle, 'line', 'copy']);
  C.push([`${dn}-all-cut`, doc, needle, 'all', 'cut']);
  C.push([`${dn}-line-menucut`, doc, needle, 'line', 'menucut']);
  C.push([`${dn}-all-menucopy`, doc, needle, 'all', 'menucopy']);
}
// ⌘E: the empty-code placeholder, and the caret place after a code span
C.push(['frac-home-typedel-esc', '$\\frac{1}{2}$ half here\n\nnext\n', 'half', 'none', 'esc', async () => { await page.keyboard.press('Home'); await page.keyboard.type('Z'); await page.keyboard.press('Backspace'); await sleep(150); }]);
C.push(['frac-home-type-esc', '$\\frac{1}{2}$ half here\n\nnext\n', 'half', 'none', 'esc', async () => { await page.keyboard.press('Home'); await page.keyboard.type('Z'); await sleep(150); }]);
C.push(['para-home-typedel-esc', '$x$ half here\n\nnext\n', 'half', 'none', 'esc', async () => { await page.keyboard.press('Home'); await page.keyboard.type('Z'); await page.keyboard.press('Backspace'); await sleep(150); }]);
C.push(['frac-cut-paste', '$\\frac{1}{2}$ half here\n\nnext\n', 'half', 'line', 'cut', async () => {}]);
C.push(['cmdE-empty-copy', 'abc def ghi\n\nnext\n', 'def', 'all', 'copy', async () => { await page.keyboard.press('Meta+e'); await sleep(150); }]);
C.push(['cmdE-empty-cut', 'abc def ghi\n\nnext\n', 'def', 'all', 'cut', async () => { await page.keyboard.press('Meta+e'); await sleep(150); }]);
C.push(['cmdE-after-copy', 'abc def ghi\n\nnext\n', 'def', 'all', 'copy', async () => { await page.keyboard.press('Meta+e'); await page.keyboard.type('k'); await page.keyboard.press('ArrowRight'); await sleep(150); }]);
C.push(['cmdE-after-left-copy', 'abc def ghi\n\nnext\n', 'def', 'left5', 'copy', async () => { await page.keyboard.press('Meta+e'); await page.keyboard.type('k'); await page.keyboard.press('Meta+e'); await page.keyboard.type('zz'); await sleep(150); }]);
C.push(['cmdE-after-esc', 'abc def ghi\n\nnext\n', 'def', 'none', 'esc', async () => { await page.keyboard.press('Meta+e'); await page.keyboard.type('k'); await page.keyboard.press('ArrowRight'); await page.keyboard.type('m'); await sleep(150); }]);

let bad = 0;
try {
  for (const [name, doc, needle, selm, action, pre] of C) {
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    try {
      await prepare(B, doc);
      await clickOn(needle);
      if (pre) await pre();
      if (selm === 'all') { await page.keyboard.press('Meta+a'); }
      else if (selm === 'line') { await page.keyboard.press('End'); await page.keyboard.press('Shift+Home'); }
      else if (selm === 'left5') { for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft'); }
      await sleep(120);
      await clearClip();
      if (action === 'copy') await page.keyboard.press('Meta+c');
      else if (action === 'cut') await page.keyboard.press('Meta+x');
      else if (action === 'menucopy') await page.evaluate(() => document.execCommand('copy'));
      else if (action === 'menucut') await page.evaluate(() => document.execCommand('cut'));
      await sleep(200);
      const c = action === 'esc' ? { plain: '', html: '' } : await clip();
      const inSession = await domZw();
      await page.keyboard.press('Escape');
      await B.settle(500);
      const src = await B.source();
      const after = await domZw();
      // KaTeX's own output holds U+200B (its vlist struts): only zero-width characters beyond those of the formulas count
      const katexZw = await page.evaluate(() => { let n = 0; for (const k of document.querySelectorAll('.mdr-preview .katex')) for (const c of k.textContent) if (c.charCodeAt(0) === 0x200b) n++; return n; });
      const zwN = (t) => (t.match(new RegExp('[' + ZW + BOM + ']', 'g')) || []).length;
      const okClip = (action === 'esc' || zwN(c.plain) <= (selm === 'none' ? 0 : katexZw)) && c.plain !== '<<none>>';
      const okSrc = !hasZw(src) && (action.includes('cut') || src === doc || action === 'esc' || !!pre);
      if (!check(name, okClip && okSrc && after === 0, `plain=${show(c.plain.slice(0, 60))} htmlZw=${hasZw(c.html)} srcZw=${hasZw(src)} src=${show(src.slice(0, 50))} domZwInSession=${inSession} domZwAfterEsc=${after}`)) bad++;
      // ⌘Z back to the original, byte for byte
      for (let k = 0; k < 10 && (await B.source()) !== doc; k++) {
        await page.evaluate(() => window.__mdr.app.editor.view.focus());
        await page.keyboard.press('Meta+z'); await sleep(150);
      }
      const back = await B.source();
      if (!check(name + ':undo', back === doc, `after undo=${show(back)}`)) bad++;
    } catch (err) { check(name, false, 'error ' + (err && err.message)); bad++; }
  }
} finally {
  summary();
  clearTimeout(stop);
  await B.close();
}
process.exit(bad ? 1 : 0);
