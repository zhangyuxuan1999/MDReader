// bench/verify/v5-offp-ticks.mjs — verify-off-preview: task checkboxes with 预览可编辑 OFF, the candidate and 0.1.1
// side by side (each case runs on both pages at the same time), judged by bench/verify/v5-chc-lib.mjs (the task whose
// text was under the pointer at the press must be the line toggled, or nothing with the toast). Documents and
// gestures the earlier scripts did not use: footnotes, <details>, CJK / RTL / emoji / combining marks, lazy
// continuation lines, tasks that differ only by an image or a formula, * + 1) [X] spellings, CRLF without a final
// newline, an unclosed inline tag in a task, a raw checkbox inside a task item; an IME composition open in the editor
// when the box is pressed; Tab + Space; rapid series across two lists (shown at the first frame, undo order).
//   MDR_PORT=5485 MDR_BASE_PORT=5495 MDR_CAND_PERF=1 node bench/verify/v5-offp-ticks.mjs [group|case-prefix ...]
// Groups: rest, edit, ime, keys, series, focus. Global timeout 110 s per group recommended (run groups separately).
// Writes nothing into the tree.
import { openPage, install, load, clickBox, judge, sleep, J } from './v5-chc-lib.mjs';

const only = process.argv.slice(2);
const want = (nm, g) => !only.length || only.some((o) => o === g || nm.startsWith(o));
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, Number(process.env.MDR_TIMEOUT || 110000));
const cp = (n) => String.fromCodePoint(n);

const DOCS = {
  foot: 'Intro q0 word\n\nRef[^1] here.\n\n[^1]: Footnote with tasks:\n\n    - [ ] q1 in footnote\n    - [ ] q2 in footnote\n\n- [ ] q3 after word\n- [ ] q4 after word\n',
  details: '<details>\n<summary>S</summary>\n\n- [ ] q1 in details\n- [ ] q2 in details\n\n</details>\n\n- [ ] q3 after\n- [ ] q4 after\n',
  intl: `- [ ] q1 中文任务 很长的中文\n- [ ] q2 משימה בעברית\n- [ ] q3 ${cp(0x1f600)}${cp(0x200d)}${cp(0x1f469)} emoji\n- [ ] q4 e${cp(0x301)}${cp(0x302)} combining\n- [ ] q5 العربية\n`,
  lazy: '- [ ] q1 first line\nlazy continuation\n- [ ] q2 second\n  indented cont\n\n  second para of q2\n- [ ] q3 third\n',
  imgf: '- [ ] q1 ![a](x.png)\n- [ ] q2 ![a](y.png)\n- [ ] q3 $a$\n- [ ] q4 $b$\n- [ ] q5 $$c$$\n',
  spell: '* [ ] q1 star\n* [X] q2 star upper\n\n+ [ ] q3 plus\n\n1) [ ] q4 paren\n2) [x] q5 paren\n\n-\t[ ] q6 tab before\n- [ ]\tq7 tab after\n',
  crlf: '- [ ] q1 a\r\n- [ ] q2 b\r\n\r\n- [ ] q3 c',
  unclosed: '- [ ] q1 <b>bold open\n- [ ] q2 after unclosed\n- [ ] q3 <i>it\n- [ ] q4 end\n',
  rawin: '- [ ] q1 text <input type="checkbox"> raw inside\n- [ ] q2 next\n',
  nest: '1. [ ] q1 ord\n   - [ ] q2 nested\n     > - [ ] q3 quote in nest\n2. [ ] q4 ord two\n',
  twolists: 'Intro word\n\n- [ ] q1 one\n- [ ] q2 two\n- [ ] q3 three\n- [ ] q4 four\n\nMiddle paragraph.\n\n- [ ] q5 five\n- [ ] q6 six\n- [ ] q7 seven\n- [ ] q8 eight\n\nend\n',
};
const toks = (doc) => Array.from(new Set(doc.match(/\bq[1-9]\d*\b/g)));

const [C, B] = await Promise.all([openPage('cand'), openPage('base')]);
const sides = [['cand', C.page], ['base', B.page]];
const out = [];
const rep = (nm, r) => { out.push({ nm, ...r }); console.log(nm, J(r)); };

async function both(fn) { return Promise.all(sides.map(([k, p]) => fn(p, k).catch((e) => ({ error: String(e.message).slice(0, 160) })))); }
const verdictOf = (r) => (r && r.verdict) || (r && r.error ? 'error' : '?');

try {
  // ---- rest: every task box of every document, at rest
  for (const [dn, doc] of Object.entries(DOCS)) for (const tok of toks(doc)) {
    const nm = `rest-${dn}-${tok}`;
    if (!want(nm, 'rest')) continue;
    const [c, b] = await both(async (p) => { await load(p, doc); await install(p); const k = await clickBox(p, tok); if (k.nobox) return { verdict: 'nobox' }; const j = await judge(p, 500); return { ...j, shown: k.shown }; });
    rep(nm, { cand: verdictOf(c), base: verdictOf(b), ...(verdictOf(c) !== verdictOf(b) || verdictOf(c) !== 'right' ? { c, b } : {}) });
  }
  // ---- edit: an editor edit above, then a click 0 / 20 / 60 ms later (natural worker)
  for (const [dn, doc] of Object.entries(DOCS)) for (const tok of toks(doc).slice(-2)) for (const d of [0, 20, 60]) {
    const nm = `edit-${dn}-${tok}-${d}`;
    if (!want(nm, 'edit')) continue;
    const [c, b] = await both(async (p) => {
      await load(p, doc); await install(p);
      await p.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ changes: { from: 0, insert: '新行 above\n\n' }, userEvent: 'input' }); });
      if (d) await sleep(d);
      const k = await clickBox(p, tok); if (k.nobox) return { verdict: 'nobox' };
      return { ...(await judge(p, 800)), shown: k.shown };
    });
    rep(nm, { cand: verdictOf(c), base: verdictOf(b), ...(verdictOf(c) !== 'right' ? { c } : {}) });
  }
  // ---- ime: a composition open in the editor (on the task's own line / above it) when the box is pressed
  for (const where of ['above', 'own-end', 'own-start']) for (const tok of ['q2', 'q3']) {
    const nm = `ime-${where}-${tok}`;
    if (!want(nm, 'ime')) continue;
    const [c, b] = await both(async (p) => {
      const doc = DOCS.twolists;
      await load(p, doc); await install(p);
      await p.evaluate(([where, tok]) => {
        const v = window.__mdr.app.editor.view; const d = v.state.doc.toString();
        const l = v.state.doc.lineAt(d.indexOf(tok));
        const at = where === 'above' ? 5 : where === 'own-end' ? l.to : l.from;
        v.focus(); v.dispatch({ selection: { anchor: at } });
      }, [where, tok]);
      const cdp = await p.context().newCDPSession(p);
      await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
      await sleep(60);
      await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
      await sleep(40);
      const k = await clickBox(p, tok); if (k.nobox) return { verdict: 'nobox' };
      const j = await judge(p, 900);
      const src = await p.evaluate(() => window.__mdr.app.getText());
      await cdp.detach().catch(() => {});
      return { ...j, shown: k.shown, srcHas: src.includes('中文') ? 'committed' : src.includes('zhong') ? 'zhong' : 'none' };
    });
    rep(nm, { cand: verdictOf(c), base: verdictOf(b), c, b });
  }
  // ---- keys: Tab from the previous box to the box, Space; and Space after a mouse tick
  for (const tok of ['q2', 'q6']) {
    const nm = `keys-tab-space-${tok}`;
    if (!want(nm, 'keys')) continue;
    const [c, b] = await both(async (p) => {
      await load(p, DOCS.twolists); await install(p);
      // focus the previous task's box without a click, then Tab, then Space
      const prev = tok === 'q2' ? 'q1' : 'q5';
      await p.evaluate((prev) => { const b = Array.from(document.querySelectorAll('.mdr-preview input[type=checkbox]')).find((x) => x.closest('li').textContent.includes(prev)); b.focus(); }, prev);
      await p.keyboard.press('Tab');
      const focused = await p.evaluate(() => { const a = document.activeElement; return a && a.tagName === 'INPUT' ? a.closest('li').textContent.trim().slice(0, 12) : a && a.tagName; });
      const before = await p.evaluate(() => window.__mdr.app.getText());
      await p.keyboard.press('Space');
      await sleep(700); await p.evaluate(() => window.__mdr.waitIdle());
      const after = await p.evaluate(() => window.__mdr.app.getText());
      const fl = before.split('\n').map((l, i) => [l, after.split('\n')[i]]).filter(([a, b2]) => a !== b2).map(([, b2]) => b2);
      return { focused, flipped: fl };
    });
    rep(nm, { c, b, same: J(c) === J(b) });
  }
  // ---- focus: a click on the box, then Space on the same (now focused) box: two toggles; a second Space: three
  for (const tok of ['q2', 'q7']) {
    const nm = `focus-click-space-space-${tok}`;
    if (!want(nm, 'focus')) continue;
    const [c, b] = await both(async (p) => {
      await load(p, DOCS.twolists); await install(p);
      await clickBox(p, tok); await sleep(300);
      await p.keyboard.press('Space'); await sleep(300);
      await p.keyboard.press('Space'); await sleep(700);
      await p.evaluate(() => window.__mdr.waitIdle());
      const s = await p.evaluate(() => window.__mdr.app.getText());
      return { line: s.split('\n').find((l) => l.includes(tok)), toasts: (await p.evaluate(() => window.__chc.toasts.length)) };
    });
    rep(nm, { c, b, same: J(c) === J(b) });
  }
  // ---- series: ticks across two lists, `gap` ms apart; every tick shown at its first frame; source; undo order (cand)
  for (const gap of [30, 80, 150, 300]) for (const order of [['q1', 'q5', 'q2', 'q6'], ['q8', 'q4', 'q7', 'q3'], ['q3', 'q3', 'q6', 'q6']]) {
    const nm = `series-${gap}-${order.join('')}`;
    if (!want(nm, 'series')) continue;
    const [c, b] = await both(async (p, k) => {
      await load(p, DOCS.twolists); await install(p);
      const shown = [];
      for (const t of order) { const r = await clickBox(p, t, { scroll: false }); shown.push(r.shown ? r.shown.join('') : 'x'); await sleep(gap); }
      await sleep(900); await p.evaluate(() => window.__mdr.waitIdle()); await sleep(200);
      const s = await p.evaluate(() => window.__mdr.app.getText());
      const ticked = s.split('\n').filter((l) => /\[x\]/.test(l)).map((l) => l.match(/q\d+/)[0]);
      const toasts = await p.evaluate(() => window.__chc.toasts.length);
      const mism = await p.evaluate(() => { const d = window.__mdr.app.getText(); return Array.from(document.querySelectorAll('.mdr-preview input[type=checkbox]')).filter((x) => { const t = (x.closest('li').textContent.match(/q\d+/) || [''])[0]; const m = new RegExp('\\[([ x])\\] ' + t + '\\b').exec(d); return m && (m[1] === 'x') !== x.checked; }).length; });
      let undo = null;
      if (k === 'cand') {
        // ⌘Z outside the editor (the focus is on the last box): CodeMirror's own undo, one step per tick, newest first
        const seq = [];
        for (let i = 0; i < order.length; i++) { await p.keyboard.press('Meta+z'); await sleep(250); const t = await p.evaluate(() => window.__mdr.app.getText()); seq.push(t.split('\n').filter((l) => /\[x\]/.test(l)).map((l) => l.match(/q\d+/)[0]).join(',')); }
        undo = seq;
      }
      return { ticked, toasts, shown, mism, undo };
    });
    // expected: each token flipped once per click
    const cnt = {}; for (const t of order) cnt[t] = (cnt[t] || 0) + 1;
    const want2 = Object.keys(cnt).filter((t) => cnt[t] % 2 === 1).sort().join(',');
    const ok = (r) => r && r.ticked && r.ticked.slice().sort().join(',') === want2 && r.toasts === 0 && r.mism === 0;
    rep(nm, { cand: ok(c) ? 'ok' : 'BAD', base: ok(b) ? 'ok' : 'BAD', want: want2, c, b: { ticked: b.ticked, toasts: b.toasts, shown: b.shown } });
  }
  // ---- giant: 100 tasks with formulas (the re-render takes 250 ms or more); ticks by Tab + Space in a row, and a tick
  // followed at once by another gesture; every tick on its own task, shown at once, no toast; source compared
  const GIANT = 'Intro word\n\n' + Array.from({ length: 100 }, (_, i) => `- [ ] q${i + 1} word $a_{${i}}$ $b^{${i}}$ $c_${i}$ $\\frac{${i}}{2}$`).join('\n') + '\n\nend word\n';
  const giantFollow = {
    'tabspace-30': async (p) => { await p.evaluate(() => { const b = Array.from(document.querySelectorAll('.mdr-preview input[type=checkbox]'))[4]; b.focus(); }); for (let i = 0; i < 4; i++) { await p.keyboard.press('Space'); await sleep(30); await p.keyboard.press('Tab'); await sleep(30); } },
    'tabspace-150': async (p) => { await p.evaluate(() => { const b = Array.from(document.querySelectorAll('.mdr-preview input[type=checkbox]'))[4]; b.focus(); }); for (let i = 0; i < 4; i++) { await p.keyboard.press('Space'); await sleep(150); await p.keyboard.press('Tab'); await sleep(20); } },
    'tick-then-editor-type': async (p) => { await clickBox(p, 'q5'); const q = await p.evaluate(() => { const l = document.querySelector('.cm-line'); const r = l.getBoundingClientRect(); return { x: r.left + 30, y: r.top + r.height / 2 }; }); await p.mouse.click(q.x, q.y); await p.keyboard.type('XY'); await clickBox(p, 'q6'); },
    'tick-then-text-click': async (p) => { await clickBox(p, 'q5'); const q = await p.evaluate(() => { const l = document.querySelector('.mdr-preview p'); const r = l.getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; }); await p.mouse.click(q.x, q.y); await clickBox(p, 'q7'); },
    'tick-then-find': async (p) => { await clickBox(p, 'q5'); await p.keyboard.press('Meta+f'); await sleep(100); await p.keyboard.press('Escape'); await clickBox(p, 'q8'); },
    'tick-then-mode': async (p) => { await clickBox(p, 'q5'); await p.evaluate(() => window.__mdr.mode('preview')); await sleep(60); await clickBox(p, 'q9'); await p.evaluate(() => window.__mdr.mode('split')); },
    'tick-then-undo': async (p) => { await clickBox(p, 'q5'); await sleep(40); await p.keyboard.press('Meta+z'); await sleep(40); await clickBox(p, 'q6'); },
    'tick-rapid-6': async (p) => { for (const t of ['q3', 'q4', 'q5', 'q6', 'q7', 'q8']) { await clickBox(p, t, { scroll: false }); await sleep(40); } },
  };
  for (const [gn, fn] of Object.entries(giantFollow)) {
    const nm = `giant-${gn}`;
    if (!want(nm, 'giant')) continue;
    const [c, b] = await both(async (p) => {
      await load(p, GIANT); await install(p); await sleep(400);
      const before = await p.evaluate(() => window.__mdr.app.getText());
      await fn(p);
      await sleep(1500); await p.evaluate(() => window.__mdr.waitIdle()); await sleep(300);
      const after = await p.evaluate(() => window.__mdr.app.getText());
      const bl = before.split('\n'), al = after.split('\n');
      const changed = al.map((l, i) => (l !== bl[i] ? (l.match(/q\d+|^[^-]*$/) || ['?'])[0] + (/\[x\]/.test(l) ? ':x' : ':_') : null)).filter(Boolean);
      const W = await p.evaluate(() => window.__chc);
      const mism = await p.evaluate(() => { const d = window.__mdr.app.getText(); return Array.from(document.querySelectorAll('.mdr-preview input[type=checkbox]')).filter((x) => { const t = (x.closest('li').textContent.match(/q\d+/) || [''])[0]; const m = new RegExp('\\[([ x])\\] ' + t + '\\b').exec(d); return m && (m[1] === 'x') !== x.checked; }).map((x) => (x.closest('li').textContent.match(/q\d+/) || [''])[0]); });
      return { changed: changed.slice(0, 12), lines: al.length - bl.length, toasts: W.toasts.map((t) => t.text), presses: W.presses.filter((x) => x.box).map((x) => x.tok), mism };
    });
    rep(nm, { same: J(c.changed) === J(b.changed) && J(c.toasts) === J(b.toasts), c, b });
  }
  // ---- chb3: real keys typed in the editor at the end of a task's line (its own / the neighbour above), then a click on
  // that list's box 0 / 20 / 60 / 150 ms later; small list and the 100-formula list
  for (const [ln, doc] of [['small', DOCS.twolists], ['giant', GIANT]]) for (const [wn, typedTok, clickTok] of [['own', 'q3', 'q3'], ['above', 'q2', 'q3'], ['below', 'q4', 'q3']]) for (const d of [0, 20, 60, 150]) {
    const nm = `chb3-${ln}-${wn}-${d}`;
    if (!want(nm, 'chb3')) continue;
    const [c, b] = await both(async (p) => {
      await load(p, doc); await install(p);
      await p.evaluate((tok) => { const v = window.__mdr.app.editor.view; const s = v.state.doc.toString(); const l = v.state.doc.lineAt(s.search(new RegExp('\\b' + tok + '\\b'))); v.focus(); v.dispatch({ selection: { anchor: l.to } }); }, typedTok);
      await p.keyboard.type(' ab', { delay: 15 });
      if (d) await sleep(d);
      const k = await clickBox(p, clickTok, { scroll: false }); if (k.nobox) return { verdict: 'nobox' };
      return { ...(await judge(p, 900)), shown: k.shown };
    });
    rep(nm, { cand: verdictOf(c), base: verdictOf(b), ...(verdictOf(c) !== 'right' || verdictOf(b) !== 'right' ? { c, b } : {}) });
  }
  // ---- hist: ticks and editor typing in quick succession, then ⌘Z / ⇧⌘Z typed IN THE EDITOR (CodeMirror's history
  // in both builds): the sequence of sources must be the same in both
  const HIST = {
    'tick-type-undo': async (p) => { await clickBox(p, 'q5'); await sleep(80); await edClick(p); await p.keyboard.type('ab'); await sleep(100); },
    'type-tick-undo': async (p) => { await edClick(p); await p.keyboard.type('ab'); await sleep(80); await clickBox(p, 'q5'); await sleep(100); await edClick(p, true); },
    'tick-tick-undo': async (p) => { await clickBox(p, 'q5'); await sleep(60); await clickBox(p, 'q6'); await sleep(100); await edClick(p); },
    'tick-same-twice-undo': async (p) => { await clickBox(p, 'q5'); await sleep(60); await clickBox(p, 'q5'); await sleep(100); await edClick(p); },
  };
  async function edClick(p, keep) { if (keep) { await p.evaluate(() => window.__mdr.app.editor.view.focus()); return; } const q = await p.evaluate(() => { const l = document.querySelectorAll('.cm-line')[0]; const r = l.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; }); await p.mouse.click(q.x, q.y); }
  for (const [hn, fn] of Object.entries(HIST)) {
    const nm = `hist-${hn}`;
    if (!want(nm, 'hist')) continue;
    const [c, b] = await both(async (p) => {
      await load(p, DOCS.twolists); await install(p);
      await fn(p);
      await sleep(600);
      const seq = [];
      const sig = async () => { const s = await p.evaluate(() => window.__mdr.app.getText()); return s.split('\n').filter((l) => /\[x\]|ab/.test(l)).join('|') || '-'; };
      seq.push(await sig());
      for (let i = 0; i < 3; i++) { await p.keyboard.press('Meta+z'); await sleep(200); seq.push('z:' + await sig()); }
      for (let i = 0; i < 3; i++) { await p.keyboard.press('Meta+Shift+z'); await sleep(200); seq.push('y:' + await sig()); }
      return seq;
    });
    rep(nm, { same: J(c) === J(b), c, b });
  }
  // ---- dbl: a real double click (mouse.dblclick: clickCount 1 then 2) and a real triple click on a box
  for (const [dn, n] of [['dbl', 2], ['triple', 3]]) for (const tok of ['q2', 'q6']) {
    const nm = `dbl-${dn}-${tok}`;
    if (!want(nm, 'dbl')) continue;
    const [c, b] = await both(async (p) => {
      await load(p, DOCS.twolists); await install(p);
      const q = await p.evaluate((tok) => { const x = Array.from(document.querySelectorAll('.mdr-preview li input')).find((e) => e.closest('li').textContent.includes(tok)); const r = x.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, tok);
      await p.mouse.click(q.x, q.y, { clickCount: n });
      await sleep(900); await p.evaluate(() => window.__mdr.waitIdle());
      const s = await p.evaluate(() => window.__mdr.app.getText());
      return { line: s.split('\n').find((l) => l.includes(tok)), toasts: await p.evaluate(() => window.__chc.toasts.length), presses: await p.evaluate(() => window.__chc.presses.length) };
    });
    rep(nm, { same: J(c) === J(b), c, b });
  }
  // ---- huge: test-data/huge.md (10 MB, 10 000 tasks that all read 待办事项; each gets a token q<n> here), positions
  // 80 % deep; one load, then a series of edits elsewhere and clicks 0 to 400 ms later
  if (want('huge', 'huge')) {
    const { readFileSync } = await import('node:fs');
    let n = 0;
    const HUGE = readFileSync(new URL('../../test-data/huge.md', import.meta.url), 'utf8').replace(/^- \[( |x)\] (待办事项|已完成事项)$/gm, (s, x, t) => `- [${x}] ${t} q${++n}`);
    const seq = [
      ['rest', null, 'q8000', 0],
      ['top-insert-0', `v.dispatch({changes:{from:0,insert:'新行 top\\n\\n'},userEvent:'input'})`, 'q8001', 0],
      ['top-insert-60', `v.dispatch({changes:{from:0,insert:'新行 top\\n\\n'},userEvent:'input'})`, 'q8002', 60],
      ['top-delete-0', `const l=v.state.doc.line(3); v.dispatch({changes:{from:l.from,to:l.to+1},userEvent:'delete'})`, 'q8003', 0],
      ['near-above-enter-20', `const s=v.state.doc.toString(); const i=s.indexOf(' q8003\\n'); const l=v.state.doc.lineAt(i); const p=v.state.doc.line(l.number-3); v.dispatch({changes:{from:p.to,insert:'\\nnew line'},userEvent:'input'})`, 'q8004', 20],
      ['own-append-0', `const s=v.state.doc.toString(); const i=s.indexOf(' q8005\\n'); const l=v.state.doc.lineAt(i); v.dispatch({changes:{from:l.to,insert:' more'},userEvent:'input'})`, 'q8005', 0],
      ['paste-above-400', `const s=v.state.doc.toString(); const i=s.indexOf(' q8006\\n'); const l=v.state.doc.lineAt(i); const p=v.state.doc.line(l.number-20); v.dispatch({changes:{from:p.from,insert:Array.from({length:300},(_,k)=>'pasted '+k).join('\\n')+'\\n'},userEvent:'input.paste'})`, 'q8006', 400],
    ];
    const res = await both(async (p) => {
      await p.evaluate(([t]) => window.__mdr.loadText(t, 'huge.md'), [HUGE]);
      await p.evaluate(() => window.__mdr.waitIdle()); await sleep(1500);
      const line = HUGE.split('\n').findIndex((l) => l.endsWith(' q8000')) + 1;
      await p.evaluate((line) => window.__mdr.app.preview.scrollToLine(line, 0, 'instant'), line);
      await sleep(1500); await p.evaluate(() => window.__mdr.waitIdle()); await sleep(800);
      const r = [];
      for (const [nm, body, tok, d] of seq) {
        await install(p);
        if (body) await p.evaluate((body) => { const v = window.__mdr.app.editor.view; new Function('v', body)(v); }, body);
        if (d) await sleep(d);
        const k = await clickBox(p, tok);
        if (k.nobox) { r.push([nm, 'nobox']); continue; }
        const j = await judge(p, 1500);
        r.push([nm, j.verdict, j.tok, j.toast]);
      }
      return r;
    });
    rep('huge', { same: J(res[0]) === J(res[1]), c: res[0], b: res[1] });
  }
} finally {
  clearTimeout(killer);
  const bad = out.filter((r) => (r.cand && !/^(right|ok|nothing\+toast)$/.test(r.cand)) || r.same === false);
  console.log('summary', J({ cases: out.length, bad: bad.map((r) => `${r.nm}:${r.cand}/${r.base}`) }));
  await Promise.all([C.browser.close(), B.browser.close()]);
}
