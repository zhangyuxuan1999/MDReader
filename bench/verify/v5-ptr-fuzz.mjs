// bench/verify/v5-ptr-fuzz.mjs — verify-session-pointer: a seeded pointer / clipboard / paste fuzz of the in-preview
// editing session (switch ON, the dev server of the tree). Random clicks, double / triple clicks, drags inside and out
// of blocks, Shift-clicks, Shift+arrows, ⌘A, typing unique tokens, pastes (one line, lines, paragraphs, leading /
// trailing blank lines, Markdown characters), copies, cuts, Enter / Shift+Enter / Backspace / Delete, ⌘B / ⌘E, undo,
// Esc, at machine speed or with pauses. After every step:
//   V1 the source holds no invisible code point the document did not hold (U+200B, U+FEFF, raw U+00A0, marker ranges)
//   V2 with no live session, no zero-width character is left in the preview outside KaTeX's markup
//   V3 a copy / cut put no U+200B / U+FEFF / marker character on the clipboard (the documents hold no KaTeX vlist)
//   V4 no token typed or pasted appears in the source more than once
//   V5 no anchor word of a block that held no session and no selection end before the step vanished (not checked for
//      undo / redo steps)
// Soft notes: a token typed into a live session that is not in the source 1 s later (printed, not a violation).
// Run: node bench/verify/v5-ptr-fuzz.mjs <seed> [--ops N] [--doc k]   (exit 1 on a violation, 3 on the global timeout)
import { sleep, globalTimeout, J, openAt, prepare, CP, show, invisibleExtra, none, readClip, clearClip, domZw, sessionOn } from './v5-ptr-lib.mjs';
import { rng } from './v3-ses-lib.mjs';

const seed = Number(process.argv[2] || 1);
const ai = process.argv.indexOf('--ops');
const OPS = ai > 0 ? Number(process.argv[ai + 1]) : 40;
const di = process.argv.indexOf('--doc');
const DOCS = [
  [
    '# Head Aaa with $x^2$ formula', '',
    'Para Bbb **bold Ccc** and [link Ddd](http://e.x/) end.', '',
    '$a+b$ leads Eee line  ', 'second Fff line.', '',
    '- item Ggg one', '- item Hhh *em*', '  - nested Iii', '',
    '> quote Jjj words', '> more Kkk', '',
    '| Lll a | Mmm b |', '|---|---|', '| Nnn c | ![im](x.png) Ooo |', '',
    '1. ord Ppp', '2. ord Qqq', '',
    'Last Rrr para ~~del~~ `code Sss`.', '',
  ].join('\n'),
  [
    'Alpha Aaa words and more words here.', '',
    'Bravo Bbb ![pic](x.png) image $y^2$ text.', '',
    '- [ ] task Ccc', '- [x] task Ddd', '', '***both Eee*** plain', '',
    '## Second Fff heading', '',
    '> - quoted Ggg item', '> - quoted Hhh item', '',
    'Tail Iii para with [**bold link Jjj**](http://e.x/j) end.', '',
  ].join('\n'),
];
const DOC = DOCS[di > 0 ? Number(process.argv[di + 1]) : seed % DOCS.length];
const ANCHORS = [...new Set(DOC.match(/\b[A-Z][a-z]{2}\b/g).filter((w) => w[1] === w[0].toLowerCase() && w[2] === w[1]))];
const R = rng(seed * 7919 + 17);
const pick = (a) => a[Math.floor(R() * a.length)];
const int = (a, b) => a + Math.floor(R() * (b - a + 1));
let tokN = 0;
const tok = () => `z${seed}q${++tokN}x`;
const typedTokens = new Set();

async function randomPoint(page) {
  return page.evaluate((r) => {
    const root = document.querySelector('.mdr-preview');
    const nodes = [];
    const tw = document.createTreeWalker(root, 4, { acceptNode: (n) => (n.parentElement?.closest('.katex-mathml, [data-mdr-ui], .mdr-preview__edit-capture') || !n.data.trim() ? 2 : 1) });
    for (let n = tw.nextNode(); n; n = tw.nextNode()) nodes.push(n);
    if (!nodes.length) return null;
    const n = nodes[Math.floor(r[0] * nodes.length)];
    const k = Math.floor(r[1] * n.data.length);
    const range = document.createRange(); range.setStart(n, k); range.setEnd(n, Math.min(n.data.length, k + 1));
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    if (!rect || rect.width + rect.height === 0 || rect.top < box.top || rect.bottom > box.bottom) return null;
    return { x: rect.left + Math.min(1.5, rect.width / 2), y: rect.top + rect.height / 2, text: n.data.slice(Math.max(0, k - 4), k + 4) };
  }, [R(), R()]);
}
const sessionAnchors = (page) => page.evaluate(() => { const e = document.querySelector('.mdr-preview .is-editing'); return e ? e.textContent : ''; });
const selEnds = (page) => page.evaluate(() => {
  const s = getSelection(); if (!s.rangeCount) return '';
  const blk = (n) => (n ? (n.nodeType === 1 ? n : n.parentElement)?.closest('section.md-block')?.textContent ?? '' : '');
  return blk(s.anchorNode) + ' ' + blk(s.focusNode);
});

let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
const viol = [], notes = [], log = [];
try {
  A = await openAt(CP, false);
  await prepare(A, DOC);
  const page = A.page;
  for (let i = 0; i < OPS; i++) {
    const srcBefore = await A.source();
    const inSession = await sessionAnchors(page);
    const ends = await selEnds(page);
    const liveBefore = await sessionOn(page);
    const edFocus = await page.evaluate(() => !!document.activeElement?.closest('.cm-editor'));   // (keys then edit the source in the editor pane: V5 not judged)
    const r = R();
    let op = '', copiedClip = null, history = false, typed = null;
    if (r < 0.16) { const p = await randomPoint(page); if (p) { op = `click "${p.text}"`; await page.mouse.click(p.x, p.y); } }
    else if (r < 0.21) { const p = await randomPoint(page); if (p) { const n = pick([2, 3]); op = `click${n} "${p.text}"`; await page.mouse.click(p.x, p.y, { clickCount: n }); } }
    else if (r < 0.28) {
      const p = await randomPoint(page), q = await randomPoint(page);
      if (p && q) { op = `drag "${p.text}"->"${q.text}"`; await page.mouse.move(p.x, p.y); await page.mouse.down(); for (let s = 1; s <= 6; s++) { await page.mouse.move(p.x + (q.x - p.x) * s / 6, p.y + (q.y - p.y) * s / 6); await sleep(12); } await page.mouse.up(); }
    }
    else if (r < 0.32) { const p = await randomPoint(page); if (p) { op = `shift-click "${p.text}"`; await page.keyboard.down('Shift'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Shift'); } }
    else if (r < 0.40) { const k = pick(['Shift+ArrowLeft', 'Shift+ArrowRight', 'Shift+Home', 'Shift+End', 'Meta+a', 'Shift+ArrowUp', 'Shift+ArrowDown', 'Alt+Shift+ArrowLeft']); const n = k.includes('Arrow') ? int(1, 4) : 1; op = `${k}x${n}`; for (let s = 0; s < n; s++) await page.keyboard.press(k); }
    else if (r < 0.52) { typed = tok(); op = `type ${typed}`; await page.keyboard.type(pick([typed, typed + ' ', ' ' + typed])); }
    else if (r < 0.64) {
      const a = tok(), b = tok();
      const text = pick([a, `${a} ${b}`, `${a}\n${b}`, `${a}\n\n${b}`, `\n\n${a}`, `${a}\n\n`, `*${a}* [${b}](u)`, `${a}\n   \n${b}`, `  ${a}  `]);
      typed = a; op = `paste ${J(text)}`;
      await page.evaluate((t) => navigator.clipboard.writeText(t), text); await page.keyboard.press('Meta+v');
      typedTokens.add(b);
    }
    else if (r < 0.70) { op = 'copy'; await clearClip(page); await page.keyboard.press('Meta+c'); await sleep(150); copiedClip = await readClip(page); }
    else if (r < 0.74) { op = 'cut'; await clearClip(page); await page.keyboard.press('Meta+x'); await sleep(150); copiedClip = await readClip(page); }
    else if (r < 0.84) { const k = pick(['Enter', 'Shift+Enter', 'Backspace', 'Delete', 'Backspace', 'ArrowLeft', 'ArrowRight', 'Home', 'End']); const n = int(1, 2); op = `${k}x${n}`; for (let s = 0; s < n; s++) await page.keyboard.press(k); }
    else if (r < 0.88) { const k = pick(['Meta+b', 'Meta+e', 'Meta+i']); if (liveBefore) { op = k; await page.keyboard.press(k); } else { op = 'Escape'; await page.keyboard.press('Escape'); } }   // (outside a session these are the editor's commands, as in 0.1.1)
    else if (r < 0.95) { const k = pick(['Meta+z', 'Meta+z', 'Meta+Shift+z']); op = k; history = true; await page.keyboard.press(k); }
    else { op = 'Escape'; await page.keyboard.press('Escape'); }
    if (!op) { i--; continue; }
    if (typed) typedTokens.add(typed);
    await sleep(pick([0, 60, 250, 450]));
    await A.settle(120);
    const src = await A.source();
    const live = await sessionOn(page);
    const step = `${i}:${op}`;
    log.push(step);
    const ix = invisibleExtra(src, DOC);
    if (!none(ix)) viol.push(`V1 ${step} invisible ${J(ix)} src=${show(src)}`);
    if (!live) { const z = await domZw(page); if (z.length) viol.push(`V2 ${step} zw left ${J(z)}`); }
    if (copiedClip) {
      const cx = invisibleExtra(copiedClip.plain + copiedClip.html, '');
      delete cx['U+00A0'];
      if (!none(cx)) viol.push(`V3 ${step} clipboard ${J(cx)} plain=${show(copiedClip.plain.slice(0, 80))}`);
    }
    for (const t of typedTokens) { const k = src.split(t).length - 1; if (k > 1) viol.push(`V4 ${step} token ${t} x${k} src=${show(src)}`); }
    if (!history && !edFocus) {
      for (const a of ANCHORS) if (srcBefore.includes(a) && !src.includes(a) && !inSession.includes(a) && !ends.includes(a)) viol.push(`V5 ${step} anchor ${a} vanished (session block "${inSession.slice(0, 40)}") src=${show(src)}`);
    }
    if (typed && liveBefore && /^type/.test(op)) {
      await sleep(600); await A.settle(100);
      if (!(await A.source()).includes(typed)) notes.push(`${step} typed ${typed} not in source (live before)`);
    }
    if (viol.length) break;
  }
  const fin = await A.source();
  console.log(`seed=${seed} ops=${log.length} doc=${DOCS.indexOf(DOC)} violations=${viol.length}`);
  for (const v of viol) console.log('VIOLATION ' + v);
  for (const n of notes) console.log('note ' + n);
  if (viol.length || process.env.MDR_VERBOSE) console.log('steps: ' + log.join(' | '));
  if (process.env.MDR_VERBOSE) console.log('final=' + show(fin));
  if (A.pageErrors.length) console.log('pageErrors ' + J(A.pageErrors.slice(0, 3)));
} finally { stop(); await A?.close(); }
process.exitCode = viol.length ? 1 : 0;
