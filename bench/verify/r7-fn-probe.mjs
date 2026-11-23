// bench/verify/r7-fn-probe.mjs — fix-san (round 7): probes which raw HTML makes src/preview/sanitize.ts throw, with the
// stack. Loads the tree's sanitize.ts through the dev server (MDR_PORT) and calls sanitizeToFragment on each input given
// as a JSON array file (argv[2]) or on a built-in list. Prints one line per input: ok | THROW message + top stack frames.
//   MDR_PORT=5462 node bench/verify/r7-fn-probe.mjs [inputs.json]
// Global timeout 100 s. Writes nothing.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000);
const port = process.env.MDR_PORT || '5462';
const inputs = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : [
  '<p><?form></p>', '<?form>', '<div><?form></div>', '<p>x <?php echo 1 ?> y</p>', '<?xml version="1.0"?>',
  '<p><?FORM></p>', '<p><?form x></p>', '<p><?input></p>', '<p><?a></p>', '<svg><?form></svg>', '<math><?form></math>',
];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${port}/?perf=1`, { waitUntil: 'domcontentloaded' });
  const out = await page.evaluate(async (list) => {
    const m = await import('/src/preview/sanitize.ts');
    const res = [];
    for (const h of list) {
      try { const f = m.sanitizeToFragment(h); const d = document.createElement('div'); d.append(f); res.push(['ok', h, d.innerHTML]); }
      catch (e) { res.push(['THROW', h, String(e && e.message), String(e && e.stack).split('\n').slice(0, 6).join(' | ')]); }
    }
    return res;
  }, inputs);
  for (const r of out) console.log(JSON.stringify(r));
} finally { clearTimeout(KILL); await browser.close().catch(() => {}); }
