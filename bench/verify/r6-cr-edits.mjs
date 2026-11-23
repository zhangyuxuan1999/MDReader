// bench/verify/r6-cr-edits.mjs — challenge-refs (0.2.0 stage 2g, fix round 6): rule S in the app under the user's own
// gestures around a character the source spells as a reference (&shy; &zwnj; &#x2060; &lrm; &emsp;): Backspace that
// deletes it, a selection across it deleted, bold across it, a join of two list items / quote paragraphs next to it,
// a paste next to it, Enter after it, Enter then Backspace, typing then Cmd+Z and Shift+Cmd+Z, Esc and a second session,
// the &emsp;&emsp; indent idiom, a heading, a table cell. After each: no character that is not plainly visible is in
// the source more often than before (raw), every reference of one is still there unless the user deleted it, the guard
// did not fire, and the block re-rendered after Esc shows the text the session showed.
// Run: MDR_PORT=<dev server> node bench/verify/r6-cr-edits.mjs [filter]   (T_MS: global timeout, default 110000)
// Writes nothing into the tree. Characters are built from code points.
import { chromium } from '@playwright/test';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = process.argv[2] ?? '';
const T_MS = Number(process.env.T_MS ?? 110000);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, T_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = (...cps) => String.fromCodePoint(...cps);
const show = (s) => (s == null ? 'null' : JSON.stringify(s.replace(/[^\x20-\x7e\n]/gu, (c) => '<' + c.codePointAt(0).toString(16) + '>')));
const SHY = C(0xad), ZWNJ = C(0x200c), WJ = C(0x2060), LRM = C(0x200e), EMSP = C(0x2003);
const NOT_PLAIN = /[^\p{L}\p{N}\p{P}\p{S} \n\t]/u;
const rawOf = (s) => { const m = {}; for (const c of s) if (NOT_PLAIN.test(c)) m[c] = (m[c] ?? 0) + 1; return m; };
const REF = /&(?:shy|zwnj|zwj|lrm|rlm|emsp|ensp|NoBreak|#[0-9]+|#[xX][0-9a-fA-F]+);/g;
const refCount = (s) => (s.match(REF) ?? []).length;
// [name, block, steps, the user deletes a hidden character (refs may drop)]; a step: ['caret', text] (caret after the
// last occurrence of text) | ['caretStart', text] (before it) | ['select', from, to] | ['key', k] | ['type', t] |
// ['paste', t] | ['wait', ms] | ['esc-click']
const CASES = [
  ['bs-deletes-it', `Para a&shy;b words end text`, [['caret', 'a' + SHY], ['key', 'Backspace']], true],
  ['selection-deleted', `Para a&zwnj;b words end text`, [['select', 'a', 'b'], ['key', 'Backspace']], true],
  ['bold-across', `Para xa&zwnj;bx words end text`, [['select', 'a', 'b'], ['key', 'Meta+b']]],
  ['italic-across-emsp', `Para a&emsp;b words end text`, [['select', 'a', 'b'], ['key', 'Meta+i']]],
  ['join-list-items', `- one a&#x2060;b\n- two words end text`, [['caretStart', 'two'], ['key', 'Backspace'], ['wait', 300], ['type', 'Y']]],
  ['join-quote-paras', `> one a&zwnj;b\n>\n> two words end text`, [['caretStart', 'two'], ['key', 'Backspace'], ['wait', 300], ['type', 'Y']]],
  ['join-paras', `one a&shy;b\n\ntwo words end text`, [['caretStart', 'two'], ['key', 'Backspace'], ['wait', 400], ['type', 'Y']]],
  ['paste-next-to-it', `Para a&shy;b words end text`, [['caret', 'a' + SHY], ['paste', 'P']]],
  ['enter-after-it', `Para a&shy;b words end text`, [['caret', 'a' + SHY], ['key', 'Enter'], ['wait', 300], ['type', 'Y']]],
  ['enter-backspace', `Para a&lrm;b words end text`, [['caret', 'a' + LRM], ['key', 'Enter'], ['wait', 300], ['key', 'Backspace']]],
  ['undo-redo', `Para a&shy;b words end text`, [['caret', 'words'], ['type', 'X'], ['wait', 300], ['key', 'Meta+z'], ['wait', 300], ['key', 'Meta+Shift+z'], ['wait', 300]]],
  ['esc-second-session', `Para a&shy;b words end text`, [['caret', 'words'], ['type', 'X'], ['esc-click'], ['caret', 'wordsX'], ['type', 'Y']]],
  ['emsp-indent', `&emsp;&emsp;段落 words end text`, [['caretStart', '段落'], ['type', 'Q']]],
  ['heading', `## Title a&lrm;b words end text`, [['caret', 'words'], ['type', 'X']]],
  ['cell', `| h | k |\n| --- | --- |\n| a&shy;b | words end text |`, [['caret', 'words'], ['type', 'X']]],
  ['hidden-at-end', `Para words end text&zwnj;`, [['caret', 'words'], ['type', 'X']]],
  ['hidden-at-start', `&zwnj;Para words end text`, [['caret', 'words'], ['type', 'X']]],
  ['url-start-then-second', `See https://e.example/a%E2%80%8Db here words end text`, [['caret', 'https://'], ['type', 'Z'], ['esc-click'], ['caret', 'words'], ['type', 'Y']]],
  ['url-end-then-second', `See <https://e.example/a%E2%80%AEb> here words end text`, [['caret', 'a' + C(0x202e) + 'b'], ['type', 'Z'], ['esc-click'], ['caret', 'here'], ['type', 'Y']]],
  ['www-middle', `See www.e.example/a%E2%81%A0b here words end text`, [['caret', 'example/'], ['type', 'Z']]],
  ['email-middle', `See <u%E2%80%8Cv@e.example> here words end text`, [['caret', 'e.exam'], ['type', 'Z'], ['esc-click'], ['caret', 'words'], ['type', 'Y']]],
  ['linktext-hidden', `See [a&#x2060;b](https://e.example/p) here words end text`, [['caret', 'a' + C(0x2060)], ['type', 'Z']]],
].filter((c) => c[0].includes(filter));

let bad = 0;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  const guard = [];
  page.on('console', (m) => { if (m.text().includes('the write guard refused')) guard.push(m.text()); });
  await page.goto(`http://localhost:${port}/?perf=1&mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  await page.addStyleTag({ content: '[class*="mdr-perf"] { visibility: hidden !important; pointer-events: none !important; }' });
  const clickBlock = async () => {
    const at = await page.evaluate(() => {
      const root = window.__mdr.app.preview.el;
      const tw = document.createTreeWalker(root, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf('end text'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 2); const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; } }
      return null;
    });
    await page.mouse.click(at.x, at.y);
    await sleep(450);
  };
  const hrefs = () => page.evaluate(() => {
    const el = document.querySelector('.md-block.is-editing') ?? Array.from(document.querySelectorAll('.md-block')).find((b) => (b.textContent ?? '').includes('end text'));
    return el ? Array.from(el.querySelectorAll('a[href], img[src]')).map((a) => a.getAttribute('href') ?? a.getAttribute('src')).join(' ') : null;
  });
  const shownText = () => page.evaluate(() => {
    const el = document.querySelector('.md-block.is-editing') ?? Array.from(document.querySelectorAll('.md-block')).find((b) => (b.textContent ?? '').includes('end text'));
    return el ? (el.innerText ?? '').split(String.fromCharCode(0x200b)).join('').replace(/\s+/g, ' ').trim() : null;
  });
  for (const [name, para, steps, deletes] of CASES) {
    guard.length = 0;
    await page.keyboard.press('Escape');
    const doc = `# Edits\n\nfiller\n\n${para}\n\nlast paragraph\n`;
    await page.evaluate(([t]) => window.__mdr.loadText(t, 'edits.md'), [doc]);
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(900);
    const hrefBefore = await hrefs();
    await clickBlock();
    const started = await page.evaluate(() => !!document.querySelector('.md-block.is-editing'));
    for (const st of steps) {
      const [k, a, b] = st;
      if (k === 'caret' || k === 'caretStart' || k === 'select') {
        await page.evaluate(([kind, x, y]) => {
          const el = document.querySelector('.md-block.is-editing');
          if (!el) return;
          const tw = document.createTreeWalker(el, 4);
          const nodes = [];
          for (let n = tw.nextNode(); n; n = tw.nextNode()) nodes.push(n);
          const r = document.createRange();
          if (kind === 'select') {
            let s0 = null, s1 = null;
            for (const n of nodes) { if (!s0) { const i = n.data.indexOf(x); if (i >= 0) s0 = [n, i]; } if (s0 && !s1) { const j = n === s0[0] ? n.data.indexOf(y, s0[1] + x.length) : n.data.indexOf(y); if (j >= 0) s1 = [n, j + y.length]; } }
            if (!s0 || !s1) return;
            r.setStart(s0[0], s0[1]); r.setEnd(s1[0], s1[1]);
          } else {
            let last = null, li = -1;
            for (const n of nodes) { const i = n.data.lastIndexOf(x); if (i >= 0) { last = n; li = i; } }
            if (!last) return;
            r.setStart(last, kind === 'caret' ? li + x.length : li); r.collapse(true);
          }
          const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        }, [k, a, b]);
      } else if (k === 'key') await page.keyboard.press(a);
      else if (k === 'type') await page.keyboard.type(a, { delay: 15 });
      else if (k === 'wait') await sleep(a);
      else if (k === 'paste') {
        await page.evaluate(([t]) => {
          const dt = new DataTransfer(); dt.setData('text/plain', t);
          (document.activeElement ?? document.body).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        }, [a]);
      } else if (k === 'esc-click') {
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.__mdr.waitIdle());
        await sleep(900);
        await clickBlock();
      }
      await sleep(150);
    }
    await sleep(400);
    const inSession = await shownText();
    const toast = await page.evaluate(() => document.body.innerText.includes('此块请在源码中编辑'));
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(600);
    const after = await shownText();
    const full = await page.evaluate(() => window.__mdr.app.getText());
    const out = full.replace(/^# Edits\n\nfiller\n\n/, '').replace(/\n\nlast paragraph\n$/, '');
    const r0 = rawOf(para), r1 = rawOf(out);
    const rawAdded = Object.keys(r1).filter((c) => r1[c] > (r0[c] ?? 0));
    const refsLost = refCount(out) < refCount(para) && !deletes;
    const sameShown = inSession === after;
    const hrefAfter = await hrefs();
    const hrefSame = hrefAfter === hrefBefore;
    const ok = started && guard.length === 0 && !toast && rawAdded.length === 0 && !refsLost && sameShown && hrefSame;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: started=${started} guard=${guard.length} toast=${toast} rawAdded=${show(rawAdded.join(''))} refs=${refCount(para)}->${refCount(out)} sameShown=${sameShown} href=${hrefSame ? 'same' : 'CHANGED ' + show(hrefBefore) + ' -> ' + show(hrefAfter)} source=${show(out)}${sameShown ? '' : `\n     session ${show(inSession)}\n     after   ${show(after)}`}`);
  }
} finally { await browser.close(); clearTimeout(killer); }
console.log(`RESULT ${bad === 0 ? 'PASS' : 'FAIL'} bad=${bad} of ${CASES.length}`);
process.exit(bad === 0 ? 0 : 1);
