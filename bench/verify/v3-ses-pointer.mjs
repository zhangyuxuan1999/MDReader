// bench/verify/v3-ses-pointer.mjs — verify-session stage 2c: U7 pointer gestures in real Chromium (real mouse
// press / move / release through Playwright). Each case says where the caret is, whether a session started, what
// typing does and what the source holds. Copy cases compare the copied text with the same gesture while
// 预览可编辑 is off (setPreviewEditable(false)), which equals 0.1.1 (r1 G15).
// Run: MDR_PORT=5382 node bench/verify/v3-ses-pointer.mjs [name-filter]     (exit code 1 on a failure)
// Baseline (0.1.1 renderer, no editing): npx vite preview --outDir release/baseline-0.1.1.noindex/dist --port 5392 --strictPort
//   then MDR_PORT=5392 MDR_PERF=1 node bench/verify/v3-ses-pointer.mjs out-of-session
import { openB, sleep, globalTimeout, J, check, summary, view, shownText, pointOf, clickText, BASE, loadDocAny } from './v3-ses-lib.mjs';

const filter = process.argv[2] || '';
const B = await openB({ clipboard: true });
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
const DOC = 'First para alpha words here.\n\nSecond para beta words here.\n\nThird para gamma words here.\n\n- [ ] task one\n- [ ] task two\n\nA [link](https://example.com/x) in text.\n\nInline $x^2$ formula here.\n\n```js\nconst code = 1;\n```\n\nLast para omega.\n';
async function load(doc = DOC) {
  await page.evaluate(() => { window.__mdr.app.preview.setPreviewEditable?.(true); getSelection().removeAllRanges(); });
  await loadDocAny(B, doc); await sleep(650);
}
async function sessionText() { const v = await view(page); return v.editing ? v.editing.text : null; }
async function copied() {
  await page.evaluate(() => navigator.clipboard.writeText('<<none>>'));
  await page.keyboard.press('Meta+c');
  await sleep(150);
  return page.evaluate(() => navigator.clipboard.readText());
}
async function drag(a, b, steps = 12) {
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps); await sleep(15); }
  await page.mouse.up();
}
const cases = [];
const def = (name, fn) => cases.push({ name, fn });

def('press-A-release-B', async () => {
  await load();
  const a = await pointOf(page, 'alpha', 2), b = await pointOf(page, 'beta', 2);
  await drag(a, b);
  await sleep(200);
  const v = await view(page);
  const sel = await page.evaluate(() => getSelection().toString());
  await page.keyboard.type('Q'); await settle();
  const src = await B.source();
  return { ok: !v.editing && src === DOC && sel.includes('ha words here.') && sel.includes('be'), detail: `session=${!!v.editing} sel=${J(sel)} srcChanged=${src !== DOC}` };
});
for (const [nm, from, to] of [['fwd', ['alpha', 0], ['gamma', 3]], ['bwd', ['gamma', 3], ['alpha', 0]]]) {
  def(`drag-across-copy-${nm}`, async () => {
    await load();
    const a = await pointOf(page, from[0], from[1]), b = await pointOf(page, to[0], to[1]);
    await drag(a, b);
    const on = await copied();
    const v = await view(page);
    await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable(false));
    let off;
    try {
      await page.evaluate(() => getSelection().removeAllRanges());
      const a2 = await pointOf(page, from[0], from[1]), b2 = await pointOf(page, to[0], to[1]);
      await drag(a2, b2);
      off = await copied();
    } finally { await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable(true)); }
    return { ok: on === off && !v.editing, detail: `on=${J(on)} off=${J(off)} session=${!!v.editing}` };
  });
}
// G15 / U7: a drag (or a shift-click) that starts in the session's block and leaves it: the selection must extend
// from where the gesture started, as with editing off; ⌘C copies that.
for (const [nm, typed] of [['clean', ''], ['typed', 'Z']]) {
  for (const how of ['drag', 'shift']) {
    def(`out-of-session-${how}-${nm}-copy`, async () => {
      await load();
      await clickText(page, 'alpha', 1);
      await sleep(200);
      if (typed) await page.keyboard.type(typed);
      await sleep(30);
      const a = await pointOf(page, 'words here', 0), b = await pointOf(page, 'gamma', 3);
      if (how === 'drag') await drag(a, b);
      else {
        await B.caretAt('alpha'.slice(0, 1) + typed + 'lpha ', 'after').catch(async () => { await B.caretAt('alpha ', 'after'); });
        await page.keyboard.down('Shift'); await page.mouse.click(b.x, b.y); await page.keyboard.up('Shift');
      }
      await sleep(400);
      const on = await copied();
      const v = await view(page);
      const src = await B.source();
      const want = 'words here.\n\nSecond para beta words here.\n\nThird para gam';
      return { ok: !v.editing && on === want && (typed ? src.includes('aZlpha') : src === DOC), detail: `copied=${J(on)} want=${J(want)} session=${!!v.editing} line1=${J(src.split('\n')[0])}` };
    });
  }
}
def('dblclick-word-type-replaces', async () => {
  await load();
  const p = await pointOf(page, 'beta', 1);
  await page.mouse.dblclick(p.x, p.y);
  await sleep(250);
  const sel = await page.evaluate(() => getSelection().toString());
  const t = await sessionText();
  await page.keyboard.type('XY'); await settle();
  const src = await B.source();
  return { ok: src.includes('Second para XY words') && t !== null, detail: `sel=${J(sel)} session=${t !== null} line=${J(src.split('\n')[2])}` };
});
def('tripleclick-para-type-replaces', async () => {
  await load();
  const p = await pointOf(page, 'beta', 1);
  await page.mouse.click(p.x, p.y, { clickCount: 3, delay: 30 });
  await sleep(250);
  const sel = await page.evaluate(() => getSelection().toString());
  const t = await sessionText();
  await page.keyboard.type('XY'); await settle();
  const src = await B.source();
  return { ok: src.includes('\n\nXY\n\nThird') || src.includes('\n\nXY\n') , detail: `sel=${J(sel)} session=${t !== null} src=${J(src.slice(0, 90))}` };
});
def('tripleclick-then-delete', async () => {
  await load();
  const p = await pointOf(page, 'beta', 1);
  await page.mouse.click(p.x, p.y, { clickCount: 3, delay: 30 });
  await sleep(250);
  const t = await sessionText();
  await page.keyboard.press('Backspace'); await settle();
  const src = await B.source();
  return { ok: !src.includes('Second') && src.includes('Third para gamma'), detail: `session=${t !== null} src=${J(src.slice(0, 90))}` };
});
def('shift-click-outside-session', async () => {
  await load();
  const p = await pointOf(page, 'beta', 1);
  await page.keyboard.down('Shift'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Shift');
  await sleep(200);
  const v = await view(page);
  return { ok: !v.editing, detail: `session=${!!v.editing}` };
});
def('shift-click-inside-session-extends', async () => {
  await load();
  await clickText(page, 'beta', 0);
  await sleep(200);
  const p = await pointOf(page, 'words here', 5);
  await page.keyboard.down('Shift'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Shift');
  await sleep(100);
  const sel = await page.evaluate(() => getSelection().toString());
  await page.keyboard.type('Q'); await settle();
  const src = await B.source();
  return { ok: src.includes('Second para Q here.'), detail: `sel=${J(sel)} line=${J(src.split('\n')[2])}` };
});
def('shift-click-other-block-while-in-session', async () => {
  await load();
  await clickText(page, 'beta', 0);
  await sleep(200);
  const p = await pointOf(page, 'gamma', 2);
  await page.keyboard.down('Shift'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Shift');
  await sleep(200);
  const sel = await page.evaluate(() => getSelection().toString());
  const v = await view(page);
  await page.keyboard.type('Q'); await settle();
  const src = await B.source();
  return { ok: src === DOC || /Second para (Q)?ma/.test(src) === false, detail: `sel=${J(sel)} session=${!!v.editing} src=${J(src.slice(0, 100))}` };
});
def('drag-inside-block-type-replaces', async () => {
  await load();
  const a = await pointOf(page, 'beta', 0), b = await pointOf(page, 'beta', 3, 'right');
  await drag(a, b, 6);
  await sleep(200);
  const sel = await page.evaluate(() => getSelection().toString());
  const t = await sessionText();
  await page.keyboard.type('Q'); await settle();
  const src = await B.source();
  return { ok: src.includes('Second para Q words'), detail: `sel=${J(sel)} session=${t !== null} line=${J(src.split('\n')[2])}` };
});
def('right-click-then-type', async () => {
  await load();
  const p = await pointOf(page, 'beta', 1);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await sleep(200);
  const v = await view(page);
  await page.keyboard.press('Escape');
  await page.keyboard.type('Q'); await settle();
  const src = await B.source();
  return { ok: src === DOC, detail: `session=${!!v.editing} changed=${src !== DOC}` };
});
def('right-click-in-session', async () => {
  await load();
  await clickText(page, 'beta', 1);
  await sleep(200);
  await page.keyboard.type('Z');
  const p = await pointOf(page, 'gamma', 1);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await sleep(200);
  const v = await view(page);
  await page.keyboard.type('Q'); await settle();
  const src = await B.source();
  return { ok: src.includes('bZeta') && !/gQamma|gammaQ/.test(src), detail: `session=${v.editing ? v.editing.text.slice(0, 20) : null} line2=${J(src.split('\n')[2])} line4=${J(src.split('\n')[4])}` };
});
def('click-checkbox-outside-session', async () => {
  await load();
  const box = await page.evaluate(() => { const b = document.querySelectorAll('.mdr-preview input[type=checkbox]')[1]; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(box.x, box.y);
  await settle();
  const src = await B.source();
  const v = await view(page);
  return { ok: src.includes('- [ ] task one\n- [x] task two'), detail: `session=${!!v.editing} src=${J(src.split('\n').slice(6, 8))}` };
});
def('click-checkbox-right-after-session-write', async () => {
  await load();
  await clickText(page, 'beta', 1);
  await sleep(150);
  await page.keyboard.type('Z');
  const box = await page.evaluate(() => { const b = document.querySelectorAll('.mdr-preview input[type=checkbox]')[1]; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(box.x, box.y);
  await settle(500);
  const src = await B.source();
  return { ok: src.includes('bZeta') && src.includes('- [ ] task one\n- [x] task two'), detail: `src=${J(src.split('\n').slice(2, 8))}` };
});
def('click-link-outside-session', async () => {
  await load();
  await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  const p = await pointOf(page, 'link', 1);
  await page.mouse.click(p.x, p.y);
  await sleep(250);
  const v = await view(page);
  const opened = await page.evaluate(() => window.__opened);
  return { ok: !v.editing && opened.length === 1 && page.url().startsWith(BASE), detail: `session=${!!v.editing} opened=${J(opened)} url=${page.url()}` };
});
def('click-link-in-session-places-caret', async () => {
  await load();
  await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  await clickText(page, 'in text', 1);
  await sleep(200);
  const p = await pointOf(page, 'link', 2);
  await page.mouse.click(p.x, p.y);
  await sleep(200);
  await page.keyboard.type('Q'); await settle();
  const src = await B.source();
  const opened = await page.evaluate(() => window.__opened);
  return { ok: opened.length === 0 && /\[liQnk\]|\[liQnk/.test(src), detail: `opened=${J(opened)} line=${J(src.split('\n').find((l) => l.includes('ext')))}` };
});
def('click-formula-outside-session', async () => {
  await load();
  const p = await page.evaluate(() => { const m = document.querySelector('.mdr-preview .md-math'); const r = m.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(p.x, p.y);
  await sleep(250);
  const v = await view(page);
  await page.keyboard.type('3'); await settle();
  const src = await B.source();
  return { ok: !!v.editing && src.includes('$x^23$'), detail: `session=${!!v.editing} html=${J(v.editing && v.editing.html.slice(0, 120))} line=${J(src.split('\n').find((l) => l.includes('formula')))}` };
});
def('click-gap-between-blocks', async () => {
  await load();
  const g = await page.evaluate(() => {
    const ss = Array.from(document.querySelectorAll('.mdr-preview section.md-block'));
    const a = ss[0].getBoundingClientRect(), b = ss[1].getBoundingClientRect();
    return { x: a.left + 40, y: (a.bottom + b.top) / 2, gap: b.top - a.bottom };
  });
  await page.mouse.click(g.x, g.y);
  await sleep(250);
  const v = await view(page);
  await page.keyboard.type('Q'); await settle();
  const src = await B.source();
  return { ok: src === DOC || src.startsWith('First para alpha words here.Q') || src.includes('\n\nQSecond'), detail: `gap=${g.gap} session=${v.editing ? v.editing.text.slice(0, 20) : null} src=${J(src.slice(0, 70))}` };
});
def('click-code-copy-button', async () => {
  await load();
  const btn = await page.evaluate(() => { const b = document.querySelector('.mdr-preview .md-codewrap button, .mdr-preview [data-mdr-ui] button, .mdr-preview button'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; });
  if (!btn || !btn.w) return { ok: true, detail: 'no visible copy button (hover only?)' };
  await page.mouse.click(btn.x, btn.y);
  await sleep(250);
  const v = await view(page);
  return { ok: !v.editing || !String(v.editing.text).includes('const'), detail: `session=${v.editing ? v.editing.text.slice(0, 30) : null}` };
});
def('click-B-while-A-unwritten-heights', async () => {
  // A gets two empty paragraphs (no source form, K16): A's re-render after the click makes it shorter, so B moves
  // up; B's session must start at the clicked character all the same.
  await load();
  await clickText(page, 'alpha', 1);
  await sleep(150);
  await B.caretAt('here.', 'after');
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await sleep(10);
  const p = await pointOf(page, 'gamma', 2, 'left', false);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.type('Q');
  await settle(600);
  const src = await B.source();
  return { ok: src.includes('Third para gaQmma'), detail: `line=${J(src.split('\n').find((l) => l.includes('Third')))} src=${J(src.slice(0, 120))}` };
});
def('two-clicks-100ms', async () => {
  await load();
  await clickText(page, 'alpha', 1);
  await sleep(100);
  await page.keyboard.type('Z');
  await clickText(page, 'beta', 1);
  await sleep(60);
  await clickText(page, 'gamma', 1);
  await page.keyboard.type('Q');
  await settle(600);
  const src = await B.source();
  return { ok: src.includes('aZlpha') && src.includes('gQamma') && !src.includes('bQeta'), detail: `src=${J(src.slice(0, 110))}` };
});
def('click-during-wait-type-at-once', async () => {
  await load();
  await clickText(page, 'alpha', 1);
  await sleep(100);
  await page.keyboard.type('Z');
  await clickText(page, 'beta', 1);
  await page.keyboard.type('QRS');
  await settle(600);
  const src = await B.source();
  return { ok: src.includes('aZlpha') && src.includes('bQRSeta'), detail: `src=${J(src.slice(0, 110))}` };
});
def('press-hold-2s-release', async () => {
  await load();
  await clickText(page, 'beta', 1, { hold: 2000 });
  await sleep(150);
  await page.keyboard.type('Q'); await settle();
  const src = await B.source();
  return { ok: src.includes('bQeta'), detail: `line=${J(src.split('\n')[2])}` };
});
def('mousedown-esc-mouseup', async () => {
  await load();
  const p = await pointOf(page, 'beta', 1);
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.keyboard.press('Escape'); await page.mouse.up();
  await sleep(150);
  const v = await view(page);
  await page.keyboard.type('Q'); await settle();
  const src = await B.source();
  return { ok: true, detail: `note: session=${!!v.editing} line=${J(src.split('\n')[2])}` };
});
def('mouseup-without-mousedown', async () => {
  await load();
  const p = await pointOf(page, 'beta', 1);
  await page.mouse.move(p.x, p.y);
  await page.mouse.up();
  await sleep(150);
  const v = await view(page);
  return { ok: !v.editing, detail: `session=${!!v.editing}` };
});
def('click-block-just-scrolled-in', async () => {
  const big = Array.from({ length: 120 }, (_, i) => `Paragraph number ${i} with some words.`).join('\n\n') + '\n';
  await load(big);
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(181, 0, 'instant'));
  await sleep(120);
  const p = await pointOf(page, 'number 90 ', 9, 'left', false);
  if (!p) return { ok: false, detail: 'paragraph 90 not shown' };
  await page.mouse.click(p.x, p.y);
  await page.keyboard.type('Q');
  await settle(500);
  const src = await B.source();
  const line = src.split('\n').find((l) => l.includes('Q')) ?? null;
  return { ok: line === 'Paragraph number 90 Qwith some words.', detail: `line=${J(line)}` };
});
def('click-other-block-after-typing-same-frame', async () => {
  await load();
  await clickText(page, 'alpha', 1);
  await sleep(100);
  await page.keyboard.type('Z');
  const p = await pointOf(page, 'beta', 1);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.type('Q');
  await settle(600);
  const src = await B.source();
  return { ok: src.includes('aZlpha') && src.includes('bQeta'), detail: `src=${J(src.slice(0, 110))}` };
});

def('cmd-a-twice-copy', async () => {
  await load();
  await clickText(page, 'beta', 1);
  await sleep(200);
  await page.keyboard.type('Z');
  await page.keyboard.press('Meta+a'); await page.keyboard.press('Meta+a');
  await sleep(400);
  const on = await copied();
  const v = await view(page);
  await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable?.(false));
  let off;
  try {
    await page.evaluate(() => getSelection().removeAllRanges());
    const p = await pointOf(page, 'gamma', 1);
    await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Meta+a');
    off = await copied();
  } finally { await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable?.(true)); }
  const norm = (t) => t.replace('bZeta', 'beta');
  return { ok: !v.editing && norm(on).includes('First para') && norm(on).includes('Last para omega') && on.includes('bZeta'), detail: `session=${!!v.editing} on=${J(on.slice(0, 60))}…${J(on.slice(-30))} (len ${on.length}) off=${J(off.slice(0, 40))}… (len ${off.length})` };
});

let bad = 0;
try {
  await B.boot(process.env.MDR_PERF ? 'mode=split&perf=1' : 'mode=split');
  for (const c of cases) {
    if (filter && !c.name.includes(filter)) continue;
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
