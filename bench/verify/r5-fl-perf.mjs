// bench/verify/r5-fl-perf.mjs — fix-lazy (0.2.0 stage 2f): runs an existing session script against a PRODUCTION build
// in test mode, without editing it. The v2-ses-* helpers boot `${BASE}/?mode=split` and wait for window.__mdr, which a
// production build installs only with ?perf=1; this wrapper adds an init script to every browser context that puts
// perf=1 into the page's URL (history.replaceState) before the app reads location.search.
//   MDR_PORT=5474 node bench/verify/r5-fl-perf.mjs bench/verify/v2-ses-resume.mjs [its arguments ...]
// (MDR_PORT = a `vite preview` of the build: v2-ses-lib's ensureServer then reuses it.) Writes nothing.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const target = process.argv[2];
if (!target) { console.error('usage: node bench/verify/r5-fl-perf.mjs <script> [args]'); process.exit(64); }
const addPerf = () => {
  if (!/[?&]perf=1(&|$)/.test(location.search)) {
    history.replaceState(history.state, '', location.pathname + (location.search ? location.search + '&' : '?') + 'perf=1' + location.hash);
  }
};
const launch = chromium.launch.bind(chromium);
chromium.launch = async (...a) => {
  const b = await launch(...a);
  const newContext = b.newContext.bind(b);
  b.newContext = async (...o) => { const c = await newContext(...o); await c.addInitScript(addPerf); return c; };
  const newPage = b.newPage.bind(b);
  b.newPage = async (...o) => { const p = await newPage(...o); await p.addInitScript(addPerf); return p; };
  return b;
};
process.argv = [process.argv[0], path.resolve(target), ...process.argv.slice(3)];
await import(pathToFileURL(path.resolve(target)).href);
