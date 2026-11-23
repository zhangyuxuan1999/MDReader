// bench/electron/v3-dec-diff-electron.mjs — the v3-dec decoder differential run INSIDE the Electron main
// process, i.e. with the TextDecoder (Chromium ICU) the shipped app and the candidate really use. The
// system Node that runs vitest decodes gbk / big5 / shift_jis / euc-kr differently (v3-dec-icu.mjs).
//   MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex SEEDS=400 \
//     node bench/electron/v3-dec-diff-electron.mjs > out.json
// Candidate = <MDR_APP_DIR>/electron/fileIO.mjs, reference = test/fixtures/fileIO-0.1.0.mjs, both loaded
// in the same main process. MDR_NOSHAPE=<copy of fileIO.mjs without the language-shape rule> adds the
// gain column. Inputs are built here (iconv) and truth is re-checked with Electron's own decoder.
// Wrapper launch (isolated profile); global timeout 9 min; run it in the background.
import { electron } from './_electron.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildInputs } from '../verify/v3-dec-inputs.mjs';
import { buildInputs2 } from '../verify/v3-dec-inputs2.mjs';

const APP_DIR = process.env.MDR_APP_DIR;
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const SEEDS = Number(process.env.SEEDS || 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app = null;
const t0 = Date.now();
const timer = setTimeout(async () => { console.log(JSON.stringify({ error: 'GLOBAL TIMEOUT' })); await close(); process.exit(2); }, 9 * 60_000);
async function close() {
  if (!app) return;
  const pid = app.process()?.pid;
  try { await Promise.race([app.evaluate(({ app: a }) => a.exit(0)), sleep(3000)]); } catch { /* gone */ }
  await Promise.race([app.close().catch(() => {}), sleep(4000)]);
  if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  app = null;
}
try {
  // INPUTS=2: the second set (bench/verify/v3-dec-inputs2.mjs)
  const list = (process.env.INPUTS === '2' ? buildInputs2 : buildInputs)(SEEDS, process.env.FILTER || '');
  app = await electron.launch({ args: [APP_DIR], timeout: 30000 });
  await app.firstWindow();
  const urls = {
    neu: pathToFileURL(path.join(APP_DIR, 'electron', 'fileIO.mjs')).href,
    old: pathToFileURL(path.resolve('test/fixtures/fileIO-0.1.0.mjs')).href,
    chk: pathToFileURL(path.resolve('bench/verify/v3-dec-check.mjs')).href,
    noshape: process.env.MDR_NOSHAPE ? pathToFileURL(process.env.MDR_NOSHAPE).href : null,
  };
  await app.evaluate((_e, u) => {
    const { createRequire } = process.getBuiltinModule('node:module');
    const req = createRequire(u.chk);
    const p = (x) => new URL(x).pathname;
    const N = req(p(u.neu));
    const O = req(p(u.old));
    const S = u.noshape ? req(p(u.noshape)) : null;
    globalThis.__v3 = { chk: req(p(u.chk)).makeChecker(N, O, S), notGenuine: {}, n: 0 };
  }, urls);
  for (let i = 0; i < list.length; i += 2500) {
    const batch = list.slice(i, i + 2500);
    await app.evaluate((_e, batch) => {
      const g = globalThis.__v3;
      for (const x of batch) {
        const b = Buffer.from(x.hex, 'hex');
        let truth = x.truth;
        if (!truth.startsWith(String.fromCharCode(0))) {
          let et = null;
          try { et = new TextDecoder(x.label, { fatal: true }).decode(b); } catch { et = null; }
          if (et !== truth) { g.notGenuine[x.fam] = (g.notGenuine[x.fam] || 0) + 1; truth = String.fromCharCode(0) + 'not genuine in this runtime'; }
        }
        g.chk.check(x.fam, b, truth, x.label, x.bom);
        g.n++;
      }
    }, batch);
  }
  const res = await app.evaluate(() => {
    const g = globalThis.__v3;
    return { n: g.n, notGenuine: g.notGenuine, stats: g.chk.stats, gains: g.chk.gains, examples: g.chk.examples, icu: process.versions.icu, node: process.versions.node };
  });
  console.log(JSON.stringify({ appDir: APP_DIR, seeds: SEEDS, inputs: list.length, ms: Date.now() - t0, ...res }, null, 1));
} catch (e) {
  console.log(JSON.stringify({ error: String(e && e.stack || e).slice(0, 800) }));
} finally {
  clearTimeout(timer);
  await close();
}
