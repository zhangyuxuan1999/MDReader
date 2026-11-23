// bench/verify/v5-chc-ticks.mjs — challenge-c: attacks on "the tick that does not wait" (U16 as amended a second time,
// fix-session-f A1) and U24 (fix-session-e B1/B4), switch OFF unless MDR_ON=1. Every click is judged by the model in
// v5-chc-lib.mjs (the task whose text was under the pointer at the press is the one toggled, or nothing with the toast).
// Run: MDR_PORT=5487 node bench/verify/v5-chc-ticks.mjs cand [group|case-prefix ...]
//      MDR_BASE_PORT=5497 node bench/verify/v5-chc-ticks.mjs base [group|case-prefix ...]
// Env: MDR_SLOW=<ms> (slow-worker hook of v3-ses-preview.mjs for every case), MDR_DELAYS=0,40,120 (click delays).
// Groups: edits, keys, docs, states, ring. Global timeout 30 min. Writes nothing into the tree.
import { openPage, install, load, clickBox, judge, pageEdit, slowWorker, src, sleep, J, PAGE_EDITS } from './v5-chc-lib.mjs';

const target = process.argv[2] || 'cand';
const only = process.argv.slice(3);
const want = (nm, group) => !only.length || only.some((o) => o === group || nm.startsWith(o));
const DELAYS = (process.env.MDR_DELAYS || '0,40,120,300').split(',').map(Number);
const SLOW = Number(process.env.MDR_SLOW || 0);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 30 * 60 * 1000);

const MIXED = [
  'Intro word', '',
  '- [ ] q1 alpha word', '  - [ ] q2 nested word', '  - [ ] q3 nested word', '- [ ] q4 beta word $x^2$',
  '- [ ] q5 gamma word ![i](x.png)', '- [ ] q6 delta <b>word</b>', '- [ ] q7 eps word', '- [ ] q8 zeta word', '',
  '- [ ] q9 after blank word', '- [ ] q10 word', '',
  '1. [ ] q11 ordered word', '2. [ ] q12 ordered word', '',
  '> - [ ] q13 quoted word', '> - [ ] q14 quoted word', '',
  'end word', '',
].join('\n');

const results = [];
function report(name, obj) { results.push({ name, ...obj }); console.log(name, J(obj)); }

const { browser, page, errs } = await openPage(target);
async function fresh(doc) {
  await page.evaluate(() => { window.__delay = false; });
  await page.keyboard.press('Escape').catch(() => {});
  await load(page, doc);
  await install(page);
  if (SLOW) await slowWorker(page, SLOW);
}
async function one(name, doc, edit, tok, delay, extra = {}) {
  try {
    await fresh(doc);
    await edit();
    if (delay) await sleep(delay);
    const c = await clickBox(page, tok);
    if (c.nobox) { report(name, { verdict: 'nobox' }); return; }
    const j = await judge(page, SLOW ? SLOW * 2 + 1200 : 1200);
    // a tick applied must show at the first frame (no wait)
    if (j.verdict === 'right' && c.shown && j.was !== undefined && c.shown[0] === j.was && c.shown[1] === j.was) j.verdict = 'WAIT';
    report(name, { ...j, shown: c.shown, ...extra });
  } catch (e) { report(name, { error: String(e.message).slice(0, 200) }); }
}

try {
  // ---- edits: one dispatched editor edit, then a click on a box
  const TARGETS = { default: ['q5', 'q4'], 'outdent-nested': ['q2', 'q3'], 'multi-line-col0': ['q3', 'q5'], 'join-own-into-prev': ['q4', 'q5'], 'blank-remove-between': ['q9', 'q8'], 'swap-block-up': ['q2', 'q4'], 'move-drop-lines': ['q2', 'q9'], 'delete-list-above-blank': ['q5', 'q6'], 'sort-lines': ['q5', 'q3'] };
  for (const e of Object.keys(PAGE_EDITS)) for (const tok of (TARGETS[e] || TARGETS.default)) for (const d of DELAYS) {
    const nm = `edit-${e}-${tok}-${d}`;
    if (!want(nm, 'edits')) continue;
    await one(nm, MIXED, () => pageEdit(page, e), tok, d);
  }
  // ---- keys: Enter / Backspace at every column of q5's line (real keys in the editor), then a click on q5 / q4 / q6
  const line5 = MIXED.split('\n').find((l) => l.includes('q5'));
  for (const k of ['Enter', 'Backspace', 'Delete']) for (let col = 0; col <= line5.length; col += (col < 9 ? 1 : 4)) for (const tok of ['q5', 'q4', 'q6']) {
    const nm = `keys-${k}-c${col}-${tok}`;
    if (!want(nm, 'keys')) continue;
    await one(nm, MIXED, async () => {
      await page.evaluate((col) => { const v = window.__mdr.app.editor.view; const d = v.state.doc.toString(); const l = v.state.doc.lineAt(d.indexOf('q5')); v.dispatch({ selection: { anchor: l.from + col } }); v.focus(); }, col);
      await page.keyboard.press(k);
    }, tok, 0);
  }
  // ---- typed: the prototype's real-key edits that showed WRONG / nothing-silent in v5-ptk-ticks, judged by the press
  const caretAt = (tok, where) => page.evaluate(([tok, where]) => { const v = window.__mdr.app.editor.view; const d = v.state.doc.toString(); const l = v.state.doc.lineAt(d.search(new RegExp('\\b' + tok + '\\b'))); v.dispatch({ selection: { anchor: where === 'end' ? l.to : l.from }, scrollIntoView: true }); v.focus(); }, [tok, where]);
  const TYPED = {
    'enter-mid-text': async () => { await caretAt('q3', 'end'); await page.keyboard.press('Enter'); await page.keyboard.type('q77 new'); },
    'above-2lines': async () => { await caretAt('Intro', 'end'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.type('p'); },
    'enter-own-end-type': async () => { await caretAt('q5', 'end'); await page.keyboard.press('Enter'); await page.keyboard.type('q78 x'); },
    'enter-twice-own': async () => { await caretAt('q4', 'end'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); },
    'bs-join-next': async () => { await caretAt('q6', 'start'); await page.keyboard.press('Backspace'); },
    'type-fast-many': async () => { await caretAt('q4', 'end'); await page.keyboard.type(' abc def ghi'); },
  };
  for (const [tn, fn] of Object.entries(TYPED)) for (const tok of ['q5', 'q4', 'q6']) for (const d of [0, 20, 60]) for (let r = 0; r < Number(process.env.MDR_RUNS || 1); r++) {
    const nm = `typed-${tn}-${tok}-${d}${r ? '-r' + r : ''}`;
    if (!want(nm, 'typed')) continue;
    await one(nm, MIXED, fn, tok, d);
  }
  // ---- col0: a new task typed at column 0 of the clicked task's line, then Enter (the old task's text moves to the next
  // line), then a click on the old task's box while its HTML is stale (giant formula list: the giant guard keeps it)
  const GIANT = 'Intro word\n\n' + Array.from({ length: 100 }, (_, i) => `- [ ] q${i + 1} word $a_{${i}}$ $b^{${i}}$ $c_${i}$ $\\frac{${i}}{2}$`).join('\n') + '\n\nend word\n';
  const COL0 = {
    'type-task-enter': async (tok) => { await caretAt(tok, 'start'); await page.keyboard.type('- [ ] q901 new'); await page.keyboard.press('Enter'); },
    'paste-task-enter': async (tok) => { await caretAt(tok, 'start'); await page.evaluate(() => { const v = window.__mdr.app.editor.view; const p = v.state.selection.main.head; v.dispatch({ changes: { from: p, insert: '- [ ] q902 pasted' }, selection: { anchor: p + 17 }, userEvent: 'input.paste' }); }); await page.keyboard.press('Enter'); },
    'type-ordered-enter': async (tok) => { await caretAt(tok, 'start'); await page.keyboard.type('1. [ ] q903 n'); await page.keyboard.press('Enter'); },
    'enter-after-box': async (tok) => { await page.evaluate((tok) => { const v = window.__mdr.app.editor.view; const d = v.state.doc.toString(); const l = v.state.doc.lineAt(d.search(new RegExp('\\b' + tok + '\\b'))); v.dispatch({ selection: { anchor: l.from + l.text.indexOf(']') + 2 } }); v.focus(); }, tok); await page.keyboard.press('Enter'); },
    'type-word-enter': async (tok) => { await caretAt(tok, 'start'); await page.keyboard.type('note'); await page.keyboard.press('Enter'); },
  };
  for (const [docName, doc, tok] of [['mixed', MIXED, 'q5'], ['giant', GIANT, 'q5'], ['quoted', MIXED, 'q13'], ['ordered', MIXED, 'q11'], ['nested', MIXED, 'q3'], ['last', MIXED, 'q10']]) for (const [cn, fn] of Object.entries(COL0)) for (const d of (process.env.MDR_COL0_DELAYS ? process.env.MDR_COL0_DELAYS.split(',').map(Number) : docName === 'giant' ? [0, 150, 400] : [0, 15])) {
    const nm = `col0-${docName}-${cn}-${tok}-${d}`;
    if (!want(nm, 'col0')) continue;
    await one(nm, doc, () => fn(tok), tok, d);
  }
  // ---- docs: other documents
  const DOCS = {
    crlf: MIXED.replace(/\n/g, '\r\n'),
    nofinal: MIXED.replace(/end word\n$/, '- [ ] q20 last word'),
    firstblock: MIXED.replace(/^Intro word\n\n/, ''),
    dupes: MIXED + '\n- [ ] q31 same\n- [ ] q32 same\n\n- [ ] q33 same\n- [ ] q34 same\n',
    tasks2000: 'Intro word\n\n' + Array.from({ length: 2000 }, (_, i) => `- [ ] q${100 + i} word $a_${i}$`).join('\n') + '\n\nend\n',
  };
  const DOC_EDITS = [
    ['above', async () => pageEdit(page, 'heading-above')],
    ['own-text', async () => page.evaluate(() => { const v = window.__mdr.app.editor.view; const d = v.state.doc.toString(); const i = d.search(/\bq(5|20|105|1500)\b/); const l = v.state.doc.lineAt(i); v.focus(); v.dispatch({ changes: { from: l.to, insert: 'Z' }, userEvent: 'input.type' }); })],
    ['insert-above-own', async () => page.evaluate(() => { const v = window.__mdr.app.editor.view; const d = v.state.doc.toString(); const i = d.search(/\bq(5|20|105|1500)\b/); const l = v.state.doc.lineAt(i); v.focus(); v.dispatch({ changes: { from: l.from, insert: '- [ ] q999 new\n' }, userEvent: 'input' }); })],
  ];
  for (const [dn, doc] of Object.entries(DOCS)) for (const [en, fn] of DOC_EDITS) for (const d of [0, 120]) {
    const tok = dn === 'nofinal' ? 'q20' : dn === 'tasks2000' ? (en === 'own-text' ? 'q105' : 'q105') : 'q5';
    const nm = `docs-${dn}-${en}-${tok}-${d}`;
    if (!want(nm, 'docs')) continue;
    await one(nm, doc, fn, tok, d);
  }
  // ---- states
  const LONG = MIXED + Array.from({ length: 400 }, (_, i) => `Paragraph ${i} with some words to make it long enough.`).join('\n\n') + '\n';
  if (want('states-scroll-away-back', 'states')) for (const d of [0, 300]) {
    await one(`states-scroll-away-back-${d}`, LONG, async () => {
      await slowWorker(page, 600);
      await pageEdit(page, 'heading-above');
      await page.evaluate(() => { const el = document.querySelector('.mdr-preview'); el.scrollTop = el.scrollHeight; });
      await sleep(250);
      await page.evaluate(() => { const el = document.querySelector('.mdr-preview'); el.scrollTop = 0; });
      await sleep(80);
    }, 'q5', d);
  }
  for (const m of ['edit', 'preview']) if (want(`states-mode-${m}`, 'states')) for (const d of [0, 50, 200]) {
    await one(`states-mode-${m}-${d}`, MIXED, async () => {
      await page.evaluate((m) => window.__mdr.mode(m), m);
      await sleep(200);
      await page.evaluate(() => { const v = window.__mdr.app.editor.view; const d = v.state.doc.toString(); const l = v.state.doc.lineAt(d.indexOf('q3')); v.dispatch({ changes: { from: l.from, insert: '- [ ] q90 n\n- [ ] q91 n\n' }, userEvent: 'input' }); });
      await sleep(100);
      await page.evaluate(() => window.__mdr.mode('split'));
    }, 'q5', d);
    await page.evaluate(() => window.__mdr.mode('split'));
  }
  if (want('states-docreplace', 'states')) for (const d of [0, 5, 20, 60]) {
    const other = MIXED.replace(/q(\d+)/g, (s, n) => 'q' + (Number(n) + 50));
    await one(`states-docreplace-${d}`, MIXED, async () => {
      page.evaluate((t) => window.__mdr.loadText(t, 'other.md'), other).catch(() => {});
    }, 'q5', d);
  }
  // docreplace-pt: the point of q5's box taken BEFORE a document replacement, the click sent right after it starts
  if (want('states-docreplace-pt', 'states')) for (const d of [0, 2, 10, 30]) {
    const other = MIXED.replace(/q(\d+)/g, (s, n) => 'q' + (Number(n) + 50)).replace('Intro word', 'Other intro');
    const nm = `states-docreplace-pt-${d}`;
    try {
      await fresh(MIXED);
      const p = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]'))[4]; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await page.evaluate(([t, d]) => { setTimeout(() => window.__mdr.loadText(t, 'other.md'), d); }, [other, d]);
      await sleep(d + 1);
      await page.mouse.click(p.x, p.y);
      report(nm, await judge(page, 1500));
    } catch (e) { report(nm, { error: String(e.message).slice(0, 200) }); }
  }
  // ring-slow: the slow-worker hook holds the HTML back for 6 s while N edits are made, then a click on the old box
  for (const n of [4095, 4096, 4097]) {
    const nm = `ring-slow-${n}`;
    if (!want(nm, 'ring')) continue;
    await one(nm, MIXED, async () => {
      await slowWorker(page, 6000);
      await page.evaluate((n) => {
        const v = window.__mdr.app.editor.view;
        for (let i = 0; i < n; i++) { const d = v.state.doc.toString(); const l = v.state.doc.lineAt(d.indexOf('q8')); v.dispatch({ changes: { from: l.to, insert: 'y' }, userEvent: 'input.type' }); }
      }, n);
    }, 'q5', 0, { n });
    await sleep(7000);
  }
  // ---- ring: many single-character edits with the preview hidden, then a click within the re-render time
  for (const n of [4094, 4095, 4096, 4097, 5000]) {
    const nm = `ring-${n}`;
    if (!want(nm, 'ring')) continue;
    await one(nm, MIXED, async () => {
      await page.evaluate(() => window.__mdr.mode('edit'));
      await sleep(150);
      await page.evaluate((n) => {
        const v = window.__mdr.app.editor.view;
        for (let i = 0; i < n; i++) { const d = v.state.doc.toString(); const l = v.state.doc.lineAt(d.indexOf('q8')); v.dispatch({ changes: { from: l.to, insert: 'y' }, userEvent: 'input.type' }); }
      }, n);
      await page.evaluate(() => window.__mdr.mode('split'));
      await sleep(30);
    }, 'q5', 0, { n });
    await page.evaluate(() => window.__mdr.mode('split'));
  }
} finally {
  clearTimeout(killer);
  const bad = results.filter((r) => /^(WRONG|SILENT|TOAST-APPLIED|WAIT|OTHER|LINECOUNT)/.test(String(r.verdict || '')));
  const count = {};
  for (const r of results) count[r.verdict || 'error'] = (count[r.verdict || 'error'] || 0) + 1;
  if (errs.length) console.log('pageerrors', J(errs.slice(0, 5)));
  console.log('summary', J({ target, slow: SLOW, cases: results.length, count, bad: bad.map((r) => `${r.name}:${r.verdict}`) }));
  await browser.close();
}
