// bench/verify/v3-ses-fuzz.mjs — verify-session stage 2c: oracle fuzz of preview sessions WITH the pointer, paste and
// the emptied block (stronger than v2-ses-fuzz.mjs). The region under test is a run of plain paragraphs (letters,
// digits, CJK, astral characters; no spaces, no Markdown punctuation), so a text-editor model predicts the source
// byte for byte. Ops: type (keyboard / insertText / CDP IME), Enter (split), Backspace (character or U3 merge),
// ←/→, ⌘←/⌘→, a CLICK (real press + release) at a random character of a random paragraph, paste (one line, or
// paragraphs separated by a blank line), emptying the current paragraph (⌘A + Backspace) followed by typing or a
// click elsewhere, Esc + click. After every round and every click: source === model and the caret where the model
// says. At the end: ⌘Z until the original, ⇧⌘Z until the final text (byte for byte). Every failure prints the seed
// and the op log.
// Run: MDR_PORT=5382 node bench/verify/v3-ses-fuzz.mjs <seed> [--human] [--rounds N] [--ops N] [--large]   (exit 1 on a failure)
import { openB, sleep, globalTimeout, J, readRoot, view } from './v3-ses-lib.mjs';

const args = process.argv.slice(2);
const seed = Number(args[0] ?? 1);
const HUMAN = args.includes('--human');
const LARGE = args.includes('--large');
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const ROUNDS = opt('--rounds', 4), OPS = opt('--ops', 18);
let st = (seed * 2654435761) >>> 0 || 1;
const rnd = () => { st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return st / 0x100000000; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
const CJK = Array.from('中文字段落测试编辑器输入法拆分合并撤销');
const ASTRAL = ['😀', '🎉', '𝒳', '𠀀'];
const cps = (s) => Array.from(s);
const word = (n) => { let w = ''; for (let i = 0; i < n; i++) w += ALPHA[Math.floor(rnd() * ALPHA.length)]; return w; };

const B = await openB({ viewport: { width: 1500, height: 900 }, clipboard: true });
const stop = globalTimeout(Number(process.env.FUZZ_TIMEOUT ?? 110_000), B.close);
const { page } = B;
const log = [];
let failed = 0;
const fail = (what, detail) => { failed++; console.log(`FAIL seed=${seed}${HUMAN ? ' --human' : ''}${LARGE ? ' --large' : ''} ${what}: ${detail}`); console.log(`  ops: ${log.join(' ')}`); };

// ---- model
const paras = [];
for (let i = 0; i < 6; i++) paras.push(word(4 + Math.floor(rnd() * 6)));
let cur = { i: 0, off: 0 };
let ghost = null;            // { at }: the session sits on an emptied element; typing inserts a paragraph at `at`
let prefix = 'Header line\n\n', suffix = '\n\nTrailer line\n';
if (LARGE) {
  const all = readRoot('test-data/large.md').split('\n');
  const at = 54402;
  prefix = all.slice(0, at).join('\n') + '\n\n';
  suffix = '\n\n' + all.slice(at).join('\n');
}
const text = () => paras.join('\n\n');
const expected = () => prefix + text() + suffix;
const firstLine = () => prefix.split('\n').length;

async function typeStr(s) {
  const how = pick(['kb', 'kb', 'ins', 'ime']);
  log.push(`(${how})`);
  if (how === 'ime' && CJK.includes(cps(s)[0]) && cps(s).every((c) => CJK.includes(c))) await B.ime(['z', 'zh'].slice(0, 1 + Math.floor(rnd() * 2)), s);
  else if (how === 'ins') await page.keyboard.insertText(s);
  else await page.keyboard.type(s, { delay: HUMAN ? 25 + Math.floor(rnd() * 50) : 0 });
}
const randText = () => { const r = rnd(); return r < 0.5 ? word(1 + Math.floor(rnd() * 3)) : r < 0.85 ? pick(CJK) + (rnd() < 0.5 ? pick(CJK) : '') : pick(ASTRAL); };
async function waitLive(ms = 3000) {
  await page.waitForFunction(() => { const e = document.querySelector('.mdr-preview .is-editing'); return !!e && document.activeElement === e; }, null, { timeout: ms }).catch(() => {});
}
/** Click (real press + release) on the left half of character `off` (code units) of paragraph `i` — or after its end. */
async function clickPara(i, off) {
  await sleep(450); await B.settle(120);
  await page.evaluate((line) => { const pv = window.__mdr.app.preview; if (!pv.isLineVisible(line)) pv.scrollToLine(line, 0.3, 'instant'); }, firstLine() + 2 * i);
  await sleep(700);    // past the navigation anchor
  const pt = await page.evaluate(({ line, off }) => {
    const pv = window.__mdr.app.preview;
    const b = pv.blockAtLine(line);
    const el = b && pv.elementOfBlock(b.id);
    if (!el) return null;
    // a session's paragraph can hold several text nodes (typed / pasted pieces): find the one holding `off`
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (x) => (x.data.replace(/\s/g, '') ? 1 : 2) });
    const nodes = [];
    for (let x = w.nextNode(); x; x = w.nextNode()) nodes.push(x);
    if (!nodes.length) return null;
    let n = nodes[nodes.length - 1], base = 0, acc = 0;
    for (const x of nodes) { const L = x.data.replace(/\s+$/, '').length; if (off < acc + L) { n = x; base = acc; break; } acc += L; base = acc - L; }
    off -= base;
    const r = document.createRange();
    const atEnd = off >= n.data.replace(/\s+$/, '').length;
    const k = atEnd ? n.data.replace(/\s+$/, '').length : off;
    if (atEnd) { r.setStart(n, k - (/[\udc00-\udfff]/.test(n.data[k - 1]) ? 2 : 1)); r.setEnd(n, k); }
    else { r.setStart(n, k); r.setEnd(n, k + (/[\ud800-\udbff]/.test(n.data[k]) ? 2 : 1)); }
    const rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
    return atEnd ? { x: rect.right - 0.5, y: rect.top + rect.height / 2, text: n.data } : { x: rect.left + Math.min(1.5, rect.width / 4), y: rect.top + rect.height / 2, text: n.data };
  }, { line: firstLine() + 2 * i, off });
  if (!pt) return false;
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  if (HUMAN) await sleep(40 + Math.floor(rnd() * 80));
  await page.mouse.up();
  await waitLive(2000);
  return true;
}
async function check(where) {
  await sleep(HUMAN ? 300 : 450); await B.settle(200);
  const src = await B.source();
  if (src !== expected()) {
    const cut = (s) => (s.length > 4000 ? s.slice(prefix.length - 30, s.length - suffix.length + 30) : s);
    fail(`${where} source`, `got ${J(cut(src))}\n  expected ${J(cut(expected()))}`);
    return false;
  }
  if (ghost) return true;
  const c = await page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const s = getSelection();
    if (!el || !s.rangeCount || !el.contains(s.anchorNode)) return null;
    const r = document.createRange(); r.setStart(el, 0); r.setEnd(s.focusNode, s.focusOffset);
    return { off: r.toString().length, text: el.textContent.replace(/\n+$/, ''), focused: document.activeElement === el };
  });
  if (!c || !c.focused) { fail(`${where} session`, `no live focused session: ${J(await B.state())}`); return false; }
  if (c.text !== paras[cur.i] || c.off !== cur.off) { fail(`${where} caret`, `session text ${J(c.text)} off ${c.off}; model ${J(paras[cur.i])} off ${cur.off}`); return false; }
  return true;
}

async function op() {
  if (ghost) {
    // the session sits on an emptied element: type (a new paragraph at the same place) or click elsewhere
    if (rnd() < 0.7 || paras.length === 0) {
      const s = randText();
      log.push(`G${J(s)}`);
      await typeStr(s);
      paras.splice(ghost.at, 0, s);
      cur = { i: ghost.at, off: s.length };
      ghost = null;
    } else {
      const j = Math.floor(rnd() * paras.length), k = Math.floor(rnd() * (paras[j].length + 1));
      const kk = k > 0 && /[\udc00-\udfff]/.test(paras[j][k]) ? k - 1 : k;
      log.push(`GC${j}:${kk}`);
      if (await clickPara(j, kk)) { cur = { i: j, off: kk }; ghost = null; await check(`after ghost-click ${j}:${kk}`); }
    }
    return;
  }
  const p = paras[cur.i];
  const len = p.length;
  let k = pick(['type', 'type', 'type', 'enter', 'bs', 'left', 'right', 'home', 'end', 'click', 'click', 'paste', 'paste2', 'empty', 'escclick']);
  if (len === 0 && k !== 'bs') k = 'type';
  if (k === 'enter' && (cur.off === 0 || cur.off === len)) k = 'type';
  if (k === 'bs' && cur.off === 0 && cur.i === 0) k = 'right';
  if (k === 'empty' && paras.length < 3) k = 'type';
  switch (k) {
    case 'type': {
      const s = randText();
      log.push(`T${J(s)}`);
      await typeStr(s);
      paras[cur.i] = p.slice(0, cur.off) + s + p.slice(cur.off);
      cur.off += s.length;
      break;
    }
    case 'enter': {
      log.push('E');
      await page.keyboard.press('Enter');
      paras.splice(cur.i, 1, p.slice(0, cur.off), p.slice(cur.off));
      cur = { i: cur.i + 1, off: 0 };
      break;
    }
    case 'bs': {
      log.push('B');
      await page.keyboard.press('Backspace');
      if (cur.off > 0) {
        const c = cps(p.slice(0, cur.off)); const last = c.pop();
        paras[cur.i] = c.join('') + p.slice(cur.off);
        cur.off -= last.length;
      } else {
        const j = cur.i - 1, prevLen = paras[j].length;
        paras.splice(j, 2, paras[j] + p);
        cur = { i: j, off: prevLen };
      }
      break;
    }
    case 'left': case 'right': {
      if (k === 'left' && cur.off === 0) { log.push('L0'); break; }
      if (k === 'right' && cur.off >= len) { log.push('R0'); break; }
      log.push(k === 'left' ? 'L' : 'R');
      await page.keyboard.press(k === 'left' ? 'ArrowLeft' : 'ArrowRight');
      if (k === 'left') { const c = cps(p.slice(0, cur.off)); cur.off -= c[c.length - 1].length; } else cur.off += cps(p.slice(cur.off))[0].length;
      break;
    }
    case 'home': case 'end': {
      log.push(k === 'home' ? 'H' : 'N');
      await page.keyboard.press(k === 'home' ? 'Meta+ArrowLeft' : 'Meta+ArrowRight');
      cur.off = k === 'home' ? 0 : len;
      break;
    }
    case 'click': case 'escclick': {
      const j = Math.floor(rnd() * paras.length);
      let kk = Math.floor(rnd() * (paras[j].length + 1));
      if (kk > 0 && kk < paras[j].length && /[\udc00-\udfff]/.test(paras[j][kk])) kk--;
      log.push(`${k === 'escclick' ? 'X' : ''}C${j}:${kk}`);
      if (k === 'escclick') await page.keyboard.press('Escape');
      if (await clickPara(j, kk)) { cur = { i: j, off: kk }; await check(`after click ${j}:${kk}`); }
      else { log.push('(click missed)'); await clickPara(cur.i, cur.off); }
      break;
    }
    case 'paste': case 'paste2': {
      const a = randText();
      const b = k === 'paste2' ? randText() : null;
      const t = b === null ? a : `${a}\n\n${b}`;
      log.push(`P${J(t)}`);
      await page.evaluate((t) => navigator.clipboard.writeText(t), t);
      await page.keyboard.press('Meta+v');
      if (b === null) { paras[cur.i] = p.slice(0, cur.off) + a + p.slice(cur.off); cur.off += a.length; }
      else { paras.splice(cur.i, 1, p.slice(0, cur.off) + a, b + p.slice(cur.off)); cur = { i: cur.i + 1, off: b.length }; }
      break;
    }
    case 'empty': {
      // ⌘A selects the session block's content: right after a split / paste that block is still the old one
      // (all its paragraphs) until the split is written — wait for the session on the current paragraph first
      log.push('Z');
      await sleep(HUMAN ? 150 : 60); await waitLive(3000);
      await page.keyboard.press('Meta+a');
      await page.keyboard.press('Backspace');
      paras.splice(cur.i, 1);
      ghost = { at: cur.i };
      await check('after emptying');
      break;
    }
  }
  if (HUMAN) await sleep(40 + Math.floor(rnd() * 120));
}

try {
  await B.boot('mode=split');
  const orig = expected();
  await B.loadDoc(orig);
  await sleep(500);
  cur = { i: 0, off: Math.floor(rnd() * paras[0].length) };
  if (!(await clickPara(0, cur.off))) throw new Error('first click missed');
  if (!(await check('start'))) throw new Error('start');
  for (let r = 0; r < ROUNDS && !failed; r++) {
    for (let k = 0; k < OPS && !failed; k++) await op();
    if (!failed) await check(`round ${r}`);
  }
  if (!failed) {
    if (ghost) { const s = word(2); log.push(`G${J(s)}`); await page.keyboard.type(s); paras.splice(ghost.at, 0, s); cur = { i: ghost.at, off: s.length }; ghost = null; await check('final ghost type'); }
    const fin = await B.source();
    let u = fin;
    for (let i = 0; i < 150 && u !== orig; i++) { await page.keyboard.press('Meta+z'); await sleep(70); if (i % 5 === 4) { await B.settle(80); u = await B.source(); } }
    await sleep(500); await B.settle(200); u = await B.source();
    if (u !== orig) fail('undo to original', `got ${J(u.length > 4000 ? u.slice(prefix.length - 20, u.length - suffix.length + 20) : u)}`);
    let r2 = u;
    for (let i = 0; i < 150 && r2 !== fin && !failed; i++) { await page.keyboard.press('Meta+Shift+z'); await sleep(70); if (i % 5 === 4) { await B.settle(80); r2 = await B.source(); } }
    await sleep(500); await B.settle(200); r2 = await B.source();
    if (!failed && r2 !== fin) fail('redo to final', `got ${J(r2.length > 4000 ? r2.slice(prefix.length - 20, r2.length - suffix.length + 20) : r2)}`);
  }
  if (B.pageErrors.length) fail('page errors', J(B.pageErrors.slice(0, 3)));
  console.log(`${failed ? 'FAILED' : 'OK'} seed=${seed} ops=${log.length}${HUMAN ? ' human' : ''}${LARGE ? ' large' : ''}`);
} catch (e) { fail('threw', String(e.stack).split('\n').slice(0, 3).join(' | ')); }
finally { stop(); await B.close(); process.exit(failed ? 1 : 0); }
