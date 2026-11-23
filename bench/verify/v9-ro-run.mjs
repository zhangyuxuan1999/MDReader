// bench/verify/v9-ro-run.mjs — regress-off (round 7, 0.2.1): runs the standing switch-off comparison one script after
// the other (or a few in parallel for the matrix shards), each in its own process with its own bound, and writes the
// output of every run to <out>/<job>.log and one line per run to <out>/index.txt. A runner only: it judges nothing.
//   node bench/verify/v9-ro-run.mjs <phase> <out-dir> [job-name-filter]
// Phases: m (matrix A + B, fuzz B), s (the sequential lists), u (real-user scripts: needs 5467 / 5478 WITHOUT the
// ?perf=1 redirect), k (scripts that start or kill their own server: 5479 and 5478 must be free).
// Ports: 5467 candidate dist, 5477 0.1.1 dist, 5478 0.2.0 dist, 5479 the tree's Vite dev server.
// Writes only into <out-dir>. Every child is killed (SIGTERM, then SIGKILL) at its bound.
import { spawn, execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, createWriteStream } from 'node:fs';

const [phase, OUT, filt] = process.argv.slice(2);
if (!phase || !OUT) { console.error('usage: v9-ro-run.mjs <phase> <out> [filter]'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const ROOT = new URL('../..', import.meta.url).pathname;
const C = 5467, B1 = 5477, B2 = 5478, D = 5479;
const TMP = `${OUT}/tmp`; mkdirSync(TMP, { recursive: true });

function run(job) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const log = createWriteStream(`${OUT}/${job.n}.log`);
    const p = spawn('/bin/sh', ['-c', job.c], { cwd: ROOT, env: { ...process.env, ...(job.e || {}) }, detached: true });
    p.stdout.pipe(log); p.stderr.pipe(log);
    let killed = false;
    const tm = setTimeout(() => { killed = true; try { process.kill(-p.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, 5000); }, (job.t || 120) * 1000);
    p.on('exit', (code) => {
      clearTimeout(tm);
      const line = `${new Date().toISOString()} ${job.n} exit=${code}${killed ? ' KILLED' : ''} ${Math.round((Date.now() - t0) / 1000)}s`;
      appendFileSync(`${OUT}/index.txt`, line + '\n');
      setTimeout(() => resolve(code), 300);
    });
  });
}
async function seq(jobs) { for (const j of jobs) if (!filt || j.n.includes(filt)) await run(j); }
async function par(jobs) { await Promise.all(jobs.filter((j) => !filt || j.n.includes(filt)).map(run)); }
const node = (s, args = '') => `node bench/verify/${s}.mjs ${args}`;
function chunked(script, env, size, name, t = 125) {
  const names = execSync(`node bench/verify/${script}.mjs --list`, { cwd: ROOT, env: { ...process.env, ...env } }).toString().trim().split('\n').filter(Boolean);
  const jobs = [];
  for (let i = 0; i < names.length; i += size) jobs.push({ n: `${name}-${String(i).padStart(3, '0')}`, c: node(script, names.slice(i, i + size).join(' ')), e: env, t });
  return jobs;
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const CB1 = { MDR_PORT: C, MDR_BASE_PORT: B1, MDR_CAND_PERF: '1' };
const CB2 = { MDR_PORT: C, MDR_BASE_PORT: B2, MDR_CAND_PERF: '1' };

if (phase === 'm') {
  const shards = (tag, env) => range(0, 3).map((i) => ({ n: `matrix${tag}-${i}`, c: node('v5-offd-matrix', `--shard ${i}/4`), e: { ...env, MDR_TIMEOUT: '3300000', MDR_SCRATCH: `${OUT}/offd${tag}` }, t: 3400 }));
  await par(shards('A', CB1));
  await par(shards('B', CB2));
  await seq(range(9301, 9310).map((s) => ({ n: `fuzzB-${s}`, c: node('v5-offd-fuzz', `${s} --ops 60`), e: { ...CB2, MDR_TIMEOUT: '600000', MDR_SCRATCH: `${OUT}/fuzzB` }, t: 620 })));
}

if (phase === 's') {
  const A = { MDR_PORT: C, MDR_BASE_PORT: B1 };
  const DA = { MDR_PORT: D, MDR_BASE_PORT: B1 };
  const OA = { ...A, MDR_TMP: TMP };
  await seq([
    { n: 'offc-probes-A', c: node('v5-offc-probes', 'all'), e: { ...A, MDR_TIMEOUT: '1500000' }, t: 1550 },
    { n: 'offc-probes-B', c: node('v5-offc-probes', 'all'), e: { MDR_PORT: C, MDR_BASE_PORT: B2, MDR_TIMEOUT: '1500000' }, t: 1550 },
    { n: 'offc-rest-A', c: node('v5-offc-rest', 'css dom:small dom:readme dom:all style:small style:readme style:all'), e: { ...A, MDR_TIMEOUT: '600000' }, t: 620 },
    { n: 'ro-pi', c: node('v6-ro-pi'), e: A, t: 125 },
    { n: 'ro-piwait', c: node('v6-ro-piwait'), e: A, t: 125 },
  ]);
  await seq(chunked('v5-offa-r6', OA, 3, 'offa-r6'));
  await seq(chunked('v5-offa-daily', A, 12, 'offa-daily'));
  await seq(chunked('v5-offa-u2', A, 7, 'offa-u2'));
  await seq(chunked('v5-offa-drop', OA, 3, 'offa-drop'));
  await seq([
    { n: 'offp-attrs', c: node('v5-offp-attrs'), e: CB1, t: 125 },
    { n: 'offp-j13', c: node('v5-offp-j13'), e: CB1, t: 125 },
    { n: 'offp-u24', c: node('v5-offp-u24'), e: CB1, t: 125 },
    ...['rest', 'edit', 'ime', 'keys', 'series', 'focus', 'chb3', 'giant'].map((g) => ({ n: `offp-ticks-${g}`, c: node('v5-offp-ticks', g), e: { ...CB1, MDR_TIMEOUT: '900000' }, t: 920 })),
    { n: 'offp-probes', c: node('v5-offp-probes'), e: { ...CB1, MDR_STRICT_CLIP: '1', MDR_TIMEOUT: '900000' }, t: 920 },
    ...[1, 2, 3, 4, 5, 6, 9, 10, 11, 12].map((s) => ({ n: `offp-fuzz-${s}`, c: node('v5-offp-fuzz', String(s)), e: { ...CB1, MDR_STRICT_CLIP: '1', MDR_TIMEOUT: '600000' }, t: 620 })),
    { n: 'offp-cmdk', c: node('v5-offp-cmdk', '2'), e: CB1, t: 240 },
    ...range(231, 250).map((s) => ({ n: `fuzzA-${s}`, c: node('v5-offd-fuzz', `${s} --ops 60`), e: { ...CB1, MDR_TIMEOUT: '600000', MDR_SCRATCH: `${OUT}/fuzzA` }, t: 620 })),
    // ticks (dev server of the tree = the candidate's renderer)
    { n: 'chc-ticks', c: node('v5-chc-ticks', 'cand'), e: { MDR_PORT: D, MDR_TIMEOUT: '2400000' }, t: 2450 },
    { n: 'ptk-cand', c: node('v5-ptk-ticks', 'cand'), e: { MDR_PORT: D }, t: 900 },
    { n: 'rvk-cand', c: node('v5-rvk-ticks', 'cand'), e: { MDR_PORT: D }, t: 600 },
    { n: 'rvk-base', c: node('v5-rvk-ticks', 'base'), e: { MDR_BASE_PORT: B1 }, t: 600 },
    { n: 'rvt-trust', c: node('v5-rvt-trust'), e: DA, t: 300 },
    { n: 'r4-t-stale', c: node('r4-t-stale'), e: { MDR_URL: `http://localhost:${D}/?mode=split` }, t: 300 },
    { n: 'r4-t-u24', c: node('r4-t-u24'), e: { MDR_URL: `http://localhost:${D}/?mode=split` }, t: 300 },
    { n: 'r4-if-holes', c: node('r4-if-holes', 'ring-4000 ring-5000 ring-5000-elsewhere lostscroll pending'), e: { MDR_PORT: D, T_MS: '600000' }, t: 620 },
    { n: 'r4-if-miss-cand', c: node('r4-if-miss', 'cand'), e: DA, t: 300 },
    { n: 'r4-if-miss-base', c: node('r4-if-miss', 'base'), e: DA, t: 300 },
    ...[1, 2, 3, 4, 5, 6, 541, 542, 543, 544].map((s) => ({ n: `tickfuzz-${s}`, c: node('v5-chc-tickfuzz', String(s)), e: { MDR_PORT: D }, t: 300 })),
    // the switch (test-mode cases on the dev server)
    { n: 'sw-off', c: node('v5-sw-off'), e: { ...DA, MDR_TIMEOUT: '900000' }, t: 920 },
    { n: 'sw-print', c: node('v5-sw-print'), e: { MDR_PORT: D }, t: 200 },
    // the application
    { n: 'app-shortcuts', c: node('v2-app-shortcuts'), e: { MDR_PORT: D }, t: 300 },
    { n: 'app-longuse', c: node('v2-app-longuse'), e: { MDR_PORT: D }, t: 300 },
    { n: 'app-stale', c: node('v2-app-stale', '3'), e: { MDR_PORT: D }, t: 300 },
    { n: 'app-regress-cand', c: node('v2-app-regress'), e: { MDR_EDIT: 'off', MDR_BASE_URL: `http://localhost:${D}` }, t: 300 },
    { n: 'app-regress-base', c: node('v2-app-regress'), e: { MDR_PERF: '1', MDR_BASE_URL: `http://localhost:${B1}` }, t: 300 },
    { n: 'flow-web', c: node('v2-flow-web'), e: { MDR_PORT: D }, t: 600 },
    { n: 'fixC-nbsp', c: node('fixC-nbsp'), t: 80 },
    { n: 'v4-flow-drop', c: node('v4-flow-drop'), e: { MDR_URL: `http://localhost:${D}/`, MDR_BASE_URL: `http://localhost:${B1}/?perf=1`, MDR_TMP: TMP }, t: 600 },
    { n: 'v4-flow-r5', c: node('v4-flow-r5'), e: { MDR_URL: `http://localhost:${D}/`, MDR_BASE_URL: `http://localhost:${B1}/?perf=1` }, t: 600 },
    { n: 'v4-flow-textdrag', c: node('v4-flow-textdrag'), e: { MDR_URL: `http://localhost:${D}/`, MDR_BASE_URL: `http://localhost:${B1}/?perf=1` }, t: 300 },
    { n: 'v4-flow-filestype', c: node('v4-flow-probe-filestype'), e: { MDR_URL: `http://localhost:${D}/`, MDR_BASE_URL: `http://localhost:${B1}/?perf=1` }, t: 100 },
    ...['caretmark', 'h15', 'h17', 'tex', 'e2e', 'null', 'u16'].map((s) => ({ n: `tru-${s}`, c: node(`v4-tru-${s}`), e: { MDR_URL: `http://localhost:${D}/?mode=split` }, t: 400 })),
    { n: 'tru-u16-base', c: node('v4-tru-u16'), e: { MDR_URL: `http://localhost:${B1}/?mode=split&perf=1` }, t: 400 },
    { n: 'tru-h29', c: node('v4-tru-h29'), e: { MDR_PORT: D }, t: 600 },
    { n: 'tru-diff-1', c: node('v4-tru-diff', '20000 1'), e: { MDR_PORT: D }, t: 2400 },
  ]);
  const fx = ['01-shortcuts', '02-toolbar-mode-toc-theme', '03-persistence', '04-palette-find-goto', '05-editing', '06-preview-interactions', '07-scrollsync', '08-files', '09-save', '10-drafts', '11-status-progress-resize', '12-narrow-toc', '13-gaps', '15-contrast', '16-overflow', '17-misc', '18-toc-big', '19-toc-collapse', '20-edge', '21-focus-modes', '22-hazards', '23-altclick-race', '24-more'];
  await seq(fx.flatMap((f) => [[C, 'cand'], [B1, 'base']].map(([p, k]) => ({ n: `fx-${f}-${k}`, c: node('v6-ro-fx', f), e: { MDR_FX_URL: `http://localhost:${p}`, MDR_TMP: `${TMP}/fx-${k}` }, t: 125 }))));
}

if (phase === 'u') {
  const A = { MDR_PORT: C, MDR_BASE_PORT: B1 };
  await seq([
    { n: 'rel-default', c: node('r4-rel-default'), e: { MDR_PORT: C }, t: 300 },
    { n: 'sw-default', c: node('v5-sw-default'), e: { MDR_PORT: C, MDR_DEV_PORT: D }, t: 600 },
    { n: 'sw-user', c: node('v5-sw-user'), e: A, t: 600 },
    { n: 'sw-narrow', c: node('v5-sw-narrow'), e: A, t: 300 },
    { n: 'offp-nohooks', c: node('v5-offp-nohooks'), e: A, t: 300 },
    { n: 'noload-user', c: node('r5-pl-noload', '--user'), e: { MDR_URL: `http://localhost:${C}/` }, t: 200 },
    { n: 'noload-none', c: node('r5-pl-noload', '--user --stored none'), e: { MDR_URL: `http://localhost:${C}/` }, t: 200 },
    { n: 'noload-perf0', c: node('r5-pl-noload', '--stored 0'), e: { MDR_URL: `http://localhost:${C}/?perf=1` }, t: 200 },
    { n: 'noload-dev0', c: node('r5-pl-noload', '--stored 0'), e: { MDR_URL: `http://localhost:${D}/` }, t: 200 },
    ...[[C, 'cand'], [B2, 'b020'], [B1, 'b011']].flatMap(([p, k]) => [
      { n: `vo-gest-${k}`, c: node('v6-vo-gest', `${p} ${OUT}/vo-gest-${k}.json`), t: 125 },
      { n: `vo-daily-${k}`, c: node('v6-vo-daily', `${p} none ${OUT}/vo-daily-${k}.json`), t: 125 },
      { n: `vo-stand-${k}`, c: node('v6-vo-stand', `${p} ${OUT}/vo-stand-${k}.json`), t: 125 },
    ]),
    { n: 'vo-gest-b020b', c: node('v6-vo-gest', `${B2} ${OUT}/vo-gest-b020b.json`), t: 125 },
    { n: 'vo-tickscroll', c: node('v6-vo-tickscroll', `${C} ${B2} ${B1}`), t: 125 },
    { n: 'vo-copyrace', c: node('v6-vo-copyrace', `${C} ${B2}`), t: 125 },
    { n: 'vo-arrive', c: node('v6-vo-arrive', 'all'), e: { MDR_URL: `http://localhost:${C}/` }, t: 300 },
    { n: 'vo-fail', c: node('v6-vo-fail', 'all'), e: { MDR_URL: `http://localhost:${C}/` }, t: 300 },
    { n: 'chunkprobe-0', c: node('v6-ro-chunkprobe', '3 --pref 0'), e: { MDR_PORT: C }, t: 200 },
    { n: 'chunkprobe-null', c: node('v6-ro-chunkprobe', '3 --pref null'), e: { MDR_PORT: C }, t: 200 },
  ]);
}

if (phase === 'k') {
  await seq([
    { n: 'fixA-large-jump', c: node('fixA-large-jump'), e: { MDR_PORT: D }, t: 300 },
    { n: 'fixA-undo-outside', c: node('fixA-undo-outside'), e: { MDR_PORT: D }, t: 300 },
    { n: 'fixC-listperf', c: node('fixC-listperf'), e: { MDR_PORT: D }, t: 200 },
    { n: 'fixF-web-drop', c: node('fixF-web-drop'), e: { MDR_PORT: D }, t: 300 },
    { n: 'offa-upgrade', c: node('v5-offa-upgrade'), e: { MDR_UPG_PORT: B2, MDR_CAND_DIST: 'release/staging-0.2.1.noindex/dist', MDR_TMP: TMP }, t: 900 },
  ]);
}
console.log('phase done', phase);
