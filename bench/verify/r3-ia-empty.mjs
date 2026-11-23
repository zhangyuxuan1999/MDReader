// bench/verify/r3-ia-empty.mjs — fix-session-a (round 3): decisions U18 (a)-(c) in real Chromium, the neighbour
// matrix of an emptied block. The emptied block X is a heading, a list, a quote, a fence, a table, a paragraph or a
// formula block; above it: nothing (first block), a blank line, or a paragraph line directly above (tight); below it:
// a blank line, a heading directly below (tight), or the end of the document. A combination the segmenter does not
// make into a block of its own (a quote right under a paragraph line is part of that paragraph's block) is reported
// as "n/a" and skipped. Per combination six action sequences, each on a freshly loaded document:
//   type   — ⌘A, Backspace (empties X), then type N: N is written between the same neighbours, the session goes on
//   enter  — ⌘A, Backspace, Enter, type N
//   esc    — ⌘A, Backspace, Esc
//   click  — ⌘A, Backspace, click on the last block
//   bs     — ⌘A, Backspace, Backspace (U18 a: no source change, caret to the end of the block before), type Q
//   del    — ⌘A, Backspace, forward Delete (nothing), type N
// After each: the neighbours are still separate blocks (never joined), the source after the emptying is the
// expected deletion (X's lines and own blank lines gone, a blank line kept between two non-blank lines, the final
// newline kept) where the emptying deletes X, and ⌘Z brings the original source back byte for byte (≤ 12 presses).
// Run: MDR_PORT=5404 node bench/verify/r3-ia-empty.mjs [name-filter]   (exit code 1 on a failure; T_MS = global timeout)
import { openB, sleep, globalTimeout, J, check, summary, view, shownText, clickText, undoTo } from './v3-ses-lib.mjs';

const filter = process.argv[2] || '';
const B = await openB({ clipboard: false });
const stop = globalTimeout(Number(process.env.T_MS ?? 900_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
const press = (k) => page.keyboard.press(k);
const type = (t) => page.keyboard.type(t);
async function waitSession(ms = 1500) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await view(page); if (v.editing && !v.capFocused) return v; await sleep(30); }
  return view(page);
}

// X: [source, click needle, typed-block spelling check (shown text of the new block contains N)]
const KINDS = {
  heading: ['## Head x', 'Head'],
  list: ['- li one\n- li two', 'li one'],
  quote: ['> quote x', 'quote'],
  fence: ['```\ncode x\n```', 'code'],
  table: ['| h1 |\n|----|\n| c1 |', 'c1'],
  para: ['para x', 'para'],
  math: ['$$\nx^2\n$$', null],
};
const ABOVE = { none: '', blank: 'aaa\n\n', tight: 'aaa\n' };
const BELOW = { blank: '\n\nzzz\n', tight: '\n# zzz\n', eod: '\n' };

/** The deletion U18 (b) expects for X emptied between these neighbours. */
function expectedDeletion(above, below) {
  const rest = below === 'blank' ? 'zzz\n' : below === 'tight' ? '# zzz\n' : '';
  if (above === 'none') return rest;
  return rest === '' ? 'aaa\n' : 'aaa\n\n' + rest;
}

/** X is a block of its own in this document (else the combination does not exist as two blocks). */
async function ownBlock(doc, xSrc, above) {
  const first = above === 'none' ? 1 : above === 'blank' ? 3 : 2;
  const n = xSrc.split('\n').length;
  return page.evaluate(({ first, n }) => {
    const pv = window.__mdr.app.preview;
    const b = pv.blockAtLine(first);
    const lines = window.__mdr.app.getText().split('\n');
    // its range: its own lines plus blank lines only
    if (!b || b.startLine !== first || b.lineCount < n) return false;
    for (let i = first - 1 + n; i < first - 1 + b.lineCount; i++) if (lines[i].trim() !== '') return false;
    return true;
  }, { first, n });
}

async function emptyX(kind, needle) {
  if (kind === 'math') {
    // a click on the formula shows its source; select it all and delete
    const p = await page.evaluate(() => { const m = document.querySelector('.mdr-preview .md-math--block'); if (!m) return null; const r = m.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    if (!p) throw new Error('no formula');
    await page.mouse.click(p.x, p.y);
  } else await clickText(page, needle, 1, { side: 'right' });
  const v = await waitSession();
  if (!v.editing) throw new Error('no session ' + J(v));
  await press('Meta+a'); await press('Backspace'); await settle();
}

const shownOk = (sh, above, below, mid = null) => {
  const want = [];
  if (above !== 'none') want.push('aaa');
  if (mid !== null) want.push(mid);
  if (below !== 'eod') want.push('zzz');
  return J(sh) === J(want);
};

const cases = [];
for (const [kind, [xSrc, needle]] of Object.entries(KINDS)) {
  for (const above of Object.keys(ABOVE)) {
    for (const below of Object.keys(BELOW)) {
      const doc = ABOVE[above] + xSrc + BELOW[below];
      for (const act of ['type', 'enter', 'esc', 'click', 'bs', 'del']) {
        cases.push({ name: `${kind}-${above}-${below}-${act}`, kind, above, below, doc, xSrc, needle, act });
      }
    }
  }
}

let bad = 0, na = 0;
try {
  await B.boot('mode=split');
  for (const c of cases) {
    if (filter && !c.name.includes(filter)) continue;
    try {
      await B.loadDoc(c.doc);
      const orig = await B.source();
      if (orig !== c.doc) throw new Error('loaded ' + J(orig));
      if (!(await ownBlock(c.doc, c.xSrc, c.above))) { na++; console.log(`n/a   ${c.name}  — X is not a block of its own here`); continue; }
      await sleep(650);
      await emptyX(c.kind, c.needle);
      const s1 = await B.source();
      const sh1 = await shownText(page);
      const expDel = expectedDeletion(c.above, c.below);
      // a heading, a list, a quote, a paragraph emptied is deleted (U9); an emptied fence / table / formula block
      // stays as an empty block of its kind (the serializer writes it), which is not a deletion
      const deleted = s1 === expDel;
      const delOk = deleted || !['heading', 'list', 'quote', 'para'].includes(c.kind);
      // the neighbours as separate blocks (an emptied fence / table still shows as an empty block: no text)
      const sepOk = shownOk(sh1, c.above, c.below);
      let ok = delOk && sepOk;
      let detail = `empty=${J(s1)}${deleted ? '' : ' (not a deletion)'} shown=${J(sh1)}`;
      let v;
      if (c.act === 'type' || c.act === 'enter' || c.act === 'del') {
        if (c.act === 'enter') { await press('Enter'); await settle(); }
        if (c.act === 'del') { await press('Delete'); await settle(); const sd = await B.source(); if (deleted && sd !== s1) { ok = false; detail += ` DEL-CHANGED=${J(sd)}`; } }
        await type('N'); await settle(500);
        v = await view(page);
        const sh = await shownText(page);
        const mid = sh.find((x) => x.includes('N'));
        ok = ok && !!mid && shownOk(sh, c.above, c.below, mid) && !!v.editing && v.editing.text.includes('N') && !v.capFocused;
        detail += ` typed=${J(v.src)} shown2=${J(sh)} editing=${J(v.editing && v.editing.text.slice(0, 30))}`;
      } else if (c.act === 'esc') {
        await press('Escape'); await settle();
        v = await view(page);
        ok = ok && v.src === s1 && !v.editing && shownOk(await shownText(page), c.above, c.below);
        detail += ` afterEsc=${J(v.src)}`;
      } else if (c.act === 'click') {
        const last = c.below === 'eod' ? (c.above === 'none' ? null : 'aaa') : 'zzz';
        if (last) { await clickText(page, last, 1); await settle(); }
        v = await view(page);
        ok = ok && v.src === s1 && shownOk(await shownText(page), c.above, c.below);
        detail += ` afterClick=${J(v.src)} editing=${J(v.editing && v.editing.text)}`;
      } else if (c.act === 'bs') {
        await press('Backspace'); await settle(600);
        const v0 = await view(page);
        const srcOk = !deleted || v0.src === s1;
        await type('Q'); await settle(500);
        v = await view(page);
        // U18 (a): the caret went to the end of the block before (an editable one), so Q ends that block's text;
        // without a block before, the session just ended and Q went nowhere
        const wantQ = !deleted ? null : c.above === 'none' ? s1 : s1.replace(/^aaa/, 'aaaQ');
        const qOk = wantQ === null || v.src === wantQ;
        const sh = (await shownText(page)).map((x) => x.replace(/^aaaQ$/, 'aaa'));
        // (an emptied fence / formula block is still a block: Q went into it)
        const shOk = shownOk(sh, c.above, c.below) || (!deleted && shownOk(sh, c.above, c.below, sh.find((x) => x.includes('Q')) ?? null));
        ok = ok && srcOk && qOk && shOk;
        detail += ` afterBs=${J(v0.src)} editing0=${J(v0.editing && v0.editing.text)} afterQ=${J(v.src)}${wantQ !== null && !qOk ? ' want=' + J(wantQ) : ''}`;
      }
      const u = await undoTo(B, orig, 12);
      ok = ok && u.ok;
      detail += ` undo=${u.ok ? u.n : 'FAIL ' + J(u.now)}`;
      if (!check(c.name, ok, detail)) bad++;
    } catch (e) { bad++; check(c.name, false, 'threw ' + String(e.message).split('\n')[0]); }
    try { await press('Escape'); await B.settle(60); } catch { /* */ }
  }
  console.log(`n/a ${na}`);
  console.log('pageErrors', J(B.pageErrors.slice(0, 3)), 'console', J(B.consoleErrors.filter((x) => !/DevTools|Download/.test(x)).slice(0, 3)));
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
