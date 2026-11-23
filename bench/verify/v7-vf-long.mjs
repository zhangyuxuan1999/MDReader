// bench/verify/v7-vf-long.mjs — verify-refs (round 6): THE GUARD in a long life. One session started in a paragraph of a
// document that holds hidden characters (references), then ROUNDS rounds of mixed input at the caret: typed words,
// a CJK composition, emoji with ZWJ / VS16 / keycaps / skin tones / flags (CDP insertText), Persian with ZWNJ,
// consecutive spaces, pasted fragments with U+00A0 and U+3000; every few rounds an Enter (split), a merge (Home,
// Backspace, End), an undo + redo pair. At the end Esc. Checks: the guard fired 0 times, no refusal toast, the session
// was live to the end, every character the input held that is not plainly visible is in the source as often as it was
// put in (raw, or as a reference where the block spelled it so), the rendered text holds everything typed in order, the
// references of the untouched blocks are byte-identical.
// Run: MDR_PORT=<server with hooks> node bench/verify/v7-vf-long.mjs [rounds=50] [seed=1]   (T_MS, default 110000)
import { launch, openApp, load, source, toasts, clickAt, caret, paste, ime, insertText, esc, editing, rawCounts, refCounts, show, shown, globalTimeout, sleep, C } from './v7-vf-lib.mjs';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const ROUNDS = Number(process.argv[2] ?? 50);
let seed = Number(process.argv[3] ?? 1);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const T_MS = Number(process.env.T_MS ?? 110000);
const ZWJ = C(0x200d), VS16 = C(0xfe0f), ZWNJ = C(0x200c), NBSP = C(0xa0), IDSP = C(0x3000);
const EMOJI = [C(0x1f469) + ZWJ + C(0x1f4bb), C(0x2764) + VS16, C(0x1f44d, 0x1f3fd), C(0x1f1e8, 0x1f1f3), '1' + VS16 + C(0x20e3), C(0x1f3f3) + VS16 + ZWJ + C(0x1f308), C(0x1f468) + ZWJ + C(0x1f469) + ZWJ + C(0x1f467)];
const PERSIAN = ['می' + ZWNJ + 'خواهم', 'کتاب' + ZWNJ + 'ها', 'نامه' + ZWNJ + 'ای'];
const IMES = [[['n', 'ni', 'nih', 'niha', 'nihao'], '你好'], [['s', 'sh', 'shi', 'shij', 'shijie'], '世界'], [['z', 'zh', 'zho', 'zhon', 'zhong'], '中文'], [['k', 'ka', 'kan'], '看']];
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'word', 'text', 'line'];
const DOC = '# Long\n\nAbove&emsp;paragraph with a&shy;b and c&zwnj;d words.\n\nStart here and&nbsp;go\n\nBelow&#x3000;paragraph&ensp;end.\n';

let browser;
const stop = globalTimeout(T_MS, async () => browser?.close());
try {
  browser = await launch();
  const A = await openApp(browser, port, { perf: true });
  await load(A, DOC, 'long.md');
  const t0 = await toasts(A);
  if (!(await clickAt(A, 'Start here', 0, 2))) throw new Error('no session');
  await caret(A, 'go');
  const put = [];                     // the input, in order (a split is a line feed)
  let lostSession = 0, undoBad = 0, merges = 0, splits = 0;
  for (let r = 0; r < ROUNDS; r++) {
    if (!(await editing(A))) { lostSession++; console.log('session lost at round ' + r); break; }
    const w = ' ' + WORDS[Math.floor(rnd() * WORDS.length)] + r;
    await A.page.keyboard.type(w, { delay: 5 }); put.push(w);
    const [steps, commit] = IMES[r % IMES.length];
    await ime(A, steps, commit); put.push(commit);
    const e = EMOJI[r % EMOJI.length];
    await insertText(A, e); put.push(e);
    if (r % 2 === 0) { const p = ' ' + PERSIAN[r % PERSIAN.length]; await insertText(A, p); put.push(p); }
    if (r % 3 === 0) { await A.page.keyboard.type(' x   y', { delay: 5 }); put.push(' x   y'); }
    if (r % 4 === 1) { const p = ' p' + NBSP + 'q' + IDSP + 'r'; await paste(A, p); put.push(p); }
    if (r % 6 === 5) {
      const before = await source(A);
      await sleep(400);
      await A.page.keyboard.press('Meta+z'); await sleep(250);
      await A.page.keyboard.press('Meta+Shift+z'); await sleep(350);
      const after = await source(A);
      if (after !== before) { undoBad++; console.log(`undo/redo round ${r}: ${show(before.slice(-60))} -> ${show(after.slice(-60))}`); }
    }
    if (r % 5 === 4) { await A.page.keyboard.press('Enter'); await sleep(350); put.push('\n'); splits++; }
    if (r % 7 === 6 && put.at(-1) !== '\n') {
      await A.page.evaluate(() => {   // the caret to the start of the paragraph it is in (Home would go to the visual line)
        const s = getSelection(); const n = s.anchorNode; const p = (n.nodeType === 1 ? n : n.parentElement).closest('p, li, h1, h2, h3, div.md-block, section');
        const r = document.createRange(); r.setStart(p, 0); r.collapse(true); s.removeAllRanges(); s.addRange(r);
      });
      await sleep(60);
      await A.page.keyboard.press('Backspace'); await sleep(450);
      await A.page.evaluate(() => {   // and back to the end of the session's text
        const el = document.querySelector('.md-block.is-editing'); if (!el) return;
        const tw = document.createTreeWalker(el, 4); let last = null; for (let n = tw.nextNode(); n; n = tw.nextNode()) if (n.data.trim()) last = n;
        const r = document.createRange(); r.setStart(last, last.data.length); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      });
      await sleep(60);
      merges++;
      // the merge joined this line to the one above: the line feed of the last split goes
      for (let i = put.length - 1; i >= 0; i--) if (put[i] === '\n') { put[i] = ''; break; }
    }
  }
  await sleep(400);
  await esc(A);
  const out = await source(A);
  const tt = (await toasts(A)) - t0;
  const typed = put.join('');
  // characters that are not plainly visible: source raw + source references (beyond the document's own) == input
  const want = rawCounts(typed), srcRaw = rawCounts(out), srcRef = refCounts(out), docRaw = rawCounts(DOC), docRef = refCounts(DOC);
  const miss = [];
  for (const [c, k] of want) {
    const have = (srcRaw.get(c) ?? 0) - (docRaw.get(c) ?? 0) + (srcRef.get(c) ?? 0) - (docRef.get(c) ?? 0);
    if (c === NBSP) {   // K26: typed runs of spaces are written with &nbsp; as well; a raw U+00A0 is never written
      const rawAdd = (srcRaw.get(c) ?? 0) - (docRaw.get(c) ?? 0), spaces = [...typed].filter((x) => x === ' ').length;
      if (rawAdd > 0 || have < k || have > k + spaces) miss.push(`U+A0 put ${k} (+${spaces} spaces) source ${have} raw added ${rawAdd}`);
      continue;
    }
    if (have !== k) miss.push(`U+${c.codePointAt(0).toString(16).toUpperCase()} put ${k} source ${have}`);
  }
  for (const [c] of srcRaw) if (!want.has(c) && (srcRaw.get(c) ?? 0) > (docRaw.get(c) ?? 0)) miss.push(`U+${c.codePointAt(0).toString(16).toUpperCase()} raw but not put`);
  // the rendered text holds the input in order (white space normalized)
  const norm = (s) => s.split(NBSP).join(' ').replace(/\s+/g, ' ').trim();
  const view = norm(await shown(A));
  const wantView = norm(typed);
  const at = view.indexOf(norm(put.find((x) => x.trim()) ?? ''));
  const inOrder = view.includes(wantView);
  let firstDiff = -1;
  if (!inOrder) { const v = view.slice(Math.max(0, at)); for (let i = 0; i < wantView.length; i++) if (v[i] !== wantView[i]) { firstDiff = i; break; } }
  const untouched = out.startsWith('# Long\n\nAbove&emsp;paragraph with a&shy;b and c&zwnj;d words.\n\nStart here and&nbsp;go') && out.endsWith('Below&#x3000;paragraph&ensp;end.\n');
  const bad = A.guard.length || tt || lostSession || miss.length || !inOrder || !untouched || undoBad;
  console.log(`rounds=${ROUNDS} seed=${process.argv[3] ?? 1} chars put=${[...typed].length} splits=${splits} merges=${merges} guard=${A.guard.length} toast=${tt} lostSession=${lostSession} undoRedoBad=${undoBad}`);
  console.log(`counted characters: ${miss.length ? miss.join('; ') : 'all equal'} (${[...want].map(([c, k]) => 'U+' + c.codePointAt(0).toString(16).toUpperCase() + 'x' + k).join(' ')})`);
  console.log(`rendered text in order: ${inOrder}${inOrder ? '' : ' first difference at ' + firstDiff + ': view ' + show(view.slice(Math.max(0, at) + firstDiff - 20, Math.max(0, at) + firstDiff + 40)) + ' want ' + show(wantView.slice(firstDiff - 20, firstDiff + 40))}; untouched blocks byte-identical: ${untouched}`);
  if (A.guard.length) console.log('guard lines: ' + A.guard.slice(0, 3).join(' | '));
  console.log(`RESULT ${bad ? 'FAIL' : 'PASS'}`);
} finally { stop(); await browser?.close(); }
