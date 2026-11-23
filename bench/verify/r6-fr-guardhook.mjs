// bench/verify/r6-fr-guardhook.mjs — fix-refs (0.2.0 stage 2g, fix round 6): counts THE GUARD's firings in any existing
// browser script without changing it. Loaded before the script:
//   node --import ./bench/verify/r6-fr-guardhook.mjs bench/verify/<script>.mjs …
// It wraps @playwright/test's chromium.launch so every page of every browser the script opens reports the console lines
// inlineEdit.ts logs when the guard refuses a write or a session start ("the write guard refused …"). At exit it prints
//   R6FR-GUARD fired=<writes refused> starts=<session starts refused>
// (and appends the same line plus each message to $R6FR_GUARD_OUT when set). Writes nothing into the tree.
import { chromium } from '@playwright/test';
import { appendFileSync } from 'node:fs';

const out = process.env.R6FR_GUARD_OUT || '';
const script = process.argv.slice(1).join(' ');
let fired = 0, starts = 0;
const lines = [];
const seen = new WeakSet();
const hookPage = (p) => {
  if (seen.has(p)) return;
  seen.add(p);
  p.on('console', (m) => {
    const t = m.text();
    if (!t.includes('the write guard refused')) return;
    if (t.includes('session start')) starts++; else fired++;
    lines.push(t);
  });
};
const hookContext = (c) => { if (seen.has(c)) return; seen.add(c); c.on('page', hookPage); for (const p of c.pages()) hookPage(p); };
const launch = chromium.launch.bind(chromium);
chromium.launch = async (...a) => {
  const b = await launch(...a);
  const newContext = b.newContext.bind(b);
  b.newContext = async (...x) => { const c = await newContext(...x); hookContext(c); return c; };
  const newPage = b.newPage.bind(b);
  b.newPage = async (...x) => { const p = await newPage(...x); hookPage(p); return p; };
  for (const c of b.contexts()) hookContext(c);
  return b;
};
process.on('exit', () => {
  const res = `R6FR-GUARD fired=${fired} starts=${starts}`;
  console.log(res);
  if (out) { try { appendFileSync(out, `${res} ${script}\n${lines.map((l) => '  ' + l).join('\n')}${lines.length ? '\n' : ''}`); } catch { /* */ } }
});
