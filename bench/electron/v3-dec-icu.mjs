// bench/electron/v3-dec-icu.mjs — verify-decoder (stage 2c): do the decoders behave the same inside the
// Electron main process (its own ICU) as in the Node that runs the unit tests and the v3-dec differential?
// Compares, Node vs Electron main: (1) every 1- and 2-byte decode of the five legacy labels (via the
// tables fileIO builds, WHATWG and 0.1.0 variants), (2) decodeBuffer (overrides on / off), the 0.1.0
// fixture and saveTableOf on a seeded sample of the v3-dec corpus.
//   MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex node bench/electron/v3-dec-icu.mjs
// Launch through the wrapper (isolated profile); no window interaction; global timeout 100 s.
import { electron } from './_electron.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as neu from '../../electron/fileIO.mjs';
import * as old from '../../test/fixtures/fileIO-0.1.0.mjs';
import * as C from '../verify/v3-dec-corpus.mjs';

const APP_DIR = process.env.MDR_APP_DIR;
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app = null;
const timer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await close(); process.exit(2); }, 100_000);
async function close() {
  if (!app) return;
  const pid = app.process()?.pid;
  try { await Promise.race([app.evaluate(({ app: a }) => a.exit(0)), sleep(3000)]); } catch { /* gone */ }
  await Promise.race([app.close().catch(() => {}), sleep(4000)]);
  if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  app = null;
}
function summarize(N, O, bufs) {
  const tables = {};
  for (const l of ['gbk', 'big5', 'shift_jis', 'euc-kr', 'windows-1252']) {
    for (const w of [true, false]) {
      const t = N.legacyEncoderTable(l, w);
      let h = 0;
      for (const [k, v] of t) { h = (Math.imul(h, 31) + k.charCodeAt(0) * 65599 + v.reduce((a, b) => a * 257 + b, 0)) >>> 0; }
      tables[`${l} ${w}`] = `${t.size}:${h}`;
    }
  }
  const res = bufs.map((hex) => {
    const b = Buffer.from(hex, 'hex');
    const one = (f) => { try { const d = f(); return `${d.encoding}|${d.bom}|${d.replaced || 0}|${d.text.length}|${[...d.text].reduce((a, c) => (Math.imul(a, 31) + c.codePointAt(0)) >>> 0, 0)}`; } catch (e) { return 'THROW'; } };
    const on = one(() => N.decodeBuffer(b));
    const off = one(() => N.decodeBuffer(b, false));
    const fx = one(() => O.decodeBuffer(b));
    let tab = '';
    try { const d = N.decodeBuffer(b); tab = String(d.replaced ? '' : N.saveTableOf(d.text, d.encoding, b)); } catch { tab = 'THROW'; }
    return [on, off, fx, tab].join(' / ');
  });
  return { tables, res };
}
try {
  // corpus sample: built here, decoded on both sides
  const bufs = [];
  const gens = [C.zhMarkdown, C.zhSheet, C.hantText, C.jaMixed, C.jaHalfwidth, (r) => C.koText(r, 0.5), (r) => C.sbText(r, C.LATIN_MD), C.zhLog];
  const labels = ['GBK', 'CP950', 'CP932', 'CP949', 'CP1252', 'UTF-8', 'CP1251', 'CP874'];
  const r = C.rng(31337);
  for (let i = 0; i < 1600; i++) {
    const t = C.pick(r, gens)(r);
    const l = C.pick(r, labels);
    let b = l === 'UTF-8' ? Buffer.from(t, 'utf8') : C.iconvEncode(t, l);
    if (!b) continue;
    if (r() < 0.3) b = b.subarray(0, C.int(r, 1, b.length));
    if (r() < 0.1) b = Buffer.concat([b, Buffer.from([C.int(r, 0x80, 0xff)])]);
    bufs.push(b.toString('hex'));
  }
  for (let x = 0; x < 256; x++) bufs.push(Buffer.from([x]).toString('hex'), Buffer.from([0x41, x, 0x0a]).toString('hex'));
  const local = summarize(neu, old, bufs);
  app = await electron.launch({ args: [APP_DIR], timeout: 30000 });
  await app.firstWindow();
  const fileUrl = pathToFileURL(path.resolve('electron/fileIO.mjs')).href;
  const fixUrl = pathToFileURL(path.resolve('test/fixtures/fileIO-0.1.0.mjs')).href;
  const remote = await app.evaluate(async (_e, { fileUrl, fixUrl, bufs, src }) => {
    // no dynamic import in evaluate: require(esm) through createRequire (both files are synchronous ESM)
    const { createRequire } = process.getBuiltinModule('node:module');
    const req = createRequire(fileUrl);
    const N = req(new URL(fileUrl).pathname);
    const O = req(new URL(fixUrl).pathname);
    // eslint-disable-next-line no-new-func
    const summarize = new Function('return ' + src)();
    return { versions: process.versions.icu + ' node ' + process.versions.node, ...summarize(N, O, bufs) };
  }, { fileUrl, fixUrl, bufs, src: summarize.toString() });
  const tableDiff = Object.keys(local.tables).filter((k) => local.tables[k] !== remote.tables[k]).map((k) => `${k}: node ${local.tables[k]} electron ${remote.tables[k]}`);
  const resDiff = [];
  local.res.forEach((x, i) => { if (x !== remote.res[i]) resDiff.push({ hex: bufs[i].slice(0, 60), node: x, electron: remote.res[i] }); });
  console.log(JSON.stringify({ node: process.versions.icu + ' node ' + process.versions.node, electron: remote.versions, inputs: bufs.length, tableDiff, resDiffCount: resDiff.length, resDiff: resDiff.slice(0, 10) }, null, 1));
} catch (e) {
  console.log('ERROR', String(e && e.stack || e).slice(0, 600));
} finally {
  clearTimeout(timer);
  await close();
}
