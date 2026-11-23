// bench/verify/v4-dec-diff.mjs — verify-decoder (0.2.0 stage 2d): the v4 decoder differential in the
// system Node (bench/electron/v4-dec-diff.mjs runs the same checks inside the Electron main process).
//   SEEDS=200 BIG=1 node bench/verify/v4-dec-diff.mjs  (prints one JSON summary; writes nothing in the tree)
// Env: SEEDS (default 100), BIG=1 adds the size family (0 B .. 3 MiB), TREE=<fileIO.mjs to test>
//      (default electron/fileIO.mjs), FILES_EVERY=<n> (real readFileInfo/writeFileAtomic every n-th
//      input, default 25, temp files under SCRATCH or os.tmpdir()).
// D = a scratch copy of TREE whose dormant override helpers throw: any 'DORMANT' hit proves that the
// default configuration still reaches override code. Global timeout 100 s.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCorpus } from './v4-dec-corpus.mjs';
import { makeChecker } from './v4-dec-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DORMANT_FNS = ['overrideOf', 'otherCjkReading', 'lenientUtf8Reading', 'sampleOf', 'sniffUtf16', 'plausibleShare', 'lenientUtf8', 'measureLegacy', 'charWeight', 'weightTable', 'hardControlShare'];

/** Writes a copy of `src` in which every DORMANT_FNS function throws on entry; returns its path. */
export function writeDormant(src, dir) {
  let s = fs.readFileSync(src, 'utf8');
  for (const fn of DORMANT_FNS) {
    const re = new RegExp(`((?:export )?function ${fn}\\([^)]*\\) \\{)`);
    if (!re.test(s)) throw new Error(`dormant: ${fn} not found`);
    s = s.replace(re, `$1 throw new Error('DORMANT:${fn}');`);
  }
  const out = path.join(dir, `dormant-fileIO-${process.pid}.mjs`);
  fs.writeFileSync(out, s);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const timer = setTimeout(() => { console.log(JSON.stringify({ error: 'GLOBAL TIMEOUT' })); process.exit(2); }, 100_000);
  const SEEDS = Number(process.env.SEEDS || 100);
  const tmp = fs.mkdtempSync(path.join(process.env.SCRATCH || os.tmpdir(), 'v4dec-'));
  try {
    const TREE = path.resolve(process.env.TREE || path.join(ROOT, 'electron/fileIO.mjs'));
    const N = await import(pathToFileURL(TREE).href);
    const O = await import(pathToFileURL(path.join(ROOT, 'test/fixtures/fileIO-0.1.0.mjs')).href);
    const D = await import(pathToFileURL(writeDormant(TREE, tmp)).href);
    const C = makeChecker(N, O, D);
    const every = Number(process.env.FILES_EVERY || 25);
    let k = 0;
    const t0 = Date.now();
    for (let s = 1; s <= SEEDS; s++) {
      for (const it of buildCorpus(s, { big: process.env.BIG === '1' && s === 1 })) {
        C.check(it.buf, it.name);
        if (++k % every === 0 || it.fam === 'size') await C.checkFile(it.buf, it.name, tmp);
      }
    }
    const S = C.summary();
    console.log(JSON.stringify({ runtime: `node ${process.version} icu ${process.versions.icu}`, tree: TREE, ms: Date.now() - t0, tables: C.tables(), ...S }, null, 1));
  } finally {
    clearTimeout(timer);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
