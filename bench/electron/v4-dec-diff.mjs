// bench/electron/v4-dec-diff.mjs — verify-decoder (0.2.0 stage 2d): the v4 decoder differential INSIDE
// the Electron main process of a real app launch (wrapper, isolated profile), i.e. with the ICU the
// shipped app decodes with. Same checks as bench/verify/v4-dec-diff.mjs (bench/verify/v4-dec-check.mjs):
//   MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex SEEDS=300 BIG=1 \
//     SCRATCH=<scratch dir> node bench/electron/v4-dec-diff.mjs > out.json
// N = <MDR_APP_DIR>/electron/fileIO.mjs, O = test/fixtures/fileIO-0.1.0.mjs, D = a copy of N whose
// dormant override helpers throw. Inputs are generated in the system Node (iconv) and handed to the main
// process through one bundle file in the scratch dir. Prints one JSON summary; exit 0 = no failure.
// Global timeout 9 min (run it in the background); every app.evaluate batch is bounded to 90 s.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCorpus } from '../verify/v4-dec-corpus.mjs';
import { writeDormant } from '../verify/v4-dec-diff.mjs';

const APP_DIR = process.env.MDR_APP_DIR;
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const SEEDS = Number(process.env.SEEDS || 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.SCRATCH || os.tmpdir(), 'v4dec-e-')));
let app = null;
async function close() {
  if (!app) return;
  const pid = app.process()?.pid;
  try { await Promise.race([app.evaluate(({ app: a }) => a.exit(0)), sleep(3000)]); } catch { /* gone */ }
  await Promise.race([app.close().catch(() => {}), sleep(4000)]);
  if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  app = null;
}
const timer = setTimeout(async () => { console.log(JSON.stringify({ error: 'GLOBAL TIMEOUT' })); await close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(2); }, 9 * 60_000);
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`timeout ${what}`); })]);
let code = 1;
try {
  // inputs -> bundle
  const idx = [];
  const parts = [];
  let off = 0;
  for (let s = 1; s <= SEEDS; s++) {
    for (const it of buildCorpus(s, { big: process.env.BIG === '1' && s === 1 })) {
      idx.push({ name: it.name, fam: it.fam, off, len: it.buf.length });
      parts.push(it.buf);
      off += it.buf.length;
    }
  }
  const bundle = path.join(tmp, 'bundle.bin');
  fs.writeFileSync(bundle, Buffer.concat(parts));
  const tree = path.join(APP_DIR, 'electron', 'fileIO.mjs');
  const dormant = writeDormant(tree, tmp);
  app = await electron.launch({ args: [APP_DIR], timeout: 30000 });
  await app.firstWindow();
  const urls = {
    neu: pathToFileURL(tree).href,
    old: pathToFileURL(path.resolve('test/fixtures/fileIO-0.1.0.mjs')).href,
    dor: pathToFileURL(dormant).href,
    chk: pathToFileURL(path.resolve('bench/verify/v4-dec-check.mjs')).href,
    bundle,
  };
  const rt = await app.evaluate((_e, u) => {
    const { createRequire } = process.getBuiltinModule('node:module');
    const fsm = process.getBuiltinModule('node:fs');
    const req = createRequire(u.chk);
    const p = (x) => new URL(x).pathname;
    globalThis.__v4 = { C: req(p(u.chk)).makeChecker(req(p(u.neu)), req(p(u.old)), req(p(u.dor))), data: fsm.readFileSync(u.bundle) };
    return `electron ${process.versions.electron} node ${process.version} icu ${process.versions.icu} type ${process.type}`;
  }, urls);
  const t0 = Date.now();
  const tables = await withTimeout(app.evaluate(() => globalThis.__v4.C.tables()), 90_000, 'tables');
  const FILES_EVERY = Number(process.env.FILES_EVERY || 25);
  const BATCH = 1500;
  for (let i = 0; i < idx.length; i += BATCH) {
    const batch = idx.slice(i, i + BATCH).map((x, k) => ({ ...x, file: (i + k + 1) % FILES_EVERY === 0 || x.fam === 'size' }));
    await withTimeout(app.evaluate(async (_e, { batch, dir }) => {
      const g = globalThis.__v4;
      for (const x of batch) {
        const b = g.data.subarray(x.off, x.off + x.len);
        g.C.check(b, x.name);
        if (x.file) await g.C.checkFile(b, x.name, dir);
      }
    }, { batch, dir: tmp }), 90_000, `batch ${i}`);
  }
  const S = await app.evaluate(() => globalThis.__v4.C.summary());
  const bad = S.readDiff + S.dormantReached + S.saveWorse + S.saveSameCountDiff + S.newRefusal + S.fileFail;
  code = bad ? 1 : 0;
  console.log(JSON.stringify({ runtime: rt, appDir: APP_DIR, seeds: SEEDS, ms: Date.now() - t0, verdict: bad ? 'FAIL' : 'OK', tables, ...S }, null, 1));
} catch (e) {
  console.log(JSON.stringify({ error: String(e && e.stack || e).slice(0, 800) }));
} finally {
  clearTimeout(timer);
  await close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}
