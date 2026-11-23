// bench/verify/p13-leak.mjs — are evicted preview blocks leaked? large.md: after 100 preview jumps
// (many mounts + evictions) compare CDP Memory.getDOMCounters before/after Memory.prepareForLeakDetection
// + 3× HeapProfiler.collectGarbage; if detached nodes remain, take a heap snapshot, count nodes with
// detachedness === 2 by class name, and print retainer paths for a few detached elements.
import { BASE, launch, waitFirstVisible, waitIdle, dumpErrors, sleep, fmt } from './common.mjs';

const which = process.argv[2] ?? 'large';
const JUMPS = Number(process.argv[3] ?? 100);
const { browser, page, cdp, errors } = await launch();
const counters = async () => { const c = await cdp.send('Memory.getDOMCounters'); const st = await page.evaluate(() => ({ elements: document.getElementsByTagName('*').length, mounted: document.querySelectorAll('.md-block:not(.is-pending)').length })); return { ...c, ...st }; };
const gcHard = async () => { try { await cdp.send('Memory.prepareForLeakDetection'); } catch (e) { console.log('prepareForLeakDetection failed:', e.message.slice(0, 80)); } for (let i = 0; i < 3; i++) { await cdp.send('HeapProfiler.collectGarbage'); await sleep(300); } };
try {
  await page.goto(`${BASE}/?doc=/test-data/${which}.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 120_000);
  await waitIdle(page);
  await sleep(1000);
  await gcHard();
  const c0 = await counters();
  console.log(`[leak] after load: ${JSON.stringify(c0)}`);
  const lines = await page.evaluate(() => window.__mdr.app.editor.lineCount());
  for (let i = 1; i <= JUMPS; i++) { await page.evaluate((l) => window.__mdr.app.preview.scrollToLine(l, 0, 'instant'), Math.floor((lines * i) / JUMPS)); await sleep(120); }
  await waitIdle(page);
  await sleep(2500); // let idle eviction passes run
  const c1 = await counters();
  console.log(`[leak] after ${JUMPS} jumps (no GC): ${JSON.stringify(c1)}`);
  await gcHard();
  const c2 = await counters();
  console.log(`[leak] after ${JUMPS} jumps + prepareForLeakDetection + 3×GC: ${JSON.stringify(c2)}`);
  const detachedApprox = c2.nodes - c0.nodes;
  console.log(`[leak] nodes retained beyond the after-load baseline: ${detachedApprox} (elements in document ${c2.elements}, mounted ${c2.mounted})`);
  if (detachedApprox > 5000) {
    // heap snapshot
    const chunks = [];
    cdp.on('HeapProfiler.addHeapSnapshotChunk', (e) => chunks.push(e.chunk));
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
    const snap = JSON.parse(chunks.join(''));
    const meta = snap.snapshot.meta;
    const NF = meta.node_fields, EF = meta.edge_fields, nfc = NF.length, efc = EF.length;
    const nodes = snap.nodes, edges = snap.edges, strings = snap.strings;
    const iType = NF.indexOf('type'), iName = NF.indexOf('name'), iSize = NF.indexOf('self_size'), iEC = NF.indexOf('edge_count'), iDet = NF.indexOf('detachedness');
    const eType = EF.indexOf('type'), eName = EF.indexOf('name_or_index'), eTo = EF.indexOf('to_node');
    const nodeTypes = meta.node_types[0], edgeTypes = meta.edge_types[0];
    const N = nodes.length / nfc;
    const nName = (n) => strings[nodes[n * nfc + iName]];
    const nType = (n) => nodeTypes[nodes[n * nfc + iType]];
    // first edge index per node
    const firstEdge = new Uint32Array(N + 1);
    for (let n = 0; n < N; n++) firstEdge[n + 1] = firstEdge[n] + nodes[n * nfc + iEC];
    // reverse edges (CSR)
    const E = edges.length / efc;
    const inCount = new Uint32Array(N + 1);
    for (let e = 0; e < E; e++) inCount[edges[e * efc + eTo] / nfc + 1]++;
    for (let n = 0; n < N; n++) inCount[n + 1] += inCount[n];
    const inEdge = new Uint32Array(E), fill = inCount.slice();
    for (let n = 0; n < N; n++) for (let e = firstEdge[n]; e < firstEdge[n + 1]; e++) { const to = edges[e * efc + eTo] / nfc; inEdge[fill[to]++] = e; }
    const fromOf = new Uint32Array(E);
    for (let n = 0; n < N; n++) for (let e = firstEdge[n]; e < firstEdge[n + 1]; e++) fromOf[e] = n;
    // detached nodes by name
    const byName = new Map(); let detachedTotal = 0, detachedBytes = 0;
    const detachedIdx = [];
    for (let n = 0; n < N; n++) if (iDet >= 0 && nodes[n * nfc + iDet] === 2) { detachedTotal++; detachedBytes += nodes[n * nfc + iSize]; const k = nName(n); byName.set(k, (byName.get(k) ?? 0) + 1); if (detachedIdx.length < 20000) detachedIdx.push(n); }
    console.log(`[leak] heap snapshot: ${N} nodes, ${E} edges; detached DOM wrappers (detachedness=2): ${detachedTotal} (self ${fmt(detachedBytes / 1048576)} MB in V8 wrappers only)`);
    console.log(`[leak] detached by class: ${[...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join(', ')}`);
    // retainer paths: start from detached element nodes, walk up via non-weak edges to a non-detached, non-DOM retainer
    const edgeLabel = (e) => { const t = edgeTypes[edges[e * efc + eType]]; const ni = edges[e * efc + eName]; return t === 'element' || t === 'hidden' ? `[${ni}]` : `${t}:${strings[ni]}`; };
    const isDetached = (n) => iDet >= 0 && nodes[n * nfc + iDet] === 2;
    const seenPaths = new Map();
    let shown = 0;
    for (const start of detachedIdx) {
      if (!/^<|Element|Text|DocumentFragment|Attr/.test(nName(start))) continue;
      // BFS upward, max depth 8, skipping weak edges
      const q = [[start, []]]; const seen = new Set([start]); let found = null;
      while (q.length && !found) {
        const [n, path] = q.shift();
        if (path.length > 8) continue;
        for (let k = inCount[n]; k < inCount[n + 1]; k++) {
          const e = inEdge[k]; const t = edgeTypes[edges[e * efc + eType]]; if (t === 'weak') continue;
          const from = fromOf[e]; if (seen.has(from)) continue; seen.add(from);
          const p = [...path, `${nName(from)}(${nType(from)})${isDetached(from) ? '[detached]' : ''} --${edgeLabel(e)}--> `];
          if (!isDetached(from) && nType(from) !== 'native' && nType(from) !== 'synthetic' || nType(from) === 'synthetic') { found = p; break; }
          q.push([from, p]);
        }
      }
      if (found) { const key = found.map((s) => s.replace(/\[\d+\]/g, '[i]')).join(''); seenPaths.set(key, (seenPaths.get(key) ?? 0) + 1); }
      if (++shown >= 838) break;
    }
    console.log(`[leak] most common retainer paths (of ${shown} sampled detached elements; read right-to-left toward the detached node):`);
    for (const [k, v] of [...seenPaths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`   ×${v}: ${k.split(' --').reverse().join(' <-- ').slice(0, 600)}`);
  }
} finally {
  dumpErrors(errors);
  await browser.close();
}
