// bench/verify/v4-sesb-clickwait.mjs — verify-session-b: U19's `lost` marking makes a click on a block whose session
// just ended wait for that block's re-render (a click resume bounded by CLICK_WAIT_MS = 300 ms; keys typed meanwhile
// are queued). When the re-render takes longer, the resume expires and cancelResume() drops the queued keys. Cases:
// click into A, (type), Esc or a click elsewhere, click back into A at once, type "QRS" at once. The worker's HTML
// answers are delayed by MDR_DELAY ms (default 400; 0 = natural timing). --large puts the paragraphs in the middle of
// test-data/large.md (natural timing of a big document).
// Run (candidate server up on MDR_PORT, default 5432, else started): node bench/verify/v4-sesb-clickwait.mjs [filter] [--large]
import { readFileSync } from 'node:fs';
import { sleep, globalTimeout, J, check, summary, openAt, prepare, requireServer, view, pointOf, results } from './v4-sesb-lib.mjs';

const argv = process.argv.slice(2);
const LARGE = argv.includes('--large');
const filter = argv.find((a) => !a.startsWith('--')) || '';
const CP = Number(process.env.MDR_PORT || 5432);
const DELAY = Number(process.env.MDR_DELAY ?? (LARGE ? 0 : 400));
await requireServer(CP);
const REGION = 'Alpha para words here.\n\nBeta para words here.\n\nGamma para words here.\n';
let prefix = '', suffix = '';
if (LARGE) {
  const lines = readFileSync(new URL('../../test-data/large.md', import.meta.url), 'utf8').split('\n');
  let cut = Math.floor(lines.length / 2);
  while (!(lines[cut] === '' && lines[cut - 1] !== '' && !/^\s|^[>|$`~-]|^\d/.test(lines[cut - 1]) && lines[cut + 1] !== '' && !/^\s|^[>|$`~-]|^\d/.test(lines[cut + 1]))) cut++;
  prefix = lines.slice(0, cut + 1).join('\n') + '\n';
  suffix = '\n' + lines.slice(cut + 1).join('\n');
}
const DOC = prefix + REGION + suffix;
async function slowHtml(page, ms) {
  await page.evaluate((ms) => {
    const pv = window.__mdr.app.preview;
    if (!window.__origHtml) { window.__origHtml = pv.applyHtml.bind(pv); pv.applyHtml = (m) => { if (window.__delayHtml) setTimeout(() => window.__origHtml(m), window.__delayHtml); else window.__origHtml(m); }; }
    window.__delayHtml = ms;
  }, ms);
}
const C = [
  ['esc-then-click-same', [['click', 'Beta', 2], ['key', 'Escape'], ['click', 'Beta', 6]], 'Beta pQRSara words here.'],
  ['typed-esc-then-click-same', [['click', 'Beta', 2], ['type', 'Z'], ['wait', 60], ['key', 'Escape'], ['click', 'BeZta', 7]], 'BeZta pQRSara words here.'],
  ['click-other-then-back', [['click', 'Beta', 2], ['click', 'Gamma', 2], ['click', 'Beta', 6]], 'Beta pQRSara words here.'],
  ['typed-click-other-then-back', [['click', 'Beta', 2], ['type', 'Z'], ['wait', 60], ['click', 'Gamma', 2], ['click', 'BeZta', 7]], 'BeZta pQRSara words here.'],
  ['typed-click-other-type', [['click', 'Beta', 2], ['type', 'Z'], ['click', 'Gamma', 2]], 'GaQRSmma para words here.'],
];
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  const { page } = A;
  for (const [name, steps, wantLine] of C) {
    for (let run = 1; run <= Number(process.env.RUNS || 1); run++) {
      const cname = `${name}${LARGE ? '-large' : ''}-d${DELAY}${process.env.RUNS ? '#' + run : ''}`;
      if (filter && !new RegExp(filter).test(cname)) continue;
      try {
        await slowHtml(page, 0);
        await prepare(A, DOC);
        if (LARGE) {
          const line = prefix.split('\n').length;
          await page.evaluate((l) => window.__mdr.app.preview.scrollToLine(l, 0, 'instant'), line);
          await sleep(1500);
          const p0 = await pointOf(page, 'Alpha para', 1); await page.mouse.click(p0.x, p0.y); await sleep(500);
          await page.keyboard.press('Escape'); await sleep(800);
        }
        await slowHtml(page, DELAY);
        for (const [op, a, b] of steps) {
          if (op === 'click') { const p = await pointOf(page, a, b); if (!p) throw new Error('not shown ' + a); await page.mouse.click(p.x, p.y); }
          else if (op === 'type') await page.keyboard.type(a);
          else if (op === 'key') await page.keyboard.press(a);
          else if (op === 'wait') await sleep(a);
        }
        await page.keyboard.type('QRS');
        await sleep(DELAY * 2 + 800);
        await slowHtml(page, 0);
        await page.keyboard.press('Escape'); await A.settle(300);
        const src = await A.source();
        const region = src.slice(prefix.length, src.length - suffix.length);
        const ok = region.split('\n').includes(wantLine) && src.startsWith(prefix) && src.endsWith(suffix);
        check(cname, ok, `region=${J(region)} want line ${J(wantLine)}`);
      } catch (e) { check(cname, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
    }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
