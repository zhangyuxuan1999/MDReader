// bench/electron/v3-shell-dropeditor.mjs — verify-shell (0.2.0 stage 2c): a Markdown FILE dropped (CDP
// Input.dispatchDragEvent, the browser's real drag path) onto the EDITOR pane of a clean document.
// Prints the title, the editor text and the sends, per build. Expected (0.1.1): the dropped file opens
// (or nothing changes); the current document must not become dirty / gain text the user did not type.
//   MDR_TARGET=staging|baseline MDR_V2_TMP=<scratch> node bench/electron/v3-shell-dropeditor.mjs [same|other]
import * as L from './v2-shell-lib.mjs';

const { sleep, check } = L;
L.watchdog(Number(process.env.MDR_TIMEOUT_MS || 120000), 'v3-dropeditor');
const MODE = process.argv[2] || 'other';
const ctx = await L.launch('dropeditor');
const { app } = ctx;
try {
  const page = await L.firstReady(app);
  const base = L.makeDoc('dropeditor-base');
  await L.emitOpen(app, base.file);
  await L.mainShows(app, base);
  await sleep(500);
  const dropped = MODE === 'same' ? base : L.makeDoc('dropeditor-dropped');
  const cdp = await page.context().newCDPSession(page);
  const pt = await page.evaluate(() => { const r = document.querySelector('.cm-content').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 10 }; });
  const data = { items: [], files: [dropped.file], dragOperationsMask: 1 | 2 | 16 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: pt.x, y: pt.y, data });
  await sleep(2500);
  const s = await L.mainSnap(app);
  const n = (await L.openSends(app, dropped.file)).length;
  console.log(`  after drop (${MODE}): ${L.describe(s)} sends=${n}`);
  console.log(`  editor text: ${JSON.stringify(s.editor)}`);
  const clean = !(s.title || '').startsWith('●');
  const shows = s.editor === `# ${dropped.h1}${dropped.marker}`.replace(/\n/g, '') || (s.editor || '').includes(dropped.marker);
  if (process.env.V3_ANSWER && (s.buttons || []).includes(process.env.V3_ANSWER)) {
    await L.clickBtn(app, process.env.V3_ANSWER);
    await sleep(1500);
    const a = await L.mainSnap(app);
    console.log(`  after answering ${process.env.V3_ANSWER}: ${L.describe(a)} editor=${JSON.stringify(a.editor)}`);
  }
  check(`[dropeditor ${MODE}] the document is not dirtied by the drop and shows the dropped file`, clean && shows && !(s.editor || '').includes(base.marker + dropped.marker), `title=${JSON.stringify(s.title)}`);
} catch (e) {
  check('threw', false, String(e && e.stack || e).slice(0, 300));
} finally {
  await L.hardQuit(ctx);
  const f = L.summary();
  await L.cleanup();
  process.exit(f ? 1 : 0);
}
