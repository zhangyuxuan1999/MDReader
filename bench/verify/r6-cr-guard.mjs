// bench/verify/r6-cr-guard.mjs — challenge-refs (0.2.0 stage 2g, fix round 6): does THE GUARD of inlineEdit.ts
// (replaceSource / writeReveals / userPut) refuse anything in ordinary use? Sessions in the app that put text with
// characters the guard counts into a block: emoji (ZWJ sequences, skin tones, flags, keycaps, VS16, tag flags) through
// keyboard.insertText and keyboard.type; IME compositions through CDP (Input.imeSetComposition + Input.insertText:
// Persian with ZWNJ, Hindi with virama, emoji); a paste (synthetic ClipboardEvent, text/plain) holding NBSP, ZWSP,
// RLM, U+3000 and a tab; consecutive typed spaces; a simulated replacement (beforeinput insertReplacementText with a
// DataTransfer, then the edit); the link box (Cmd+K); a long session with splits; split, merge and history steps
// between typed emoji; deleting a raw emoji the document holds; a typed character next to a document's own &zwj;.
// For each case: the guard's console lines (fired / starts), the toast 此块请在源码中编辑, and whether the source after
// Esc holds what was put in (`want`: a substring) and nothing else changed outside the block.
// Run: MDR_PORT=<dev server> node bench/verify/r6-cr-guard.mjs [filter]   (T_MS: global timeout, default 110000)
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
const ZWJ = C(0x200d), ZWNJ = C(0x200c), VS16 = C(0xfe0f), NBSP = C(0xa0), ZWSP = C(0x200b), RLM = C(0x200f), IDSP = C(0x3000);
const FAMILY = C(0x1f468) + ZWJ + C(0x1f469) + ZWJ + C(0x1f467);
const THUMB = C(0x1f44d, 0x1f3fd);
const FLAG = C(0x1f1e8, 0x1f1f3);
const KEYCAP = '1' + VS16 + C(0x20e3);
const HEART = C(0x2764) + VS16;
const SCOT = C(0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f);
const PERSIAN = C(0x645, 0x6cc) + ZWNJ + C(0x62e, 0x648, 0x627, 0x647, 0x645);
const HINDI = C(0x915, 0x94d, 0x937, 0x924, 0x94d, 0x930, 0x93f, 0x92f);
const NAMASTE = C(0x928, 0x92e, 0x938, 0x94d, 0x924, 0x947);
const EMOJIS = FAMILY + ' ' + THUMB + ' ' + FLAG + ' ' + KEYCAP + ' ' + HEART + ' ' + SCOT;
const PASTE = 'p' + NBSP + 'q' + ZWSP + 'r' + RLM + 's' + IDSP + 't\tu';

// [name, the block's source, steps]; a step: ['insert', text] | ['type', text] | ['ime', composing, committed] |
// ['paste', text] | ['replace', text] | ['key', key] | ['link', url] | ['caret', word (caret after its last occurrence)] |
// ['select', word] | ['wait', ms]; want: substrings the source must hold afterwards
const CASES = [
  ['emoji-insertText', 'Para words end text', [['caret', 'words'], ['insert', ' ' + EMOJIS]], [EMOJIS]],
  ['emoji-type', 'Para words end text', [['caret', 'words'], ['type', ' ' + FAMILY + THUMB + HEART]], [FAMILY + THUMB + HEART]],
  ['ime-persian', 'Para words end text', [['caret', 'words'], ['insert', ' '], ['ime', C(0x645), PERSIAN]], [PERSIAN]],
  ['ime-hindi', 'Para words end text', [['caret', 'words'], ['insert', ' '], ['ime', C(0x915, 0x94d), HINDI], ['insert', ' '], ['ime', C(0x928), NAMASTE]], [HINDI, NAMASTE]],
  ['ime-emoji', 'Para words end text', [['caret', 'words'], ['ime', FAMILY, FAMILY + VS16]], [FAMILY]],
  ['insert-persian', 'Para words end text', [['caret', 'words'], ['insert', ' ' + PERSIAN]], [PERSIAN]],
  ['paste-invisibles', 'Para words end text', [['caret', 'words'], ['paste', PASTE]], ['p', 'u']],
  ['spaces', 'Para words end text', [['caret', 'words'], ['type', 'a    b  c']], ['wordsa']],
  ['replace', 'Para wrods end text', [['select', 'wrods'], ['replace', 'words' + ZWJ + 'x']], ['words']],
  ['linkbox', 'Para words end text', [['select', 'words'], ['key', 'Meta+k'], ['wait', 300], ['type', 'https://e.example/p'], ['key', 'Enter']], ['https://e.example/p']],
  ['long-splits', 'Para words end text', [['caret', 'words'], ...Array.from({ length: 6 }, (_, i) => [['type', ` w${i} `], ['insert', THUMB + FLAG], ['key', 'Enter'], ['wait', 250]]).flat()], [THUMB + FLAG]],
  ['split-merge-history', 'Para words end text', [['caret', 'words'], ['insert', FAMILY], ['key', 'Enter'], ['wait', 300], ['insert', HEART], ['key', 'Home'], ['key', 'Backspace'], ['wait', 300], ['key', 'Meta+z'], ['wait', 300], ['key', 'Meta+Shift+z'], ['wait', 300], ['insert', SCOT]], [SCOT]],
  ['paste-resume', 'Para words end text', [['caret', 'words'], ['paste', 'one' + ZWJ + 'two\n\nthree' + RLM + 'four'], ['wait', 400], ['insert', THUMB]], [THUMB]],
  ['doc-emoji-delete', `Para ${FAMILY} words end text`, [['caret', 'words'], ['type', 'Y'], ['caret', FAMILY], ['key', 'Backspace'], ['type', 'Z']], ['wordsY']],
  ['doc-zwj-ref', 'Para a&zwj;b words end text', [['caret', 'words'], ['type', 'Y']], ['a&zwj;b wordsY']],
  ['doc-emoji-ref-next', `Para ${FAMILY} &shy; words end text`, [['caret', 'words'], ['insert', THUMB]], ['&shy; words' + THUMB]],
  ['quote-ime', '> Para words end text', [['caret', 'words'], ['insert', ' '], ['ime', C(0x645), PERSIAN]], [PERSIAN]],
  ['item-emoji', '- Para words end text\n- two', [['caret', 'words'], ['insert', FAMILY], ['key', 'Enter'], ['wait', 300], ['insert', FLAG]], [FAMILY, FLAG]],
  ['cell-emoji', '| h | k |\n| --- | --- |\n| Para words | end text |', [['caret', 'words'], ['insert', KEYCAP + SCOT]], [KEYCAP + SCOT]],
  ['code-ime', 'Para `code words` end text', [['caret', 'words'], ['ime', C(0x645), PERSIAN]], [PERSIAN]],
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
  const cdp = await page.context().newCDPSession(page);
  for (const [name, para, steps, want] of CASES) {
    guard.length = 0;
    await page.keyboard.press('Escape');
    const doc = `# Guard\n\nfiller\n\n${para}\n\nlast paragraph\n`;
    await page.evaluate(([t]) => window.__mdr.loadText(t, 'guard.md'), [doc]);
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(900);
    const at = await page.evaluate(() => {
      const root = window.__mdr.app.preview.el;
      const tw = document.createTreeWalker(root, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf('end text'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 2); const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; } }
      return null;
    });
    if (!at) { console.log(`FAIL ${name}: no target`); bad++; continue; }
    await page.mouse.click(at.x, at.y);
    await sleep(450);
    const started = await page.evaluate(() => !!document.querySelector('.md-block.is-editing'));
    let toast = false;
    for (const st of steps) {
      const [k, a, b] = st;
      if (k === 'caret' || k === 'select') {
        await page.evaluate(([wd, sel]) => {
          const el = document.querySelector('.md-block.is-editing');
          if (!el) return;
          const tw = document.createTreeWalker(el, 4);
          let last = null, li = -1;
          for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.lastIndexOf(wd); if (i >= 0) { last = n; li = i; } }
          if (!last) return;
          const r = document.createRange();
          if (sel) { r.setStart(last, li); r.setEnd(last, li + wd.length); } else { r.setStart(last, li + wd.length); r.collapse(true); }
          const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        }, [a, k === 'select']);
      } else if (k === 'insert') await page.keyboard.insertText(a);
      else if (k === 'type') await page.keyboard.type(a, { delay: 15 });
      else if (k === 'key') await page.keyboard.press(a);
      else if (k === 'wait') await sleep(a);
      else if (k === 'ime') {
        for (let i = 1; i <= Array.from(a).length; i++) {
          const part = Array.from(a).slice(0, i).join('');
          await cdp.send('Input.imeSetComposition', { text: part, selectionStart: part.length, selectionEnd: part.length });
          await sleep(30);
        }
        await cdp.send('Input.insertText', { text: b });
      } else if (k === 'paste') {
        await page.evaluate(([t]) => {
          const el = document.querySelector('.md-block.is-editing');
          const dt = new DataTransfer(); dt.setData('text/plain', t);
          (document.activeElement ?? el).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        }, [a]);
      } else if (k === 'replace') {
        await page.evaluate(([t]) => {
          const el = document.querySelector('.md-block.is-editing');
          const dt = new DataTransfer(); dt.setData('text/plain', t);
          const target = getSelection().anchorNode?.parentElement ?? el;
          const ev = new InputEvent('beforeinput', { inputType: 'insertReplacementText', dataTransfer: dt, bubbles: true, cancelable: true });
          if (target.dispatchEvent(ev)) document.execCommand('insertText', false, t);
        }, [a]);
      } else if (k === 'link') { /* (the link box is driven by keys) */ }
      await sleep(120);
      if (await page.evaluate(() => document.body.innerText.includes('此块请在源码中编辑'))) toast = true;
    }
    await sleep(400);
    if (await page.evaluate(() => document.body.innerText.includes('此块请在源码中编辑'))) toast = true;
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(500);
    const out = await page.evaluate(() => window.__mdr.app.getText());
    const head = out.startsWith('# Guard\n\nfiller\n\n'), tail = out.endsWith('\n\nlast paragraph\n');
    const missing = want.filter((w) => !out.includes(w));
    const ok = started && guard.length === 0 && !toast && missing.length === 0 && head && tail;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: started=${started} guard=${guard.length}${guard.length ? ' ' + JSON.stringify(guard) : ''} toast=${toast} missing=${show(missing.join('|'))} outside=${head && tail ? 'same' : 'CHANGED'} source=${show(out.replace(/^# Guard\n\nfiller\n\n/, '').replace(/\n\nlast paragraph\n$/, ''))}`);
  }
} finally { await browser.close(); clearTimeout(killer); }
console.log(`RESULT ${bad === 0 ? 'PASS' : 'FAIL'} bad=${bad} of ${CASES.length}`);
process.exit(bad === 0 ? 0 : 1);
