// bench/verify/v4-dec-mutate.mjs — verify-decoder (0.2.0 stage 2d), step 4: do the decoder unit tests
// notice when electron/fileIO.mjs is broken? Mutates a COPY of the tree's fileIO.mjs in a scratch
// harness (MUT dir: electron/, test/ with copies of the 8 decoder test files, test/fixtures, the corpus
// module, node_modules symlink, a vitest config with its own cacheDir) and runs those tests per mutant.
//   MUT=<harness dir> MUTANTS=M0,M1 node bench/verify/v4-dec-mutate.mjs   (one JSON line per mutant)
// The tree is never touched. Each vitest run is bounded (alarm 300 s). Run it in the background.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MUT = process.env.MUT;
if (!MUT) { console.error('set MUT'); process.exit(64); }
const orig = fs.readFileSync(path.join(MUT, 'electron/fileIO.orig.mjs'), 'utf8');
const rep = (s, a, b) => { if (!s.includes(a)) throw new Error('mutant anchor missing: ' + a.slice(0, 60)); return s.replace(a, b); };
const MUTANTS = {
  M0: (s) => s, // unmodified copy: the reference run
  M1: (s) => rep(s, 'export const DECODER_OVERRIDES = false;', 'export const DECODER_OVERRIDES = true;'),
  M2: (s) => rep(s, '  if (overrides) {\n    const o = overrideOf(buf, base);', '  if (false) {\n    const o = overrideOf(buf, base);'),
  M3: (s) => rep(s, "  if (applyEol(text, eolOf(text)) === text && encodesBack(text, encoding, buf) && !encodesBack(text, encoding, buf, false)) return undefined;\n  return '0.1.0';", "  return '0.1.0';"),
  M4: (s) => rep(s, "  if (applyEol(text, eolOf(text)) === text && encodesBack(text, encoding, buf) && !encodesBack(text, encoding, buf, false)) return undefined;\n  return '0.1.0';", '  return undefined;'),
  M5: (s) => rep(s, 'if (applyEol(text, eolOf(text)) === text && encodesBack(', 'if (encodesBack('),
  M6: (s) => rep(s, 'const bytes = table.get(ch) || fallback?.get(ch);', 'const bytes = table.get(ch);'),
  M7: (s) => rep(s, 'if (text !== null && !CONTROL_RE_010.test(text)) return { text, encoding: label, bom: false };', 'if (text !== null && !CONTROL_RE.test(text)) return { text, encoding: label, bom: false };'),
  M8: (s) => rep(s, '  const { text, encoding, bom, replaced } = decodeBuffer(buf);', '  const { text, encoding, bom, replaced } = decodeBuffer(buf, true);'),
  M9: (s) => rep(s, "export const LEGACY_ENCODINGS = ['gbk', 'big5', 'shift_jis', 'euc-kr', 'windows-1252'];", "export const LEGACY_ENCODINGS = ['gbk', 'shift_jis', 'big5', 'euc-kr', 'windows-1252'];"),
  M10: (s) => rep(s, "  store?.set(real, { encoding, bom, eol, ...(table ? { table } : {}), mtimeMs: st.mtimeMs, size: st.size });", '  store?.set(real, { encoding, bom, eol, mtimeMs: st.mtimeMs, size: st.size });'),
  M11: (s) => rep(s, "    if (!table.has(s) || (whatwg && label === 'big5' && BIG5_LAST_POINTER.has(s))) table.set(s, [hi, lo]);", '    if (!table.has(s) || whatwg) table.set(s, [hi, lo]);'),
  M12: (s) => rep(s, "  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {\n    const text = decodeWith(buf.subarray(2), 'utf-16be');", "  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff && buf.length > 6) {\n    const text = decodeWith(buf.subarray(2), 'utf-16be');"),
  M13: (s) => rep(s, 'const MIN_EVIDENCE_CHARS = 20;', 'const MIN_EVIDENCE_CHARS = 2000;'),
  M14: (s) => rep(s, 'const UTF8_LENIENT_MIN_VALID = 8;', 'const UTF8_LENIENT_MIN_VALID = 800;'),
};
const want = (process.env.MUTANTS || Object.keys(MUTANTS).join(',')).split(',');
for (const id of want) {
  const src = MUTANTS[id](orig);
  fs.writeFileSync(path.join(MUT, 'electron/fileIO.mjs'), src);
  const t0 = Date.now();
  const r = spawnSync('perl', ['-e', 'alarm 300; exec @ARGV', 'npx', 'vitest', 'run', '--root', MUT, '--config', path.join(MUT, 'vitest.config.mjs'), '--reporter=json', '--outputFile', path.join(MUT, `res-${id}.json`)], { cwd: MUT, encoding: 'utf8', maxBuffer: 1 << 28 });
  let res = null;
  try { res = JSON.parse(fs.readFileSync(path.join(MUT, `res-${id}.json`), 'utf8')); } catch { /* none */ }
  const failed = [];
  const perFile = {};
  if (res) {
    for (const f of res.testResults) {
      const name = path.basename(f.name);
      for (const a of f.assertionResults) {
        if (a.status === 'failed') { failed.push(`${name}: ${a.title}`); perFile[name] = (perFile[name] || 0) + 1; }
      }
      if (f.status === 'failed' && f.assertionResults.length === 0) { failed.push(`${name}: (file failed) ${String(f.message).slice(0, 200)}`); perFile[name] = 'file'; }
    }
  }
  console.log(JSON.stringify({ id, ms: Date.now() - t0, exit: r.status, signal: r.signal, total: res?.numTotalTests, passed: res?.numPassedTests, failedN: res?.numFailedTests, perFile, failed: failed.slice(0, 25) }));
}
fs.writeFileSync(path.join(MUT, 'electron/fileIO.mjs'), orig);
