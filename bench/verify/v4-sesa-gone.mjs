// bench/verify/v4-sesa-gone.mjs — verify-session-a (round-3 re-verification): U18 (H3, H12 variations) in real
// Chromium. Every case loads a fresh document, starts a session in block X by a real click, empties X (⌘A ⌫ unless
// the case says otherwise) and then presses keys in the emptied element; the source after the last step is
// compared with the exact expected string, then ⌘Z is pressed until the original comes back (byte for byte) and
// ⇧⌘Z until the final source comes back. Optional `after`: a click on a neighbour + typing proves the app is
// usable (never stuck).
// Steps: ['click', needle, k] ['sel'] (⌘A) ['k', key] (press) ['t', text] (type) ['w', ms] (settle) ['fast', ...keys]
// (presses without any wait, machine speed) ['clickSel', css].
// Run: MDR_PORT=5431 node bench/verify/v4-sesa-gone.mjs [name-filter]   (T_MS = global timeout, default 600 s)
import { openB, sleep, globalTimeout, J, check, summary, view, shownText, clickText, undoTo, redoTo, waitSession, clickSel, load } from './v4-sesa-lib.mjs';

const filter = process.argv[2] || '';
const B = await openB({ clipboard: true });
const stop = globalTimeout(Number(process.env.T_MS ?? 600_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };

async function run(steps) {
  for (const st of steps) {
    const [op, a, b] = st;
    if (op === 'click') { await clickText(page, a, b ?? 1, { side: 'right' }); await waitSession(page); await sleep(80); }
    else if (op === 'clickSel') { await clickSel(B, a); await sleep(80); }
    else if (op === 'sel') await page.keyboard.press('Meta+a');
    else if (op === 'k') await page.keyboard.press(a);
    else if (op === 't') await page.keyboard.type(a);
    else if (op === 'w') await settle(a ?? 320);
    else if (op === 'fast') { for (const k of st.slice(1)) { if (k.length === 1) await page.keyboard.type(k); else await page.keyboard.press(k); } }
    else if (op === 'ime') { await B.ime(a, b); }
    else throw new Error('bad step ' + op);
  }
}

const EMPTY = [['sel'], ['k', 'Backspace'], ['w']];
const P = 'xx para';
const BELOW = '\n\nzz\n';
/** A case: doc, steps after the click into X, wanted final source (string) or a predicate, X's click needle. */
const cases = [];
const add = (name, doc, steps, want, extra = {}) => cases.push({ name, doc, steps, want, ...extra });

// ---- P: the block before the emptied element is of another kind: Backspace puts the caret at its END
const PREV = {
  list: ['- a1\n- b1', '- a1\n- b1Q'],
  task: ['- [ ] a1\n- [x] b1', '- [ ] a1\n- [x] b1Q'],
  nested: ['- a1\n  - b1', '- a1\n  - b1Q'],
  ordered: ['1. a1\n2. b1', '1. a1\n2. b1Q'],
  heading: ['# Hd1', '# Hd1Q'],
  quote: ['> q1', '> q1Q'],
  quotelist: ['> - qa1', '> - qa1Q'],
  quote2: ['> q1\n>\n> q2', '> q1\n>\n> q2Q'],
  fence: ['```\ncode1\n```', '```\ncode1Q\n```'],
  fenceLang: ['```js\nlet a = 1;\n```', '```js\nlet a = 1;Q\n```'],
  indented: ['    ind1', '    ind1Q'],
  table: ['| h1 | h2 |\n|----|----|\n| c1 | c2 |', '| h1 | h2 |\n|----|----|\n| c1 | c2Q |'],
  math: ['$$\nx^2\n$$', '$$\nx^2Q\n$$'],
  imgEnd: ['see ![i](https://e.example/i.png)', 'see ![i](https://e.example/i.png)Q'],
  mathEnd: ['a1 $x^2$', 'a1 $x^2$Q'],
  codeEnd: ['a1 `cd`', 'a1 `cd`Q'],
  linkEnd: ['a1 [lk](https://e.example/)', 'a1 [lk](https://e.example/)Q'],
  hardbreak: ['a1  \nb1', 'a1  \nb1Q'],
  softbreak: ['a1\nb1', 'a1\nb1Q'],
  boldEnd: ['a1 **bb**', 'a1 **bbQ**'],
};
for (const [k, [prev, want]] of Object.entries(PREV)) {
  add(`prev-${k}-bs`, prev + '\n\n' + P + BELOW, [...EMPTY, ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], want + '\n\nzz\n');
  add(`prev-${k}-fast`, prev + '\n\n' + P + BELOW, [['fast', 'Meta+a', 'Backspace', 'Backspace', 'Q'], ['w', 900]], want + '\n\nzz\n');
}
// uneditable / refused block before: the session just ends, Q goes nowhere, nothing written
add('prev-html-bs', '<div>raw1</div>\n\n' + P + BELOW, [...EMPTY, ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], '<div>raw1</div>\n\nzz\n', { after: ['zz', 'zzY'] });
add('prev-reserved-bs', 'a1 <span data-md="1">r1</span>\n\n' + P + BELOW, [...EMPTY, ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], 'a1 <span data-md="1">r1</span>\n\nzz\n', { after: ['zz', 'zzY'] });
add('prev-hr-bs', '---\n\n' + P + BELOW, [...EMPTY, ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], '---\n\nzz\n', { after: ['zz', 'zzY'] });
add('prev-none-bs', P + BELOW, [...EMPTY, ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], 'zz\n', { after: ['zz', 'zzY'] });

// ---- K: every key in the emptied element (paragraph X between paragraphs)
const D = 'aaa\n\n' + P + BELOW;
const KEYS = {
  'alt-bs': [['k', 'Alt+Backspace']], 'meta-bs': [['k', 'Meta+Backspace']], 'ctrl-h': [['k', 'Control+h']],
  'shift-bs': [['k', 'Shift+Backspace']],
};
for (const [k, st] of Object.entries(KEYS)) add(`key-${k}`, D, [...EMPTY, ...st, ['w', 600], ['t', 'Q'], ['w', 500]], 'aaaQ\n\nzz\n');
const STAY = {
  del: [['k', 'Delete']], 'alt-del': [['k', 'Alt+Delete']], 'meta-del': [['k', 'Meta+Delete']], 'ctrl-d': [['k', 'Control+d']],
  'ctrl-k': [['k', 'Control+k']], tab: [['k', 'Tab']], 'shift-tab': [['k', 'Shift+Tab']], up: [['k', 'ArrowUp']],
  down: [['k', 'ArrowDown']], left: [['k', 'ArrowLeft']], right: [['k', 'ArrowRight']], home: [['k', 'Home']], end: [['k', 'End']],
  'meta-left': [['k', 'Meta+ArrowLeft']], 'meta-up': [['k', 'Meta+ArrowUp']], 'alt-left': [['k', 'Alt+ArrowLeft']],
  enter: [['k', 'Enter']], 'meta-b': [['k', 'Meta+b']], 'meta-e': [['k', 'Meta+e']],
};
for (const [k, st] of Object.entries(STAY)) {
  add(`key-${k}`, D, [...EMPTY, ...st, ['w'], ['t', 'Q'], ['w', 500]], 'aaa\n\nQ\n\nzz\n');
  add(`key-${k}-fast`, D, [['fast', 'Meta+a', 'Backspace', ...st.map((x) => x[1]), 'Q'], ['w', 900]], 'aaa\n\nQ\n\nzz\n');
}
add('key-esc', D, [...EMPTY, ['k', 'Escape'], ['w'], ['t', 'Q'], ['w', 500]], 'aaa\n\nzz\n', { after: ['zz', 'zzY'] });
add('key-esc-fast', D, [['fast', 'Meta+a', 'Backspace', 'Escape', 'Q'], ['w', 900]], 'aaa\n\nzz\n', { after: ['zz', 'zzY'] });
add('key-meta-a', D, [...EMPTY, ['k', 'Meta+a'], ['w'], ['t', 'Q'], ['w', 500]], 'aaa\n\nzz\n', { after: ['zz', 'zzY'] });
add('key-shift-enter', D, [...EMPTY, ['k', 'Shift+Enter'], ['w'], ['t', 'Q'], ['w', 500]], (s) => /^aaa\n\n(\\\n|<br>)?Q\n\nzz\n$/.test(s) || s === 'aaa\n\nQ\n\nzz\n');
add('key-undo', D, [...EMPTY, ['k', 'Meta+z'], ['w', 600], ['t', 'Q'], ['w', 500]], (s) => s.replace('Q', '') === D);
add('key-undo-redo', D, [...EMPTY, ['k', 'Meta+z'], ['w', 600], ['k', 'Meta+Shift+z'], ['w', 600], ['t', 'Q'], ['w', 500]], 'aaa\n\nQ\n\nzz\n');
add('key-undo-redo-fast', D, [['fast', 'Meta+a', 'Backspace'], ['w'], ['fast', 'Meta+z', 'Meta+Shift+z', 'Q'], ['w', 1200]], 'aaa\n\nQ\n\nzz\n');
add('key-type-bs3', D, [...EMPTY, ['t', 'ab'], ['w'], ['k', 'Backspace'], ['w'], ['k', 'Backspace'], ['w'], ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], 'aaaQ\n\nzz\n');
add('key-type-bs3-fast', D, [['fast', 'Meta+a', 'Backspace', 'a', 'b', 'Backspace', 'Backspace', 'Backspace', 'Q'], ['w', 1200]], 'aaaQ\n\nzz\n');
add('key-type-bs2-type', D, [...EMPTY, ['t', 'ab'], ['w'], ['k', 'Backspace'], ['w'], ['k', 'Backspace'], ['w'], ['t', 'Q'], ['w', 500]], 'aaa\n\nQ\n\nzz\n');
add('key-type-left-bs', D, [...EMPTY, ['t', 'ab'], ['w'], ['k', 'ArrowLeft'], ['k', 'ArrowLeft'], ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], 'aaa\n\nQab\n\nzz\n');
add('key-ime', D, [...EMPTY, ['ime', ['n', 'ni'], '你'], ['w', 500]], 'aaa\n\n你\n\nzz\n');
add('key-ime-bs', D, [...EMPTY, ['ime', ['n', 'ni'], '你'], ['w', 500], ['k', 'Backspace'], ['w'], ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], 'aaaQ\n\nzz\n');

// ---- E: other ways to empty X, then Backspace
const EMPTIERS = {
  cut: [['sel'], ['k', 'Meta+x'], ['w']],
  'sel-del': [['sel'], ['k', 'Delete'], ['w']],
  'meta-bs': [['k', 'End'], ['k', 'Meta+Backspace'], ['w']],
  chars: [['k', 'End'], ...Array.from({ length: 7 }, () => ['k', 'Backspace']), ['w']],
  words: [['k', 'End'], ['k', 'Alt+Backspace'], ['k', 'Alt+Backspace'], ['w']],
};
for (const [k, st] of Object.entries(EMPTIERS)) add(`empty-${k}`, D, [...st, ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], 'aaaQ\n\nzz\n');

// ---- N: X kinds × neighbours that the fixer's matrix does not have
add('n-task-between-lists', '- a1\n\n- [ ] t1\n\n- z1\n', [...EMPTY, ['t', 'N'], ['w', 500]], (s) => s === '- a1\n\nN\n\n- z1\n' || s === '- a1\n\n- N\n\n- z1\n', { x: 't1' });
add('n-heading-tight-list-below', 'aaa\n## xx\n- li\n', [...EMPTY, ['t', 'N'], ['w', 500]], (s) => /^aaa\n\n(## )?N\n\n?- li\n$/.test(s), { x: 'xx' });
add('n-heading-tight-list-below-bs', 'aaa\n## xx\n- li\n', [...EMPTY, ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], (s) => s === 'aaaQ\n\n- li\n', { x: 'xx' });
add('n-list-tight-under-list?', 'aaa\n\n- a1\n\n1. xx\n2. yy\n\nzz\n', [...EMPTY, ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], '- a1Q\n\nzz\n'.replace(/^/, 'aaa\n\n'), { x: 'xx' });
add('n-leading-blank-first', '\nxx para\n\nzz\n', [...EMPTY, ['t', 'N'], ['w', 500]], '\nN\n\nzz\n');
add('n-leading-blank-first-bs', '\nxx para\n\nzz\n', [...EMPTY, ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], (s) => s === '\nzz\n' || s === 'zz\n', { after: ['zz', 'zzY'] });
add('n-last-no-final-newline', 'aaa\n\nxx para', [...EMPTY, ['t', 'N'], ['w', 500]], 'aaa\n\nN');
add('n-last-no-final-newline-bs', 'aaa\n\nxx para', [...EMPTY, ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], 'aaaQ');
add('n-tight-heading-last-no-nl', 'aaa\n## xx', [...EMPTY, ['t', 'N'], ['w', 500]], (s) => s === 'aaa\n\nN' || s === 'aaa\n\n## N');
add('n-only-block', 'xx para\n', [...EMPTY, ['t', 'N'], ['w', 500]], 'N\n');
add('n-only-block-no-nl', 'xx para', [...EMPTY, ['t', 'N'], ['w', 500]], 'N');
add('n-after-html', '<div>raw1</div>\n\nxx para\n\nzz\n', [...EMPTY, ['t', 'N'], ['w', 500]], '<div>raw1</div>\n\nN\n\nzz\n');
add('n-before-html', 'aaa\n\nxx para\n\n<div>raw1</div>\n', [...EMPTY, ['t', 'N'], ['w', 500]], 'aaa\n\nN\n\n<div>raw1</div>\n');
add('n-trailing-2blank', 'aaa\n\nxx para\n\n\n\nzz\n', [...EMPTY, ['t', 'N'], ['w', 500]], (s) => s === 'aaa\n\nN\n\n\n\nzz\n' || s === 'aaa\n\nN\n\nzz\n');
add('n-tight-heading-under-list', '- a1\n## xx\n\nzz\n', [...EMPTY, ['t', 'N'], ['w', 500]], (s) => s === '- a1\n\nN\n\nzz\n' || s === '- a1\n\n## N\n\nzz\n', { x: 'xx' });
add('n-tight-heading-under-list-bs', '- a1\n## xx\n\nzz\n', [...EMPTY, ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], (s) => s === '- a1Q\n\nzz\n' || s === '- a1Q\nzz\n' ? s === '- a1Q\n\nzz\n' : false, { x: 'xx' });
add('n-tight-heading-under-quote', '> q1\n## xx\n\nzz\n', [...EMPTY, ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], '> q1Q\n\nzz\n', { x: 'xx' });
add('n-tight-list-under-heading', '# Hd1\n- xx\n\nzz\n', [...EMPTY, ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], (s) => s === '# Hd1Q\n\nzz\n', { x: 'xx' });
add('n-tight-heading-under-heading-type', '# Hd1\n## xx\n\nzz\n', [...EMPTY, ['t', 'N'], ['w', 500]], (s) => s === '# Hd1\n\nN\n\nzz\n' || s === '# Hd1\nN\n\nzz\n' || s === '# Hd1\n## N\n\nzz\n', { x: 'xx' });
add('n-tight-heading-between-headings', '# Hd1\n## xx\n### Hd3\n', [...EMPTY, ['t', 'N'], ['w', 500]], (s) => /^# Hd1\n\n?(## )?N\n\n?### Hd3\n$/.test(s), { x: 'xx' });
add('n-tight-heading-between-headings-bs', '# Hd1\n## xx\n### Hd3\n', [...EMPTY, ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], (s) => /^# Hd1Q\n\n?### Hd3\n$/.test(s), { x: 'xx' });
add('n-under-fence-tight', '```\nc1\n```\n## xx\n\nzz\n', [...EMPTY, ['t', 'N'], ['w', 500]], (s) => s === '```\nc1\n```\n\nN\n\nzz\n' || s === '```\nc1\n```\nN\n\nzz\n' || s === '```\nc1\n```\n## N\n\nzz\n' || s === '```\nc1\n```\n\n## N\n\nzz\n', { x: 'xx' });
add('n-two-empties', 'aaa\n\nxx para\n\nyy para\n\nzz\n', [...EMPTY, ['k', 'Escape'], ['w'], ['click', 'yy para', 1], ['sel'], ['k', 'Backspace'], ['w'], ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], 'aaaQ\n\nzz\n');
// H12 variations: several blocks typed into the emptied element of a tight block; the emptied tight block re-typed
// at machine speed; a tight block emptied twice in a row
const T = 'aaa\n## xx\n\nzz\n';
add('h12v-type-enter-type', T, [...EMPTY, ['t', 'N'], ['w'], ['k', 'Enter'], ['w'], ['t', 'M'], ['w', 500]], (s) => /^aaa\n\n(## )?N\n\nM\n\nzz\n$/.test(s), { x: 'xx' });
add('h12v-type-enter-type-fast', T, [['fast', 'Meta+a', 'Backspace', 'N', 'Enter', 'M'], ['w', 1200]], (s) => /^aaa\n\n(## )?N\n\nM\n\nzz\n$/.test(s), { x: 'xx' });
add('h12v-type-shiftenter', T, [...EMPTY, ['t', 'N'], ['w'], ['k', 'Shift+Enter'], ['w'], ['t', 'M'], ['w', 500]], (s) => /^aaa\n\n(## )?N(  \n|<br>)M\n\nzz\n$/.test(s) || /^aaa\n\n## N\n\nM\n\nzz\n$/.test(s), { x: 'xx' });
add('h12v-retype-empty-again', T, [...EMPTY, ['t', 'N'], ['w'], ['k', 'Backspace'], ['w'], ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], 'aaaQ\n\nzz\n', { x: 'xx' });
add('h12v-retype-empty-again-type', T, [...EMPTY, ['t', 'N'], ['w'], ['k', 'Backspace'], ['w'], ['t', 'M'], ['w', 500]], (s) => /^aaa\n\n(## )?M\n\nzz\n$/.test(s), { x: 'xx' });
add('h12v-list-tight-both', 'aaa\n- l1\n- l2\n# zzz\n', [...EMPTY, ['t', 'N'], ['w', 500]], (s) => /^aaa\n\n(- )?N\n\n?# zzz\n$/.test(s), { x: 'l1' });
add('h12v-list-tight-both-bs', 'aaa\n- l1\n- l2\n# zzz\n', [...EMPTY, ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], 'aaaQ\n\n# zzz\n', { x: 'l1' });
add('h12v-heading-under-para-eod-nonl', 'aaa\n## xx', [...EMPTY, ['k', 'Escape'], ['w']], 'aaa', { x: 'xx' });
add('h12v-heading-under-para-eod', 'aaa\n## xx\n', [...EMPTY, ['k', 'Escape'], ['w']], 'aaa\n', { x: 'xx' });
add('h12v-two-tight-headings', 'aaa\n## xx\n## yy\n\nzz\n', [...EMPTY, ['t', 'N'], ['w', 500]], (s) => /^aaa\n\n(## )?N\n\n?## yy\n\nzz\n$/.test(s), { x: 'xx' });
add('h12v-undo-chain', T, [...EMPTY, ['t', 'N'], ['w'], ['k', 'Enter'], ['w'], ['t', 'M'], ['w'], ['k', 'Meta+z'], ['w', 600], ['k', 'Meta+z'], ['w', 600], ['k', 'Meta+z'], ['w', 600], ['k', 'Meta+z'], ['w', 600]], 'aaa\n## xx\n\nzz\n', { x: 'xx' });
// list / task / quote / table / fence / formula block as the emptied element, then list keys in it
const LX = 'aaa\n\n- l1\n- l2\n\nzz\n';
add('lx-tab-type', LX, [...EMPTY, ['k', 'Tab'], ['w'], ['t', 'N'], ['w', 500]], (s) => /^aaa\n\n(- )?N\n\nzz\n$/.test(s), { x: 'l1' });
add('lx-shifttab-type', LX, [...EMPTY, ['k', 'Shift+Tab'], ['w'], ['t', 'N'], ['w', 500]], (s) => /^aaa\n\n(- )?N\n\nzz\n$/.test(s), { x: 'l1' });
add('lx-enter-type', LX, [...EMPTY, ['k', 'Enter'], ['w'], ['t', 'N'], ['w', 500]], (s) => /^aaa\n\n(- )?N\n\nzz\n$/.test(s), { x: 'l1' });
add('lx-type-enter-type', LX, [...EMPTY, ['t', 'N'], ['w'], ['k', 'Enter'], ['w'], ['t', 'M'], ['w', 500]], (s) => /^aaa\n\n- N\n- M\n\nzz\n$/.test(s), { x: 'l1' });
add('lx-type-enter-tab-type', LX, [...EMPTY, ['t', 'N'], ['w'], ['k', 'Enter'], ['w'], ['k', 'Tab'], ['w'], ['t', 'M'], ['w', 500]], (s) => /^aaa\n\n- N\n {2,4}- M\n\nzz\n$/.test(s), { x: 'l1' });
add('tx-type', 'aaa\n\n- [ ] t1\n- [x] t2\n\nzz\n', [...EMPTY, ['t', 'N'], ['w', 500]], (s) => /^aaa\n\n(- (\[[ x]\] )?)?N\n\nzz\n$/.test(s), { x: 't1' });
add('qx-type-enter-type', 'aaa\n\n> q1\n> q2\n\nzz\n', [...EMPTY, ['t', 'N'], ['w'], ['k', 'Enter'], ['w'], ['t', 'M'], ['w', 500]], (s) => /^aaa\n\n(> N\n>\n> M|N\n\nM)\n\nzz\n$/.test(s), { x: 'q1' });
add('fx-type-enter', 'aaa\n\n```\nc1\nc2\n```\n\nzz\n', [...EMPTY, ['t', 'N'], ['w'], ['k', 'Enter'], ['w'], ['t', 'M'], ['w', 500]], (s) => s === 'aaa\n\n```\nN\nM\n```\n\nzz\n', { x: 'c1' });
add('bx-type', 'aaa\n\n| h1 |\n|----|\n| c1 |\n\nzz\n', [...EMPTY, ['t', 'N'], ['w', 500]], (s) => /^aaa\n\n.*N.*\n(.*\n)*\nzz\n$/.test(s) && !/c1/.test(s), { x: 'c1' });

const UNDO = 18;
let bad = 0;
try {
  await B.boot('mode=split');
  for (const c of cases) {
    if (filter && !c.name.includes(filter)) continue;
    try {
      await load(B, c.doc);
      const orig = c.doc;
      // the click into X (unless the steps start with their own)
      const x = c.x ?? P;
      if (c.doc.includes(x)) { await clickText(page, x, 1, { side: 'right' }); const v = await waitSession(page); if (!v.editing) throw new Error('no session in X ' + J(v)); await sleep(80); }
      await run(c.steps);
      const v = await view(page);
      const fin = v.src;
      const okWant = typeof c.want === 'function' ? c.want(fin) : fin === c.want;
      let ok = okWant;
      let detail = `src=${J(fin)}${okWant ? '' : ' want=' + (typeof c.want === 'function' ? '(pred)' : J(c.want))} editing=${J(v.editing && v.editing.text.slice(0, 30))} active=${v.active} dup=${J(v.dupIds)} toast=${J(v.toast.slice(0, 40))}`;
      if (B.pageErrors.length) { ok = false; detail += ' PAGEERR ' + B.pageErrors.splice(0).join(' ').slice(0, 200); }
      if (c.after) {
        await page.keyboard.press('Escape'); await settle();
        await clickText(page, c.after[0], c.after[0].length - 1, { side: 'right' }); await waitSession(page);
        await page.keyboard.type('Y'); await settle(500);
        const s2 = await B.source();
        const okA = s2.includes(c.after[1]) && s2.replace('Y', '') === fin;
        ok = ok && okA;
        detail += ` after=${okA ? 'ok' : 'BAD ' + J(s2)}`;
        await page.keyboard.press('Escape'); await settle();
      }
      await page.keyboard.press('Escape'); await settle(200);
      const finNow = await B.source();
      const u = await undoTo(B, orig, UNDO, 120);
      const r = u.ok ? await redoTo(B, finNow, UNDO, 120) : { ok: false, n: 0, now: '' };
      ok = ok && u.ok && r.ok;
      detail += ` undo=${u.ok ? u.n : 'FAIL ' + J(u.now)} redo=${r.ok ? r.n : 'FAIL ' + J(r.now)}`;
      if (!check(c.name, ok, detail)) bad++;
    } catch (e) { bad++; check(c.name, false, 'threw ' + String(e.message).split('\n')[0]); }
    try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
  }
  console.log('console', J(B.consoleErrors.filter((x) => !/DevTools|Download|favicon/.test(x)).slice(0, 5)));
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
