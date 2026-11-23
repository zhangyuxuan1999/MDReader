// bench/verify/v2-ses-undo.mjs — verify-session: undo / redo inside a session (U1, U3).
// A mixed sequence (typing, splits, merges, formatting, paste) in one or more blocks, then ⌘Z until the
// history is exhausted: the source must equal the original BYTE FOR BYTE; then ⇧⌘Z all the way: the source
// must equal the final text. Also: the session stays live (the user can keep typing) and a redo after new
// typing does nothing. Run: MDR_PORT=5282 node bench/verify/v2-ses-undo.mjs [case] [gapMs]
import { openB, sleep, globalTimeout, J, check, results, readRoot } from './v2-ses-lib.mjs';

const only = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2] : '';
const GAP = Number(process.argv[3] ?? 150);
const B = await openB();
const stop = globalTimeout(115_000, B.close);
const { page } = B;

async function paste(text, html) {
  await page.evaluate(({ text, html }) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    if (html) dt.setData('text/html', html);
    const t = document.activeElement;
    t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { text, html });
}
async function run(seq) {
  for (const a of seq) {
    const [k, ...rest] = a.split(':');
    const v = rest.join(':');
    if (k === 'type') await page.keyboard.type(v, { delay: 20 });
    else if (k === 'press') await page.keyboard.press(v);
    else if (k === 'paste') await paste(v.replace(/\\n/g, '\n'));
    else if (k === 'click') { const needle = v.split('@')[1]; await B.settle(150); const line = (await B.source()).split('\n').findIndex((l) => l.includes(needle)) + 1; await B.clickLine(line, 'first', needle); await B.caretAt(needle, 'after'); }
    else if (k === 'wait') await sleep(Number(v));
    await sleep(GAP);
  }
  await B.settle(300);
}
const live = () => page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing') && document.activeElement?.classList.contains('is-editing'));

const SMALL = readRoot('test-data/small.md').split('\n').slice(0, 40).join('\n') + '\n';
const C = {
  plain: { doc: 'one two\n\nthree four\n\nfive\n', seq: ['click:3@three', 'type: alpha', 'press:Enter', 'type:beta', 'press:Meta+ArrowLeft', 'press:Backspace', 'type:X', 'press:Shift+Alt+ArrowLeft', 'press:Meta+b', 'press:Meta+ArrowRight', 'paste:p1\\n\\np2', 'press:Enter', 'type:end'] },
  small: { doc: SMALL, seq: ['click:7@段落', 'type:加入', 'press:Enter', 'type:新段', 'press:Enter', 'press:Backspace', 'press:Backspace', 'type:Z', 'press:Shift+ArrowLeft', 'press:Meta+i', 'press:Meta+e', 'type:code'] },
  list: { doc: '- aaa\n- bbb\n  - ccc\n- [ ] ddd\n\npara\n', seq: ['click:2@bbb', 'type:X', 'press:Enter', 'type:new', 'press:Tab', 'press:Enter', 'press:Enter', 'type:out', 'press:Enter', 'type:more'] },
  code: { doc: 'p\n\n```js\nlet a = 1;\n```\n\nq\n', seq: ['click:4@let', 'press:Enter', 'type:b();', 'paste:x\\ny\\n', 'press:Tab', 'type:z'] },
  multi: { doc: 'aaa\n\nbbb\n\nccc\n', seq: ['click:1@aaa', 'type:1', 'press:Escape', 'click:3@bbb', 'type:2', 'press:Enter', 'type:3', 'press:Escape', 'click:5@ccc', 'type:4'] },
  emptied: { doc: 'aaa\n\nbbb\n\nccc\n', seq: ['click:3@bbb', 'press:Backspace', 'press:Backspace', 'press:Backspace', 'type:new', 'press:Meta+a', 'press:Backspace'] },
  bursts: { doc: 'alpha beta\n\ngamma delta\n\nepsilon\n', seq: ['click:@alpha', 'type:1', 'wait:600', 'press:Enter', 'wait:600', 'type:2', 'wait:600', 'press:Meta+ArrowLeft', 'press:Backspace', 'wait:600', 'type:3', 'wait:600', 'press:Enter', 'type:4', 'wait:600', 'press:Shift+ArrowLeft', 'press:Meta+b', 'wait:600', 'press:Meta+ArrowRight', 'press:Enter', 'wait:600', 'type:5', 'wait:600', 'paste:six\n\nseven', 'wait:600', 'press:Meta+ArrowLeft', 'press:Backspace', 'wait:600', 'type:8'] },
  table: { doc: '| a | b |\n|---|---|\n| c | d |\n\nx\n', seq: ['click:3@c', 'type:1', 'press:Tab', 'type:2', 'press:Shift+Tab', 'type:3'] },
};

try {
  await B.boot('mode=split');
  for (const [name, c] of Object.entries(C)) {
    if (only && name !== only) continue;
    try {
      await B.loadDoc(c.doc);
      const orig = await B.source();
      await run(c.seq);
      const fin = await B.source();
      const stillLive = await live();
      if (process.env.HELD) {
        for (let i = 0; i < 25; i++) { await page.keyboard.press('Meta+z'); await sleep(33); }
        await sleep(600); await B.settle(300);
        const u = await B.source();
        check(`${name}: held ⌘Z x25 @33ms restores the original`, u === orig, u === orig ? '' : `got ${J(u)} expected ${J(orig)} live=${await live()}`);
        for (let i = 0; i < 25; i++) { await page.keyboard.press('Meta+Shift+z'); await sleep(33); }
        await sleep(600); await B.settle(300);
        const rr = await B.source();
        check(`${name}: held ⇧⌘Z x25 @33ms restores the final`, rr === fin, rr === fin ? '' : `got ${J(rr)} expected ${J(fin)} live=${await live()}`);
        check(`${name}: live after held keys`, await live(), J(await B.state()));
        await B.esc();
        continue;
      }
      const steps = [];
      let prev = fin;
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Meta+z');
        await sleep(GAP);
        await B.settle(120);
        const now = await B.source();
        const l = await live();
        steps.push({ i, changed: now !== prev, live: l });
        prev = now;
        if (now === orig) break;
        if (!l && i > 0 && !steps[i - 1].changed && !steps[i].changed) break;
      }
      const atOrig = prev === orig;
      check(`${name}: undo all the way restores the original`, atOrig, atOrig ? `${steps.length} steps` : `got ${J(prev)} expected ${J(orig)} steps=${J(steps.slice(-4))}`);
      const extra = [];
      for (let i = 0; i < 3; i++) { await page.keyboard.press('Meta+z'); await sleep(GAP); }
      await B.settle(120);
      check(`${name}: more ⌘Z at the bottom changes nothing`, (await B.source()) === prev);
      let r = await B.source();
      for (let i = 0; i < 40 && r !== fin; i++) {
        await page.keyboard.press('Meta+Shift+z');
        await sleep(GAP);
        await B.settle(120);
        r = await B.source();
      }
      check(`${name}: redo all the way restores the final text`, r === fin, r === fin ? '' : `got ${J(r)} expected ${J(fin)}`);
      check(`${name}: session live during and after (before ⌘Z: ${stillLive})`, stillLive && await live(), J(await B.state()));
      await B.esc();
    } catch (e) { check(name, false, 'threw ' + e.message.split('\n')[0]); }
  }
  console.log('errors', J(B.pageErrors), J(B.consoleErrors.slice(0, 5)));
} finally { console.log(`${results.pass}/${results.pass + results.fail} passed; fails: ${results.fails.join(' | ')}`); stop(); await B.close(); }
