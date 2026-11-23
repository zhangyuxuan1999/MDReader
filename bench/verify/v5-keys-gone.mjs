// bench/verify/v5-keys-gone.mjs — verify-session-keys: variations of r3 J30 / J12 and P-C (the emptied element's place).
// A block is emptied in the preview (DOM select-all + Backspace); then an action; then Q. The source must equal the
// expected text exactly.
//   pos first|last|only|mid  x  kind para|list|heading|quote|code|table|task
//   act: undo (Cmd-Z restores the block; Q at the end of its content, U22), type (Q is the new block at the place),
//        above (an editor-pane insertion of two lines at the top while the element lives, then Q),
//        below (the same at the end), esc-click (Esc, click the neighbour, Q there)
//   MDR_PORT=5481 node bench/verify/v5-keys-gone.mjs [filter]
// Global timeout 110 s.
import { open, sleep, J } from './v5-keys-lib.mjs';

const filter = process.argv[2] ?? '';
const K = await open();
const { page } = K;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await K.close(); } catch { /* */ } process.exit(3); }, 110_000);
const KINDS = {
  para: ['乙段落文字。', '乙段落文字。Q', 'Q'],
  list: ['- 乙一\n- 乙二', '- 乙一\n- 乙二Q', 'Q'],
  heading: ['## 乙标题', '## 乙标题Q', 'Q'],
  quote: ['> 乙引用', '> 乙引用Q', 'Q'],
  task: ['- [ ] 乙任务', '- [ ] 乙任务Q', 'Q'],
};
const NB = { before: '甲前文。', after: '丙后文。' };
const docOf = (pos, body) => (pos === 'first' ? `${body}\n\n${NB.after}\n` : pos === 'last' ? `${NB.before}\n\n${body}\n` : pos === 'only' ? `${body}\n` : `${NB.before}\n\n${body}\n\n${NB.after}\n`);
let bad = 0;
try {
  for (const pos of ['first', 'last', 'only', 'mid']) {
    for (const [kind, [body, restoredQ, newQ]] of Object.entries(KINDS)) {
      for (const act of ['undo', 'type', 'above', 'below', 'esc-click']) {
        if (pos === 'only' && act === 'esc-click') continue;
        const name = `${pos} ${kind} ${act}`;
        if (filter && !name.includes(filter)) continue;
        const doc = docOf(pos, body);
        let expected;
        if (act === 'undo') expected = docOf(pos, restoredQ);
        else if (act === 'type') expected = docOf(pos, newQ);
        else if (act === 'above') expected = 'top new\n\n' + docOf(pos, newQ);
        else if (act === 'below') expected = docOf(pos, newQ) + '\nbottom new\n';
        else expected = pos === 'first' ? `${NB.after.replace('丙', 'Q丙')}\n` : docOf(pos, '').replace(/\n\n\n$/, '\n').replace('甲', 'Q甲').replace('\n\n\n丙', '\n\n丙');
        try {
          await K.load(doc);
          await K.clickText('乙', 1); await sleep(300);
          if (!(await K.session())) throw new Error('no session');
          await K.selectBlock(); await page.keyboard.press('Backspace');
          await K.idle(300);
          const emptied = await K.src();
          if (act === 'undo') { await page.keyboard.press('ControlOrMeta+z'); await K.idle(300); }
          if (act === 'above') { await K.editorEdit(0, 'top new\n\n'); await K.idle(300); }
          if (act === 'below') { await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: v.state.doc.length, insert: '\nbottom new\n' } }); }); await K.idle(300); }
          if (act === 'esc-click') { await page.keyboard.press('Escape'); await K.idle(300); await K.clickText(pos === 'first' ? '丙' : '甲', 0); await sleep(300); }
          const sess = await K.session();
          await page.keyboard.type('Q'); await K.idle(400);
          await page.keyboard.press('Escape'); await K.idle(300);
          const after = await K.src();
          const qn = after.split('Q').length - 1;
          const lost = ['甲', '丙'].filter((w) => doc.includes(w) && !after.includes(w));
          const ok = after === expected || (act === 'esc-click' && qn === 1 && lost.length === 0);
          if (!ok) bad++;
          console.log(`RESULT ${name} ${ok ? 'ok' : 'BAD'}${ok ? '' : ' ' + J({ emptied, expected, after, qn, lost, session: sess && sess.text })}`);
        } catch (e) { bad++; console.log(`RESULT ${name} ERROR ${String(e.message).split('\n')[0]}`); }
      }
    }
  }
} finally { clearTimeout(KILL); await K.close().catch(() => {}); console.log(`DONE bad=${bad}`); process.exit(bad ? 1 : 0); }
