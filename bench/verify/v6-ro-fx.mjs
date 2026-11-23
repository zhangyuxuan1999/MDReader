// bench/verify/v6-ro-fx.mjs — regress-off (stage 2f, round 5): bench/verify/v5-offa-fx.mjs with the generated copy
// named bench/verify/v6-ro-fxgen-<NN>-<pid>.mjs (deleted afterwards), so that a run creates no file outside the
// v6-ro prefix. Runs a bench/verify/fx/NN-*.mjs UX scenario against a build (switch OFF, ?perf=1 added through
// bench/verify/v5-offa-ux.mjs) whose localhost:5203 URLs point at MDR_FX_URL and whose /tmp/ paths point at MDR_TMP.
//   MDR_FX_URL=http://localhost:5467 MDR_TMP=<scratch> node bench/verify/v6-ro-fx.mjs 03-persistence
// 14-visual is refused (it writes screenshots into the tree). Prints the scenario's own output. Global timeout 110 s.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const here = path.dirname(new URL(import.meta.url).pathname);
const name = process.argv[2];
if (!name || name.startsWith('14')) { console.log('usage: v6-ro-fx.mjs <NN-name> (14-visual refused: it writes into the tree)'); process.exit(2); }
const src = fs.readdirSync(path.join(here, 'fx')).find((f) => f.startsWith(name));
if (!src) { console.log('no scenario ' + name); process.exit(2); }
const tmp = (process.env.MDR_TMP || '/tmp').replace(/\/?$/, '/');
let s = fs.readFileSync(path.join(here, 'fx', src), 'utf8');
s = s.replaceAll("'../ux/lib.mjs'", "'./v5-offa-ux.mjs'").replace(/'http:\/\/localhost:5203/g, "process.env.MDR_FX_URL+'").replaceAll("'/tmp/", `'${tmp}`).replaceAll('`/tmp/', '`' + tmp);
const gen = path.join(here, `v6-ro-fxgen-${name}-${process.pid}.mjs`);
fs.writeFileSync(gen, s);
try {
  const r = spawnSync('node', [gen], { env: { ...process.env, MDR_UX_BASE: process.env.MDR_FX_URL }, encoding: 'utf8', timeout: 110_000 });
  process.stdout.write(r.stdout || ''); process.stdout.write(r.stderr || '');
  if (r.error) console.log('ERROR ' + r.error.message);
} finally { fs.rmSync(gen, { force: true }); }
