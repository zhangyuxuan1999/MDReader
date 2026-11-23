// bench/verify/v3-ses-paste.mjs — verify-session stage 2c: the rewritten paste (U8, pasteText) in real Chromium.
// Real ⌘V with the system clipboard (navigator.clipboard.writeText first) unless a case needs a synthetic
// ClipboardEvent (text/html only, files). Each case: expected source after the paste, then ⌘Z inside the session
// until the original (byte for byte; the number of steps is printed), then ⇧⌘Z back to the pasted text.
// Run: MDR_PORT=5382 node bench/verify/v3-ses-paste.mjs [name-filter]       (exit code 1 on a failure)
import { openB, sleep, globalTimeout, J, check, summary, view, shownText, clickText, undoTo, redoTo } from './v3-ses-lib.mjs';

const filter = process.argv[2] || '';
const B = await openB({ clipboard: true });
const stop = globalTimeout(Number(process.env.T_MS ?? 118_000), B.close);
const { page } = B;
const settle = async (ms = 350) => { await sleep(ms); await B.settle(200); };
const ch = (n) => String.fromCharCode(n);
const NBSP = ch(0xa0), ZW = ch(0x200b), LS = ch(0x2028);
async function waitSession(ms = 2000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await view(page); if (v.editing && !v.capFocused) return v; await sleep(30); }
  return view(page);
}
async function start(doc, needle, k = null) {
  await B.loadDoc(doc);
  await sleep(650);
  await clickText(page, needle, k ?? needle.length - 1, { side: 'right' });
  const v = await waitSession();
  if (!v.editing) throw new Error('no session ' + J(v).slice(0, 200));
}
async function realPaste(text) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press('Meta+v');
}
async function synthPaste(data) {
  await page.evaluate((data) => {
    const dt = new DataTransfer();
    for (const [k, v] of Object.entries(data)) if (k !== 'file') dt.setData(k, v);
    if (data.file) dt.items.add(new File([data.file], 'f.txt', { type: 'text/plain' }));
    const t = document.activeElement;
    t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, data);
}
const cases = [];
const def = (name, fn) => cases.push({ name, fn });
/** A generic case: doc, needle (caret after it, or `sel` = select it), pasted text, expected source (or a predicate). */
function pc(name, doc, needle, text, exp, opts = {}) {
  def(name, async () => {
    await start(doc, opts.click ?? needle);
    if (opts.sel) await B.selectText(needle); else if (needle) await B.caretAt(needle, opts.where ?? 'after');
    if (opts.synth) await synthPaste(opts.synth); else await realPaste(text);
    if (opts.typeAfter) await page.keyboard.type(opts.typeAfter);
    await settle(opts.wait ?? 400);
    const v = await view(page);
    const ok1 = typeof exp === 'function' ? exp(v.src, v) : v.src === exp;
    const sh = await shownText(page);
    let undoInfo = 'skipped';
    let ok2 = true;
    if (!opts.noUndo) {
      const fin = v.src;
      const u = await undoTo(B, doc, opts.maxUndo ?? 8);
      const r = await redoTo(B, fin, opts.maxUndo ?? 8);
      ok2 = u.ok && r.ok;
      undoInfo = `undo=${u.ok ? u.n : 'FAIL ' + J(u.now.slice(0, 200))} redo=${r.ok ? r.n : 'FAIL ' + J(r.now.slice(0, 200))}`;
    }
    const show = (s) => (s.length > 300 ? J(s.slice(0, 150)) + '…' + J(s.slice(-120)) + ` (len ${s.length})` : J(s));
    return { ok: ok1 && ok2, detail: `src=${show(v.src)} ${typeof exp === 'string' ? 'exp=' + show(exp) : ''} toast=${J(v.toast)} live=${!!v.editing} ${undoInfo} shown=${J(sh).slice(0, 160)}` };
  });
}

// ---- size limit (MAX_EDIT_CHARS = 60 000); words with spaces (K16: one unbroken word is slow in Chromium)
const big = (n) => { let s = ''; while (s.length < n) s += 'word '; return s.slice(0, n - 1) + 'x'; };
const B59 = big(59000);
const P = (n) => big(n).replace(/^./, 'P');
for (const n of [900, 1000, 1001, 1100]) {
  pc(`limit-prose-59000+${n}`, `${B59}\n\nz\n`, null, P(n), (src) => (n <= 1000 ? src.length === 59000 + n + 3 : src === `${B59}\n\nz\n`), { click: 'word', where: 'after', noUndo: n > 1000, wait: 1500 });
}
pc('limit-prose-sel-replaced', `${B59}\n\nz\n`, null, P(1100), (src) => src.length > 59000 + 400, { click: 'word', wait: 1500, noUndo: true, pre: 'sel500' });
pc('limit-code-59000+1100', '```\n' + B59 + '\n```\n\nz\n', null, P(1100), (src) => src === '```\n' + B59 + '\n```\n\nz\n', { click: 'word', noUndo: true, wait: 1500 });
pc('limit-lines-estimate', `abc\n\nz\n`, 'abc', Array.from({ length: 20000 }, () => 'ab').join('\n'), (src, v) => src === 'abc\n\nz\n' && /太长/.test(v.toast), { noUndo: true, wait: 1500 });
// ---- characters
pc('crlf', 'abc def\n\nz\n', 'abc', 'X\r\nY', 'abcX  \nY def\n\nz\n');
pc('cr-alone', 'abc def\n\nz\n', 'abc', 'X\rY', 'abcX  \nY def\n\nz\n');
pc('crlf-blank', 'abc def\n\nz\n', 'abc', 'X\r\n\r\nY', 'abcX\n\nY def\n\nz\n');
pc('tab', 'abc def\n\nz\n', 'abc', 'X\tY', (s) => s === 'abcX\tY def\n\nz\n' || s === 'abcX Y def\n\nz\n');
pc('nbsp', 'abc def\n\nz\n', 'abc', 'X' + NBSP + 'Y', 'abcX&nbsp;Y def\n\nz\n');
pc('zwsp', 'abc def\n\nz\n', 'abc', 'X' + ZW + 'Y', (s) => s === 'abcX' + ZW + 'Y def\n\nz\n' || s === 'abcX&#8203;Y def\n\nz\n');
pc('u2028', 'abc def\n\nz\n', 'abc', 'X' + LS + 'Y', (s) => s.startsWith('abcX') && s.includes('Y def') && !s.includes('<'));
pc('trailing-newline-prose', 'abc def\n\nz\n', 'abc', 'X\n', 'abcX  \n def\n\nz\n');
pc('trailing-newline-prose-end', 'abc\n\nz\n', 'abc', 'X\n', (s) => s === 'abcX\n\nz\n' || s === 'abcX  \n\nz\n' || s.startsWith('abcX'));
pc('code-end-trailing-nl', '```\nabc\n```\n\nz\n', 'abc', 'X\n', '```\nabcX\n\n```\n\nz\n');
pc('code-end-trailing-nl-type', '```\nabc\n```\n\nz\n', 'abc', 'X\n', '```\nabcX\nQ\n```\n\nz\n', { typeAfter: 'Q' });
pc('code-mid-lines', '```\nabc def\n```\n\nz\n', 'abc', 'X\n\nY', '```\nabcX\n\nY def\n```\n\nz\n');
pc('code-crlf', '```\nabc\n```\n\nz\n', 'abc', 'X\r\nY\r\n', '```\nabcX\nY\n\n```\n\nz\n');
// ---- link edges
pc('link-end-edge', 'a [link](http://e.com/) b\n', 'link', 'X', 'a [link](http://e.com/)X b\n', { click: ' b' });
pc('link-start-edge', 'a [link](http://e.com/) b\n', 'link', 'X', 'a X[link](http://e.com/) b\n', { where: 'before', click: ' b' });
pc('link-middle', 'a [link](http://e.com/) b\n', 'li', 'X', 'a [liXnk](http://e.com/) b\n', { click: ' b' });
pc('link-end-lines', 'a [link](http://e.com/) b\n', 'link', 'X\nY', 'a [link](http://e.com/)X  \nY b\n', { click: ' b' });
// ---- block kinds
pc('quote-lines', '> abc def\n\nz\n', 'abc', 'X\nY', '> abcX  \n> Y def\n\nz\n');
pc('quote-paras', '> abc def\n\nz\n', 'abc', 'X\n\nY', '> abcX\n>\n> Y def\n\nz\n');
pc('li-lines', '- abc def\n- two\n', 'abc', 'X\nY', '- abcX  \n  Y def\n- two\n');
pc('li-paras', '- abc def\n- two\n', 'abc', 'X\n\nY', (s) => s.startsWith('- abcX') && s.includes('Y def') && s.endsWith('- two\n') && !s.includes('<p'));
pc('cell-paras', '| h |\n|---|\n| abc def |\n', 'abc', 'X\n\nY', (s) => /\| abcX<br>(<br>)?Y def \|/.test(s));
pc('heading-paras', '# abc def\n\nz\n', 'abc', 'X\n\nY', (s) => s.startsWith('# abcX') && s.includes('Y def') && s.endsWith('z\n'));
pc('heading-line-start-syntax', '# abc def\n\nz\n', 'abc', 'X\n# not heading', (s) => s.startsWith('# abcX<br>') && !/\n# not/.test(s));
pc('prose-line-start-syntax', 'abc def\n\nz\n', 'abc', 'X\n- not list\n# not heading\n> not quote\n1. not ol', (s) => !/\n(- not|# not|> not|1\. not)/.test(s));
pc('prose-paras-syntax', 'abc def\n\nz\n', 'abc', 'X\n\n- not list\n\n```\nnot code', (s) => !/\n(- not list|```)/.test(s));
pc('paste-markdown-literal', 'abc\n\nz\n', 'abc', '**not bold** [x](y) `c`', (s) => s.startsWith('abc\\*\\*not bold\\*\\* \\[x\\](y) \\`c\\`') || !/\*\*not bold\*\*(?!\\)/.test(s.replace(/\\\*/g, '')));
// ---- many paragraphs: the resume must land on the last pasted one
pc('paras-300-type-after', 'abc def\n\nz\n', 'abc', Array.from({ length: 300 }, (_, i) => `para${i}`).join('\n\n'), (s) => s.includes('\n\npara299Q def\n\nz\n') && s.startsWith('abcpara0\n\npara1\n'), { typeAfter: 'Q', wait: 2500, maxUndo: 6 });
pc('paras-300-undo-steps', 'abc def\n\nz\n', 'abc', Array.from({ length: 300 }, (_, i) => `para${i}`).join('\n\n'), (s) => s.includes('para299 def'), { wait: 2500, maxUndo: 4 });
// ---- clipboards without text/plain
pc('html-only', 'abc def\n\nz\n', 'abc', null, 'abc def\n\nz\n', { synth: { 'text/html': '<b>bold</b>' }, noUndo: true });
pc('files-only', 'abc def\n\nz\n', 'abc', null, 'abc def\n\nz\n', { synth: { file: 'file content' }, noUndo: true });
// ---- selection replaced, across lines of the block
pc('sel-replace', 'abc def ghi\n\nz\n', 'def', 'X', 'abc X ghi\n\nz\n', { sel: true });
pc('sel-replace-lines', 'abc def ghi\n\nz\n', 'def', 'X\n\nY', 'abc X\n\nY ghi\n\nz\n', { sel: true });
// ---- into an emptied block, and in the resume window
def('into-emptied', async () => {
  await start('a\n\nmid\n\nz\n', 'mid');
  await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace'); await settle();
  const s0 = await B.source();
  await realPaste('P1\n\nP2');
  await settle(600);
  const v = await view(page);
  const sh = await shownText(page);
  await page.keyboard.type('Q'); await settle();
  const v2 = await view(page);
  return { ok: s0 === 'a\n\nz\n' && v.src === 'a\n\nP1\n\nP2\n\nz\n' && v2.src === 'a\n\nP1\n\nP2Q\n\nz\n', detail: `emptied=${J(s0)} pasted=${J(v.src)} shown=${J(sh)} typed=${J(v2.src)}` };
});
def('in-resume-window', async () => {
  await start('abc def\n\nz\n', 'abc');
  await B.caretAt('abc');
  await page.evaluate((t) => navigator.clipboard.writeText(t), 'PP');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Meta+v');
  await page.keyboard.type('Q');
  await settle(700);
  const v = await view(page);
  return { ok: v.src === 'abc\n\nPPQdef\n\nz\n', detail: `src=${J(v.src)}` };
});
def('cut-then-paste-elsewhere', async () => {
  await start('abc def ghi\n\nzzz\n', 'def');
  await B.selectText('def');
  await page.keyboard.press('Meta+x');
  await settle();
  const s1 = await B.source();
  await clickText(page, 'zzz', 2, { side: 'right' });
  await waitSession();
  await B.caretAt('zzz');
  await page.keyboard.press('Meta+v');
  await settle();
  const v = await view(page);
  return { ok: s1 === 'abc ghi\n\nzzz\n' && v.src === 'abc ghi\n\nzzzdef\n', detail: `afterCut=${J(s1)} afterPaste=${J(v.src)}` };
});

def('dblclick-word-paste', async () => {
  await B.loadDoc('Some words here to replace now.\n\nz\n');
  await sleep(650);
  const { pointOf } = await import('./v3-ses-lib.mjs');
  const p = await pointOf(page, 'here', 1);
  await page.mouse.dblclick(p.x, p.y);
  await sleep(250);
  const sel = await page.evaluate(() => getSelection().toString());
  await realPaste('there');
  await settle();
  const v = await view(page);
  return { ok: v.src === 'Some words there to replace now.\n\nz\n', detail: `sel=${J(sel)} src=${J(v.src)} live=${!!v.editing}` };
});
def('dblclick-word-type', async () => {
  await B.loadDoc('Some words here to replace now.\n\nz\n');
  await sleep(650);
  const { pointOf } = await import('./v3-ses-lib.mjs');
  const p = await pointOf(page, 'here', 1);
  await page.mouse.dblclick(p.x, p.y);
  await sleep(250);
  await page.keyboard.type('there');
  await settle();
  const v = await view(page);
  return { ok: v.src === 'Some words there to replace now.\n\nz\n', detail: `src=${J(v.src)}` };
});
def('doc-zwsp-kept-on-edit', async () => {
  const doc = 'a' + ZW + 'b cd\n\nz\n';
  await start(doc, 'cd');
  await B.caretAt('cd');
  await page.keyboard.type('X');
  await settle();
  const v = await view(page);
  return { ok: v.src === 'a' + ZW + 'b cdX\n\nz\n' || /此块请在源码中编辑/.test(v.toast), detail: `src=${J(v.src)} toast=${J(v.toast)}` };
});

let bad = 0;
try {
  await B.boot('mode=split');
  for (const c of cases) {
    if (filter && (filter.startsWith('!') ? c.name.includes(filter.slice(1)) : !c.name.includes(filter))) continue;
    try {
      const r = await c.fn();
      if (!check(c.name, r.ok, r.detail)) bad++;
    } catch (e) { bad++; check(c.name, false, 'threw ' + String(e.message).split('\n')[0]); }
    try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
  }
  console.log('pageErrors', J(B.pageErrors.slice(0, 3)), 'console', J(B.consoleErrors.filter((x) => !/DevTools|Download/.test(x)).slice(0, 3)));
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
