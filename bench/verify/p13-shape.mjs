// bench/verify/p13-shape.mjs — what drives the ~200 MB-per-keystroke renderer growth seen on
// huge.md? Builds synthetic documents that vary LINE COUNT and BYTE SIZE independently, loads each
// via __mdr.loadText, samples the renderer footprint after load and after 5 keystrokes mid-document.
// Usage: node bench/verify/p13-shape.mjs
import { execSync } from 'node:child_process';
import { BASE, launch, warmUp, waitIdle, memory, dumpErrors, sleep, fmt } from './common.mjs';

const { browser, page, cdp, errors } = await launch();
const bcdp = await browser.newBrowserCDPSession();
const rendererPids = async () => (await bcdp.send('SystemInfo.getProcessInfo')).processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
function fp() {
  return rendererPids().then((pids) => {
    const rows = execSync('ps -axo pid,rss,command').toString().split('\n').slice(1)
      .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
      .map((m) => ({ pid: +m[1], rssMB: +m[2] / 1024 })).filter((r) => pids.includes(r.pid));
    return rows.map((r) => {
      let v = r.rssMB;
      try { const m = execSync(`footprint ${r.pid} 2>/dev/null`).toString().match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/); if (m) v = +m[1] * (m[2] === 'GB' ? 1024 : m[2] === 'KB' ? 1 / 1024 : 1); } catch {}
      return v;
    }).sort((a, b) => b - a)[0] ?? 0;
  });
}
async function gcSample() {
  try { await cdp.send('HeapProfiler.collectGarbage'); } catch {}
  await sleep(1200);
  const m = await memory(page, cdp);
  return { fp: await fp(), heap: m.jsHeapUsedMB, nodes: m.nodes };
}

// paragraph blocks of `lineLen` chars, `lines` lines total (blank line every 4 lines)
function makeDoc(lines, lineLen) {
  const body = 'x'.repeat(Math.max(1, lineLen));
  const out = [];
  for (let i = 0; i < lines; i++) out.push(i % 4 === 3 ? '' : `${body} ${i}`);
  return out.join('\n');
}

const CASES = [
  { name: 'A 340k lines x 18 B  (~6.5 MB, huge-shaped)', lines: 340000, len: 18 },
  { name: 'B  34k lines x 190 B (~6.5 MB, same bytes)', lines: 34000, len: 190 },
  { name: 'C 340k lines x 1 B   (~1.0 MB, same lines)', lines: 340000, len: 1 },
  { name: 'D 100k lines x 18 B  (~1.9 MB, large-shaped)', lines: 100000, len: 18 },
];

try {
  await warmUp(page);
  for (const c of CASES) {
    const text = makeDoc(c.lines, c.len);
    await page.goto(`${BASE}/?mode=split`);
    await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
    await page.evaluate((t) => window.__mdr.loadText(t, 'shape.md'), text);
    await waitIdle(page).catch(() => {});
    await sleep(2500);
    const a = await gcSample();
    await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), Math.floor(c.lines / 2));
    await sleep(800);
    await page.keyboard.type('abcde', { delay: 120 });
    await sleep(1500);
    const b = await gcSample();
    await sleep(8000);
    const d = await gcSample();
    const blocks = await page.evaluate(() => window.__mdr.app.preview.blockCount());
    console.log(`[${c.name}] bytes ${(text.length / 1048576).toFixed(1)} MB, blocks ${blocks} — footprint after load ${a.fp.toFixed(0)} MB → after 5 keys ${b.fp.toFixed(0)} MB → after 8 s idle ${d.fp.toFixed(0)} MB (Δ ${(d.fp - a.fp).toFixed(0)} MB); page JS heap ${fmt(a.heap)} → ${fmt(d.heap)} MB`);
  }
} finally {
  dumpErrors(errors);
  await browser.close();
}
