// bench/verify/v2-app-stale.mjs — verify-app (0.2.0 stage 2a): a session whose END changes the line count
// (an emptied block: its deletion is written only when the session ends) followed by a click elsewhere in the
// preview. The mousedown ends the session synchronously; the click then acts on block positions taken from
// the structure that does not yet know about the deletion.
// Needs the candidate renderer running: npx vite --port 5283 --strictPort
// Run: MDR_PORT=5283 node bench/verify/v2-app-stale.mjs [runs]
import { openBrowser, step, assert, eq, finish, sleep } from './v2-app-lib.mjs';

await (await import('./v2-app-lib.mjs')).ensureServer();
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000);
const RUNS = Number(process.argv[2] ?? 3);
const B = await openBrowser();
const { page } = B;
const L = (doc, needle) => doc.split('\n').findIndex((l) => l.includes(needle)) + 1;

async function emptyBlock(doc, needle) {
  await B.loadDoc(doc);
  await B.clickLine(L(doc, needle), 'first', needle.slice(0, 2));
  await B.caretAt(needle);
  assert(await B.editing(), 'no session');
  await page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const r = document.createRange(); r.selectNodeContents(el.querySelector('p') ?? el);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.keyboard.press('Backspace');
  await sleep(120);
}

try {
  await B.boot('mode=split');
  const DOC = ['甲段落文字。', '', '乙段落文字。', '', '丙段落文字。', '', '丁段落文字。', ''].join('\n');
  for (let run = 1; run <= RUNS; run++) {
    for (const gap of [0, 90]) {
      await step(`S1 run ${run}: empty 甲, then click 乙 (down/up ${gap} ms) and type X → 乙段落文字。X, 丙 still its own paragraph`, async () => {
        await emptyBlock(DOC, '甲段落文字。');
        const pt = await page.evaluate(() => {
          const els = [...document.querySelectorAll('.mdr-preview section.md-block p')];
          const p = els.find((e) => e.textContent.includes('乙段落文字。'));
          const r = document.createRange(); r.setStart(p.firstChild, 5); r.setEnd(p.firstChild, 6);
          const b = r.getBoundingClientRect(); return { x: b.right - 1, y: b.top + b.height / 2 };
        });
        await page.mouse.move(pt.x, pt.y);
        await page.mouse.down(); if (gap) await sleep(gap); await page.mouse.up();
        await sleep(150);
        const ed = await B.editing();
        await page.keyboard.type('X');
        await B.settle(400);
        await B.esc();
        const s = await B.source();
        const html = await page.evaluate(() => [...document.querySelectorAll('.mdr-preview section.md-block')].map((e) => e.innerText.trim()).filter(Boolean));
        assert(s.includes('乙段落文字。X') || !ed, `typed X not after 乙: ${JSON.stringify(s)}`);
        assert(/乙段落文字。X?\n\n丙段落文字。/.test(s), `blank line between 乙 and 丙 lost: ${JSON.stringify(s)} | blocks ${JSON.stringify(html)}`);
        return `session=${ed ? 'yes' : 'no'} src=${JSON.stringify(s)}`;
      });
    }
  }

  for (let run = 1; run <= RUNS; run++) {
    await step(`S3 run ${run}: empty 甲, then click into the EDITOR at the end of 丙 and type Q → 丙段落文字。Q`, async () => {
      await emptyBlock(DOC, '甲段落文字。');
      const pt = await page.evaluate(() => {
        const v = window.__mdr.app.editor.view;
        // Lead decision U9 (stage 2): the deletion of 甲 is already written here, so 丙 is no longer line 5 —
        // the line is found by its text.
        const line = v.state.doc.line(v.state.doc.toString().split('\n').findIndex((l) => l.includes('丙段落')) + 1);
        const c = v.coordsAtPos(line.to);
        return { x: c.left + 1, y: (c.top + c.bottom) / 2 };
      });
      await page.mouse.click(pt.x, pt.y);
      await sleep(100);
      await page.keyboard.type('Q');
      await B.settle(300);
      const s = await B.source();
      assert(s.includes('丙段落文字。Q'), `Q not where clicked: ${JSON.stringify(s)}`);
    });
  }

  for (let run = 1; run <= RUNS; run++) {
    await step(`S4 run ${run}: IME composition open in 甲 (preview), click into the EDITOR at the end of 丙, type Q → 丙段落文字。Q`, async () => {
      await B.loadDoc(DOC);
      await B.clickLine(1, 'first', '甲段'); await B.caretAt('甲段落文字。');
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
      await sleep(120);
      const pt = await page.evaluate(() => { const v = window.__mdr.app.editor.view; const c = v.coordsAtPos(v.state.doc.line(5).to); return { x: c.left + 1, y: (c.top + c.bottom) / 2 }; });
      await page.mouse.click(pt.x, pt.y);
      await sleep(150);
      await page.keyboard.type('Q');
      await B.settle(300);
      await cdp.detach().catch(() => {});
      const s = await B.source();
      assert(s.includes('丙段落文字。Q'), `Q not where clicked: ${JSON.stringify(s)}`);
      return JSON.stringify(s.split('\n')[0]);
    });
  }

  const TASKS = ['甲段落文字。', '', '- [ ] 任务一', '- [ ] 任务二', '- [ ] 任务三', '- [ ] 任务四', ''].join('\n');
  for (let run = 1; run <= RUNS; run++) {
    for (const gap of [0, 90]) {
      await step(`S2 run ${run}: empty 甲, then click checkbox 任务二 (down/up ${gap} ms) → 任务二 checked, no other task`, async () => {
        await emptyBlock(TASKS, '甲段落文字。');
        const p = await page.evaluate(() => {
          const b = [...document.querySelectorAll('.mdr-preview li')].find((li) => li.textContent.includes('任务二')).querySelector('input');
          const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.mouse.move(p.x, p.y);
        await page.mouse.down(); if (gap) await sleep(gap); await page.mouse.up();
        await B.settle(400);
        const s = await B.source();
        const tasks = s.split('\n').filter((l) => l.includes('任务'));
        const wrong = tasks.filter((l) => l.startsWith('- [x]') && !l.includes('任务二'));
        assert(wrong.length === 0, `WRONG task toggled: ${JSON.stringify(tasks)}`);
        assert(tasks.find((l) => l.includes('任务二')) === '- [x] 任务二', `click lost: ${JSON.stringify(tasks)}`);
      });
    }
  }
} finally {
  finish();
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
}
