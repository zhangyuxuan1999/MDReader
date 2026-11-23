// bench/verify/r3-ib-dash-probe.mjs — fix-session-b (round 3): what happens in v3-fid-reach u13-softbreak-dash
// ("abc⏎- def", Enter after abc): the session DOM, the source and the editing block, step by step. Prints only.
//   MDR_PORT=5411 node bench/verify/r3-ib-dash-probe.mjs [doc-json]
import { openB, sleep, globalTimeout, J, view, clickText } from './v3-ses-lib.mjs';
const B = await openB();
const stop = globalTimeout(100_000, B.close);
const { page } = B;
try {
  await B.boot('mode=split');
  for (const doc of process.argv[2] ? [JSON.parse(process.argv[2])] : ['abc\n- def\n', 'abc\n\n- def\n', 'abc\n\ndef\n', 'abc\n# def\n']) {
    await B.loadDoc(doc);
    await B.mountLine(1);
    await sleep(650);
    await clickText(page, 'abc', 2, { side: 'right' });
    await sleep(200);
    await B.caretAt('abc', 'after');
    const dom0 = (await view(page)).editing?.html;
    await page.keyboard.press('Enter');
    const dom1 = (await view(page)).editing?.html;
    await sleep(500); await B.settle(200);
    const v = await view(page);
    await page.keyboard.press('Escape'); await B.settle(300);
    const after = await B.source();
    console.log(J(doc), '\n  before', J(dom0), '\n  enter ', J(dom1), '\n  500ms ', J(v.editing?.html), 'src', J(v.src), '\n  esc   ', J(after));
  }
} finally { stop(); await B.close(); }
