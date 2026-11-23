// bench/verify/v5-cha-pc.mjs — challenge-a (round 4): variations of J12 / J30 (P-C: the place of an emptied element
// is a line position) and of trackPlace. A block is emptied (its whole text selected + Backspace), then:
//   undoQ   Cmd-Z (the source must be the original byte for byte), then Q: Q must be written INSIDE the restored block
//   typeQ   Q typed into the emptied element: Q must stand between the neighbour texts `above` and `below`
//   pasteQ  'Q1' pasted into the emptied element: same rule
//   editQ   a programmatic change above (`edit`: CodeMirror changes) while the element is empty, then Q: `wantEdit`
// Each case ends with Cmd-Z back to the original (byte for byte).
// Run: MDR_PORT=5485 node bench/verify/v5-cha-pc.mjs [case-prefix ...]   (MDR_DELAY=ms slow worker during the case)
// Writes nothing into the tree.
import { openB, sleep, globalTimeout, J, check, summary, view, clickText, waitSession, load } from './v4-sesa-lib.mjs';

const only = process.argv.slice(2);
const B = await openB({ clipboard: true });
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
const DELAY = Number(process.env.MDR_DELAY ?? 0);
async function slowWorker(ms) {
  await page.evaluate((ms) => {
    const pv = window.__mdr.app.preview;
    if (!window.__origDelta) { window.__origDelta = pv.applyStructureDelta.bind(pv); window.__origHtml = pv.applyHtml.bind(pv); }
    window.__delayMs = ms;
    pv.applyStructureDelta = (m) => { if (window.__delay) { setTimeout(() => window.__origDelta(m), window.__delayMs); return true; } return window.__origDelta(m); };
    pv.applyHtml = (m) => { if (window.__delay) setTimeout(() => window.__origHtml(m), window.__delayMs); else window.__origHtml(m); };
    window.__delay = ms > 0;
  }, ms);
}
// [name, doc, needle of the block to empty, text of the neighbour above (null: none), below (null: none)]
const K = [
  ['para-mid', 'aaa above\n\n乙段落 words\n\nzzz below\n', '乙', 'aaa', 'zzz'],
  ['para-first', '乙段落 words\n\nzzz below\n\nend\n', '乙', null, 'zzz'],
  ['para-last', 'aaa above\n\n乙段落 words\n', '乙', 'aaa', null],
  ['heading-tight', 'aaa above\n## 乙题 words\n\nzzz below\n', '乙', 'aaa', 'zzz'],
  ['heading-mid', 'aaa above\n\n## 乙题 words\n\nzzz below\n', '乙', 'aaa', 'zzz'],
  ['quote-mid', 'aaa above\n\n> 乙引 words\n\nzzz below\n', '乙', 'aaa', 'zzz'],
  ['list-mid', 'aaa above\n\n- 乙项 words\n\nzzz below\n', '乙', 'aaa', 'zzz'],
  ['fence-mid', 'aaa above\n\n```\n乙码 words\n```\n\nzzz below\n', '乙', 'aaa', 'zzz'],
  ['lists-around', '- aaa\n\n乙段落\n\n- zzz\n', '乙', 'aaa', 'zzz'],
  ['lists-around-tight', '- aaa\n- bbb\n\n乙段落\n\n- zzz\n- yyy\n', '乙', 'bbb', 'zzz'],
  ['ordered-around-heading', '1. aaa\n\n## 乙题\n\n2. zzz\n', '乙', 'aaa', 'zzz'],
  ['quotes-around', '> aaa\n\n乙段落\n\n> zzz\n', '乙', 'aaa', 'zzz'],
  ['code-around', '    aaa code\n\n乙段落\n\n    zzz code\n', '乙', 'aaa', 'zzz'],
  ['para-lazy-quote', '> aaa\n\n乙段落\n\nzzz below\n', '乙', 'aaa', 'zzz'],
  ['after-html', '<div>aaa</div>\n\n乙段落\n\nzzz below\n', '乙', 'aaa', 'zzz'],
  ['before-math', 'aaa above\n\n乙段落\n\n$$\nzzz\n$$\n', '乙', 'aaa', null],
  ['identical-neighbours', 'same\n\n乙段落\n\nsame\n', '乙', null, null],
];
const E = [
  // a change above that leaves the three lines right above the place as they were (a loose list of identical items)
  ['edit-periodic', '- a\n\n- a\n\n- a\n\n乙段落\n\nzzz\n', '乙', [{ from: 0, insert: '- a\n\n' }], '- a\n\n- a\n\n- a\n\n- a\n\nQ\n\nzzz\n'],
  // the same change in a plain run of identical paragraph lines
  ['edit-periodic-para', 'x\n\nx\n\nx\n\n乙段落\n\nzzz\n', '乙', [{ from: 0, insert: 'x\n\n' }], 'x\n\nx\n\nx\n\nx\n\nQ\n\nzzz\n'],
  // a change far above that does not touch the three lines above the place
  ['edit-far-above', 'top\n\nm1\n\nm2\n\nm3\n\n乙段落\n\nzzz\n', '乙', [{ from: 0, insert: 'new\n\n' }], 'new\n\ntop\n\nm1\n\nm2\n\nm3\n\nQ\n\nzzz\n'],
  // a change below the place
  ['edit-below', 'aaa\n\n乙段落\n\nzzz\n', '乙', 'end-insert', 'aaa\n\nQ\n\nzzz\nmore\n'],
];
let bad = 0;
const want = (n) => !only.length || only.some((o) => n.startsWith(o));
async function empty(doc, needle) {
  await slowWorker(0);
  await load(B, doc);
  await clickText(page, needle, 0, { side: 'right' });
  const v0 = await waitSession(page);
  if (!v0.editing) throw new Error('no session');
  await sleep(80);
  await slowWorker(DELAY);
  await page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.keyboard.press('Backspace');
  await settle(400 + DELAY);
}
async function backTo(doc) {
  await slowWorker(0);
  await page.keyboard.press('Escape'); await settle(200);
  for (let i = 0; i < 6 && (await B.source()) !== doc; i++) { await page.keyboard.press('Meta+z'); await settle(300); }
  return (await B.source()) === doc;
}
try {
  await B.boot('mode=split');
  for (const [name, doc, needle, above, below] of K) {
    for (const act of ['undoQ', 'typeQ', 'pasteQ']) {
      const nm = `${name}-${act}${DELAY ? '-d' + DELAY : ''}`;
      if (!want(nm)) continue;
      try {
        await empty(doc, needle);
        const deleted = await B.source();
        if (act === 'typeQ' && below !== null && above !== null) {
          await sleep(400);
          const order = await page.evaluate(({ above, below }) => { const root = document.querySelector('.mdr-preview'); const ed = root.querySelector('.is-editing'); const all = Array.from(root.querySelectorAll('section.md-block')).filter((s) => s.getBoundingClientRect().height > 0 || s === ed); const iE = all.indexOf(ed); const iA = all.findIndex((s) => s !== ed && s.textContent.includes(above)); const iB = all.findIndex((s) => s !== ed && s.textContent.includes(below)); return { iE, iA, iB, ok: iE >= 0 && iA >= 0 && iB >= 0 && ((iA < iE && iE < iB) || (iA === iB && iE !== iA)) , betweenStrict: iA < iE && iE < iB }; }, { above, below });
          if (!check(`${name}-emptyShown`, order.betweenStrict, J(order))) bad++;
        }
        let ok, detail;
        if (act === 'undoQ') {
          await page.keyboard.press('Meta+z');
          await settle(700 + DELAY);
          const u = await B.source();
          await page.keyboard.type('Q');
          await settle(600 + DELAY);
          const v = await view(page);
          const blockLine = doc.split('\n').find((l) => l.includes(needle));
          const qLine = v.src.split('\n').find((l) => l.includes('Q')) ?? '';
          ok = u === doc && qLine.replace('Q', '') === blockLine && v.src.replace('Q', '') === doc;
          detail = `afterUndo=${J(u)} src=${J(v.src)} editing=${J(v.editing && v.editing.text.slice(0, 30))}`;
        } else {
          if (act === 'typeQ') await page.keyboard.type('Q');
          else {
            await page.evaluate(() => navigator.clipboard.writeText('Q1'));
            await page.keyboard.press('Meta+v');
          }
          await settle(700 + DELAY);
          const v = await view(page);
          const s = v.src;
          const iA = above === null ? -1 : s.indexOf(above), iQ = s.indexOf('Q'), iZ = below === null ? s.length : s.indexOf(below);
          ok = iQ >= 0 && iA < iQ && iQ < iZ && (above === null || iA >= 0);
          // the rest of the document is unchanged (the deleted text gone, Q in its place)
          const rest = s.replace(act === 'typeQ' ? 'Q' : 'Q1', '');
          detail = `deleted=${J(deleted)} src=${J(s)} rest=${J(rest)}`;
          if (needle === '乙' && name === 'identical-neighbours') ok = s === 'same\n\nQ' + (act === 'typeQ' ? '' : '1') + '\n\nsame\n';
        }
        const back = await backTo(doc);
        if (!back) detail += ` undoBack=FAIL ${J(await B.source())}`;
        if (!check(nm, ok && back, detail)) bad++;
      } catch (e) { bad++; check(nm, false, 'threw ' + String(e.message).split('\n')[0]); }
      try { await slowWorker(0); await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
    }
  }
  for (const [name, doc, needle, edit, exp] of E) {
    const nm = `${name}${DELAY ? '-d' + DELAY : ''}`;
    if (!want(nm)) continue;
    try {
      await empty(doc, needle);
      await page.evaluate((edit) => {
        const v = window.__mdr.app.editor.view;
        if (edit === 'end-insert') v.dispatch({ changes: { from: v.state.doc.length, insert: 'more\n' } });
        else v.dispatch({ changes: edit });
      }, edit);
      await settle(500 + DELAY);
      await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); if (el) el.focus(); });
      await page.keyboard.type('Q');
      await settle(700 + DELAY);
      const v = await view(page);
      if (!check(nm, v.src === exp, `observed=${J(v.src)} expected=${J(exp)}`)) bad++;
    } catch (e) { bad++; check(nm, false, 'threw ' + String(e.message).split('\n')[0]); }
    try { await slowWorker(0); await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
  }
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
