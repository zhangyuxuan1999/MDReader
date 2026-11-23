// bench/verify/v7-vf-start.mjs — verify-refs (round 6): does a session start in a block? For each case (a block source
// placed between two plain paragraphs), click the needle and report: SESSION (and, after typing Ж at the needle's end
// and Esc, whether the source is the original plus Ж there: exact / the diff), REFUSED (toast) or NOSESSION.
// Cases: a set of bench/verify/v7-vf-cases.mjs by name (tables, swap, ruleT, b1) or a JSON file [[name, blockSource, needle], ...]. The guard's console lines are counted.
// Run: MDR_PORT=<server with hooks> node bench/verify/v7-vf-start.mjs <set|cases.json> [filter]   (T_MS, default 110000)
import { readFileSync } from 'node:fs';
import { SETS } from './v7-vf-cases.mjs';
import { launch, openApp, load, source, toasts, clickAt, caret, esc, rawAdded, strDiff, show, globalTimeout, sleep } from './v7-vf-lib.mjs';

const port = process.env.MDR_PORT;
if (!port || !process.argv[2]) { console.log('pass MDR_PORT and a cases file'); process.exit(2); }
const filter = new RegExp(process.argv[3] ?? '.');
const CASES = (SETS[process.argv[2]] ?? JSON.parse(readFileSync(process.argv[2], 'utf8'))).filter((c) => filter.test(c[0]));
const T_MS = Number(process.env.T_MS ?? 110000);
let browser;
const stop = globalTimeout(T_MS, async () => browser?.close());
const tally = {};
try {
  browser = await launch();
  const A = await openApp(browser, port, { perf: true });
  for (const [name, block, needle, k = 0] of CASES) {
    A.guard.length = 0;
    const doc = `# Probe\n\nfiller para\n\n${block}\n\nlast para\n`;
    await load(A, doc, 'probe-' + name + '.md');
    const t0 = await toasts(A);
    const started = await clickAt(A, needle, k, 1);
    let verdict, extra = '';
    if (!started) {
      verdict = (await toasts(A)) > t0 ? 'REFUSED' : 'NOSESSION';
      extra = `unchanged=${(await source(A)) === doc}`;
    } else {
      const ok = await caret(A, needle);
      if (ok) await A.page.keyboard.type('Ж');
      await sleep(250);
      await esc(A);
      const out = await source(A);
      const d = strDiff(doc, out);
      const added = rawAdded(doc, out, 'Ж');
      verdict = d.del === '' && d.ins === 'Ж' ? 'SESSION-exact' : 'SESSION-diff';
      extra = `raw+=${added.join(',') || '-'} del=${show(d.del)} ins=${show(d.ins)}`;
      if (added.length) verdict = 'SESSION-REVEAL';
    }
    tally[verdict] = (tally[verdict] ?? 0) + 1;
    console.log(`${verdict.padEnd(14)} ${name}: guard=${A.guard.length} ${extra}`);
  }
  console.log('RESULT ' + JSON.stringify(tally) + ` of ${CASES.length}`);
} finally { stop(); await browser?.close(); }
