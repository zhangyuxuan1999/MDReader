// bench/verify/fixC-listperf.mjs — the serializer's share of in-preview editing on large list blocks
// (finding medium 8, docs/FINDINGS-inline-r1.md). Runs in real Chromium against the dev server:
//   · builds a list block of N items, renders it with OUR markdown-it (src/worker/md.ts), mounts it the
//     way the preview does (sanitizeToFragment + wrapCodeFences) into a live section;
//   · "session start" = the first serializeBlock(…, { editing: true }) on the fresh DOM (what
//     inlineEdit.begin() does for its baseline);
//   · "keystroke" = one character inserted into a text node of one item (what the browser does while
//     typing), then serializeBlock again (what inlineEdit.commit() does per flush);
//   · every keystroke's output is compared with the uncached one-pass serialization (byte-identical).
// Run: MDR_PORT=5273 node bench/verify/fixC-listperf.mjs   (own vite, killed at exit; global timeout 60 s)
// Numbers measured while other agents load the machine are indicative only. Dev build.
import { execSync, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.MDR_PORT) || 5273;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killPort = () => {
  try {
    const pids = execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
    for (const pid of pids.split(/\s+/).filter(Boolean)) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* */ } }
  } catch { /* */ }
};

let server = null, browser = null, failed = 0;
const timer = setTimeout(() => { console.log('FAIL  global timeout (60 s)'); cleanup(); process.exit(2); }, 60_000);
function cleanup() {
  if (server) { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* */ } try { server.kill('SIGKILL'); } catch { /* */ } }
  killPort();
}
process.on('exit', cleanup);

const SIZES = (process.env.MDR_LIST_SIZES ?? '300,1000').split(',').map(Number);
const KEYS = Number(process.env.MDR_KEYS ?? 60);

try {
  server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, BROWSER: 'none' } });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`vite exited early:\n${log}`);
    try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* */ }
    if (Date.now() > deadline) throw new Error(`vite not up on :${PORT}\n${log}`);
    await sleep(150);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  const res = await page.evaluate(async ({ sizes, keys }) => {
    const ser = await import('/src/preview/serialize.ts');
    const md = await import('/src/worker/md.ts');
    const san = await import('/src/preview/sanitize.ts');
    const cp = await import('/src/preview/createPreview.ts');
    const types = await import('/src/shared/types.ts');
    const mdk = md.createMarkdown({ ...types.DEFAULT_RENDER_OPTIONS, math: false });
    const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    const out = [];
    for (const n of sizes) {
      for (const shape of ['bullet', 'ordered', 'task', 'loose']) {
        const lines = Array.from({ length: n }, (_, i) => {
          const body = `列表项 ${i + 1}：这是一段用于测试序列化性能的中文文字 **粗体** 与 \`code\``;
          if (shape === 'ordered') return `${i + 1}. ${body}`;
          if (shape === 'task') return `- [${i % 3 ? ' ' : 'x'}] ${body}`;
          return `- ${body}`;
        });
        const src = lines.join(shape === 'loose' ? '\n\n' : '\n');
        const host = document.createElement('div');
        document.body.appendChild(host);
        const w = document.createElement('section');
        w.className = 'md-block';
        w.replaceChildren(san.sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
        cp.wrapCodeFences(w);
        host.appendChild(w);
        for (const e of Array.from(w.querySelectorAll('span, font'))) e.setAttribute('data-mdr-o', '');
        const hints = { editing: true };
        const t0 = performance.now();
        const base = ser.serializeBlock(w, types.BlockKind.List, hints);
        const start = performance.now() - t0;
        const u0 = performance.now();
        const unc = ser.serializeBlock(w, types.BlockKind.List, { ...hints, uncached: true });
        const uncachedMs = performance.now() - u0;
        let mismatches = base === unc ? 0 : 1;
        let firstMismatch = base === unc ? null : { base: base.slice(0, 200), unc: unc.slice(0, 200) };
        const roundTripsSource = base === src;
        const items = w.querySelectorAll(':scope > ul > li, :scope > ol > li');
        const target = items[Math.floor(n / 2)];
        const tn = Array.from(target.childNodes).find((c) => c.nodeType === 3) ?? target.querySelector('p')?.firstChild;
        const per = [];
        for (let k = 0; k < keys; k++) {
          tn.data = tn.data.slice(0, 6) + 'xyz'[k % 3] + tn.data.slice(6);
          const k0 = performance.now();
          const text = ser.serializeBlock(w, types.BlockKind.List, hints);
          per.push(performance.now() - k0);
          if (k % 10 === 0 || k === keys - 1) {
            const u = ser.serializeBlock(w, types.BlockKind.List, { ...hints, uncached: true });
            if (u !== text) { mismatches++; firstMismatch ??= { k, text: text.slice(0, 200), u: u.slice(0, 200) }; }
          }
        }
        host.remove();
        out.push({ n, shape, chars: src.length, start, uncachedMs, p50: pct(per, 0.5), p95: pct(per, 0.95), max: Math.max(...per), mismatches, firstMismatch, roundTripsSource });
      }
    }
    return out;
  }, { sizes: SIZES, keys: KEYS });
  const f = (x) => x.toFixed(2);
  for (const r of res) {
    const keyTarget = r.n <= 300 ? 10 : 30;
    const startTarget = r.n <= 300 ? 20 : Infinity;
    const ok = r.p95 <= keyTarget && r.start <= startTarget && r.mismatches === 0;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.n} items ${r.shape} (${r.chars} chars): session start ${f(r.start)} ms (target ${startTarget === Infinity ? 'info' : '≤ ' + startTarget}), keystroke p50/p95/max ${f(r.p50)} / ${f(r.p95)} / ${f(r.max)} ms (target p95 ≤ ${keyTarget}), one-pass uncached ${f(r.uncachedMs)} ms, cached == uncached: ${r.mismatches === 0 ? 'yes' : 'NO ' + JSON.stringify(r.firstMismatch)}, canonical source reproduced: ${r.roundTripsSource}`);
  }
} catch (err) {
  failed++;
  console.log('FAIL ', err instanceof Error ? err.stack : String(err));
} finally {
  clearTimeout(timer);
  try { await browser?.close(); } catch { /* */ }
  cleanup();
}
console.log(failed ? `RESULT: ${failed} failing` : 'RESULT: all pass');
process.exit(failed ? 1 : 0);
