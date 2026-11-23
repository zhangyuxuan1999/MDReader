// bench/verify/v4-sesa-fuzz.mjs — verify-session-a: a model-checked keyboard fuzz of in-preview editing.
// The document is a fixed heading, then plain paragraphs (words of a-z, CJK, digits and an occasional emoji,
// separated by single spaces), then a fixed last paragraph. A session is started by a real click on a block; the
// caret is then put at a model offset programmatically, and only KEYS act: typing, Enter in the middle of a
// paragraph or heading (U13: the spaces after the caret go), Backspace / Delete inside text, Backspace at a
// paragraph start (U3 merge into a paragraph above; nothing after a heading), ⌘A ⌫ (U9: the block leaves the
// source) followed by keys in the emptied element (U18: typing writes a block at its place, Backspace moves to
// the end of the block above, Delete does nothing), arrows, Esc, and ⌘Z (the source must then equal an EARLIER
// model state; the model re-syncs from it). The model computes the exact source after every step.
// After every step (slow) or every burst (fast): source === model, the shown blocks === the model's texts.
// At the end: Esc, ⌘Z until the original (byte for byte), ⇧⌘Z until the final source (byte for byte).
// Modes: MDR_FAST=1 bursts of 2-6 keys at machine speed (the resume queue), MDR_LARGE=1 the model document sits
// inside test-data/large.md (line ~50 000).
// Run: MDR_PORT=5431 node bench/verify/v4-sesa-fuzz.mjs <seedFrom> [seedTo] [ops]   (T_MS: global timeout)
import { readFileSync } from 'node:fs';
import { openB, sleep, globalTimeout, J, rng, view, shownText, undoTo, redoTo, waitSession } from './v4-sesa-lib.mjs';

const seedFrom = Number(process.argv[2] ?? 1);
const seedTo = Number(process.argv[3] ?? seedFrom);
const OPS = Number(process.argv[4] ?? 30);
const FAST = process.env.MDR_FAST === '1';
const TIGHT = process.env.MDR_TIGHT === '1';    // level-2 headings written directly under a paragraph line (U18 b/c)
const LARGE = process.env.MDR_LARGE === '1';
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 110_000), B.close);
const { page } = B;
const settle = async (ms = 330) => { await sleep(ms); await B.settle(150); };

let PRE = '', POST = '';
if (LARGE) {
  const lines = readFileSync(new URL('../../test-data/large.md', import.meta.url), 'utf8').split('\n');
  // a blank line outside any fence, after an ordinary paragraph line, before an ordinary line
  const fence = /^ {0,3}(`{3,}|~{3,})/;
  let open = false, a = -1;
  for (let k = 0; k < lines.length - 1; k++) {
    if (fence.test(lines[k])) open = !open;
    if (k >= 50_000 && !open && lines[k].trim() === '' && /^[A-Za-z\u4e00-\u9fff]/u.test(lines[k - 1]) && /^## /.test(lines[k + 1])) { a = k; break; }
  }
  if (a < 0) throw new Error('no cut point in large.md');
  PRE = lines.slice(0, a + 1).join('\n') + '\n';                          // ends with the blank line
  POST = lines.slice(a + 1).join('\n');                                   // starts with a content line
}
const preLines = PRE === '' ? 0 : PRE.split('\n').length - 1;

const CJK = '中文字段落标题内容';
const EMOJI = String.fromCodePoint(0x1f600);
function word(r) {
  const n = 1 + Math.floor(r() * 5);
  let s = '';
  for (let i = 0; i < n; i++) {
    const x = r();
    s += x < 0.7 ? String.fromCharCode(97 + Math.floor(r() * 26)) : x < 0.85 ? CJK[Math.floor(r() * CJK.length)] : x < 0.95 ? String(Math.floor(r() * 10)) : EMOJI;
  }
  // a digit run followed by nothing else could start "1." — never typed with a dot, so harmless; a leading digit
  // run is fine too (no "." or ")" in the alphabet)
  return s;
}
const para = (r) => Array.from({ length: 2 + Math.floor(r() * 4) }, () => word(r)).join(' ');

// ---- the model
/** blocks: [{h: false | true (level 1) | 2, t: string, tight?: bool (no blank line before it)}];
 *  sess: null | {i, c} | {gone: pos, kind}  (c: UTF-16 offset in t) */
const prefix = (b) => (b.h === 2 ? '## ' : b.h ? '# ' : '');
function docOf(blocks) {
  if (blocks.length === 0) return PRE + POST;
  const body = blocks.map((b, k) => (k === 0 ? '' : b.tight ? '\n' : '\n\n') + prefix(b) + b.t).join('');
  return LARGE ? PRE + body + '\n\n' + POST : body + '\n';
}
let BLOCKS = [];
const lineOf = (k) => { let l = preLines + 1; for (let j = 1; j <= k; j++) l += BLOCKS[j].tight ? 1 : 2; return l; };
const isSur = (s, k) => k > 0 && k < s.length && s.charCodeAt(k) >= 0xdc00 && s.charCodeAt(k) <= 0xdfff;
const prevPos = (s, c) => (c >= 2 && isSur(s, c - 1) ? c - 2 : c - 1);
const nextPos = (s, c) => (isSur(s, c + 1) ? c + 2 : c + 1);

async function clickBlock(k) {
  const pt = await B.textPoint(lineOf(k), 'first');
  if (!pt) throw new Error('no point for block ' + k);
  await sleep(LARGE ? 700 : 0);                   // the navigation anchor settles (scrollToLine re-applies ~600 ms)
  const pt2 = await B.textPoint(lineOf(k), 'first');
  await page.mouse.click(pt2.x, pt2.y);
  const v = await waitSession(page, 2000);
  if (!v.editing) throw new Error('no session on block ' + k + ' ' + J(v));
}
async function setCaret(c) {
  await page.evaluate((c) => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('[data-mdr-ui]') ? 2 : 1) });
    let left = c, last = null;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.data.replace(/\n/g, '').length && last) continue;
      last = n;
      const len = n.data.replace(/\n+$/, '').length;
      if (left <= len) { const r = document.createRange(); r.setStart(n, left); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return; }
      left -= len;
    }
    const r = document.createRange(); r.selectNodeContents(el.querySelector('p, h1') ?? el); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }, c);
}

async function runSeed(seed) {
  const r = rng(seed * 7919 + (FAST ? 1 : 0) + (LARGE ? 2 : 0) + (TIGHT ? 4 : 0));
  const blocks = [{ h: true, t: 'Title ' + word(r) }];
  BLOCKS = blocks;
  const n = 3 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    blocks.push({ h: false, t: para(r) });
    if (TIGHT && r() < 0.5) blocks.push({ h: 2, t: 'Sub ' + word(r), tight: true });
  }
  blocks.push({ h: false, t: 'end zz' });
  const orig = docOf(blocks);
  await B.loadDoc(orig);
  if ((await B.source()) !== orig) throw new Error('load');
  await sleep(LARGE ? 1200 : 400);
  const sane = await page.evaluate((l) => { const b = window.__mdr.app.preview.blockAtLine(l); return b && b.startLine === l; }, lineOf(0));
  if (!sane) throw new Error('the model heading is no block of its own at line ' + lineOf(0));
  const states = [orig];
  let sess = null;
  let lastOp = '', forceCheck = false;
  const log = [];
  const fail = async (why) => {
    const v = await view(page);
    console.log(`FAIL seed=${seed}${FAST ? ' fast' : ''}${LARGE ? ' large' : ''}${TIGHT ? ' tight' : ''} after op#${log.length}: ${why}\n  ops=${J(log.slice(-12))}\n  model=${J(docOf(blocks).slice(PRE.length, PRE.length + 400))}\n  src  =${J(v.src.slice(PRE.length, PRE.length + 400))}\n  editing=${J(v.editing && v.editing.text.slice(0, 60))} active=${v.active} toast=${J(v.toast)}`);
    return false;
  };
  const check = async (where) => {
    await settle(FAST ? 700 : 330);
    const src = await B.source();
    const want = docOf(blocks);
    if (src !== want) return fail(`${where}: source differs`);
    if (!LARGE) {
      const sh = await shownText(page);
      const exp = blocks.map((b) => b.t);
      if (J(sh) !== J(exp)) return fail(`${where}: shown ${J(sh)} != ${J(exp)}`);
    }
    if (states[states.length - 1] !== want) states.push(want);
    return true;
  };
  // the keys of one op; returns false when the op does not apply here
  const keyOps = [];
  const press = async (k) => { keyOps.push(k); await page.keyboard.press(k); };
  const typeT = async (t) => { keyOps.push(J(t)); await page.keyboard.type(t); };
  async function op() {
    const x = r();
    // ---- no session or a choice to move: click a block (paragraphs and the heading; never the last fixed one)
    if (sess === null || x < 0.1) {
      if (sess !== null) { await press('Escape'); sess = null; }
      await settle();                              // a user clicks what the settled preview shows
      const k = Math.floor(r() * (blocks.length - 1));
      await clickBlock(k);
      const c = Math.floor(r() * (blocks[k].t.length + 1));
      const cc = isSur(blocks[k].t, c) ? c - 1 : c;
      await setCaret(cc);
      sess = { i: k, c: cc };
      log.push(`click#${k}@${cc}`);
      return 'click';
    }
    if (sess.gone !== undefined) {
      const pos = sess.gone;
      if (x < 0.55) { const t = word(r); await typeT(t); blocks.splice(pos, 0, { h: sess.kind ?? false, t }); sess = { i: pos, c: t.length }; log.push(`gone-type ${J(t)}`); return 'k'; }
      if (x < 0.8) {
        await press('Backspace'); log.push('gone-bs');
        sess = pos > 0 ? { i: pos - 1, c: blocks[pos - 1].t.length } : null;
        return 'k';
      }
      if (x < 0.9) { await press('Delete'); log.push('gone-del'); return 'k'; }
      await press('Escape'); log.push('gone-esc'); sess = null; return 'k';
    }
    const b = blocks[sess.i];
    const { c } = sess;
    if (x < 0.4) {
      const t = word(r);
      // typing next to a space is fine; a word typed at a word start / end makes no double space
      await typeT(t); b.t = b.t.slice(0, c) + t + b.t.slice(c); sess.c = c + t.length; log.push(`type ${J(t)}@${c}`); return 'k';
    }
    if (x < 0.52) {
      // Enter strictly inside the text, both halves keep a visible character
      const left = b.t.slice(0, c).replace(/ +$/, ''), right = b.t.slice(c).replace(/^ +/, '');
      if (left === '' || right === '' || isSur(b.t, c)) return null;
      await press('Enter');
      b.t = left;
      blocks.splice(sess.i + 1, 0, { h: false, t: right });
      sess = { i: sess.i + 1, c: 0 };
      log.push(`enter@${c}`);
      return 'k';
    }
    if (x < 0.64) {
      // Backspace: at a paragraph start a U3 merge into the paragraph above (nothing after the heading)
      if (c === 0) {
        if (b.h) return null;
        const p = blocks[sess.i - 1];
        // (fast: right after an Enter in the same frame Chromium joins the two halves back — a text editor's
        // Enter + Backspace — while a written split after a heading is not merged (U3): skipped, timing decides)
        if (FAST && lastOp === 'enter' && p.h) return null;
        await press('Backspace'); log.push('bs@0');
        if (p.h) return 'k';                       // a heading above: nothing happens
        const at = p.t.length;
        p.t = p.t + b.t;
        blocks.splice(sess.i, 1);
        sess = { i: sess.i - 1, c: at };
        return 'k';
      }
      const k = prevPos(b.t, c);
      const nt = b.t.slice(0, k) + b.t.slice(c);
      // no double space, no space at an edge (Chromium would keep it as &nbsp;); never empty a block this way
      if (/  /.test(nt) || /^ | $/.test(nt) || nt === '') return null;
      await press('Backspace'); b.t = nt; sess.c = k; log.push(`bs@${c}`); return 'k';
    }
    if (x < 0.7) {
      if (c >= b.t.length) return null;
      const k = nextPos(b.t, c);
      const nt = b.t.slice(0, c) + b.t.slice(k);
      if (/  /.test(nt) || /^ | $/.test(nt) || nt === '') return null;
      await press('Delete'); b.t = nt; log.push(`del@${c}`); return 'k';
    }
    if (x < 0.76) {
      // empty the block (never the heading, never the only paragraph left)
      if (b.h === true || (b.h && !TIGHT) || blocks.length <= 3) return null;
      await press('Meta+a'); await press('Backspace');
      blocks.splice(sess.i, 1);
      // U18 (b): the block after it now follows the line before the deleted range: a blank line there (a block
      // that was directly under the deleted one gets the deleted block's blank line before it)
      if (blocks[sess.i]) blocks[sess.i].tight = false;
      sess = { gone: sess.i, kind: b.h };
      log.push('empty');
      forceCheck = true;                           // (the same-frame Backspace after an emptying: known, see SESA notes)
      return 'k';
    }
    if (x < 0.86) {
      const right = r() < 0.5;
      if (right ? c >= b.t.length : c === 0) return null;
      await press(right ? 'ArrowRight' : 'ArrowLeft');
      sess.c = right ? nextPos(b.t, c) : prevPos(b.t, c);
      log.push(right ? 'right' : 'left');
      return 'k';
    }
    if (x < 0.92) { await press('Escape'); sess = null; log.push('esc'); return 'k'; }
    // ⌘Z: the source must become an earlier state; then the model is re-read from it (and the session ended)
    return 'undo';
  }

  let i = 0, burst = 0;
  while (i < OPS) {
    const kind = await op();
    if (kind === null) continue;
    i++;
    lastOp = String(log[log.length - 1]).split('@')[0];
    if (kind === 'undo') {
      await settle();
      await page.keyboard.press('Meta+z'); log.push('undo');
      await settle(600);
      const src = await B.source();
      const at = states.lastIndexOf(src);
      if (at < 0) return fail('undo gave a source that was never there');
      states.length = at + 1;
      // re-sync the model from the source
      const body = LARGE ? src.slice(PRE.length, src.length - POST.length).replace(/\n\n$/, '') : src.replace(/\n$/, '');
      const lines = body === '' ? [] : body.split('\n');
      blocks.length = 0;
      for (let k = 0; k < lines.length; k++) {
        const p = lines[k];
        if (p === '') continue;
        const tight = k > 0 && lines[k - 1] !== '';
        blocks.push(p.startsWith('## ') ? { h: 2, t: p.slice(3), tight } : p.startsWith('# ') ? { h: true, t: p.slice(2), tight } : { h: false, t: p, tight });
      }
      await page.keyboard.press('Escape'); await settle();
      sess = null;
      continue;
    }
    // every model state is one ⌘Z may go back to (in fast mode most of them are never checked on their own)
    if (kind !== 'click' && states[states.length - 1] !== docOf(blocks)) states.push(docOf(blocks));
    if (kind === 'click') { if (!(await check('click ' + log[log.length - 1]))) return false; continue; }
    burst++;
    if (!FAST || forceCheck || burst >= 2 + Math.floor(r() * 5) || i === OPS) {
      burst = 0; forceCheck = false; lastOp = '';
      if (!(await check('op ' + log[log.length - 1]))) return false;
    }
  }
  await page.keyboard.press('Escape'); await settle();
  const fin = await B.source();
  if (fin !== docOf(blocks)) return fail('final');
  const u = await undoTo(B, orig, 120, 60);
  if (!u.ok) return fail(`undo to the original failed after ${u.n}: ${J(u.now.slice(PRE.length, PRE.length + 300))}`);
  const rd = await redoTo(B, fin, 120, 60);
  if (!rd.ok) return fail(`redo to the final failed after ${rd.n}: ${J(rd.now.slice(PRE.length, PRE.length + 300))}`);
  console.log(`OK   seed=${seed}${FAST ? ' fast' : ''}${LARGE ? ' large' : ''}${TIGHT ? ' tight' : ''} ops=${OPS} undo=${u.n} redo=${rd.n} blocks=${blocks.length}`);
  return true;
}

let bad = 0;
try {
  await B.boot('mode=split');
  for (let seed = seedFrom; seed <= seedTo; seed++) {
    try { if (!(await runSeed(seed))) bad++; } catch (e) { bad++; console.log(`FAIL seed=${seed} threw ${String(e.message).split('\n')[0]}`); }
    try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
  }
  console.log('pageErrors', J(B.pageErrors.slice(0, 3)));
} finally {
  console.log(`seeds ${seedFrom}-${seedTo}: ${seedTo - seedFrom + 1 - bad} ok, ${bad} failed`);
  stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
