// bench/verify/v5-keys-probe.mjs — verify-session-keys: small named probes (switch ON, dev server on MDR_PORT).
//   MDR_PORT=5481 node bench/verify/v5-keys-probe.mjs <case|all|list>
// Each case prints RESULT <name> {before, after, screenBefore, screenAfter, toasts, ok}. Global timeout 110 s.
import { open, sleep, J } from './v5-keys-lib.mjs';

const want = process.argv[2] ?? 'all';
const K = await open();
const { page } = K;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await K.close(); } catch { /* */ } process.exit(3); }, 110_000);
let bad = 0;
const CASES = {
  // Delete at the end of an unticked task item, before a ticked one: the items join in the session DOM; what is written?
  'task-del-join': async () => {
    await K.load('- [ ] task a\n- [x] task b\n\nend\n');
    await K.clickText('task a', 5); await sleep(300);
    await page.keyboard.press('End'); await page.keyboard.press('Delete'); await sleep(200);
    return { expect: (s) => !/\[x\] task a/.test(s) };
  },
  'task-bs-join': async () => {
    await K.load('- [ ] task a\n- [x] task b\n\nend\n');
    await K.clickText('task b', 0); await sleep(300);
    await page.keyboard.press('Home'); await page.keyboard.press('Backspace'); await sleep(200);
    return { expect: (s) => !/\[x\] task a/.test(s) };
  },
  'task-del-join-rev': async () => {
    await K.load('- [x] task a\n- [ ] task b\n\nend\n');
    await K.clickText('task a', 5); await sleep(300);
    await page.keyboard.press('End'); await page.keyboard.press('Delete'); await sleep(200);
    return { expect: (s) => /\[x\] task a/.test(s) };
  },
  'task-del-join-type': async () => {
    await K.load('- [ ] task a\n- [x] task b\n\nend\n');
    await K.clickText('task a', 5); await sleep(300);
    await page.keyboard.press('End'); await page.keyboard.press('Delete'); await sleep(100);
    await page.keyboard.type('Q'); await sleep(200);
    return { expect: (s) => !/\[x\] task a/.test(s) && s.split('Q').length === 2 };
  },
  // a plain item followed by a ticked task: the task's box arrives in the middle of the plain item's line
  'task-del-join-plain-first': async () => {
    await K.load('- plain a\n- [x] task b\n\nend\n');
    await K.clickText('plain a', 6); await sleep(300);
    await page.keyboard.press('End'); await page.keyboard.press('Delete'); await sleep(200);
    return { expect: (s) => !/\[x\] plain a/.test(s) };
  },
  // three tasks, the middle one ticked; join the middle one into the first
  'task-bs-join-three': async () => {
    await K.load('- [ ] one\n- [x] two\n- [ ] three\n\nend\n');
    await K.clickText('two', 0); await sleep(300);
    await page.keyboard.press('Home'); await page.keyboard.press('Backspace'); await sleep(200);
    return { expect: (s) => /^- \[ \] one/.test(s) };
  },
  // table cells: Delete at a cell's end / Backspace at a cell's start must not move text between cells or rows
  'cell-del-end': async () => {
    await K.load('top\n\n| a | b |\n| --- | --- |\n| c1 | d1 |\n| e1 | f1 |\n\nend\n');
    await K.clickText('c1', 1); await sleep(300); await K.caretAfter('c1');
    await page.keyboard.press('Delete'); await page.keyboard.type('Q'); await sleep(200);
    return { expect: (s) => s.includes('| c1Q | d1 |') || s.includes('| c1Q | 1 |') };
  },
  'cell-bs-start': async () => {
    await K.load('top\n\n| a | b |\n| --- | --- |\n| c1 | d1 |\n| e1 | f1 |\n\nend\n');
    await K.clickText('e1', 0); await sleep(300); await K.caretAfter('e1', 'before');
    await page.keyboard.press('Backspace'); await page.keyboard.type('Q'); await sleep(200);
    return { expect: (s) => s.includes('| c1 | d1 |') && s.includes('f1') && s.split('Q').length === 2 };
  },
  'cell-del-row-end': async () => {
    await K.load('top\n\n| a | b |\n| --- | --- |\n| c1 | d1 |\n| e1 | f1 |\n\nend\n');
    await K.clickText('d1', 1); await sleep(300); await K.caretAfter('d1');
    await page.keyboard.press('Delete'); await page.keyboard.type('Q'); await sleep(200);
    return { expect: (s) => s.includes('| e1 | f1 |') && s.split('Q').length === 2 };
  },
  'item-nested-del': async () => {
    await K.load('- one\n  - [x] nested\n- [ ] two\n\nend\n');
    await K.clickText('one', 2); await sleep(300); await K.caretAfter('one');
    await page.keyboard.press('Delete'); await sleep(200);
    return { expect: (s) => !/^- \[x\] one/m.test(s) && s.includes('[ ] two') };
  },
  // after the join and Esc, Cmd-Z in the editor gives the document back byte for byte?
  'task-join-undo': async () => {
    await K.load('- [ ] task a\n- [x] task b\n\nend\n');
    await K.clickText('task a', 5); await sleep(300);
    await page.keyboard.press('End'); await page.keyboard.press('Delete'); await sleep(200);
    await page.keyboard.press('Escape'); await K.idle(400);
    await page.evaluate(() => window.__mdr.app.editor.view.focus());
    await page.keyboard.press('ControlOrMeta+z'); await K.idle(300);
    return { expect: (s) => s === '- [ ] task a\n- [x] task b\n\nend\n' };
  },
};
// Enter at the end of a list item, then typing (at once / after 600 ms): the text goes into the NEW item
for (const [nm, doc, needle, want2] of [
  ['task', '- [ ] alpha one\n- [ ] beta two\n\nend\n', 'alpha one', (s) => /alpha one\n- (\[ \] )?new item\n- \[ \] beta two/.test(s)],
  ['task-last', '- [ ] alpha one\n- [ ] beta two\n\nend\n', 'beta two', (s) => /beta two\n- (\[ \] )?new item\n/.test(s)],
  ['plain', '- alpha one\n- beta two\n\nend\n', 'alpha one', (s) => /alpha one\n- new item\n- beta two/.test(s)],
  ['ordered', '1. alpha one\n2. beta two\n\nend\n', 'alpha one', (s) => /alpha one\n2\. new item\n3\. beta two/.test(s)],
  ['task-checked', '- [x] alpha one\n- [ ] beta two\n\nend\n', 'alpha one', (s) => /alpha one\n- (\[ \] )?new item\n- \[ \] beta two/.test(s)],
]) {
  for (const w of [0, 600]) {
    CASES[`enteritem-${nm}-w${w}`] = async () => {
      await K.load(doc);
      await K.clickText(needle, 2); await sleep(300);
      if (process.env.MDR_END_KEY) await page.keyboard.press('End'); else await K.caretAfter(needle);
      await page.keyboard.press('Enter');
      if (w) await sleep(w);
      await page.keyboard.type('new item'); await sleep(300);
      return { expect: want2 };
    };
  }
}
// Esc, then Cmd-Z / Shift-Cmd-Z outside the session (switch on: the quiet route resumes a session at the step), then
// keys right away, under a worker delay. Every key must arrive once (or be dropped WITH the P-G toast).
for (const d of [0, 150, 400, 900]) {
  for (const [hist, keys] of [['undo', ['Q']], ['redo', ['Q']], ['undo', ['End', 'Delete', 'Enter', 'Q']], ['redo', ['End', 'Delete', 'Enter', 'Q']], ['undo', ['Enter', 'Q']]]) {
    CASES[`esc-${hist}-${keys.join('')}-d${d}`] = async () => {
      await K.load('aaa one\n\nbbb two\n\nccc three\n');
      await K.clickText('bbb', 1); await sleep(300);
      await page.keyboard.type('XY'); await sleep(700);
      if (hist === 'redo') { await page.keyboard.press('ControlOrMeta+z'); await K.idle(500); }
      await page.keyboard.press('Escape'); await K.idle(400);
      await K.setDelay(d);
      await page.keyboard.press(hist === 'undo' ? 'ControlOrMeta+z' : 'ControlOrMeta+Shift+z');
      const tgt = await page.evaluate(() => document.activeElement?.tagName);
      for (const k of keys) { if (k === 'Q') await page.keyboard.type('Q'); else await page.keyboard.press(k); }
      await sleep(d * 3 + 300);
      await K.idle(600);
      const t = await page.evaluate(() => window.__toasts.slice());
      return { expect: (s) => s.split('Q').length === 2 || t.includes('预览尚未更新完，刚才的输入没有写入'), note: tgt };
    };
  }
}
// A click that waits for a pending re-render (P-F), then keys, Esc, more keys — all before the block mounts.
// Without a wait the Esc ends the session and the later keys go nowhere (as in 0.1.1): nothing after Esc may be written.
for (const d of [400, 1000]) {
  for (const [nm, after] of [['enter-type', ['Enter', 'KGA']], ['type', ['KGA']], ['bs', ['Backspace']], ['undo', ['ControlOrMeta+z']], ['enter', ['Enter']], ['del', ['Delete']]]) {
    CASES[`wait-esc-${nm}-d${d}`] = async () => {
      await K.load('head line\n\ndup words\n\nend\n');
      await K.clickText('dup', 0); await sleep(300);
      await page.keyboard.type('ab'); await sleep(60);
      await K.setDelay(d);
      await page.keyboard.press('Escape');
      await sleep(20);
      await K.clickText('words', 0);
      const t1 = await page.evaluate(() => document.activeElement?.tagName);
      await page.keyboard.type('KFA');
      await page.keyboard.press('Escape');
      for (const k of after) { if (/^[A-Z]{3}$/.test(k)) await page.keyboard.type(k); else await page.keyboard.press(k); }
      await sleep(d * 4 + 500);
      await K.idle(500);
      return { expect: (s) => s === 'head line\n\nabdup KFAwords\n\nend\n', note: t1 };
    };
  }
}
// K5 + history position: the first edit of a block normalises its spelling; Cmd-Z then puts the caret where?
for (const [nm, doc, click, k] of [
  ['k5undo-star-list', 'top\n\n* one\n* two\n* three\n\nend\n', 'one', 3],
  ['k5undo-setext', 'top\n\nTitle words\n===========\n\nend\n', 'Title', 5],
  ['k5undo-refs-end', 'top\n\nsee [ref][r] and more words\n\nend\n\n[r]: https://r.x\n', 'words', 5],
  ['k5undo-closing-hashes', 'top\n\n## Head words ##\n\nend\n', 'Head', 4],
  ['k5undo-plain-ctl', 'top\n\nplain words here\n\nend\n', 'plain', 5],
]) {
  CASES[nm] = async () => {
    await K.load(doc);
    await K.clickText(click, k - 1); await sleep(300);
    await K.caretAfter(click, 'after');
    await page.keyboard.type('QR'); await sleep(900);
    const withQR = await K.src();
    await page.keyboard.press('ControlOrMeta+z'); await K.idle(400);
    const s1 = await K.session();
    await page.keyboard.type('W'); await K.idle(300);
    const exp = withQR.replace('QR', 'W');
    return { expect: (s) => s === exp, note: s1 && s1.before };
  };
}
// CHA-2 variations: a waiting click (pending re-render, worker delay d) and keys queued; then the user turns to the
// editor pane (a real click into its text) or presses elsewhere in the preview, and types. The queued keys are dropped
// WITH the P-G toast, the later text goes where the user turned, the focus is never taken back.
for (const d of [600, 1500]) {
  for (const turn of ['editor-click', 'toolbar-press', 'other-block']) {
    CASES[`cha2-${turn}-d${d}`] = async () => {
      await K.load('head line\n\ndup words\n\nother block\n\nend\n');
      await K.setDelay(d);
      await page.evaluate(() => { const v = window.__mdr.app.editor.view; const t = v.state.doc.toString(); const i = t.indexOf('words'); v.dispatch({ changes: { from: i + 5, insert: ' ed' } }); });
      await sleep(10);
      await K.clickText('words', 0);
      await page.keyboard.type('QQ');
      const waiting = await page.evaluate(() => document.activeElement?.tagName);
      if (waiting !== 'TEXTAREA') throw new Error('the click did not wait: ' + waiting);
      await sleep(50);
      if (turn === 'editor-click') {
        const pt = await page.evaluate(() => { const v = window.__mdr.app.editor.view; const l = v.state.doc.line(7); const c = v.coordsAtPos(l.from + 3); return { x: c.left + 1, y: (c.top + c.bottom) / 2 }; });
        await page.mouse.click(pt.x, pt.y);
      } else if (turn === 'toolbar-press') {
        const b = await page.evaluate(() => { const e = document.querySelector('.mdr-statusbar, footer, .statusbar'); const r = e ? e.getBoundingClientRect() : null; return r ? { x: r.left + 5, y: r.top + r.height / 2 } : null; });
        if (b) await page.mouse.click(b.x, b.y);
      } else {
        await K.clickText('other', 2);
      }
      await page.keyboard.type('EDT');
      await sleep(d * 3 + 800);
      await K.idle(500);
      const t = await page.evaluate(() => window.__toasts.slice());
      const foc = await page.evaluate(() => document.activeElement?.className);
      return {
        expect: (s) => !s.includes('QQ') ? t.includes('预览尚未更新完，刚才的输入没有写入') && (turn === 'toolbar-press' || s.split('EDT').length === 2) && (turn !== 'editor-click' || s.includes('endEDT')) : s.split('QQ').length === 2,
        note: foc,
      };
    };
  }
}
// Order of the undo history: a session's last key (Delete), then at once the user turns to the editor pane and types.
// The session's write must come BEFORE the editor typing in CodeMirror's history (the order of the gestures).
for (const d of [0, 300]) {
  for (const how of ['focus', 'click']) {
    CASES[`order-${how}-d${d}`] = async () => {
      await K.load('top para\n\n- aaa\n- bbb\n\nplain two\n\nend\n');
      await K.setDelay(d);
      await K.clickText('bbb', 1); await sleep(10);
      await page.keyboard.press('Delete');
      if (how === 'focus') await page.evaluate(() => { const v = window.__mdr.app.editor.view; const l = v.state.doc.line(6); v.dispatch({ selection: { anchor: l.to } }); v.focus(); });
      else { const pt = await page.evaluate(() => { const v = window.__mdr.app.editor.view; const l = v.state.doc.line(6); const c = v.coordsAtPos(l.to); return { x: c.left + 1, y: (c.top + c.bottom) / 2 }; }); await page.mouse.click(pt.x, pt.y); }
      await page.keyboard.type('ECA', { delay: 30 });
      await K.idle(600);
      const steps = [];
      await page.evaluate(() => window.__mdr.app.editor.view.focus());
      let prev = await K.src();
      for (let i = 0; i < 4; i++) { await page.keyboard.press('ControlOrMeta+z'); await sleep(150); const now = await K.src(); steps.push(now === prev ? '-' : (prev.includes('ECA') && !now.includes('ECA') ? 'ECA' : prev.includes('ECA') && now.includes('EC') && !now.includes('ECA') ? 'A' : now.includes('bbb') && !prev.includes('bbb') ? 'DEL' : '?')); prev = now; }
      return { expect: () => steps[0] !== 'DEL' && steps.indexOf('DEL') > steps.lastIndexOf('ECA'), note: steps.join(',') };
    };
  }
}
// The same with a WAITING click (structure behind after an editor-pane change): the turn to the editor abandons the
// wait (CHA-2) — the queued Delete must never be applied after the editor typing; if dropped, the P-G toast says so.
for (const d of [300, 800]) {
  for (const how of ['focus', 'click']) {
    CASES[`waitorder-${how}-d${d}`] = async () => {
      await K.load('top para\n\n- aaa\n- bbb\n\nplain two\n\nend\n');
      await K.setDelay(d);
      await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: 0, insert: 'x' } }); });
      await sleep(10);
      await K.clickText('bbb', 1);
      const t0 = await page.evaluate(() => document.activeElement?.tagName);
      await page.keyboard.press('Delete');
      if (how === 'focus') await page.evaluate(() => { const v = window.__mdr.app.editor.view; const l = v.state.doc.line(6); v.dispatch({ selection: { anchor: l.to } }); v.focus(); });
      else { const pt = await page.evaluate(() => { const v = window.__mdr.app.editor.view; const l = v.state.doc.line(6); const c = v.coordsAtPos(l.to); return { x: c.left + 1, y: (c.top + c.bottom) / 2 }; }); await page.mouse.click(pt.x, pt.y); }
      await page.keyboard.type('ECA', { delay: 30 });
      await sleep(d * 3 + 500);
      await K.idle(600);
      const s0 = await K.src();
      const t = await page.evaluate(() => window.__toasts.slice());
      return { expect: () => s0.includes('- bbb') && s0.includes('plain twoECA'), note: `${t0} toasts=${t.length}` };
    };
  }
}
// A click into an ordinary paragraph deep inside test-data/large.md, then keys (the fuzz's C5 with --large).
for (const at of [30000, 50000]) {
  CASES[`large-click-${at}`] = async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../../test-data/large.md', import.meta.url), 'utf8');
    await K.load(text);
    const line = await page.evaluate(async (at) => {
      const v = window.__mdr.app.editor.view; const d = v.state.doc;
      let L = at; while (L < d.lines && !d.line(L).text.startsWith('这是一个用于性能测试的段落')) L++;
      window.__mdr.app.preview.scrollToLine(L, 0, 'instant');
      return L;
    }, at);
    await sleep(1200); await K.idle(300);
    const pt = await page.evaluate((L) => {
      const pv = window.__mdr.app.preview; const b = pv.blockAtLine(L); const el = pv.elementOfBlock(b.id);
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const n = w.nextNode();
      const r = document.createRange(); r.setStart(n, 3); r.setEnd(n, 4); const q = r.getBoundingClientRect();
      return { x: q.left + 1, y: q.top + q.height / 2, id: b.id };
    }, line);
    await page.mouse.click(pt.x, pt.y); await sleep(800);
    const s0 = await K.session();
    await page.keyboard.type('ZQZ'); await sleep(600); await K.idle(400);
    const t = await page.evaluate(() => window.__toasts.slice());
    return { expect: (s) => s.split('ZQZ').length === 2, note: `line=${line} session=${JSON.stringify(s0 && s0.text.slice(0, 40))} toasts=${JSON.stringify(t)}` };
  };
}
// P-B: a history step made from a session that re-interprets OTHER blocks (an editor-pane change before the session:
// a fence closed / opened, a setext underline, a table row, a list joined), Cmd-Z (and Shift-Cmd-Z) in the session,
// then Q: the source must be the stepped source with exactly one Q inserted; neighbours intact.
const HS = [
  ['fence-close', 'aaa para\n\n```\ncode\n```\n\nbbb para\n\nccc para\n', (t) => { const i = t.indexOf('```\n\nbbb'); return { from: i, to: i + 4, insert: '' }; }],
  ['fence-open', 'aaa para\n\nbbb para\n\nccc para\n', (t) => { const i = t.indexOf('bbb'); return { from: i, to: i, insert: '```\n' }; }],
  ['setext', 'aaa para\n\nTitle\n\nbbb para\n', (t) => { const i = t.indexOf('Title') + 6; return { from: i, to: i, insert: '===\n' }; }],
  ['table-row', 'aaa para\n\n| a | b |\n| - | - |\n| c | d |\n\nunder\n', (t) => { const i = t.indexOf('| c | d |\n') + 10; return { from: i, to: i + 1, insert: '' }; }],
  ['list-join', 'aaa para\n\n- one\n\nmid\n\n- two\n', (t) => { const i = t.indexOf('mid'); return { from: i, to: i + 5, insert: '' }; }],
  ['code-join', 'aaa para\n\n    c one\n\nmid\n\n    c two\n', (t) => { const i = t.indexOf('mid'); return { from: i, to: i + 5, insert: '' }; }],
];
for (const [nm, doc, change] of HS) {
  for (const steps of ['u', 'ur']) {
    for (const d of [0, 400]) {
      CASES[`hstep-${nm}-${steps}-d${d}`] = async () => {
        await K.load(doc);
        await page.evaluate((c) => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: c, userEvent: 'input.type' }); }, await page.evaluate((src) => src, doc).then(() => change(doc)));
        await K.idle(500);
        await K.clickText('aaa', 1); await sleep(300);
        if (!(await K.session())) throw new Error('no session');
        await K.setDelay(d);
        await page.keyboard.press('ControlOrMeta+z');
        if (steps === 'ur') { await sleep(d ? 50 : 300); await page.keyboard.press('ControlOrMeta+Shift+z'); }
        await sleep(d * 3 + 400); await K.idle(400);
        const stepped = await K.src();
        await page.keyboard.type('Q'); await K.idle(400);
        const words = ['aaa', 'bbb', 'ccc', 'code', 'Title', 'under', 'one', 'two', 'c one', 'c two', 'mid'].filter((w) => stepped.includes(w));
        return { expect: (s) => s.replace('Q', '') === stepped && s.split('Q').length === 2 && words.every((w) => s.includes(w)), note: J(stepped) };
      };
    }
  }
}
try {
  if (want === 'list') { console.log(Object.keys(CASES).join('\n')); }
  for (const [name, fn] of Object.entries(CASES)) {
    if (want !== 'all' && !name.startsWith(want)) continue;
    try {
      const r = await fn();
      const screenBefore = await K.screen();
      const sess = await K.session();
      await page.keyboard.press('Escape');
      await K.idle(500);
      const after = await K.src();
      const screenAfter = await K.screen();
      const ok = (r.expect ? r.expect(after) : true) && screenBefore === screenAfter;
      if (!ok) bad++;
      console.log(`RESULT ${name} ${J({ ok, note: r.note, after: after.length > 2000 ? after.length + ' chars' : after, screenBefore, screenAfter, session: sess && sess.text, toasts: await K.toasts() })}`);
    } catch (e) { bad++; console.log(`RESULT ${name} ERROR ${String(e.message).split('\n')[0]}`); }
  }
} finally { clearTimeout(KILL); await K.close().catch(() => {}); process.exit(bad ? 1 : 0); }
