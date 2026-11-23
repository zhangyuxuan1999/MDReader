// bench/verify/fix3-s3-leading.mjs — fix-session-3: decision U14 (a block's leading blank lines) in a real browser.
// Documents that start with 1, 2 or 5 blank lines or with whitespace-only lines, then "abcdef", a blank line and
// "ghi". Each edit runs in a session on the first content block (type a character; Enter in its middle and type;
// empty it, then type; Backspace-merge the second paragraph into it) and the WHOLE source is compared with the
// expectation (the leading lines byte for byte); then ⌘Z is pressed inside the session until the source is the
// original again (byte for byte, at most 12 presses). Mirror image: 0, 1 and 3 trailing blank lines (and no final
// newline) stay as they are after an edit of the last block. Also: blocks after an HTML comment / front matter.
// Prints one line per case (expected and actual source). Exit code 1 on a mismatch.
// Needs a renderer on MDR_PORT (started by v2-ses-lib.mjs if nothing answers). Leaves that Vite running.
// Run: MDR_PORT=5380 node bench/verify/fix3-s3-leading.mjs [name-filter]
import { openB, sleep, globalTimeout, J, check, results } from './v2-ses-lib.mjs';

const filter = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
const B = await openB();
const stop = globalTimeout(280_000, B.close);
const { page } = B;

const LEADS = { b1: '\n', b2: '\n\n', b5: '\n\n\n\n\n', w2sp: '  \n', wtab: '\t\n', w2lines: '  \n\t\n' };
const BODY = 'abcdef\n\nghi\n';

async function act(a) {
  const [k, ...rest] = a.split(':');
  const v = rest.join(':');
  if (k === 'type') await page.keyboard.type(v);
  else if (k === 'press') await page.keyboard.press(v);
  else if (k === 'wait') await sleep(Number(v));
  else throw new Error('bad action ' + a);
}

async function settle() { await sleep(350); await B.settle(200); }

/** ⌘Z inside the session until the source is `orig`. */
async function undoTo(orig) {
  let now = await B.source();
  let n = 0;
  for (; n < 12 && now !== orig; n++) { await page.keyboard.press('Meta+z'); await sleep(150); await B.settle(150); now = await B.source(); }
  return { ok: now === orig, n, now };
}

const C = [];
for (const [ln, lead] of Object.entries(LEADS)) {
  const doc = lead + BODY;
  const L = lead.split('\n').length;            // the line of "abcdef"
  C.push({ name: `${ln}-type`, doc, line: L, needle: 'abc', where: 'after', steps: [['type:X']], expect: [lead + 'abcXdef\n\nghi\n'] });
  C.push({ name: `${ln}-enter`, doc, line: L, needle: 'abc', where: 'after', steps: [['press:Enter', 'type:Q']], expect: [lead + 'abc\n\nQdef\n\nghi\n'] });
  C.push({ name: `${ln}-empty`, doc, line: L, needle: 'abc', where: 'after', steps: [['press:Meta+a', 'press:Backspace', 'wait:300'], ['type:N']], expect: [lead + 'ghi\n', lead + 'N\n\nghi\n'], shows: [['ghi'], ['N', 'ghi']] });
  C.push({ name: `${ln}-merge`, doc, line: L + 2, needle: 'ghi', where: 'before', steps: [['press:Backspace'], ['type:Z']], expect: [lead + 'abcdefghi\n', lead + 'abcdefZghi\n'] });
}
for (const [tn, tail] of Object.entries({ t0nl: '', t0: '\n', t1: '\n\n', t3: '\n\n\n\n' })) {
  const doc = `abc\n\nlast${tail}`;
  C.push({ name: `trail-${tn}`, doc, line: 3, needle: 'last', where: 'after', steps: [['type:X']], expect: [`abc\n\nlastX${tail}`] });
  C.push({ name: `trail-${tn}-enter`, doc, line: 3, needle: 'la', where: 'after', steps: [['press:Enter', 'type:Q']], expect: [`abc\n\nla\n\nQst${tail}`] });
}
C.push({ name: 'after-comment', doc: '<!-- c -->\n\nabcdef\n', line: 3, needle: 'abc', where: 'after', steps: [['type:X']], expect: ['<!-- c -->\n\nabcXdef\n'] });
C.push({ name: 'after-frontmatter', doc: '---\nt: 1\n---\n\nabcdef\n', line: 5, needle: 'abc', where: 'after', steps: [['type:X']], expect: ['---\nt: 1\n---\n\nabcXdef\n'] });
C.push({ name: 'b1-only-block-empty', doc: '\nabc\n', line: 2, needle: 'abc', where: 'after', steps: [['press:Meta+a', 'press:Backspace', 'wait:300'], ['type:N']], expect: ['', '\nN\n'] });
C.push({ name: 'b1-quote-type', doc: '\n> q abc\n\nnext\n', line: 2, needle: 'abc', where: 'after', steps: [['type:X']], expect: ['\n> q abcX\n\nnext\n'] });

let mismatch = 0;
try {
  await B.boot('mode=split');
  for (const c of C) {
    if (filter && !c.name.includes(filter)) continue;
    try {
      await B.loadDoc(c.doc);
      const orig = await B.source();
      if (orig !== c.doc) throw new Error(`loaded ${J(orig)}`);
      await B.clickLine(c.line, 'first', c.needle);
      await B.caretAt(c.needle, c.where);
      const got = [];
      const seen = [];
      let ok = true;
      for (let i = 0; i < c.steps.length; i++) {
        for (const a of c.steps[i]) await act(a);
        await settle();
        const src = await B.source();
        got.push(src);
        if (src !== c.expect[i]) ok = false;
        if (c.shows) {
          // the preview shows the text (the emptied element stays, the next block is rendered): U9 + U14
          const v = await page.evaluate(() => ({ text: document.querySelector('.mdr-preview').innerText, editing: !!document.querySelector('.mdr-preview .is-editing') }));
          const miss = c.shows[i].filter((t) => !v.text.includes(t));
          if (miss.length > 0 || !v.editing) { ok = false; seen.push({ step: i, miss, editing: v.editing }); }
        }
      }
      const st = await B.state();
      const u = await undoTo(orig);
      const all = ok && u.ok;
      if (!all) mismatch++;
      check(c.name, all, `expected=${J(c.expect)} actual=${J(got)} live=${st.editing !== null} undo=${u.ok ? `ok(${u.n})` : `FAIL now=${J(u.now)}`}${seen.length ? ` shown=${J(seen)}` : ''}`);
      await B.esc();
    } catch (e) { mismatch++; check(c.name, false, 'threw ' + e.message.split('\n')[0]); }
  }
  console.log('errors', J(B.pageErrors), J(B.consoleErrors.slice(0, 5)));
} finally {
  console.log(`${results.pass}/${results.pass + results.fail} passed; fails: ${results.fails.join(' ')}`);
  stop(); await B.close();
  process.exitCode = mismatch > 0 ? 1 : 0;
}
