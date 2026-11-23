// bench/verify/v5-chb-toggle.mjs — challenge-b (round 4): variations of CHA-1 (U16 amended: a task checkbox click whose
// block is not current waits and is then applied to the task the user clicked, else nothing changes with a toast).
// Cases: rapid ticks of several boxes of one list (switch on and switch off), a double click, a session end then two
// box clicks, a hard break typed in the item then its own box, editor-pane typing then a click on that task's box,
// duplicates, nested and ordered task lists. Each case prints observed / expected source and the toasts seen.
// Run: MDR_PORT=5486 node bench/verify/v5-chb-toggle.mjs [case-prefix ...]   (MDR_OFF=1: every case with 预览可编辑 off;
//   RUNS=n repeats). The ses libraries leave their Vite running on MDR_PORT. Writes nothing into the tree.
process.env.MDR_SCRATCH = process.env.MDR_SCRATCH || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v5-chb/lib';
const { openB, sleep, globalTimeout, J, check, summary, view, clickText, waitSession, load, caretTo } = await import('./v4-sesa-lib.mjs');

const only = process.argv.slice(2);
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), B.close);
const { page } = B;
page.removeAllListeners('dialog');
page.on('dialog', (d) => (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}));
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
const NOT_TICKED = '没有勾选：该任务项刚被改动，请再点一次';

async function boxPoint(k) {
  return page.evaluate((k) => {
    const b = document.querySelectorAll('.mdr-preview input[type="checkbox"]')[k];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, k);
}
async function clickBox(k) {
  const p = await boxPoint(k);
  if (!p) throw new Error('no checkbox ' + k);
  await page.mouse.click(p.x, p.y);
}
async function toastsInstall() {
  await page.evaluate(() => {
    window.__chbToasts = [];
    window.__chbClicks = [];
    if (!window.__chbClk) {
      window.__chbClk = true;
      const boxes = () => Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]'));
      document.addEventListener('pointerdown', (e) => { if (e.target instanceof HTMLInputElement) window.__chbClicks.push(`down#${boxes().indexOf(e.target)}@${Math.round(performance.now())}`); }, true);
      window.addEventListener('click', (e) => {
        const t = e.target;
        if (!(t instanceof HTMLInputElement)) return;
        const r = t.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        window.__chbClicks.push(`click#${boxes().indexOf(t)} trusted=${e.isTrusted} prevented=${e.defaultPrevented} inside=${inside} conn=${t.isConnected}@${Math.round(performance.now())}`);
      }, false);
    }
    if (window.__chbObs) return;
    window.__chbObs = new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const t = n.matches?.('.mdr-toast') ? n : n.querySelector?.('.mdr-toast');
        if (t) window.__chbToasts.push(t.textContent);
      }
    });
    window.__chbObs.observe(document.body, { childList: true, subtree: true });
  });
}
const toasts = () => page.evaluate(() => window.__chbToasts.slice());
async function setSwitch(on) {
  await page.evaluate((on) => { try { localStorage.setItem('mdr.previewEdit', on ? '1' : '0'); } catch { /* */ } }, on);
  for (let a = 0; a < 3; a++) {
    try {
      await sleep(300);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
      await sleep(400);
      break;
    } catch (err) { if (a === 2) throw err; }
  }
  const ls = await page.evaluate(() => localStorage.getItem('mdr.previewEdit'));
  if (ls !== (on ? '1' : '0')) throw new Error('switch not stored: ' + ls);
}
/** Click into the editor pane at the end of the line that holds `needle`, then type `text` with real keys. */
async function editorType(needle, text) {
  const p = await page.evaluate((needle) => {
    const v = window.__mdr.app.editor.view;
    const doc = v.state.doc.toString();
    const at = doc.indexOf(needle);
    if (at < 0) return null;
    const line = v.state.doc.lineAt(at);
    const c = v.coordsAtPos(line.to);
    return c ? { x: c.left + 2, y: (c.top + c.bottom) / 2 } : null;
  }, needle);
  if (!p) throw new Error('editor: no ' + needle);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('End');
  await page.keyboard.type(text);
}

const LARGE = (await import('node:fs')).readFileSync(new URL('../../test-data/large.md', import.meta.url), 'utf8');
const TL5 = '- [ ] one\n- [ ] two\n- [ ] three\n- [ ] four\n- [ ] five\n';
const tick = (src, ...names) => names.reduce((s, n) => s.replace(`- [ ] ${n}\n`, `- [x] ${n}\n`), src);
// [name, switchOn, doc, steps(async), want(src) -> expected string]
const C = [];
for (const on of [false, true]) {
  const sw = on ? 'on' : 'off';
  for (const gap of [15, 40, 80, 150]) {
    C.push([`rapid3-${sw}-${gap}`, on, `Intro\n\n${TL5}\nend\n`, async () => { await clickBox(0); await sleep(gap); await clickBox(1); await sleep(gap); await clickBox(2); },
      (d) => tick(d, 'one', 'two', 'three')]);
  }
  C.push([`rapid5-${sw}-30`, on, `Intro\n\n${TL5}\nend\n`, async () => { for (let k = 0; k < 5; k++) { await clickBox(k); await sleep(30); } },
    (d) => tick(d, 'one', 'two', 'three', 'four', 'five')]);
  C.push([`double-${sw}`, on, `Intro\n\n${TL5}\nend\n`, async () => { const p = await boxPoint(1); await page.mouse.click(p.x, p.y, { clickCount: 1 }); await sleep(60); await page.mouse.click(p.x, p.y, { clickCount: 2 }); },
    (d) => d]);
  C.push([`ordered-rapid-${sw}`, on, `Intro\n\n1. [ ] one\n2. [ ] two\n3. [ ] three\n\nend\n`, async () => { await clickBox(0); await sleep(30); await clickBox(1); await sleep(30); await clickBox(2); },
    (d) => d.replace('1. [ ] one', '1. [x] one').replace('2. [ ] two', '2. [x] two').replace('3. [ ] three', '3. [x] three')]);
  C.push([`nested-rapid-${sw}`, on, `- [ ] top\n  - [ ] in1\n  - [ ] in2\n\nend\n`, async () => { await clickBox(1); await sleep(30); await clickBox(2); await sleep(30); await clickBox(0); },
    (d) => d.replace('- [ ] top', '- [x] top').replace('- [ ] in1', '- [x] in1').replace('- [ ] in2', '- [x] in2')]);
  C.push([`quote-rapid-${sw}`, on, `> - [ ] q1\n> - [ ] q2\n> - [ ] q3\n\nend\n`, async () => { await clickBox(0); await sleep(30); await clickBox(1); await sleep(30); await clickBox(2); },
    (d) => d.replace('[ ] q1', '[x] q1').replace('[ ] q2', '[x] q2').replace('[ ] q3', '[x] q3')]);
  // editor pane: type into a task's line, then tick that task at once
  C.push([`editor-same-task-${sw}`, on, `Intro\n\n${TL5}\nend\n`, async () => { await editorType('- [ ] two', 'Z'); await clickBox(1); },
    (d) => d.replace('- [ ] two\n', '- [x] twoZ\n')]);
  C.push([`editor-other-task-${sw}`, on, `Intro\n\n${TL5}\nend\n`, async () => { await editorType('- [ ] one', 'Z'); await clickBox(1); },
    (d) => d.replace('- [ ] one\n', '- [ ] oneZ\n').replace('- [ ] two\n', '- [x] two\n')]);
  C.push([`editor-dup-neighbour-${sw}`, on, `Intro\n\n- [ ] a\n- [ ] a\n- [ ] a\n\nend\n`, async () => { await editorType('- [ ] a', 'Z'); await clickBox(1); },
    (d) => d.replace('- [ ] a\n- [ ] a\n', '- [ ] aZ\n- [x] a\n')]);
  C.push([`editor-above-dup-lists-${sw}`, on, `- [ ] a\n- [ ] b\n\n- [ ] a\n- [ ] b\n`, async () => { await editorType('- [ ] a', '\n\nnew para'); await clickBox(3); },
    (d) => '- [ ] a\n\nnew para\n- [ ] b\n\n- [ ] a\n- [x] b\n']);
}
// the window: typing in the editor pane, then a click on that task's box after `gap` ms (LARGE: large.md below)
import('node:fs').then(() => {});
for (const on of [false, true]) {
  const sw = on ? 'on' : 'off';
  for (const gap of [60, 150, 300]) {
    C.push([`gap-same-task-${sw}-${gap}`, on, `Intro\n\n${TL5}\nend\n`, async () => { await editorType('- [ ] two', 'Z'); await sleep(gap); await clickBox(1); },
      (d) => d.replace('- [ ] two\n', '- [x] twoZ\n')]);
    C.push([`large-same-task-${sw}-${gap}`, on, `Intro\n\n${TL5}\nend\n\n` + LARGE, async () => { await editorType('- [ ] two', 'Z'); await sleep(gap); await clickBox(1); },
      (d) => d.replace('- [ ] two\n', '- [x] twoZ\n')]);
  }
}
for (const gap of [10, 25, 50]) {
  C.push([`large-rapid3-off-${gap}`, false, `Intro\n\n${TL5}\nend\n\n` + LARGE, async () => { await clickBox(0); await sleep(gap); await clickBox(1); await sleep(gap); await clickBox(2); },
    (d) => tick(d, 'one', 'two', 'three')]);
}
// switch on: a session, then the box clicks
C.push(['esc-then-two-boxes', true, `Intro\n\n${TL5}\nend\n`, async () => {
  await clickText(page, 'one', 1, { side: 'right' }); await waitSession(page); await sleep(80); await caretTo(page, 'one', 'after'); await sleep(80);
  await page.keyboard.type('X'); await page.keyboard.press('Escape'); await clickBox(1); await sleep(30); await clickBox(2);
}, (d) => tick(d.replace('- [ ] one\n', '- [ ] oneX\n'), 'two', 'three')]);
const GIANT = 'Intro\n\n' + Array.from({ length: 100 }, (_, i) => `- [ ] task${i} $a_{${i}}$ $b^{${i}}$ $c_${i}$ $\\frac{${i}}{2}$`).join('\n') + '\n\nend\n';
for (const gap of [100, 250]) {
  C.push([`giant-esc-two-boxes-${gap}`, true, GIANT, async () => {
    await clickText(page, 'task1 ', 2, { side: 'right' }); await waitSession(page, 4000); await sleep(150); await caretTo(page, 'task1', 'after'); await sleep(80);
    await page.keyboard.type('X'); await page.keyboard.press('Escape'); await clickBox(3); await sleep(gap); await clickBox(4);
  }, (d) => d.replace('- [ ] task1 ', '- [ ] task1X ').replace('- [ ] task3 ', '- [x] task3 ').replace('- [ ] task4 ', '- [x] task4 ')]);
}
for (const on of [false, true]) {
  for (const gap of [150, 200, 250, 300, 500]) {
    C.push([`giant-rapid3-${on ? 'on' : 'off'}-${gap}`, on, GIANT, async () => { await clickBox(3); await sleep(gap); await clickBox(4); await sleep(gap); await clickBox(5); },
      (d) => d.replace('- [ ] task3 ', '- [x] task3 ').replace('- [ ] task4 ', '- [x] task4 ').replace('- [ ] task5 ', '- [x] task5 ')]);
  }
}
C.push(['esc-hardbreak-own-box', true, `Intro\n\n${TL5}\nend\n`, async () => {
  await clickText(page, 'one', 1, { side: 'right' }); await waitSession(page); await sleep(80); await caretTo(page, 'one', 'after'); await sleep(80);
  await page.keyboard.type('X'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('cont'); await page.keyboard.press('Escape'); await clickBox(0);
}, (d) => (s) => /^Intro\n\n- \[x\] oneX( {2}|\\)\n {2}cont\n- \[ \] two\n/.test(s)]);
C.push(['esc-doublespace-own-box', true, `Intro\n\n${TL5}\nend\n`, async () => {
  await clickText(page, 'one', 1, { side: 'right' }); await waitSession(page); await sleep(80); await caretTo(page, 'one', 'after'); await sleep(80);
  await page.keyboard.type(' x'); await page.keyboard.press('Escape'); await clickBox(0);
}, (d) => tick(d.replace('- [ ] one\n', '- [ ] one x\n'), 'one x')]);
C.push(['esc-math-own-box', true, `Intro\n\n- [ ] one $x^2$\n- [ ] two\n\nend\n`, async () => {
  await clickText(page, 'one', 1, { side: 'right' }); await waitSession(page); await sleep(80); await caretTo(page, 'one', 'after'); await sleep(80);
  await page.keyboard.type('Q'); await page.keyboard.press('Escape'); await clickBox(0);
}, (d) => d.replace('- [ ] one $x^2$', '- [x] oneQ $x^2$')]);

let bad = 0;
try {
  await B.boot('mode=split' + (process.env.MDR_PERF ? '&perf=1' : ''));
  let cur = null;
  const forceOff = process.env.MDR_OFF === '1';
  for (const [name, on0, doc, steps, want] of C) {
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    const on = forceOff ? false : on0;
    if (cur !== on && !process.env.MDR_PERF) { await setSwitch(on); cur = on; }
    for (let run = 0; run < Number(process.env.RUNS ?? 1); run++) {
      const nm = `${name}${run ? '#' + run : ''}`;
      try {
        if (process.env.MDR_PERF) { await page.evaluate(() => window.__mdr.app.preview.endEditSession?.()); await page.evaluate((t) => window.__mdr.loadText(t, 'v.md'), doc); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(500); }
        else await load(B, doc);
        await toastsInstall();
        await steps();
        await settle(1200);
        const v = await view(page);
        const ts = await toasts();
        if (process.env.CHB_TRACE) console.log('clicks', JSON.stringify(await page.evaluate(() => window.__chbClicks)));
        let exp = want(doc);
        const ok = typeof exp === 'function' ? exp(v.src) : v.src === exp;
        if (!check(nm, ok, `observed=${J(v.src)} expected=${typeof exp === 'function' ? '(regex)' : J(exp)} toasts=${J(ts)}`)) bad++;
        // Cmd-Z back to the original, byte for byte (the editor pane holds the history)
        await page.keyboard.press('Escape');
        for (let k = 0; k < 8 && (await B.source()) !== doc; k++) {
          await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); });
          await page.keyboard.press('Meta+z'); await sleep(120);
        }
        const back = await B.source();
        if (!check(nm + ':undo', back === doc, `after undo=${J(back)}`)) bad++;
      } catch (err) { check(nm, false, 'error ' + (err && err.message)); bad++; }
    }
  }
} finally {
  summary();
  clearTimeout(stop);
  await B.close();
}
process.exit(bad ? 1 : 0);
