// bench/verify/v5-offa-fx.mjs — verify-off-app JOB 3: runs a bench/verify/fx/NN-*.mjs UX scenario against a build
// (switch OFF, ?perf=1 added) by generating a copy next to this file (bench/verify/v5-offa-fxgen-<NN>.mjs, deleted
// afterwards) whose localhost:5203 URLs point at MDR_FX_URL and whose /tmp/ paths point at MDR_TMP.
//   MDR_FX_URL=http://localhost:5486 MDR_TMP=<scratch> node bench/verify/v5-offa-fx.mjs 03-persistence
// Prints the scenario's own output. Global timeout 110 s.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const here = path.dirname(new URL(import.meta.url).pathname);
const name = process.argv[2];
const src = fs.readdirSync(path.join(here, 'fx')).find((f) => f.startsWith(name));
const tmp = (process.env.MDR_TMP || '/tmp').replace(/\/?$/, '/');
let s = fs.readFileSync(path.join(here, 'fx', src), 'utf8');
s = s.replaceAll("'../ux/lib.mjs'", "'./v5-offa-ux.mjs'").replace(/'http:\/\/localhost:5203/g, "process.env.MDR_FX_URL+'").replaceAll("'/tmp/", `'${tmp}`).replaceAll('`/tmp/', '`' + tmp);
const gen = path.join(here, `v5-offa-fxgen-${name}-${process.pid}.mjs`);
fs.writeFileSync(gen, s);
try {
  const r = spawnSync('node', [gen], { env: { ...process.env, MDR_UX_BASE: process.env.MDR_FX_URL }, encoding: 'utf8', timeout: 110_000 });
  process.stdout.write(r.stdout || ''); process.stdout.write(r.stderr || '');
  if (r.error) console.log('ERROR ' + r.error.message);
} finally { fs.rmSync(gen, { force: true }); }
