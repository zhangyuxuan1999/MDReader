// bench/verify/v7-vf-diff.mjs — verify-refs (round 6): a differential of scripted sessions on blocks WITHOUT any
// hidden character (no references, no percent-escapes, no invisible characters), the tree against a copy of the tree
// before round 6. Seeded documents (paragraphs with emphasis, code, links, formulas, CJK; headings; lists, task lists,
// ordered lists; quotes; tables; fences) and seeded sessions (type, Backspace, Delete, bold / italic / code on a word,
// paste of one or two lines, Enter, undo, redo, a merge at a block start, Esc and a click into another block). Prints
// one line per session: the seed, a hash of the final source and of the toasts, so two runs can be compared line by line.
// Run: MDR_PORT=<server> node bench/verify/v7-vf-diff.mjs <firstSeed> <count> > out.txt   (T_MS, default 110000)
import { createHash } from 'node:crypto';
import { launch, openApp, load, source, toasts, clickAt, caret, paste, esc, editing, rawAdded, show, globalTimeout, sleep } from './v7-vf-lib.mjs';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const first = Number(process.argv[2] ?? 1), count = Number(process.argv[3] ?? 10);
const T_MS = Number(process.env.T_MS ?? 110000);
const VERB = !!process.env.VERBOSE;
const HIDDEN = process.env.MDR_HIDDEN === '1';   // documents WITH references and percent-escapes of hidden characters (invariants only)

function gen(seed) {
  let s = seed >>> 0 || 1;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const pick = (a) => a[Math.floor(r() * a.length)];
  const W = ['alpha', 'beta', 'gamma', 'delta', 'omega', '文字', '段落', '测试', '内容', 'lorem', 'ipsum'];
  const REFS = ['&shy;', '&emsp;', '&#x3000;', '&zwnj;', '&ensp;', '&thinsp;', '&#x200E;', '&nbsp;', '&#8288;', '&lrm;', '&#173;', '&#X2003;', '&zwj;', '&numsp;'];
  const hid = (w) => (HIDDEN && r() < 0.3 ? w.slice(0, 2) + pick(REFS) + w.slice(2) : w);
  const words = (n, tag) => Array.from({ length: n }, (_, i) => (i === 1 ? tag : hid(pick(W)))).join(' ');
  const inl = (tag) => {
    const base = words(3 + Math.floor(r() * 4), tag);
    const extra = pick([...(HIDDEN ? [' https://e.example/a%E2%80%AEb/c', ' <https://e.example/x%C2%ADy>', ' [li&shy;nk](https://e.example/p%E3%80%80q "ti&emsp;tle")', ' ![a&zwnj;lt](i.png)'] : []), '', ' **bold part**', ' *italic part*', ' `code part`', ' [link text](https://e.example/p)', ' $x^2$', ' ~~gone~~', ' 中文的句子。', ' a_b and c*d']);
    return base + extra + ' ' + pick(W);
  };
  const blocks = [];
  const n = 3 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const tag = `t${i}x`;
    const k = r();
    if (k < 0.35) blocks.push(inl(tag));
    else if (k < 0.45) blocks.push('## ' + inl(tag));
    else if (k < 0.6) blocks.push(`- ${inl(tag)}\n- ${words(3, 'i' + i + 'b')}\n- ${words(2, 'i' + i + 'c')}`);
    else if (k < 0.68) blocks.push(`- [ ] ${inl(tag)}\n- [x] ${words(3, 'i' + i + 'b')}`);
    else if (k < 0.75) blocks.push(`1. ${inl(tag)}\n2. ${words(3, 'i' + i + 'b')}`);
    else if (k < 0.85) blocks.push(`> ${inl(tag)}\n> ${words(3, 'i' + i + 'b')}`);
    else if (k < 0.95) blocks.push(`| h1 | h2 |\n| --- | --- |\n| ${words(3, tag)} | ${words(2, 'c' + i)} |\n| ${words(2, 'd' + i)} | e${i} |`);
    else blocks.push('```js\nlet ' + tag + ' = 1;\nconst y = 2;\n```');
  }
  const doc = '# Doc\n\n' + blocks.join('\n\n') + '\n';
  const acts = [];
  const nA = 2 + Math.floor(r() * 4);
  for (let i = 0; i < nA; i++) acts.push(pick(['type', 'type', 'bs', 'del', 'bold', 'italic', 'code', 'paste', 'paste2', 'enter', 'undo', 'redo', 'merge', 'other']));
  return { doc, start: Math.floor(r() * n), acts, n, r };
}

let browser;
const stop = globalTimeout(T_MS, async () => browser?.close());
try {
  browser = await launch();
  const A = await openApp(browser, port, { perf: true });
  for (let seed = first; seed < first + count; seed++) {
    A.guard.length = 0;
    const g = gen(seed);
    await load(A, g.doc, `d${seed}.md`);
    const t0 = await toasts(A);
    let typed = '', log = [];
    let on = await clickAt(A, `t${g.start}x`, 0, 1);
    log.push(on ? 'S' : 'N');
    if (on) {
      await caret(A, `t${g.start}x`);
      for (const a of g.acts) {
        if (!(await editing(A)) && a !== 'other') { log.push('-'); continue; }
        if (a === 'type') { const t = ' w' + Math.floor(g.r() * 99); await A.page.keyboard.type(t, { delay: 8 }); typed += t; }
        else if (a === 'bs') for (let i = 0; i < 1 + Math.floor(g.r() * 3); i++) await A.page.keyboard.press('Backspace');
        else if (a === 'del') for (let i = 0; i < 1 + Math.floor(g.r() * 3); i++) await A.page.keyboard.press('Delete');
        else if (a === 'bold' || a === 'italic' || a === 'code') {
          await A.page.keyboard.press('Alt+Shift+ArrowLeft');
          await A.page.keyboard.press(a === 'bold' ? 'Meta+b' : a === 'italic' ? 'Meta+i' : 'Meta+e');
          await A.page.keyboard.press('ArrowRight');
        } else if (a === 'paste') { const t = 'pasted words'; await paste(A, t); typed += t; }
        else if (a === 'paste2') { const t = 'line one\nline two'; await paste(A, t); typed += t; }
        else if (a === 'enter') { await A.page.keyboard.press('Enter'); await sleep(300); await A.page.keyboard.type('nx', { delay: 8 }); typed += 'nx'; }
        else if (a === 'undo') { await sleep(500); await A.page.keyboard.press('Meta+z'); }
        else if (a === 'redo') { await sleep(300); await A.page.keyboard.press('Meta+Shift+z'); }
        else if (a === 'merge') {
          await A.page.evaluate(() => { const s = getSelection(); if (!s.anchorNode) return; const n = s.anchorNode; const p = (n.nodeType === 1 ? n : n.parentElement).closest('p, li, td, th, h1, h2, h3, section'); if (!p) return; const r = document.createRange(); r.setStart(p, 0); r.collapse(true); s.removeAllRanges(); s.addRange(r); });
          await A.page.keyboard.press('Backspace'); await sleep(350);
        } else if (a === 'other') {
          await esc(A);
          const j = (g.start + 1) % g.n;
          const ok = await clickAt(A, `t${j}x`, 0, 1);
          if (ok) await caret(A, `t${j}x`);
        }
        await sleep(90);
        log.push(a[0]);
      }
    }
    await sleep(250);
    await esc(A);
    const out = await source(A);
    const tt = (await toasts(A)) - t0;
    const added = rawAdded(g.doc, out, typed);
    const h = createHash('sha1').update(out).digest('hex').slice(0, 12);
    console.log(`seed=${seed} acts=${g.acts.join(',')} log=${log.join('')} toast=${tt} guard=${A.guard.length} raw+=${added.join(',') || '-'} src=${h}${VERB ? ' ' + show(out) : ''}`);
  }
  console.log('DONE');
} finally { stop(); await browser?.close(); }
