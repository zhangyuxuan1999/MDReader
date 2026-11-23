// bench/electron/r3-d-parity.mjs — fix-decoder (0.2.0 stage 2d, H28 / S4 (f)): proves, in the runtime
// that ships, that with DECODER_OVERRIDES off the tree's electron/fileIO.mjs reads every input exactly
// as the frozen 0.1.0 decoder (test/fixtures/fileIO-0.1.0.mjs) does, and that a save never changes more
// bytes of the original than 0.1.0's save does (S4 (e) as amended, H23).
//
// The same checks run twice, on the same bytes: in the system Node (the one vitest uses) and inside
// Electron's own runtime — the project's Electron binary in plain Node mode (ELECTRON_RUN_AS_NODE=1):
// no window, no profile, no app is started, so the _electron.mjs wrapper rule does not apply. Electron's
// ICU decodes legacy encodings differently from the system Node's (bench/electron/v3-dec-icu.mjs).
//
//   R3D_DIR=<scratch dir> nohup node bench/electron/r3-d-parity.mjs > parity.log 2>&1 &
//
// Env: R3D_DIR   work directory (inputs, chunk results, temp files); default a fresh dir under
//                os.tmpdir(); removed at the end unless R3D_KEEP=1
//      RUNTIMES  node,electron (default both)
//      SEEDS     seeds for the v3-dec input builders (default 200, as bench/verify/v3-dec-diff.mjs)
//      R3D_TREE  harness self-test only: check another copy of fileIO.mjs instead of the tree's
//                (R3D_ALLOW_ON=1 also accepts one whose DECODER_OVERRIDES is true)
// Inputs (seeded, deterministic, generated once in the system Node and fed to both runtimes):
//   diff …     every corpus of test/electron.fileIO.differential.test.ts (its families (a)–(k), the
//              v2-dec-corpus generators among them), dumped by that test with R3D_DUMP
//   v3 … v3-2… bench/verify/v3-dec-inputs.mjs buildInputs(SEEDS), v3-dec-inputs2.mjs buildInputs2(SEEDS)
//   variants   every buffer bench/verify/v3-dec-variants.mjs decodes (captured from a copy in R3D_DIR)
//   probe …    v3-dec-icu.mjs's corpus sample, every 1- and 2-byte buffer (bare and as "# xx\n"),
//              4 000 seeded random 4-byte sequences
// Per input: (read) decodeBuffer(buf) — the default — equals the fixture (text, label, BOM flag; a
// throw equals a throw with the same message); (save) for the unmodified text, the text + "x", the
// renderer's LF-only text and that + "x": the bytes encodeText writes with the meta readFileInfo stores
// (saveTableOf included) against the fixture's encodeText: same bytes, or FEWER bytes of the original
// changed (allowed, counted, listed); more changed, or as many but different bytes, is a failure.
// (typed) the text + characters a user may type (for Big5 also a character only 0.1.0's table has, the
// HKSCS rows): the tree must not refuse a save the fixture makes; different bytes for the typed
// characters (WHATWG vs 0.1.0 spelling) are counted, not failed.
// Every 40th input also goes through the real readFileInfo / writeFileAtomic of both (temp files).
// Every child process (generation, each chunk, each runtime) is bounded to 100 s. Global timeout 20 min.
// Exit 0 when both runtimes show 0 reading differences and 0 failing saves.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TREE = process.env.R3D_TREE ? path.resolve(process.env.R3D_TREE) : path.join(ROOT, 'electron/fileIO.mjs');
const FIXTURE = path.join(ROOT, 'test/fixtures/fileIO-0.1.0.mjs');
const ELECTRON = path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const CHILD_MS = 100_000;
const CHUNK_INPUTS = 6000;
const CHUNK_BYTES = 8 << 20;
const SELF = fileURLToPath(import.meta.url);
/** Child processes of the driver (killed on the global timeout and at the end). */
const running = new Set();


// ---------------------------------------------------------------- helpers

function writeNdjson(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}
const b64 = (b) => Buffer.from(b).toString('base64');

function run(cmd, args, env, ms = CHILD_MS) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, ms);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      running.delete(child);
      resolve({ code, signal, out, err, ms: Date.now() - t0 });
    });
  });
}

// ---------------------------------------------------------------- generation (system Node)

async function genV3(dir) {
  const killer = setTimeout(() => { console.error('gen-v3 timeout'); process.exit(3); }, CHILD_MS - 5000);
  const seeds = Number(process.env.SEEDS || 200);
  const { buildInputs } = await import(pathToFileURL(path.join(ROOT, 'bench/verify/v3-dec-inputs.mjs')).href);
  const { buildInputs2 } = await import(pathToFileURL(path.join(ROOT, 'bench/verify/v3-dec-inputs2.mjs')).href);
  const a = buildInputs(seeds).map((x) => ({ fam: `v3 ${x.fam}`, b64: b64(Buffer.from(x.hex, 'hex')) }));
  const b = buildInputs2(seeds).map((x) => ({ fam: `v3-2 ${x.fam}`, b64: b64(Buffer.from(x.hex, 'hex')) }));
  writeNdjson(path.join(dir, 'v3.ndjson'), a);
  writeNdjson(path.join(dir, 'v3-2.ndjson'), b);
  console.log(JSON.stringify({ v3: a.length, v32: b.length }));
  clearTimeout(killer);
}

async function genVariants(dir) {
  const killer = setTimeout(() => { console.error('gen-variants timeout'); process.exit(3); }, CHILD_MS - 5000);
  // A copy of bench/verify/v3-dec-variants.mjs whose decode wrapper records every buffer it is given.
  let src = fs.readFileSync(path.join(ROOT, 'bench/verify/v3-dec-variants.mjs'), 'utf8');
  src = src.replaceAll("from '../../", `from '${pathToFileURL(ROOT).href}/`).replace("from './v3-dec-corpus.mjs'", `from '${pathToFileURL(path.join(ROOT, 'bench/verify/v3-dec-corpus.mjs')).href}'`);
  const hook = 'const dec = (f, b, ...a) => {';
  if (!src.includes(hook)) throw new Error('v3-dec-variants.mjs: decode wrapper not found');
  src = src.replace(hook, `${hook} globalThis.__r3dCap.push(Buffer.from(b).toString('base64'));`);
  const copy = path.join(dir, 'variants-capture.mjs');
  fs.writeFileSync(copy, src);
  globalThis.__r3dCap = [];
  const log = console.log;
  console.log = () => {};
  try {
    await import(pathToFileURL(copy).href);
  } finally {
    console.log = log;
  }
  const seen = new Set();
  const rows = [];
  for (const x of globalThis.__r3dCap) if (!seen.has(x)) { seen.add(x); rows.push({ fam: 'variants v3-dec-variants', b64: x }); }
  writeNdjson(path.join(dir, 'variants.ndjson'), rows);
  fs.rmSync(copy, { force: true });
  console.log(JSON.stringify({ variants: rows.length }));
  clearTimeout(killer);
}

async function genProbe(dir) {
  const killer = setTimeout(() => { console.error('gen-probe timeout'); process.exit(3); }, CHILD_MS - 5000);
  const C = await import(pathToFileURL(path.join(ROOT, 'bench/verify/v3-dec-corpus.mjs')).href);
  const rows = [];
  // bench/electron/v3-dec-icu.mjs's corpus sample (same seed and steps)
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
    rows.push({ fam: 'probe v3-dec-icu sample', b64: b64(b) });
  }
  for (let x = 0; x < 256; x++) {
    rows.push({ fam: 'probe 1 byte', b64: b64([x]) });
    rows.push({ fam: 'probe A x LF', b64: b64([0x41, x, 0x0a]) });
  }
  for (let hi = 0x80; hi <= 0xff; hi++) {
    for (let lo = 0; lo <= 0xff; lo++) {
      rows.push({ fam: 'probe 2 bytes', b64: b64([hi, lo]) });
      rows.push({ fam: 'probe "# xx LF"', b64: b64([0x23, 0x20, hi, lo, 0x0a]) });
    }
  }
  const q = C.rng(4242);
  for (let i = 0; i < 4000; i++) rows.push({ fam: 'probe 4 bytes', b64: b64([C.int(q, 0x81, 0xfe), C.int(q, 0x30, 0x39), C.int(q, 0x81, 0xfe), C.int(q, 0x30, 0x39)]) });
  // H23's class (DEC-2): Shift_JIS with NEC-selected IBM pairs (ED / EE), NEC row 13 (87), IBM pairs
  // (FA–FC), JIS kanji and half-width katakana, a half-width katakana before LF (GBK and Big5 fail).
  const s = C.rng(2323);
  const trail = () => { const t = C.int(s, 0x40, 0xfc); return t === 0x7f ? 0x80 : t; };
  const piece = () => {
    const k = s();
    if (k < 0.25) return Buffer.from(C.pick(s, ['- ', ' item', ' a ', 'x ', '\n', ' 1,', '# ']), 'latin1');
    if (k < 0.45) return Buffer.from([C.int(s, 0xed, 0xee), trail()]);
    if (k < 0.55) return Buffer.from([0x87, C.int(s, 0x40, 0x9c)]);
    if (k < 0.7) return Buffer.from([C.int(s, 0xfa, 0xfc), trail()]);
    if (k < 0.85) return Buffer.from([C.int(s, 0x88, 0x9f), trail()]);
    return Buffer.from([C.int(s, 0xa1, 0xdf)]);
  };
  for (let i = 0; i < 3000; i++) {
    const parts = Array.from({ length: C.int(s, 1, 40) }, piece);
    parts.push(Buffer.from([C.int(s, 0xa1, 0xdf), 0x0a]));
    rows.push({ fam: 'probe nec-style shift_jis', b64: b64(Buffer.concat(parts)) });
  }
  {
    const p = [];
    for (let i = 0; i < 10; i++) p.push(Buffer.from('- ', 'latin1'), Buffer.from([0xee, 0xef]), Buffer.from(' item\n', 'latin1'));
    p.push(Buffer.from('x ', 'latin1'), Buffer.from([0x87, 0x90]), Buffer.from(' y ', 'latin1'), Buffer.from([0xb1, 0x0a]));
    rows.push({ fam: 'probe nec-style shift_jis', b64: b64(Buffer.concat(p)) }); // test/v3-dec-decoder.test.ts DEC-2
  }
  writeNdjson(path.join(dir, 'probe.ndjson'), rows);
  console.log(JSON.stringify({ probe: rows.length }));
  clearTimeout(killer);
}

// ---------------------------------------------------------------- the check (runs in either runtime)

async function check(file, outFile) {
  const killer = setTimeout(() => { console.error('check timeout'); process.exit(3); }, CHILD_MS - 5000);
  const t0 = Date.now();
  const N = await import(pathToFileURL(TREE).href);
  const O = await import(pathToFileURL(FIXTURE).href);
  if (N.DECODER_OVERRIDES !== false && !process.env.R3D_ALLOW_ON) throw new Error('DECODER_OVERRIDES is not false');
  const changed = (a, b) => {
    let n = Math.abs(a.length - b.length);
    for (let i = 0, m = Math.min(a.length, b.length); i < m; i++) if (a[i] !== b[i]) n++;
    return n;
  };
  const tryDec = (f, b) => { try { return f(b); } catch (e) { return { err: `${e.code || ''} ${e.message}` }; } };
  const tryEnc = (f) => { try { return f(); } catch (e) { return { err: e.message }; } };
  const fam = {};
  const ex = { readDiff: [], worse: [], differentEqual: [], fewer: [], files: [] };
  const push = (list, x, max = 20) => { if (list.length < max) list.push(x); };
  const F = (k) => (fam[k] ??= { inputs: 0, readDiff: 0, worse: 0, differentEqual: 0, fewer: 0, filesChecked: 0, filesBad: 0, typedRefused: 0, typedDiffer: 0 });
  const onlyOld = (label) => [...O.legacyEncoderTable(label).keys()].find((k) => !N.legacyEncoderTable(label, true).has(k)) || '';
  const TYPED = { big5: '十卅═' + onlyOld('big5'), shift_jis: 'ⅰ≒①' + onlyOld('shift_jis'), gbk: '中文€', 'euc-kr': '한글', 'windows-1252': 'é€', 'utf-8': '中😀', 'utf-16le': '中😀', 'utf-16be': '中😀' };
  ex.typed = [];
  const tmp = fs.mkdtempSync(path.join(path.dirname(outFile), 'files-'));
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let i = 0;
  try {
    for (const line of lines) {
      const { fam: name, b64: data } = JSON.parse(line);
      const b = Buffer.from(data, 'base64');
      const f = F(name);
      f.inputs++;
      i++;
      const o = tryDec(O.decodeBuffer, b);
      const d = tryDec(N.decodeBuffer, b);
      const sameRead = o.err || d.err ? o.err === d.err && !!o.err : d.text === o.text && d.encoding === o.encoding && d.bom === o.bom && d.replaced === undefined && Object.keys(d).length === 3;
      if (!sameRead) {
        f.readDiff++;
        push(ex.readDiff, { fam: name, hex: b.subarray(0, 48).toString('hex'), len: b.length, fixture: o.err || o.encoding, tree: d.err || `${d.encoding}${d.replaced ? ` replaced ${d.replaced}` : ''}` });
        continue;
      }
      if (o.err) continue;
      const table = N.saveTableOf(d.text, d.encoding, b);
      const metaN = { encoding: d.encoding, bom: d.bom, eol: N.eolOf(d.text), ...(table ? { table } : {}) };
      const metaO = { encoding: o.encoding, bom: o.bom, eol: O.eolOf(o.text) };
      const lf = (s) => s.replace(/\r\n?/g, '\n');
      for (const [tag, tn, to, add] of [['raw', d.text, o.text, ''], ['raw+x', d.text + 'x', o.text + 'x', 'x'], ['lf', lf(d.text), lf(o.text), ''], ['lf+x', lf(d.text) + 'x', lf(o.text) + 'x', 'x']]) {
        const want = add ? Buffer.concat([b, Buffer.from(add)]) : b;
        const sn = tryEnc(() => N.encodeText(tn, metaN));
        const so = tryEnc(() => O.encodeText(to, metaO));
        if (sn.err || so.err) {
          if (sn.err === so.err) continue;
          const cn = sn.err ? Infinity : changed(sn, want);
          const co = so.err ? Infinity : changed(so, want);
          if (cn < co) { f.fewer++; push(ex.fewer, { fam: name, tag, hex: b.subarray(0, 32).toString('hex'), tree: cn, fixture: so.err ? 'REFUSED' : co }, 50); } else { f.worse++; push(ex.worse, { fam: name, tag, hex: b.subarray(0, 48).toString('hex'), tree: sn.err || cn, fixture: so.err || co }); }
          continue;
        }
        if (sn.equals(so)) continue;
        const cn = changed(sn, want);
        const co = changed(so, want);
        if (cn < co) { f.fewer++; push(ex.fewer, { fam: name, tag, enc: d.encoding, table: table || 'whatwg', hex: b.subarray(0, 32).toString('hex'), len: b.length, tree: cn, fixture: co }, 50); } else if (cn > co) { f.worse++; push(ex.worse, { fam: name, tag, enc: d.encoding, hex: b.subarray(0, 48).toString('hex'), tree: cn, fixture: co }); } else { f.differentEqual++; push(ex.differentEqual, { fam: name, tag, enc: d.encoding, hex: b.subarray(0, 48).toString('hex'), tree: cn, fixture: co }); }
      }
      {
        const typed = TYPED[d.encoding] ?? '';
        const sn = tryEnc(() => N.encodeText(d.text + typed, metaN));
        const so = tryEnc(() => O.encodeText(o.text + typed, metaO));
        if (sn.err && !so.err) { f.typedRefused++; push(ex.typed, { fam: name, enc: d.encoding, table: table || 'whatwg', hex: b.subarray(0, 32).toString('hex'), tree: sn.err }); } else if (!sn.err && !so.err && !sn.equals(so)) f.typedDiffer++;
      }
      // every 40th input: the real read / write path of both, through temp files
      if (i % 40 === 0) {
        f.filesChecked++;
        const pn = path.join(tmp, `n${i}.md`);
        const po = path.join(tmp, `o${i}.md`);
        fs.writeFileSync(pn, b);
        fs.writeFileSync(po, b);
        const sN = N.createFileMetaStore();
        const sO = O.createFileMetaStore();
        let bad = '';
        try {
          const iN = await N.readFileInfo(pn, sN);
          const iO = await O.readFileInfo(po, sO);
          if (iN.text !== iO.text || iN.encoding !== iO.encoding || 'replacedBytes' in iN) bad = `readFileInfo: ${iO.encoding} / ${iN.encoding}${iN.replacedBytes ? ` replaced ${iN.replacedBytes}` : ''}`;
          else {
            const wN = await N.writeFileAtomic(pn, lf(iN.text) + 'x', sN).then(() => fs.readFileSync(pn), (e) => ({ err: e.message }));
            const wO = await O.writeFileAtomic(po, lf(iO.text) + 'x', sO).then(() => fs.readFileSync(po), (e) => ({ err: e.message }));
            const want = Buffer.concat([b, Buffer.from('x')]);
            const cn = wN.err ? Infinity : changed(wN, want);
            const co = wO.err ? Infinity : changed(wO, want);
            const fine = wN.err ? wN.err === wO.err : wO.err ? true : wN.equals(wO) || cn < co;
            if (!fine) bad = `writeFileAtomic: tree ${wN.err || cn} / fixture ${wO.err || co}`;
          }
        } catch (e) {
          bad = `threw ${e.message}`;
        }
        fs.rmSync(pn, { force: true });
        fs.rmSync(po, { force: true });
        if (bad) { f.filesBad++; push(ex.files, { fam: name, hex: b.subarray(0, 48).toString('hex'), bad }); }
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  fs.writeFileSync(outFile, JSON.stringify({ versions: { node: process.versions.node, icu: process.versions.icu, electron: process.versions.electron || null }, inputs: i, ms: Date.now() - t0, fam, ex }));
  clearTimeout(killer);
}

// ---------------------------------------------------------------- the driver

async function drive() {
  const ownDir = !process.env.R3D_DIR;
  const dir = process.env.R3D_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'r3-d-parity-'));
  const gen = path.join(dir, 'gen');
  const chunks = path.join(dir, 'chunks');
  const results = path.join(dir, 'results');
  const runtimes = (process.env.RUNTIMES || 'node,electron').split(',');
  const global = setTimeout(() => { console.log('GLOBAL TIMEOUT'); for (const c of running) try { c.kill('SIGKILL'); } catch { /* gone */ } process.exit(2); }, 20 * 60_000);
  let exit = 1;
  try {
    for (const d of [gen, chunks, results]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
    if (runtimes.includes('electron') && !fs.existsSync(ELECTRON)) throw new Error(`no Electron binary at ${ELECTRON}`);
    // 1. inputs, in the system Node
    const steps = [
      ['v3-dec-inputs / inputs2', process.execPath, [SELF, '--gen-v3', gen], {}],
      ['v3-dec-variants capture', process.execPath, [SELF, '--gen-variants', gen], {}],
      ['probes', process.execPath, [SELF, '--gen-probe', gen], {}],
      ['differential test dump', path.join(ROOT, 'node_modules/.bin/vitest'), ['run', 'test/electron.fileIO.differential.test.ts'], { R3D_DUMP: gen }],
    ];
    for (const [name, cmd, args, env] of steps) {
      const r = await run(cmd, args, env);
      console.log(`gen ${name}: exit ${r.code}${r.signal ? ` ${r.signal}` : ''} in ${r.ms} ms ${r.out.trim().split('\n').filter((l) => l.startsWith('{')).join(' ')}`);
      if (r.code !== 0) throw new Error(`generation step ${name} failed:\n${r.err.slice(-2000)}\n${r.out.slice(-2000)}`);
    }
    // 2. chunks
    let k = 0;
    let rows = [];
    let size = 0;
    const flush = () => { if (!rows.length) return; fs.writeFileSync(path.join(chunks, `c${String(++k).padStart(3, '0')}.ndjson`), rows.join('\n') + '\n'); rows = []; size = 0; };
    for (const f of fs.readdirSync(gen).filter((x) => x.endsWith('.ndjson')).sort()) {
      for (const line of fs.readFileSync(path.join(gen, f), 'utf8').split('\n')) {
        if (!line) continue;
        rows.push(line);
        size += line.length;
        if (rows.length >= CHUNK_INPUTS || size >= CHUNK_BYTES) flush();
      }
    }
    flush();
    fs.rmSync(gen, { recursive: true, force: true });
    const chunkFiles = fs.readdirSync(chunks).sort();
    console.log(`${chunkFiles.length} chunks`);
    // 3. the check, per runtime and chunk
    const total = {};
    for (const rt of runtimes) {
      total[rt] = { inputs: 0, fam: {}, ex: { readDiff: [], worse: [], differentEqual: [], fewer: [], files: [], typed: [] }, versions: null, failedChunks: [] };
      for (const c of chunkFiles) {
        const out = path.join(results, `${rt}-${c}.json`);
        const r = rt === 'electron'
          ? await run(ELECTRON, [SELF, '--check', path.join(chunks, c), out], { ELECTRON_RUN_AS_NODE: '1' })
          : await run(process.execPath, [SELF, '--check', path.join(chunks, c), out], {});
        if (r.code !== 0 || !fs.existsSync(out)) {
          total[rt].failedChunks.push(`${c}: exit ${r.code} ${r.signal || ''} ${r.err.slice(-300)}`);
          console.log(`${rt} ${c}: FAILED (exit ${r.code} ${r.signal || ''}) ${r.err.slice(-300)}`);
          continue;
        }
        const j = JSON.parse(fs.readFileSync(out, 'utf8'));
        console.log(`${rt} ${c}: ${j.inputs} inputs in ${j.ms} ms (child ${r.ms} ms)`);
        const T = total[rt];
        T.versions = j.versions;
        T.inputs += j.inputs;
        for (const [name, v] of Object.entries(j.fam)) {
          const t = (T.fam[name] ??= { inputs: 0, readDiff: 0, worse: 0, differentEqual: 0, fewer: 0, filesChecked: 0, filesBad: 0, typedRefused: 0, typedDiffer: 0 });
          for (const key of Object.keys(t)) t[key] += v[key];
        }
        for (const key of Object.keys(T.ex)) for (const x of j.ex[key]) if (T.ex[key].length < 60) T.ex[key].push(x);
      }
    }
    // 4. report
    const fams = [...new Set(runtimes.flatMap((rt) => Object.keys(total[rt].fam)))].sort();
    const cell = (rt, name, key) => String(total[rt].fam[name]?.[key] ?? '-');
    const head = ['family'.padEnd(58), 'inputs'.padStart(7), ...runtimes.flatMap((rt) => [`${rt}:read`, `${rt}:worse`, `${rt}:fewer`, `${rt}:files`].map((h) => h.padStart(15)))].join(' ');
    console.log('\n' + head);
    for (const name of fams) {
      const rt0 = runtimes.find((rt) => total[rt].fam[name]);
      console.log([name.slice(0, 58).padEnd(58), cell(rt0, name, 'inputs').padStart(7), ...runtimes.flatMap((rt) => [
        cell(rt, name, 'readDiff'),
        `${cell(rt, name, 'worse')}+${cell(rt, name, 'differentEqual')}`,
        cell(rt, name, 'fewer'),
        `${cell(rt, name, 'filesBad')}/${cell(rt, name, 'filesChecked')}`,
      ].map((v) => v.padStart(15)))].join(' '));
    }
    let ok = true;
    console.log('\nTOTAL');
    for (const rt of runtimes) {
      const T = total[rt];
      const sum = (key) => Object.values(T.fam).reduce((a, v) => a + v[key], 0);
      const line = { runtime: rt, versions: T.versions, inputs: T.inputs, readDifferences: sum('readDiff'), worseSaves: sum('worse'), sameCountDifferentSaves: sum('differentEqual'), fewerBytesChangedSaves: sum('fewer'), typedRefused: sum('typedRefused'), typedBytesDiffer: sum('typedDiffer'), realFilesChecked: sum('filesChecked'), realFilesBad: sum('filesBad'), failedChunks: T.failedChunks.length };
      console.log(JSON.stringify(line));
      if (line.readDifferences || line.worseSaves || line.sameCountDifferentSaves || line.typedRefused || line.realFilesBad || line.failedChunks || !line.inputs) ok = false;
      for (const key of ['readDiff', 'worse', 'differentEqual', 'files', 'typed']) for (const x of T.ex[key]) console.log(`  ${rt} ${key}: ${JSON.stringify(x)}`);
      for (const x of T.ex.fewer) console.log(`  ${rt} fewer (allowed): ${JSON.stringify(x)}`);
    }
    console.log(ok ? '\nPARITY OK' : '\nPARITY FAILED');
    exit = ok ? 0 : 1;
  } catch (e) {
    console.log(`ERROR ${e.stack || e}`);
    exit = 1;
  } finally {
    clearTimeout(global);
    for (const c of running) try { c.kill('SIGKILL'); } catch { /* gone */ }
    if (ownDir && !process.env.R3D_KEEP) fs.rmSync(dir, { recursive: true, force: true });
    else { fs.rmSync(chunks, { recursive: true, force: true }); }
  }
  process.exit(exit);
}

// ---------------------------------------------------------------- entry (last: every const above is initialised)

const mode = process.argv[2] || 'drive';
if (mode === '--check') await check(process.argv[3], process.argv[4]);
else if (mode === '--gen-v3') await genV3(process.argv[3]);
else if (mode === '--gen-variants') await genVariants(process.argv[3]);
else if (mode === '--gen-probe') await genProbe(process.argv[3]);
else await drive();
