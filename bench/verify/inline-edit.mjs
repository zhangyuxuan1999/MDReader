// bench/verify/inline-edit.mjs — real-browser verification of in-preview editing (CONTRACT §11).
//
// Run:  MDR_PORT=5272 node bench/verify/inline-edit.mjs   (starts and stops its own vite on that port), or
//       MDR_BASE=http://localhost:5261 node bench/verify/inline-edit.mjs   (against a vite you started)
// Exit code 0 = every check passed, 1 = at least one failed. Console errors and page errors fail the run.
// HEADED=1 shows the browser; SHOTS=<dir> saves a few screenshots.
import { chromium } from '@playwright/test';
import { startServer, stopServer, BASE as LIB_BASE } from './inline-verify-lib.mjs';

const OWN_SERVER = !process.env.MDR_BASE && !!process.env.MDR_PORT;
const BASE = process.env.MDR_BASE ?? (OWN_SERVER ? LIB_BASE : 'http://localhost:5261');
// Global time limit: a hung browser step must not keep the run (and its vite) alive.
const killer = setTimeout(() => { console.log('FAIL  global timeout (8 min)'); try { stopServer(); } catch { /* */ } process.exit(2); }, 8 * 60_000);
if (OWN_SERVER) await startServer();
const HEADLESS = process.env.HEADED !== '1';
const SHOTS = process.env.SHOTS ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
async function step(name, fn) {
  try {
    const detail = await fn();
    check(name, true, typeof detail === 'string' ? detail : '');
  } catch (err) {
    check(name, false, err instanceof Error ? err.message.split('\n')[0] : String(err));
  }
}
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const eq = (a, b, what) => assert(a === b, `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

const browser = await chromium.launch({ headless: HEADLESS });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack : e)));
page.on('dialog', (d) => d.dismiss().catch(() => {}));

async function boot() {
  // Vite may re-optimize dependencies and reload the page once: load twice, keep the second one.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(`${BASE}/?mode=split`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
      await sleep(attempt === 0 ? 1500 : 300);
      if (attempt > 0) break;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  consoleErrors.length = 0;
  pageErrors.length = 0;
}

async function load(text) {
  await page.evaluate(() => window.__mdr.app.preview.endEditSession());
  await page.evaluate((t) => window.__mdr.loadText(t, 'inline-edit.md'), text);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(300);
}
const source = () => page.evaluate(() => window.__mdr.app.getText());
const editing = () => page.evaluate(() => {
  const e = document.querySelector('.mdr-preview .is-editing');
  return e ? { id: Number(e.dataset.id), text: e.textContent, ce: e.getAttribute('contenteditable') } : null;
});
/** Mouse click near the right end of the element's last line (puts the caret at its end). */
async function clickEnd(locator) {
  await locator.scrollIntoViewIfNeeded();
  const rects = await locator.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const all = Array.from(r.getClientRects()).filter((x) => x.width > 0);
    const last = all[all.length - 1] ?? el.getBoundingClientRect();
    return { x: last.right, y: last.top + last.height / 2 };
  });
  await page.mouse.click(rects.x - 1, rects.y);
  await sleep(60);
}
async function caretToEnd() {
  await page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const sel = getSelection();
    const node = sel.focusNode;
    const host = node && (node.nodeType === 1 ? node : node.parentElement).closest('p, li, h1, h2, h3, h4, h5, h6, td, th, pre') || el;
    const r = document.createRange();
    r.selectNodeContents(host);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  });
}
const settle = async (ms = 350) => { await sleep(ms); await page.evaluate(() => window.__mdr.waitIdle()); };
const esc = async () => { await page.keyboard.press('Escape'); await settle(); };

await boot();

// ================================================================ basics
const BASIC = '# Title\n\nFirst paragraph here.\n\nSecond para.\n\n---\n\n<div>raw html</div>\n\nLast.\n';
await load(BASIC);

await step('preview editing is on by default and a click starts a session on that block', async () => {
  eq(await page.evaluate(() => window.__mdr.app.preview.isPreviewEditable()), true, 'isPreviewEditable');
  await clickEnd(page.locator('.mdr-preview p', { hasText: 'First paragraph' }));
  const e = await editing();
  assert(e && e.ce === 'true', 'no contenteditable session after the click');
  const look = await page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const cs = getComputedStyle(el);
    const hint = document.querySelector('.mdr-preview__edit-hint');
    const hr = hint.getBoundingClientRect();
    const pane = document.querySelector('.mdr-pane--preview').getBoundingClientRect();
    return {
      outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineOffset}`, caret: cs.caretColor,
      hint: !hint.hidden && hr.width > 0, hintText: hint.textContent,
      hintInside: hr.right <= pane.right && hr.bottom <= pane.bottom && hr.bottom > pane.bottom - 60,
      focus: !!el.querySelector('.is-focus'), active: document.activeElement === el,
    };
  });
  assert(look.outline.startsWith('dashed 1px 6px'), `outline ${look.outline}`);
  assert(look.hint && look.hintInside, 'hint bar should be visible at the bottom-right of the preview pane');
  assert(look.hintText.includes('Esc 结束'), `hint text ${look.hintText}`);
  assert(look.focus, 'the click that starts editing should also tint the focus line');
  assert(look.active, 'the edited block should have focus');
  eq(await source(), BASIC, 'source must be untouched until the DOM changes');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/inline-edit-session.png` });
  return `outline ${look.outline}, caret ${look.caret}`;
});

await step('typing writes through to the source; the edited DOM is not re-rendered meanwhile', async () => {
  const before = await page.evaluate(() => { window.__p = document.querySelector('.mdr-preview .is-editing p'); return true; });
  assert(before, 'no paragraph');
  await page.keyboard.type(' More text', { delay: 15 });
  await settle();
  eq((await source()).split('\n')[2], 'First paragraph here. More text', 'line 3');
  eq(await page.evaluate(() => document.querySelector('.mdr-preview .is-editing p') === window.__p), true, 'same <p> node while editing');
  return 'source follows, DOM kept';
});

await step('typed Markdown syntax stays literal: no two-space / backtick rituals needed', async () => {
  await page.keyboard.type(' *not em* `tick` # [x] $5', { delay: 10 });
  await settle();
  // How much is escaped is the serializer's choice (0.2.0 escapes less: `\[x]`, a lone `$5`); what matters
  // is that every character stays literal text.
  const l3 = (await source()).split('\n')[2];
  assert(/^First paragraph here\. More text \\\*not em\\\* \\`tick\\` # \\\[x\\?\] \\?\$5$/.test(l3), `escaped source: ${JSON.stringify(l3)}`);
  return (await source()).split('\n')[2];
});

await step('Shift+Enter writes a hard line break (two trailing spaces)', async () => {
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('second line', { delay: 10 });
  await settle();
  const lines = (await source()).split('\n');
  assert(lines[2].endsWith('$5  '), `line 3 should end with two spaces: ${JSON.stringify(lines[2])}`);
  eq(lines[3], 'second line', 'line 4');
  return JSON.stringify(lines.slice(2, 4));
});

await step('Enter creates a new paragraph block; fast typing continues there without losing keys', async () => {
  await page.keyboard.press('Enter');
  await page.keyboard.type('Brand new paragraph', { delay: 0 });
  await settle(600);
  const lines = (await source()).split('\n');
  eq(lines[3], 'second line', 'the old block keeps its text');
  eq(lines[4], '', 'blank line between the blocks');
  eq(lines[5], 'Brand new paragraph', 'new paragraph');
  const e = await editing();
  assert(e && e.text.trim() === 'Brand new paragraph', `the session should continue on the new block, got ${JSON.stringify(e)}`);
  await page.keyboard.type('!');
  await settle();
  eq((await source()).split('\n')[5], 'Brand new paragraph!', 'typing after the split');
  return 'split + resume + replay';
});

await step('Esc ends the session and the block re-renders from the worker', async () => {
  const id = (await editing()).id;
  await page.evaluate(() => { window.__p = document.querySelector('.mdr-preview .is-editing p'); });
  await esc();
  eq(await editing(), null, 'no session after Esc');
  const r = await page.evaluate((i) => {
    const w = document.querySelector(`.mdr-preview section.md-block[data-id="${i}"]`);
    return { ce: w.hasAttribute('contenteditable'), replaced: w.querySelector('p') !== window.__p, hint: document.querySelector('.mdr-preview__edit-hint').hidden };
  }, id);
  assert(!r.ce && r.replaced && r.hint, JSON.stringify(r));
  return 're-rendered, hint hidden';
});

await step('non-editable blocks (hr, raw HTML) are refused with a toast', async () => {
  const toasts = await page.evaluate(() => { window.__toasts = []; window.__mdr.app.bus.on('toast', (t) => window.__toasts.push(t.text)); return true; });
  assert(toasts, 'bus');
  await page.locator('.mdr-preview hr').click();
  await sleep(100);
  eq(await editing(), null, 'no session on <hr>');
  await page.locator('.mdr-preview div', { hasText: 'raw html' }).last().click();
  await sleep(100);
  eq(await editing(), null, 'no session on raw HTML');
  const t = await page.evaluate(() => window.__toasts);
  assert(t.filter((x) => x === '此块请在源码中编辑').length === 2, `toasts ${JSON.stringify(t)}`);
  return 'refused twice';
});

await step('clicking into the editor ends the session', async () => {
  await clickEnd(page.locator('.mdr-preview p', { hasText: 'Last.' }));
  assert(await editing(), 'session should start');
  await page.keyboard.type('x');
  await page.locator('.cm-content .cm-line').first().click();
  await sleep(150);
  eq(await editing(), null, 'session ended on blur');
  assert((await source()).includes('Last.x'), 'pending text committed');
  return 'ended by blur';
});

// ================================================================ formatting keys
await load('Format me please.\n\nnext\n');
await step('⌘B / ⌘I / ⌘E / ⌘K format the selection', async () => {
  const p = page.locator('.mdr-preview p', { hasText: 'Format me' });
  await clickEnd(p);
  // select "please"
  await page.evaluate(() => {
    const t = document.querySelector('.mdr-preview .is-editing p').firstChild;
    const r = document.createRange();
    r.setStart(t, 10); r.setEnd(t, 16);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await page.keyboard.press('ControlOrMeta+b');
  await settle();
  eq((await source()).split('\n')[0], 'Format me **please**.', 'bold');
  await page.evaluate(() => {
    const t = document.querySelector('.mdr-preview .is-editing p').firstChild;
    const r = document.createRange();
    r.setStart(t, 0); r.setEnd(t, 6);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await page.keyboard.press('ControlOrMeta+i');
  await settle();
  eq((await source()).split('\n')[0], '*Format* me **please**.', 'italic');
  await caretToEnd();
  await page.keyboard.type(' x');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('ControlOrMeta+e');
  await page.keyboard.type('y');
  await settle();
  eq((await source()).split('\n')[0], '*Format* me **please**. `x`y', 'inline code, typing continues outside it');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('ControlOrMeta+k');
  await sleep(100);
  assert(await page.evaluate(() => document.activeElement?.closest('.mdr-preview__link-input') !== null), 'link input should take focus');
  await page.keyboard.type('https://example.com');
  await page.keyboard.press('Enter');
  await settle();
  eq((await source()).split('\n')[0], '*Format* me **please**. `x`[y](https://example.com)', 'link');
  assert(await editing(), 'the session survives the link input');
  await esc();
  return (await source()).split('\n')[0];
});

await step('a link click while editing places the caret (no navigation), ⌘Z undoes in the block', async () => {
  const pages = context.pages().length;
  // Start the session on the paragraph's text: its right end is the link, and a plain click on a link
  // outside a session navigates (CONTRACT §11 integration deltas).
  await page.locator('.mdr-preview p', { hasText: 'Format me' }).click({ position: { x: 3, y: 6 } });
  assert(await editing(), 'no session from a click on the text');
  await page.locator('.mdr-preview a', { hasText: 'y' }).click();
  await sleep(200);
  eq(context.pages().length, pages, 'no new tab');
  assert(page.url().startsWith(BASE), 'no navigation');
  assert(await editing(), 'still editing');
  await caretToEnd();
  await page.keyboard.type('ZZ');
  await settle();
  assert((await source()).includes('ZZ'), 'typed');
  await page.keyboard.press('ControlOrMeta+z');
  await settle();
  assert(!(await source()).includes('ZZ'), `undo should remove the typing: ${(await source()).split('\n')[0]}`);
  await esc();
  return 'ok';
});

// ================================================================ headings, lists, tasks
await load('## Heading\n\n- one\n- two\n\nbetween\n\n- [ ] task a\n- [x] task b\n\ntail\n');
await step('Enter in a heading creates a paragraph block below it', async () => {
  await clickEnd(page.locator('.mdr-preview h2'));
  await page.keyboard.press('Enter');
  await page.keyboard.type('Under the heading');
  await settle(600);
  const lines = (await source()).split('\n');
  eq(lines[0], '## Heading', 'heading');
  eq(lines[2], 'Under the heading', 'paragraph');
  const e = await editing();
  assert(e && e.text.trim() === 'Under the heading', 'session continues in the paragraph');
  eq(await page.evaluate(() => document.querySelector('.mdr-preview .is-editing').firstElementChild.tagName), 'P', 'a paragraph, not a heading');
  await esc();
  return 'ok';
});

await step('lists: Enter adds an item, Tab / Shift+Tab indent and outdent, Enter on an empty item leaves the list', async () => {
  await clickEnd(page.locator('.mdr-preview li', { hasText: 'two' }).first());
  await page.keyboard.press('Enter');
  await page.keyboard.type('three');
  await settle();
  assert((await source()).includes('- one\n- two\n- three'), `new item: ${JSON.stringify(await source())}`);
  await page.keyboard.press('Tab');
  await settle();
  assert((await source()).includes('- two\n  - three'), 'indent');
  await page.keyboard.press('Shift+Tab');
  await settle();
  assert((await source()).includes('- two\n- three'), 'outdent');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('After the list');
  await settle(600);
  assert((await source()).includes('- three\n\nAfter the list\n'), `leave the list: ${JSON.stringify(await source())}`);
  const e = await editing();
  assert(e && e.text.trim() === 'After the list', `session on the new paragraph, got ${JSON.stringify(e)}`);
  await esc();
  return 'ok';
});

await step('task checkboxes toggle inside a session; Enter continues a task list', async () => {
  await clickEnd(page.locator('.mdr-preview li', { hasText: 'task a' }));
  await page.locator('.mdr-preview li', { hasText: 'task a' }).locator('input').click();
  await settle();
  assert((await source()).includes('- [x] task a'), 'checkbox serialized');
  await clickEnd(page.locator('.mdr-preview li', { hasText: 'task b' }));
  await page.keyboard.press('Enter');
  await page.keyboard.type('task c');
  await settle();
  assert((await source()).includes('- [x] task b\n- [ ] task c'), `new task item: ${JSON.stringify(await source())}`);
  await esc();
  return 'ok';
});

// ================================================================ code, table, math, IME, paste
await load('```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nInline $x^2$ here.\n\n$$\nE = mc^2\n$$\n\nplain\n');
await step('code block: Enter is a newline, the fence and language are kept', async () => {
  await clickEnd(page.locator('.mdr-preview pre code'));
  await page.keyboard.press('Enter');
  await page.keyboard.type('let b = 2;');
  await settle();
  assert((await source()).startsWith('```js\nconst a = 1;\nlet b = 2;\n```\n'), JSON.stringify((await source()).slice(0, 60)));
  await esc();
  return 'ok';
});

await step('table: typing in cells, Tab moves between cells, pipes are escaped, Enter does nothing', async () => {
  await clickEnd(page.locator('.mdr-preview td', { hasText: '1' }));
  await page.keyboard.type('0');
  await page.keyboard.press('Tab');
  await page.keyboard.type('|x');
  await page.keyboard.press('Enter');
  await settle();
  assert((await source()).includes('| 10 | 2\\|x |'), JSON.stringify(await source()));
  await esc();
  return 'ok';
});

await step('formulas: a click shows the TeX source, edits write $…$ / $$…$$, Esc renders again', async () => {
  const m = await page.locator('.mdr-preview p .md-math').first().boundingBox();
  await page.mouse.click(m.x + m.width / 2, m.y + m.height / 2);
  await sleep(100);
  eq(await page.evaluate(() => document.querySelector('.mdr-preview .md-math-src')?.textContent), 'x^2', 'inline TeX shown');
  await page.keyboard.type('+1');
  await settle();
  assert((await source()).includes('Inline $x^2+1$ here.'), 'inline formula written');
  await esc();
  eq(await page.evaluate(() => document.querySelectorAll('.mdr-preview .md-math-src').length), 0, 'rendered again');
  const b = await page.locator('.mdr-preview .md-math--block').boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await sleep(100);
  await page.keyboard.press('Enter');
  await page.keyboard.type('\\\\ a_b');
  await settle();
  assert((await source()).includes('$$\nE = mc^2\n\\\\ a_b\n$$'), JSON.stringify(await source()));
  await esc();
  return 'ok';
});

await step('IME composition writes nothing until it is committed', async () => {
  await clickEnd(page.locator('.mdr-preview p', { hasText: 'plain' }));
  const cdp = await context.newCDPSession(page);
  const before = await source();
  for (const t of ['z', 'zh', 'zho', 'zhon', 'zhong']) {
    await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
    await sleep(40);
  }
  await sleep(200);
  eq(await source(), before, 'no write during composition');
  await cdp.send('Input.insertText', { text: '中' });
  await settle();
  assert((await source()).includes('plain中'), JSON.stringify(await source()));
  await cdp.detach();
  return 'ok';
});

await step('paste inserts plain text; newlines become hard breaks, Markdown stays literal', async () => {
  await caretToEnd();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', ' **p1**\np2');
    dt.setData('text/html', '<b>ignored</b>');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await settle();
  assert((await source()).includes('plain中 \\*\\*p1\\*\\*  \np2'), JSON.stringify(await source()));
  await esc();
  return 'ok';
});

// ================================================================ toggle, large document
await step('turning 预览可编辑 off stops sessions (and on again restores them)', async () => {
  await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable(false));
  await page.locator('.mdr-preview p', { hasText: 'plain' }).click();
  await sleep(100);
  eq(await editing(), null, 'no session while off');
  await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable(true));
  await clickEnd(page.locator('.mdr-preview p', { hasText: 'plain' }));
  assert(await editing(), 'session again');
  await esc();
  return 'ok';
});

await step('endEditSession writes what the next frame would have written, synchronously, and emits {id:null}', async () => {
  await clickEnd(page.locator('.mdr-preview p', { hasText: 'plain' }));
  assert(await editing(), 'no session');
  const r = await page.evaluate(() => {
    const events = [];
    const off = window.__mdr.app.bus.on('previewEdit:session', (e) => events.push(e.id));
    document.execCommand('insertText', false, ' SYNC');   // no frame between this and endEditSession
    window.__mdr.app.preview.endEditSession();
    const text = window.__mdr.app.getText();
    const still = !!document.querySelector('.mdr-preview .is-editing');
    off?.();
    return { hasSync: /p2 SYNC/.test(text), still, events, line: text.split('\n').filter((l) => l.includes('SYNC')) };
  });
  assert(r.hasSync, `the typed text was not in the source when endEditSession returned: ${JSON.stringify(r)}`);
  assert(!r.still, 'still editing after endEditSession');
  eq(JSON.stringify(r.events), '[null]', 'session events');
  return 'ok';
});

await step('toolbar 加粗 during a session formats the selection in the preview (no mode switch)', async () => {
  await settle();
  await page.evaluate(() => window.__mdr.waitIdle());
  const loc = page.locator('.mdr-preview p', { hasText: 'SYNC' });
  await clickEnd(loc);
  assert(await editing(), 'no session');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await page.locator('.mdr-toolbar [data-cmd="edit.bold"]').click();
  await settle();
  const t = await source();
  assert(/ \*\*SYNC\*\*/.test(t), `source: ${JSON.stringify(t.split('\n').find((l) => l.includes('SYNC')))}`);
  assert(await editing(), 'the session ended on the toolbar click');
  await esc();
  return 'ok';
});

await step('large document: editing deep in medium.md, the pane does not jump, the block survives scrolling away', async () => {
  await page.evaluate(() => window.__mdr.app.preview.endEditSession());
  await page.evaluate(() => window.__mdr.loadUrl('/test-data/medium.md'));
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(500);
  await page.evaluate(() => window.__mdr.mode('preview'));
  await sleep(300);
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(10000));
  await sleep(800);
  await page.evaluate(() => window.__mdr.waitIdle());
  const target = page.locator('.mdr-preview .md-block:not(.is-pending) > p').filter({ hasText: '这是一个用于性能测试的段落' }).nth(1);
  await clickEnd(target);
  const e = await editing();
  assert(e, 'no session');
  // Where the edited block sits on screen (scroll anchoring may adjust scrollTop; what must not move is the text).
  const blockTop = () => page.evaluate(() => Math.round(document.querySelector('.mdr-preview .is-editing').getBoundingClientRect().top));
  const top0 = await blockTop();
  const t0 = Date.now();
  await page.keyboard.type(' 追加文字 appended', { delay: 20 });
  const typingMs = Date.now() - t0;
  await settle();
  const top1 = await blockTop();
  assert(Math.abs(top1 - top0) < 3, `the edited block moved on screen while typing: ${top0} → ${top1}`);
  const line = await page.evaluate((id) => {
    const pv = window.__mdr.app.preview;
    const el = pv.elementOfBlock(id);
    const b = pv.blockOfElement(el);
    return window.__mdr.app.getText().split('\n')[b.startLine - 1];
  }, e.id);
  assert(line.endsWith(' 追加文字 appended'), `source line: ${line.slice(-40)}`);
  // scroll far away and back: the session block is never evicted
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(1));
  await sleep(1500);
  const alive = await page.evaluate((id) => { const el = window.__mdr.app.preview.elementOfBlock(id); return !!el && el.isConnected && el.classList.contains('is-editing'); }, e.id);
  assert(alive, 'the edited block lost its wrapper while scrolled away');
  await page.evaluate(() => window.__mdr.app.preview.endEditSession());
  await page.evaluate(() => window.__mdr.mode('split'));
  return `typing ${typingMs} ms for 16 keys, block stays put on screen`;
});

check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close().catch(() => {});
if (OWN_SERVER) stopServer();
clearTimeout(killer);
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
