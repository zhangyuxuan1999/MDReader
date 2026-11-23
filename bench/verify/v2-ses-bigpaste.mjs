// bench/verify/v2-ses-bigpaste.mjs — verify-session: a large paste into a session (prose and code).
// Prints how long the paste handler blocks the page, whether the text arrived complete in the source and
// whether the page still answers afterwards. Not a performance measurement for the record: it looks for a
// stuck page. Run (background!): MDR_PORT=5282 node bench/verify/v2-ses-bigpaste.mjs <KB> <prose|code|prose1>
//   prose: lines of 79 chars + '\n' (every line a hard break); prose1: one line, no newline; code: into a fence.
import { openB, sleep, globalTimeout, J } from './v2-ses-lib.mjs';

const KB = Number(process.argv[2] ?? 100);
const where = process.argv[3] ?? 'prose';
const B = await openB();
const stop = globalTimeout(Number(process.env.T ?? 115_000), B.close);
const { page } = B;
try {
  await B.boot('mode=split');
  const doc = where === 'code' ? 'p\n\n```\nlet a;\n```\n\nq\n' : 'abc\n\nq\n';
  await B.loadDoc(doc);
  await B.clickLine(where === 'code' ? 4 : 1, 'first', where === 'code' ? 'let' : 'abc');
  await B.caretAt(where === 'code' ? 'let' : 'abc');
  const line = 'x'.repeat(40) + '中文字'.repeat(13);
  let text = '';
  if (where === 'prose1') text = 'y'.repeat(KB * 1024);
  else { while (text.length < KB * 1024) text += line + '\n'; }
  const t0 = Date.now();
  const blocked = await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const t = performance.now();
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return performance.now() - t;
  }, text);
  console.log(`paste handler blocked ${Math.round(blocked)} ms for ${KB} KB (${text.split('\n').length} lines)`);
  await B.settle(300);
  const src = await B.source();
  const total = Date.now() - t0;
  const lines = text.split('\n').filter(Boolean).length;
  const got = src.split(line).length - 1;
  console.log(`settled after ${total} ms; source ${src.length} chars; pasted lines found ${where === 'prose1' ? (src.match(/y+/)?.[0].length ?? 0) : got}/${where === 'prose1' ? KB * 1024 : lines}`);
  const t1 = Date.now();
  await page.keyboard.type('Z');
  await B.settle(200);
  console.log(`one more key after: ${Date.now() - t1} ms; session ${J((await B.state()).editing)}`);
  const t2 = Date.now();
  await page.keyboard.press('Escape');
  await B.settle(200);
  console.log(`Esc: ${Date.now() - t2} ms`);
  console.log('errors', J(B.pageErrors.slice(0, 2)), J(B.consoleErrors.slice(0, 3)));
} catch (e) { console.log('ERR', e.message.split('\n')[0]); } finally { stop(); await B.close(); }
