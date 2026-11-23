// bench/verify/v5-sw-fuzz.mjs — verify-switch (round 4 verification): seeded random toggling of 预览可编辑 (⌘⇧E, the
// toolbar button, the palette) interleaved with clicks into the preview, typing, Enter, Backspace, Escape and typing in
// the editor pane, at random short delays. Invariants after every step that leaves the switch OFF: no contenteditable,
// textarea, .is-editing, spellcheck or data-mdr-o in the preview, the hint hidden, the button / stored value / preview
// agree; in the source: no zero-width or no-break space character, no character the script did not type. At the end
// (switch off, idle) the preview's block texts equal those of a fresh page (never on) showing the same source.
//   MDR_PORT=<candidate with test hooks (dev server)> node bench/verify/v5-sw-fuzz.mjs <seed> [--ops N] [--slow ms]
// Exit 0 ok, 1 an invariant broke (the step is printed), 3 global timeout. Global timeout 110 s. Writes nothing.
import { open, loadDoc, sleep, DOC_ALL, PORT, switchState } from './v5-offc-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, Number(process.env.MDR_TIMEOUT || 110_000));
const seed = Number(process.argv[2] || 1);
const OPS = Number((process.argv.indexOf('--ops') > 0 && process.argv[process.argv.indexOf('--ops') + 1]) || 40);
const TICKS = process.argv.includes('--ticks');
const SLOW = Number((process.argv.indexOf('--slow') > 0 && process.argv[process.argv.indexOf('--slow') + 1]) || 0);
let x = seed >>> 0 || 1;
const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const BAD = new RegExp(`[${String.fromCharCode(0x200b)}${String.fromCharCode(0xfeff)}${String.fromCharCode(0xa0)}${String.fromCharCode(0x2060)}]`);
const LETTERS = 'QWZXJVK';
const typedSet = new Set();
const log = [];
let C = null, R = null, broke = null, sessions = 0;

const leftovers = () => C.page.evaluate(() => {
  const root = document.querySelector('.mdr-preview');
  const hint = root.querySelector('.mdr-preview__edit-hint');
  const ceEls = [...root.querySelectorAll('[contenteditable]')].map((e) => `${e.tagName.toLowerCase()}.${e.className}[ce=${e.getAttribute('contenteditable')}] in block ${e.closest('section')?.dataset.id} conn=${e.isConnected}`).slice(0, 3);
  return { ceEls, ce: root.querySelectorAll('[contenteditable]').length, cap: root.querySelectorAll('textarea').length, editing: root.querySelectorAll('.is-editing').length, spell: root.querySelectorAll('[spellcheck]').length, mdrO: root.querySelectorAll('[data-mdr-o]').length, hint: !!(hint && !hint.hidden) };
});
async function randomPoint() {
  return C.page.evaluate((r) => {
    const root = document.querySelector('.mdr-preview');
    const vb = root.getBoundingClientRect();
    const ps = [...root.querySelectorAll('.mdr-preview__body p, .mdr-preview__body li, .mdr-preview__body h1, .mdr-preview__body h2')].filter((p) => { const b = p.getBoundingClientRect(); return b.top > vb.top + 5 && b.bottom < vb.bottom - 5 && b.height > 0; });
    if (!ps.length) return null;
    const p = ps[Math.floor(r[0] * ps.length)];
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    const ns = []; for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.trim() && !n.parentElement.closest('.katex')) ns.push(n);
    if (!ns.length) return null;
    const n = ns[Math.floor(r[1] * ns.length)];
    const k = Math.floor(r[2] * n.data.length);
    const rg = document.createRange(); rg.setStart(n, k); rg.setEnd(n, Math.min(n.data.length, k + 1));
    const b = rg.getBoundingClientRect();
    return b.width ? { x: b.left + 1, y: b.top + b.height / 2 } : null;
  }, [rnd(), rnd(), rnd()]);
}
async function toggleBy(how) {
  if (how === 'key') await C.page.keyboard.press('Meta+Shift+KeyE');
  else if (how === 'button') await C.page.click('[data-cmd="view.togglePreviewEdit"]');
  else { await C.page.keyboard.press('Meta+Shift+KeyP'); await sleep(120); await C.page.keyboard.type('预览可编辑'); await sleep(80); await C.page.keyboard.press('Enter'); }
}
async function check(step) {
  const st = await switchState(C);
  const src = await C.source();
  const errs = [];
  if ((st.pressed === 'true') !== st.editable) errs.push(`button ${st.pressed} vs editable ${st.editable}`);
  if (st.stored !== null && st.stored !== (st.editable ? '1' : '0')) errs.push(`stored ${st.stored} vs editable ${st.editable}`);
  if (BAD.test(src)) errs.push('invisible / no-break character in the source');
  const extra = [...src].filter((ch, i) => /[A-Z]/.test(ch) && !DOC_ALL.includes(ch) && !typedSet.has(ch));
  if (extra.length) errs.push(`untyped capitals ${extra.join('')}`);
  if (!st.editable) {
    await sleep(60);
    const l = await leftovers();
    if (l.ce || l.cap || l.editing || l.spell || l.mdrO || l.hint) {
      // transient (the block's re-render is on its way) or lasting? look again after the worker is idle
      await sleep(1500 + SLOW * 4); await C.idle(200);
      const l2 = await leftovers();
      const lasting = !!(l2.ce || l2.cap || l2.editing || l2.spell || l2.mdrO || l2.hint);
      if (lasting || process.env.MDR_STRICT) errs.push(`leftover ${JSON.stringify(l)} after idle ${JSON.stringify(l2)}`);
      else console.log(`  transient leftover at step ${step}: ${JSON.stringify(l)}`);
    }
  }
  if (C.pageErrors.length) errs.push(`page error ${C.pageErrors.join('|').slice(0, 160)}`);
  if (errs.length && !broke) broke = { step, errs, st };
  return errs;
}
try {
  C = await open(PORT, { pref: '0' });
  await loadDoc(C, DOC_ALL);
  if (SLOW) await C.page.evaluate((ms) => {
    const pv = window.__mdr.app.preview;
    const od = pv.applyStructureDelta.bind(pv), oh = pv.applyHtml.bind(pv);
    pv.applyStructureDelta = (m) => { setTimeout(() => od(m), ms); return true; };
    pv.applyHtml = (m) => { setTimeout(() => oh(m), ms); };
  }, SLOW);
  for (let i = 0; i < OPS && !broke; i++) {
    const r = TICKS && rnd() < 0.18 ? 0.999 : rnd();
    let op;
    if (r < 0.22) { const how = pick(['key', 'key', 'button', 'palette']); op = `toggle:${how}`; await toggleBy(how); }
    else if (r < 0.5) { const p = await randomPoint(); op = `click:${p ? Math.round(p.x) + ',' + Math.round(p.y) : 'none'}`; if (p) await C.page.mouse.click(p.x, p.y); }
    else if (r < 0.7) { const ch = pick([...LETTERS]); typedSet.add(ch); op = `type:${ch}`; await C.page.keyboard.type(ch); }
    else if (r < 0.76) { op = 'Enter'; await C.page.keyboard.press('Enter'); }
    else if (r < 0.82) { op = 'Backspace'; await C.page.keyboard.press('Backspace'); }
    else if (r < 0.88) { op = 'Escape'; await C.page.keyboard.press('Escape'); }
    else if (r < 0.94) { op = 'editor'; const b = await C.page.evaluate(() => { const l = document.querySelectorAll('.cm-content .cm-line')[2]; const r = l?.getBoundingClientRect(); return r ? { x: r.left + 20, y: r.top + r.height / 2 } : null; }); if (b) { await C.page.mouse.click(b.x, b.y); const ch = pick([...LETTERS]); typedSet.add(ch); await C.page.keyboard.type(ch); op += `:${ch}`; } }
    else if (r < 0.97 || !TICKS) { op = 'scroll'; await C.page.evaluate((f) => { const v = document.querySelector('.mdr-preview'); v.scrollTop = f * v.scrollHeight; }, rnd() * 0.3); }
    else {
      // a task's own box: the task under the pointer at the press must be the only line that flips (or none, with a toast)
      const b = await C.page.evaluate((k) => {
        const bs = [...document.querySelectorAll('.mdr-preview li.task-list-item > input[type="checkbox"], .mdr-preview li.task-list-item input[type="checkbox"]')].filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.top > 60 && r.bottom < innerHeight - 20; });
        if (!bs.length) return null;
        const x = bs[Math.floor(k * bs.length)]; const r = x.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: x.closest('li').textContent.trim().slice(0, 40) };
      }, rnd());
      if (b) {
        const before = await C.source();
        await C.page.mouse.click(b.x, b.y);
        await sleep(350 + SLOW * 2);
        const after = await C.source();
        const bl = before.split('\n'), al = after.split('\n');
        const changed = [];
        if (bl.length === al.length) for (let k = 0; k < bl.length; k++) if (bl[k] !== al[k]) changed.push(`${bl[k]} -> ${al[k]}`);
        const word = b.text.split(/\s+/).pop();
        // a flip is a line whose only change is [ ] <-> [x]; a flip on another task is wrong; other changes must be text
        // the script typed (a session's last write lands when the press on the box ends it)
        const flip = (k) => bl[k] !== al[k] && bl[k].replace(/\[[ xX]\]/, '[?]') === al[k].replace(/\[[ xX]\]/, '[?]');
        const wrong = [];
        if (bl.length === al.length) for (let k = 0; k < bl.length; k++) {
          if (bl[k] === al[k]) continue;
          if (flip(k)) { if (!bl[k].includes(word)) wrong.push(`flip of another task: ${bl[k]} -> ${al[k]}`); }
          else if ([...al[k]].filter((ch) => !typedSet.has(ch)).join('') !== [...bl[k]].filter((ch) => !typedSet.has(ch)).join('')) wrong.push(`text change: ${bl[k]} -> ${al[k]}`);
        }
        op = `tick:${JSON.stringify(b.text)}:${changed.length}`;
        if (wrong.length && !broke) broke = { step: i, errs: [`tick on ${JSON.stringify(b.text)} changed ${JSON.stringify(changed)}`] };
      } else op = 'tick:none';
    }
    const d = pick([0, 0, 20, 60, 150, 400]);
    if (d) await sleep(d);
    const ceNow = await C.page.evaluate(() => document.querySelectorAll('.mdr-preview [contenteditable="true"]').length);
    if (ceNow) sessions++;
    log.push(`${i}:${op}+${d}${ceNow ? '*' : ''}`);
    await check(i);
  }
  // the end: switch off, idle, compare with a fresh page
  if (!broke) {
    if ((await switchState(C)).editable) { await C.page.keyboard.press('Escape'); await toggleBy('key'); }
    await sleep(800 + SLOW * 3); await C.idle(300);
    await check('end');
    const src = await C.source();
    R = await open(PORT, { pref: '0' });
    await loadDoc(R, src);
    const texts = (B) => B.page.evaluate(async () => { window.__mdr.app.preview.mountAll?.(); await new Promise((r) => setTimeout(r, 600)); return [...document.querySelectorAll('.mdr-preview__body section.md-block')].map((s) => s.textContent.replace(/\s+/g, ' ').trim()); });
    await sleep(400);
    const a = await texts(C), b = await texts(R);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      const i = a.findIndex((t, k) => t !== b[k]);
      broke = { step: 'end-render', errs: [`block ${i} differs: shown ${JSON.stringify(a[i]).slice(0, 120)} fresh ${JSON.stringify(b[i]).slice(0, 120)} (${a.length} vs ${b.length} blocks)`] };
    }
  }
} catch (e) {
  broke = broke || { step: 'script', errs: [String(e && e.stack || e).slice(0, 300)] };
} finally {
  clearTimeout(KILL);
  console.log(`seed ${seed} ops ${OPS} slow ${SLOW} steps-in-session ${sessions} typed ${[...typedSet].join('')}: ${broke ? 'FAIL ' + JSON.stringify(broke) : 'OK'}`);
  if (broke || process.env.MDR_VERBOSE) console.log('  ops: ' + log.join(' '));
  await C?.close(); await R?.close();
  process.exit(broke ? (broke.step === 'script' ? 2 : 1) : 0);
}
