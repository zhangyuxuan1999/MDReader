// bench/verify/v3-rev-ghost.mjs — verify-review (stage 2c, 0.2.0): the emptied-block placeholder (U9 ghost) and the
// fix step's createPreview.unkeepReusedId() / held() when the worker is slower than the user.
// unkeepReusedId acts only while inline.keepsRemoved(editId) holds (a live session whose block is `gone`) and no
// ghost exists yet. If the user types into the emptied wrapper BEFORE the deletion's structure arrives, reinsert()
// writes the new block and the session is torn down (resume pending, release deferred), so keepsRemoved is false
// when the deletion's structure lands: no ghost is made, and in the U14 case (first block with a leading blank
// line) the next block inherits the session's id while the module still holds that id's HTML (held(editId)).
// Cases: <name>[-slow]  (slow = structure deltas and HTML delayed 400 ms, as v2-rev-browser.mjs race did)
//   u14   document "\nabc def\n\nsecond para\n": empty the first block, type "N", then "MORE"
//   mid   document "first para\n\nabc def\n\nsecond para\n": the same on the middle block
// Expected for every case: the source holds the typed text where the block was and the rest unchanged, a session
// is live on the new block, nothing typed is lost.
// Run from the project root:  MDR_PORT=5387 node bench/verify/v3-rev-ghost.mjs [case …]   (default: all four)
// Starts its own Vite on MDR_PORT and kills only that port at exit. Global timeout 100 s.
import { startServer, stopServer, openBrowser, check, note, sleep, results } from './inline-verify-lib.mjs';

const want = new Set(process.argv.slice(2));
const ALL = ['u14', 'u14-slow', 'mid', 'mid-slow'];
const cases = want.size ? ALL.filter((c) => want.has(c)) : ALL;
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); stopServer(); process.exit(3); }, 100_000);
await startServer();
const B = await openBrowser();
const { page } = B;
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const slow = (on) => page.evaluate((on) => {
  const pv = window.__mdr.app.preview;
  if (!window.__origDelta) {
    window.__origDelta = pv.applyStructureDelta.bind(pv);
    window.__origHtml = pv.applyHtml.bind(pv);
    pv.applyStructureDelta = (m) => { if (window.__delay) { setTimeout(() => window.__origDelta(m), 400); return true; } return window.__origDelta(m); };
    pv.applyHtml = (m) => { if (window.__delay) setTimeout(() => window.__origHtml(m), 400); else window.__origHtml(m); };
  }
  window.__delay = on;
}, on);

try {
  await B.boot('mode=split');
  for (const c of cases) {
    const [kind, speed] = c.split('-');
    const doc = kind === 'u14' ? '\nabc def\n\nsecond para\n' : 'first para\n\nabc def\n\nsecond para\n';
    const line = kind === 'u14' ? 2 : 3;
    const want = kind === 'u14' ? '\nNMORE\n\nsecond para\n' : 'first para\n\nNMORE\n\nsecond para\n';
    await slow(false);
    await B.loadDoc(doc, `${c}.md`);
    await B.clickLine(line, 'first', 'abc');
    if (speed === 'slow') await slow(true);
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.press('Backspace');
    await sleep(80);                               // the frame writes the deletion (its structure: 400 ms late when slow)
    await page.keyboard.type('N');
    await sleep(80);                               // the frame writes the new block (reinsert) and the resume waits
    await page.keyboard.type('MORE');
    await sleep(1000);
    await slow(false);
    await sleep(3500);                             // longer than RESUME_MS: a resume that never starts has given up
    await page.evaluate(() => window.__mdr.waitIdle());
    const src = await B.source();
    const ed = await B.editing();
    const shown = await page.evaluate(() => document.querySelector('.mdr-preview__body')?.innerText.trim());
    note(`${c}: source / session / preview`, `${JSON.stringify(src)} / ${JSON.stringify(ed)} / ${JSON.stringify(shown)}`);
    check(`${c}: the source holds exactly what was typed where the block was`, src === want, JSON.stringify(src));
    check(`${c}: the session continues on the new block`, ed !== null && /NMORE/.test(ed.text ?? ''), JSON.stringify(ed));
    await page.keyboard.press('Escape');
    await sleep(300);
  }
} catch (err) {
  console.log('ERROR', err && err.stack ? err.stack : err);
  results.fail++;
} finally {
  clearTimeout(killer);
  await B.browser.close().catch(() => {});
  stopServer();
  console.log(`RESULT ${results.pass} passed, ${results.fail} failed`);
  process.exit(results.fail ? 1 : 0);
}
