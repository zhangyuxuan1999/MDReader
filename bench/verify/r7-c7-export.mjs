// bench/verify/r7-c7-export.mjs — challenge-7 (round 7): 导出 HTML (App.ts buildExportDocument / exportBody, Checkpoint I
// "the export") over GENERATED documents. Two pages on the same dev server (MDR_PORT): the tree, and the frozen copy of the
// released 0.2.0 (test/fixtures/src-0.2.0, the page's entry rewritten, as bench/verify/r7-fp-export.mjs does). Every
// document of the trust generator (bench/verify/v4-tru-gen.mjs, documents from..from+n-1 of a seed, mode 0) is loaded and
// exported through the real command; when the frozen copy exports it, the tree's file must be byte-identical; when the
// frozen copy fails (the sanitizer threw), the tree must export, with no raw processing instruction, script, on* attribute
// or javascript: URL outside the md-error boxes. Then every 7th document again with a processing instruction named form
// planted in one of its paragraphs (mode "plant"): the same checks.
//   MDR_PORT=5465 node bench/verify/r7-c7-export.mjs <documents> <seed> [from] [plant]
// Global timeout T_MS (default 110 000; it stops early and prints how far it got). Writes nothing in the tree.
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import * as gen from './v4-tru-gen.mjs';

const PORT = process.env.MDR_PORT || '5465';
const N = Number(process.argv[2] ?? 200), SEED = Number(process.argv[3] ?? 11), FROM = Number(process.argv[4] ?? 0);
const PLANT = process.argv[5] === 'plant';
const T_MS = Number(process.env.T_MS ?? 110_000);
const t0 = Date.now();
let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, T_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(which) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, acceptDownloads: true });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  if (which === 'frozen') {
    await page.route(`http://localhost:${PORT}/?*`, async (route) => {
      const r = await route.fetch();
      await route.fulfill({ response: r, body: (await r.text()).replace('/src/main.ts', '/test/fixtures/src-0.2.0/main.ts') });
    });
  }
  await page.goto(`http://localhost:${PORT}/?mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable?.(false));
  const entry = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /main\.ts/.test(n)));
  return { page, errs, entry };
}
async function exportOf({ page }, text) {
  await page.evaluate(({ t }) => window.__mdr.loadText(t, 'doc.md'), { t: text });
  await page.evaluate(() => window.__mdr.waitIdle());
  await page.evaluate(() => document.querySelectorAll('.mdr-toast').forEach((t) => t.remove()));
  const dl = page.waitForEvent('download', { timeout: 4000 }).catch(() => null);
  await page.evaluate(() => window.__mdr.app.registry.run('file.exportHtml'));
  const d = await dl;
  let file = null;
  if (d) { const p = await d.path(); file = readFileSync(p, 'utf8'); }
  await sleep(30);
  const toast = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-toast')).map((t) => t.textContent).join(' | '));
  return { file, toast };
}
const bodyOf = (f) => f.slice(f.indexOf('<article'), f.lastIndexOf('</article>'));
const ERR_RE = /<div class="md-error"><p>[^<]*<\/p><pre>[^<]*<\/pre><\/div>/g;
function plant(doc, k) {
  const parts = doc.split('\n\n');
  const i = k % parts.length;
  parts[i] = parts[i] + ' <?form ?>';
  return parts.join('\n\n');
}

const T = { docs: 0, identical: 0, differ: 0, frozenFailed: 0, treeFailed: 0, unsafe: 0, boxes: 0 };
const diffs = [];
try {
  browser = await chromium.launch({ headless: true });
  const tree = await open('tree');
  const frozen = await open('frozen');
  console.log('entries', JSON.stringify(tree.entry), JSON.stringify(frozen.entry));
  const r = gen.rng(SEED + FROM * 7919);
  for (let i = FROM; i < FROM + N; i++) {
    if (Date.now() - t0 > T_MS - 8000) { console.log(`STOPPED at document ${i}`); break; }
    let doc = gen.generate(r, 0);
    if (PLANT) { if (i % 7 !== 0) continue; doc = plant(doc, i); }
    T.docs++;
    const a = await exportOf(tree, doc);
    const b = await exportOf(frozen, doc);
    if (a.file === null) { T.treeFailed++; diffs.push({ i, kind: 'tree failed', toast: a.toast, frozen: b.toast }); continue; }
    if (b.file !== null) {
      if (a.file === b.file) T.identical++;
      else { T.differ++; let at = 0; while (a.file[at] === b.file[at]) at++; diffs.push({ i, kind: 'differ', at, tree: a.file.slice(at - 40, at + 80), frozen: b.file.slice(at - 40, at + 80) }); }
      continue;
    }
    T.frozenFailed++;
    const body = bodyOf(a.file);
    const nb = (body.match(ERR_RE) ?? []).length;
    T.boxes += nb;
    if (nb === 0) diffs.push({ i, kind: 'no box (informational)', doc: doc.slice(0, 400) });
    const outside = body.replace(ERR_RE, '');
    if (/<\?|<script|<iframe|\son[a-z]+\s*=|javascript:/i.test(outside)) { T.unsafe++; diffs.push({ i, kind: 'unsafe', outside: outside.slice(0, 300) }); }
  }
  console.log(`r7-c7-export: seed ${SEED} from ${FROM} n ${N}${PLANT ? ' plant' : ''} ${JSON.stringify(T)} page errors tree ${tree.errs.length} frozen ${frozen.errs.length} ${Date.now() - t0} ms`);
  for (const d of diffs.slice(0, 10)) console.log('DIFF', JSON.stringify(d));
  const bad = T.differ + T.treeFailed + T.unsafe + tree.errs.length;
  console.log(bad ? `RESULT FAIL (${bad})` : 'RESULT PASS');
  process.exitCode = bad ? 1 : 0;
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  process.exitCode = 2;
} finally {
  clearTimeout(killer);
  try { await browser?.close(); } catch { /* */ }
}
