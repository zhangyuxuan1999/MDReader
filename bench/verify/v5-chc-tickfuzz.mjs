// bench/verify/v5-chc-tickfuzz.mjs — challenge-c: model fuzz of the tick (U16 as amended a second time, switch OFF).
// Random edits in the editor pane (dispatched transactions: inserts with and without line breaks, task lines, deletes,
// joins, duplicates, moves, indents, the editor's own task toggle, undo / redo, big pastes, mode hide / show) interleaved
// with real clicks on random task boxes the preview shows, at random delays (optionally with the slow-worker hook).
// Model, per click: the task whose own text was under the pointer at the press (token qN) is the one whose source line
// flipped, or nothing flipped and the toast 没有勾选… came. Any other outcome is printed as VIOLATION with the op index.
// Run: MDR_PORT=5487 node bench/verify/v5-chc-tickfuzz.mjs <seed> [--ops 60] [--slow ms] [--base] [--upto k]
// Exit 0 no violation, 1 violation, 3 timeout. Writes nothing into the tree.
import { openPage, sleep, J, slowWorker } from './v5-chc-lib.mjs';

const argv = process.argv.slice(2);
const seed = Number(argv[0] || 1);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OPS = Number(opt('--ops', 60));
const SLOW = Number(opt('--slow', 0));
const UPTO = Number(opt('--upto', 1e9));
const target = argv.includes('--base') ? 'base' : 'cand';
const killer = setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 10 * 60 * 1000);
let s = seed >>> 0 || 1;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
const ri = (n) => Math.floor(rnd() * n);
const pick = (a) => a[ri(a.length)];

const lines = ['Intro word', ''];
let tok = 1;
for (let b = 0; b < 4; b++) {
  for (let i = 0; i < 7; i++) lines.push(`${b === 2 ? (i + 1) + '.' : '-'} [ ] q${tok++} word ${pick(['', '$x^2$', '`c`', '**b**', '<i>h</i>'])}`.trimEnd());
  lines.push('', `Para ${b} text`, '');
}
const DOC = lines.join('\n') + '\n';
let nextTok = 100;

const { browser, page, errs } = await openPage(target);
const violations = [];
const log = [];
try {
  await page.evaluate((t) => window.__mdr.loadText(t, 'fz.md'), DOC);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(400);
  await page.evaluate(() => {
    const ownText = (li) => { const c = li.cloneNode(true); c.querySelectorAll('ul,ol').forEach((x) => x.remove()); return (c.textContent || '').replace(/\s+/g, ' ').trim(); };
    const W = window.__fz = { clicks: [], toasts: [] };
    document.addEventListener('pointerdown', (e) => {
      const t = e.target; const rec = { t: performance.now(), doc: window.__mdr.app.getText() };
      if (t instanceof HTMLInputElement && t.type === 'checkbox' && t.closest('.mdr-preview')) { const li = t.closest('li'); rec.tok = ((li ? ownText(li) : '').match(/\bq\d+\b/) || [null])[0]; rec.box = true; rec.was = t.checked; window.__fzBox = t; } else { rec.box = false; rec.tag = t && t.tagName; }
      W.clicks.push(rec);
    }, true);
    // synchronous: a cancelled click has no change event (its text is read at the click); an applied one is read at
    // its change event, which the app's own listener on the preview root has already handled
    window.addEventListener('click', (e) => { const rec = W.clicks[W.clicks.length - 1]; if (!rec || rec.after !== undefined || !rec.box) return; rec.prevented = e.defaultPrevented; if (e.defaultPrevented) { rec.after = window.__mdr.app.getText(); rec.ta = performance.now(); rec.shown = window.__fzBox ? window.__fzBox.checked : null; } else rec.waitChange = true; });
    window.addEventListener('change', (e) => { const rec = W.clicks[W.clicks.length - 1]; if (!rec || !rec.waitChange || rec.after !== undefined) return; rec.after = window.__mdr.app.getText(); rec.ta = performance.now(); rec.shown = e.target.checked; });
    if (window.__mdr.app.bus?.on) window.__mdr.app.bus.on('toast', (e) => W.toasts.push({ t: performance.now(), text: e.text }));
  });
  if (SLOW) await slowWorker(page, SLOW);
  const edit = (body, args) => page.evaluate(([body, args]) => {
    const v = window.__mdr.app.editor.view;
    // eslint-disable-next-line no-new-func
    return new Function('v', 'a', body)(v, args);
  }, [body, args]);
  const E = {
    ins: `const d=v.state.doc; const l=d.line(1+Math.floor(a.r1*d.lines)); const p=l.from+Math.floor(a.r2*(l.length+1)); v.dispatch({changes:{from:p,insert:a.t},userEvent:'input'}); return 'ins@'+l.number+':'+(p-l.from)+' '+JSON.stringify(a.t);`,
    del: `const d=v.state.doc; const p=Math.floor(a.r1*d.length); const q=Math.min(d.length,p+1+Math.floor(a.r2*a.n)); v.dispatch({changes:{from:p,to:q},userEvent:'delete'}); return 'del '+p+'-'+q;`,
    dupline: `const d=v.state.doc; const l=d.line(1+Math.floor(a.r1*d.lines)); v.dispatch({changes:{from:l.to,insert:'\\n'+l.text},userEvent:'input.copyline'}); return 'dup '+l.number;`,
    moveup: `const d=v.state.doc; const n=2+Math.floor(a.r1*(d.lines-1)); if(n>d.lines) return 'noop'; const l=d.line(n), p=d.line(n-1); v.dispatch({changes:{from:p.from,to:l.to,insert:l.text+'\\n'+p.text},userEvent:'move.line'}); return 'moveup '+n;`,
    indent: `const d=v.state.doc; const n=1+Math.floor(a.r1*d.lines); const ch=[]; for(let k=n;k<=Math.min(d.lines,n+2);k++) ch.push({from:d.line(k).from,insert:'  '}); v.dispatch({changes:ch,userEvent:'input.indent'}); return 'indent '+n;`,
    toggle: `const d=v.state.doc; const n=1+Math.floor(a.r1*d.lines); const l=d.line(n); const m=/\\[([ xX])\\]/.exec(l.text); if(!m) return 'noop'; v.dispatch({changes:{from:l.from+m.index+1,to:l.from+m.index+2,insert:m[1]===' '?'x':' '},userEvent:'input'}); return 'toggle '+n;`,
    join: `const d=v.state.doc; const n=1+Math.floor(a.r1*(d.lines-1)); const l=d.line(n); if(n>=d.lines) return 'noop'; v.dispatch({changes:{from:l.to,to:l.to+1},userEvent:'delete.backward'}); return 'join '+n;`,
    paste: `const t=Array.from({length:a.n},(_, i)=>'pasted '+i).join('\\n')+'\\n'; const d=v.state.doc; const l=d.line(1+Math.floor(a.r1*d.lines)); v.dispatch({changes:{from:l.from,insert:t},userEvent:'input.paste'}); return 'paste '+a.n+'@'+l.number;`,
  };
  for (let op = 0; op < Math.min(OPS, UPTO); op++) {
    const r = rnd();
    let what;
    if (r < 0.42) {
      // a click on a random visible box
      const pts = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]')).map((b) => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, vis: r.top > 40 && r.bottom < innerHeight - 10 && r.width > 0 }; }).filter((p) => p.vis));
      if (!pts.length) { what = 'click: no visible box'; log.push(what); continue; }
      const p = pick(pts);
      await page.mouse.click(p.x, p.y);
      what = `click ${Math.round(p.x)},${Math.round(p.y)}`;
    } else if (r < 0.52) {
      const ms = ri(300); await sleep(ms); what = 'wait ' + ms;
    } else if (r < 0.56) {
      await page.evaluate(() => window.__mdr.app.editor.view.focus());
      const k = rnd() < 0.7 ? 'Meta+z' : 'Meta+Shift+z';
      await page.keyboard.press(k); what = 'key ' + k;
    } else if (r < 0.58) {
      await page.evaluate(() => window.__mdr.mode('edit')); await sleep(ri(150)); await edit(E.ins, { r1: rnd(), r2: rnd(), t: 'y' }); await page.evaluate(() => window.__mdr.mode('split')); what = 'hide-edit-show';
    } else {
      const kinds = ['ins', 'ins', 'ins', 'del', 'dupline', 'moveup', 'indent', 'toggle', 'join', 'paste'];
      const k = pick(kinds);
      const t = pick(['x', ' ', '\n', '\n\n', `\n- [ ] q${nextTok++} new`, `- [ ] q${nextTok++} new\n`, '- ', '> ', '1. ', '[ ] ']);
      what = await edit(E[k], { r1: rnd(), r2: rnd(), t, n: k === 'paste' ? pick([3, 50, 800]) : 6 });
    }
    log.push(what);
    if (rnd() < 0.5) await sleep(ri(80));
    // judge every finished click
    const W = await page.evaluate(() => window.__fz);
    for (let ci = 0; ci < W.clicks.length; ci++) {
      const c = W.clicks[ci];
      if (c.judged || c.after === undefined) continue;
      c.judged = true;
      await page.evaluate((ci) => { window.__fz.clicks[ci].judged = true; }, ci);
      if (!c.box) continue;
      const a = c.doc.split('\n'), b = c.after.split('\n');
      const toast = W.toasts.some((x) => x.t >= c.t && x.t <= c.ta + 30 && /没有勾选/.test(x.text));
      let v;
      if (a.length !== b.length) v = 'LINECOUNT';
      else {
        const fl = []; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) fl.push({ n: i + 1, before: a[i], after: b[i] });
        // fix-session-g, rule 4 (CONTRACT §11, Checkpoint-E decisions, CHC-3): a box that never named a task line (the
        // pressed task's source line is not one the tick's TASK_LINE recognises: "- 1. [ ] q3", "- - [ ] q3") is
        // cancelled silently, as before round 4; any other silent click is still a violation.
        const TASK_LINE = /^(?:\s*>)*\s*(?:[-*+]|\d{1,9}[.)])\s+\[[ xX]\]/;
        const tokLines = c.tok ? a.filter((x) => new RegExp('\\b' + c.tok + '\\b').test(x)) : [];
        const neverTask = tokLines.length > 0 && tokLines.every((x) => !TASK_LINE.test(x));
        if (!fl.length) v = toast ? 'ok-toast' : neverTask ? 'ok-silent-shape' : 'SILENT';
        else if (fl.length === 1 && fl[0].before.replace(/\[[ xX]\]/, '') === fl[0].after.replace(/\[[ xX]\]/, '')) {
          const t2 = (fl[0].after.match(/\bq\d+\b/) || [null])[0];
          // the pressed token still on another line of the source: a wrong task for sure; gone from the source (its
          // text was edited): unclear, printed for review with the lines around
          const reTok = new RegExp('\\b' + c.tok + '\\b');
          const elsewhere = b.some((x, i) => i + 1 !== fl[0].n && reTok.test(x));
          const dupTok = b.filter((x) => reTok.test(x)).length > 1;
          if (t2 === c.tok) v = dupTok ? 'ok-dup' : toast ? 'TOAST-APPLIED' : (c.shown === c.was ? 'NOT-SHOWN' : 'ok');
          else if (elsewhere) v = `WRONG pressed ${c.tok} (still at line ${b.findIndex((x) => reTok.test(x)) + 1}) flipped ${fl[0].n} ${J(fl[0].after)}`;
          else v = `ok-unclear pressed ${c.tok} (edited away) flipped ${fl[0].n} ${J(fl[0].after)} was ${J(a[fl[0].n - 1])}`;
          if (v.startsWith('ok-unclear')) console.log('UNCLEAR', seed, 'op', op, v);
        } else v = 'OTHER ' + J(fl.slice(0, 2));
      }
      if (!/^ok/.test(v)) { violations.push({ op, v, tok: c.tok }); console.log('VIOLATION', seed, 'op', op, v, 'log tail', J(log.slice(-6))); }
    }
  }
  await sleep(1500);
} finally {
  clearTimeout(killer);
  const W = await page.evaluate(() => window.__fz).catch(() => null);
  const n = W ? W.clicks.filter((c) => c.box).length : 0;
  console.log('result', J({ seed, ops: OPS, slow: SLOW, target, boxClicks: n, violations: violations.length, errs: errs.slice(0, 3) }));
  if (process.env.MDR_LOG) console.log('log', J(log));
  await browser.close();
  process.exit(violations.length ? 1 : 0);
}
