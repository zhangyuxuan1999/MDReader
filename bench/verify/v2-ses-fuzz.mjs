// bench/verify/v2-ses-fuzz.mjs — verify-session: random editing inside preview sessions WITH AN ORACLE.
// The document region under test is a run of plain paragraphs (letters, digits, CJK, astral chars, no spaces and
// no Markdown punctuation, so a text-editor model predicts the source exactly). Ops: type (keyboard / insertText /
// real IME composition through CDP), Enter (split), Backspace (delete or U3 merge at offset 0), ArrowLeft/Right,
// ⌘←/⌘→, at machine speed or human speed. After each round: the source must equal prefix + model + suffix byte
// for byte, the session must be live with the caret at the model's offset. At the end: ⌘Z until the original,
// ⇧⌘Z until the final text. Every failure prints the seed and the op log.
// Run: MDR_PORT=5282 node bench/verify/v2-ses-fuzz.mjs <seed> [--large] [--human] [--rounds N] [--ops N] [--ses1]
//   --large: the paragraphs sit at line ~54000 of test-data/large.md;  --ses1: do not wait before ⌘←/⌘→ after a
//   split (SES-1 reproduces);  exit code 1 on any failure.
import { openB, sleep, globalTimeout, J, readRoot } from './v2-ses-lib.mjs';

const args = process.argv.slice(2);
const seed = Number(args[0] ?? 1);
const LARGE = args.includes('--large');
const HUMAN = args.includes('--human');
const SES1 = args.includes('--ses1');
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const ROUNDS = opt('--rounds', 4), OPS = opt('--ops', 25);
let st = seed >>> 0 || 1;
const rnd = () => { st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return st / 0x100000000; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
const CJK = '中文字段落测试编辑器输入法拆分合并撤销';
const ASTRAL = ['😀', '🎉', '🚀', '𝒳', '𠀀'];
const cps = (s) => Array.from(s);
const randWord = (n) => { let w = ''; for (let i = 0; i < n; i++) w += ALPHA[Math.floor(rnd() * ALPHA.length)]; return w; };

const B = await openB({ viewport: { width: 1600, height: 900 } });
const stop = globalTimeout(Number(process.env.FUZZ_TIMEOUT ?? 110_000), B.close);
const { page } = B;
const log = [];
let failed = 0;
const fail = (what, detail) => { failed++; console.log(`FAIL seed=${seed}${LARGE ? ' --large' : ''}${HUMAN ? ' --human' : ''} ${what}: ${detail}`); console.log(`  ops: ${log.join(' ')}`); };
async function debugInstall() {
  await page.evaluate(() => {
    const L = (window.__dbg = []);
    const off = () => { const el = document.querySelector('.mdr-preview .is-editing'); const s = getSelection(); if (!el || !s.rangeCount || !el.contains(s.anchorNode)) return null; const r = document.createRange(); r.setStart(el, 0); r.setEnd(s.anchorNode, s.anchorOffset); return r.toString().length; };
    const txt = () => document.querySelector('.mdr-preview .is-editing')?.textContent.replace(/\n+$/, '').replace(/\n/g, '/') ?? null;
    const ex = document.execCommand.bind(document);
    document.execCommand = (c, u, v) => { const b = { off: off(), text: txt() }; const r = ex(c, u, v); L.push(`${performance.now().toFixed(1)} exec ${c}${v !== undefined ? ' ' + JSON.stringify(v) : ''} before=${b.off}@${JSON.stringify(b.text)} after=${off()}@${JSON.stringify(txt())}`); return r; };
    window.addEventListener('keydown', (e) => L.push(`${performance.now().toFixed(1)} key ${e.metaKey ? 'M-' : ''}${e.key} on ${(e.target.className || e.target.tagName).toString().slice(0, 30)} off=${off()}@${JSON.stringify(txt())}`), true);
    document.addEventListener('focusin', (e) => L.push(`${performance.now().toFixed(1)} focus ${(e.target.className || e.target.tagName).toString().slice(0, 30)} off=${off()}@${JSON.stringify(txt())}`), true);
  });
}
async function debugDump() { if (!process.env.DEBUG) return; const d = await page.evaluate(() => window.__dbg.slice(-90)); console.log('  DEBUG\n    ' + d.join('\n    ')); }

// ---- model
const paras = [];
for (let i = 0; i < 5; i++) paras.push(randWord(4 + Math.floor(rnd() * 6)));
let cur = { i: 0, off: 0 };
const text = () => paras.filter((p) => p !== '').join('\n\n');

let prefix = '', suffix = '\n';
if (LARGE) {
  const all = readRoot('test-data/large.md').split('\n');
  const at = 54402;  // a blank line before a paragraph deep in the file
  prefix = all.slice(0, at).join('\n') + '\n\n';
  suffix = '\n\n' + all.slice(at).join('\n');
}
const expected = () => prefix + text() + suffix;

async function type(s) {
  let how = pick(['kb', 'kb', 'ins', 'ime']);
  if (process.env.FUZZ_ONLY) how = process.env.FUZZ_ONLY;
  log.push(`(${how})`);
  if (how === 'ime' && /^[一-鿿]+$/.test(s)) {
    await B.ime(['z', 'zh', 'zho'].slice(0, 1 + Math.floor(rnd() * 3)), s);
  } else if (how === 'ins') await page.keyboard.insertText(s);
  else await page.keyboard.type(s, { delay: HUMAN ? 30 + Math.floor(rnd() * 60) : 0 });
}
let lastSplit = false;
async function op() {
  const p = paras[cur.i];
  const len = p.length;
  const kinds = ['type', 'type', 'type', 'enter', 'bs', 'left', 'right', 'home', 'end'];
  let k = pick(kinds);
  if (len === 0 && k !== 'bs') k = 'type';
  if (k === 'enter' && cur.off === 0) k = 'type';
  if ((k === 'home' || k === 'end') && cps(p).length > 24) k = 'left';
  if (k === 'bs' && cur.off === 0 && cur.i === 0) k = 'right';
  let wasSplit = false;
  switch (k) {
    case 'type': {
      const r = rnd();
      const s = r < 0.5 ? randWord(1 + Math.floor(rnd() * 3)) : r < 0.8 ? cps(CJK)[Math.floor(rnd() * cps(CJK).length)] + (rnd() < 0.5 ? cps(CJK)[Math.floor(rnd() * cps(CJK).length)] : '') : pick(ASTRAL);
      log.push(`T${J(s)}`);
      await type(s);
      paras[cur.i] = p.slice(0, cur.off) + s + p.slice(cur.off);
      cur.off += s.length;
      break;
    }
    case 'enter': {
      log.push('E');
      await page.keyboard.press('Enter');
      paras.splice(cur.i, 1, p.slice(0, cur.off), p.slice(cur.off));
      cur = { i: cur.i + 1, off: 0 };
      wasSplit = true;
      if (paras[cur.i] === '') {   // a new empty paragraph: typing follows at once (an empty one would vanish)
        const s = randWord(1 + Math.floor(rnd() * 3));
        log.push(`T${J(s)}`);
        await type(s);
        paras[cur.i] = s; cur.off = s.length;
      }
      break;
    }
    case 'bs': {
      log.push('B');
      await page.keyboard.press('Backspace');
      if (cur.off > 0) {
        const c = cps(p.slice(0, cur.off));
        const last = c.pop();
        paras[cur.i] = c.join('') + p.slice(cur.off);
        cur.off -= last.length;
      } else {
        // U3: join with the previous paragraph (empty paragraphs never persist in this model)
        let j = cur.i - 1;
        const prevLen = paras[j].length;
        paras.splice(j, 2, paras[j] + p);
        cur = { i: j, off: prevLen };
        wasSplit = true;
      }
      break;
    }
    case 'left': {
      if (cur.off === 0) { log.push('L0'); break; }   // the caret cannot leave the block: skip the key
      log.push('L');
      rnd();   // (kept: the random stream of earlier runs)
      await page.keyboard.press('ArrowLeft');
      const c = cps(p.slice(0, cur.off));
      cur.off -= c[c.length - 1].length;
      break;
    }
    case 'right': {
      if (cur.off >= len) { log.push('R0'); break; }
      log.push('R');
      await page.keyboard.press('ArrowRight');
      cur.off += cps(p.slice(cur.off))[0].length;
      break;
    }
    case 'home': case 'end': {
      if (!SES1) await sleep(60);
      if (!SES1) await page.waitForFunction(() => document.activeElement !== document.querySelector('.mdr-preview__edit-capture'), null, { timeout: 3000 }).catch(() => {});
      log.push(k === 'home' ? 'H' : 'N');
      await page.keyboard.press(k === 'home' ? 'Meta+ArrowLeft' : 'Meta+ArrowRight');
      cur.off = k === 'home' ? 0 : len;
      break;
    }
  }
  lastSplit = wasSplit;
  if (HUMAN) await sleep(40 + Math.floor(rnd() * 120));
}

async function caretOff() {
  return page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const s = getSelection();
    if (!el || !s.rangeCount || !el.contains(s.anchorNode)) return null;
    const r = document.createRange(); r.setStart(el, 0); r.setEnd(s.anchorNode, s.anchorOffset);
    return { off: r.toString().length, text: el.textContent.replace(/\n+$/, ''), focused: document.activeElement === el };
  });
}

try {
  await B.boot('mode=split');
  const orig = expected();
  await B.loadDoc(orig);
  if (process.env.DEBUG) await debugInstall();
  const firstLine = prefix.split('\n').length;
  const needleLen = 1 + Math.floor(rnd() * (paras[0].length - 1));
  await B.clickLine(firstLine, 'first', paras[0]);
  await B.caretAt(paras[0].slice(0, needleLen), 'after');
  cur = { i: 0, off: needleLen };
  for (let r = 0; r < ROUNDS && !failed; r++) {
    for (let k = 0; k < OPS; k++) await op();
    await sleep(500);
    await B.settle(300);
    const src = await B.source();
    if (src !== expected()) {
      const a = src.slice(prefix.length - 40, src.length - suffix.length + 40), b = expected().slice(prefix.length - 40, expected().length - suffix.length + 40);
      fail(`round ${r} source`, `got ${J(src.length > 4000 ? a : src)}\n  expected ${J(src.length > 4000 ? b : expected())}`);
      await debugDump();
      break;
    }
    const c = await caretOff();
    if (!c || !c.focused) { fail(`round ${r} session`, `no live focused session: ${J(await B.state())}`); break; }
    if (c.text !== paras[cur.i] || c.off !== cur.off) { fail(`round ${r} caret`, `session text ${J(c.text)} off ${c.off}; model ${J(paras[cur.i])} off ${cur.off}`); break; }
  }
  if (!failed) {
    const fin = await B.source();
    let u = fin;
    for (let i = 0; i < 80 && u !== orig; i++) { await page.keyboard.press('Meta+z'); await sleep(60); if (i % 5 === 4) { await B.settle(80); u = await B.source(); } }
    await sleep(400); await B.settle(200); u = await B.source();
    if (u !== orig) fail('undo to original', `got ${J(u.length > 4000 ? u.slice(prefix.length - 20, u.length - suffix.length + 20) : u)}`);
    let r2 = u;
    for (let i = 0; i < 80 && r2 !== fin && !failed; i++) { await page.keyboard.press('Meta+Shift+z'); await sleep(60); if (i % 5 === 4) { await B.settle(80); r2 = await B.source(); } }
    await sleep(400); await B.settle(200); r2 = await B.source();
    if (!failed && r2 !== fin) fail('redo to final', `got ${J(r2.length > 4000 ? r2.slice(prefix.length - 20, r2.length - suffix.length + 20) : r2)}`);
    const live = await caretOff();
    if (!failed && !(live && live.focused)) fail('live after undo/redo', J(await B.state()));
  }
  if (B.pageErrors.length) fail('page errors', J(B.pageErrors.slice(0, 3)));
  console.log(`${failed ? 'FAILED' : 'OK'} seed=${seed} ops=${log.length}${LARGE ? ' large' : ''}${HUMAN ? ' human' : ''}`);
} catch (e) { fail('threw', e.stack.split('\n').slice(0, 3).join(' | ')); }
finally { stop(); await B.close(); process.exit(failed ? 1 : 0); }
