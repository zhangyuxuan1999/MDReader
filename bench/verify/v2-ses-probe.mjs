// bench/verify/v2-ses-probe.mjs — verify-session: exploratory scenarios against inlineEdit.ts in real Chromium.
// Run: MDR_PORT=5282 node bench/verify/v2-ses-probe.mjs <scenario> [...]   (prints source + session state)
import { openB, sleep, globalTimeout, J, readRoot } from './v2-ses-lib.mjs';

const B = await openB();
const stop = globalTimeout(100_000, B.close);
const { page } = B;
const mod = 'Meta';
const resumeWatch = () => page.evaluate(() => {
  // samples: when the capture element holds focus (resume) and how long
  window.__resumeLog = [];
  let t0 = 0;
  const cap = () => document.querySelector('.mdr-preview__edit-capture');
  document.addEventListener('focusin', (e) => {
    if (e.target === cap()) t0 = performance.now();
    else if (t0 && e.target.closest?.('.is-editing')) { window.__resumeLog.push(performance.now() - t0); t0 = 0; }
  }, true);
});
const S = {
  async resumeLen(doc, line, needle) {
    await B.loadDoc(doc);
    await resumeWatch();
    await B.clickLine(line, 'first', needle);
    await B.caretAt(needle);
    for (let i = 0; i < 6; i++) { await page.keyboard.type('x' + i); await page.keyboard.press('Enter'); await page.keyboard.type('y'); await sleep(400); }
    await B.settle(300);
    console.log('resume ms', J(await page.evaluate(() => window.__resumeLog.map((x) => Math.round(x)))));
  },
  async small() { await this.resumeLen('aaa bbb\n\nccc\n', 1, 'aaa'); },
  async large() {
    const t = readRoot('test-data/large.md');
    const lines = t.split('\n');
    const n = 54403; console.log('line', lines[n - 1].slice(0, 40));
    await this.resumeLen(t, n, lines[n - 1].slice(0, 4));
  },
  async huge() {
    const t = readRoot('test-data/huge.md');
    const lines = t.split('\n');
    let n = 170003; while (!/^这是一个/.test(lines[n - 1])) n++;
    console.log('line', n, lines[n - 1].slice(0, 20));
    await B.loadDoc(t);
    await resumeWatch();
    await B.clickLine(n, 'first', '这是一个');
    await B.caretAt('这是一个');
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.keyboard.type('Q' + i, { delay: 30 }); await sleep(3500); }
    await B.settle(300);
    console.log('resume ms', J(await page.evaluate(() => window.__resumeLog.map((x) => Math.round(x)))));
    const src = await B.source();
    console.log('typed found', [0, 1, 2, 3].map((i) => src.includes('Q' + i)), 'state', J(await B.state()));
  },
};
try {
  await B.boot('mode=split');
  for (const name of process.argv.slice(2)) {
    console.log(`== ${name}`);
    await S[name]();
  }
  console.log('errors', J(B.pageErrors), J(B.consoleErrors.slice(0, 5)));
} catch (e) { console.log('ERR', e.stack); } finally { stop(); await B.close(); }
