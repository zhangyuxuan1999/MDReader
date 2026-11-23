// bench/verify/fix2-g-walk.mjs — fix-gate (stage 2b): false refusals of the baseline fidelity gate (U12)
// over the project's own documents, on the real path in Chromium.
//
// For every block (or an evenly spread sample of a large file): click its first ordinary text (a block
// without one: its first formula / image / checkbox-free spot), record whether a session started; when not,
// whether the gate refused it (fidelityStats().refusals went up) or an earlier check did (kind, length,
// unsupportedReason, data-mdr-x); then Esc, and check that click + Esc wrote nothing (source and version).
// Prints the totals and, for every gate refusal, its kind, its line and the first difference between the
// two canonical forms.
//
// Needs a dev server already running on MDR_PORT (default 5316): this script never starts or stops one.
// A server that watches the tree reloads the page whenever a source file is saved; the script then boots
// the app again and retries the block (counted as "reloads"). For a stable snapshot start the server with a
// config that sets server: { hmr: false, watch: null } (root, base './' and worker.format 'es' as in vite.config.ts).
// Env: MDR_DOCS = comma list (default: the U12 corpus); MDR_SAMPLE = max blocks per file (default 1500,
// evenly spread); MDR_MODE = click (default) | direct (no clicks: serializeBlock + baselineFaithful on each
// mounted block — a fast pre-check, not the real path); MDR_OUT = JSON output; MDR_TIMEOUT ms (default 1500000).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from '@playwright/test';
import { makeHelpers, readRoot, sleep, stopServer } from './inline-verify-lib.mjs';

process.removeListener('exit', stopServer);       // the server is not ours to stop
process.removeAllListeners('SIGINT');
const PORT = Number(process.env.MDR_PORT) || 5316;
const BASE = `http://localhost:${PORT}`;
const MODE = process.env.MDR_MODE ?? 'click';
const SAMPLE = Number(process.env.MDR_SAMPLE ?? 1500);
const OUT = process.env.MDR_OUT ?? '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/fix2-g/walk.json';
const DOCS = (process.env.MDR_DOCS ?? 'README.md,docs/CONTRACT.md,docs/SPEC.md,docs/FINDINGS-inline-r1.md,docs/WIP-inline-edit.md,docs/FINDINGS-0.2.0-r1.md,test-data/small.md,test-data/medium.md').split(',');
const KIND = ['Prose', 'Heading', 'Code', 'Table', 'List', 'Quote', 'Html', 'Math', 'Hr'];

const out = { mode: MODE, docs: {}, totals: {}, gate: [], wrote: [], other: [], errors: [] };
try { mkdirSync(dirname(OUT), { recursive: true }); } catch { /* */ }
const dump = () => { try { writeFileSync(OUT, JSON.stringify(out, null, 2)); } catch { /* */ } };
let browser = null;
const TIMEOUT = setTimeout(async () => {
  console.log('GLOBAL TIMEOUT');
  dump();
  try { await browser?.close(); } catch { /* */ }
  process.exit(3);
}, Number(process.env.MDR_TIMEOUT ?? 1_500_000));

const bump = (k, n = 1) => { out.totals[k] = (out.totals[k] ?? 0) + n; };

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const B = makeHelpers(page);
  const BASEURL_CHECK = await fetch(`${BASE}/`).then((r) => r.ok).catch(() => false);
  if (!BASEURL_CHECK) throw new Error(`no dev server on ${BASE}`);
  // makeHelpers reads BASE from MDR_PORT; it must be ours
  if (Number(process.env.MDR_PORT) !== PORT) throw new Error('set MDR_PORT');
  // the app's own module instances (same URLs as the app imports)
  const attach = () => page.evaluate(async () => {
    window.__fg = {
      fid: await import('/src/preview/fidelity.ts'),
      ser: await import('/src/preview/serialize.ts'),
      ie: await import('/src/preview/inlineEdit.ts'),
    };
  });
  await B.boot('mode=split');
  await attach();
  out.reloads = 0;
  // ---- cost (U12 budget: ≤ 30 ms up to 10 000 characters, ≤ 150 ms at the 60 000 limit; once per session start)
  if (process.env.MDR_COST !== '0') {
    const list = Array.from({ length: 300 }, (_, i) => `- 第 ${i} 项 **粗** 与 [链接](https://e.example/${i}) 文字`).join('\n');
    const para = '这是一段很长的中文文字，含 **粗体** 与 `code` 以及 [链接](https://example.com)。'.repeat(1200).slice(0, 59990);
    const table = ['| a | b | c |', '|:--|:-:|--:|', ...Array.from({ length: 20 }, (_, i) => `| ${i} | **${i}** 与 $x_${i}$ | \`${i}\` |`)].join('\n');
    const para10k = para.slice(0, 10000);
    const parts = [['list300', list], ['para60k', para], ['para10k', para10k], ['table20', table]];
    const text = parts.map((p) => p[1]).join('\n\n') + '\n';
    await B.loadDoc(text, 'cost.md');
    const lines = []; let l = 1;
    for (const [, src] of parts) { lines.push(l); l += src.split('\n').length + 1; }
    out.cost = {};
    for (let i = 0; i < parts.length; i++) {
      await B.mountLine(lines[i]);
      const r = await page.evaluate(({ line }) => {
        const pv = window.__mdr.app.preview;
        const info = pv.blockAtLine(line);
        const el = pv.elementOfBlock(info.id);
        const { fid, ser } = window.__fg;
        const raw = window.__mdr.app.getText().split('\n').slice(info.startLine - 1, info.startLine - 1 + info.lineCount).join('\n').replace(/\n+$/, '');
        const base = ser.serializeBlock(el, info.kind, { ...ser.sourceStyleHints(raw), editing: true });
        const ms = [];
        let ok = true;
        for (let k = 0; k < 7; k++) { const t0 = performance.now(); ok = fid.baselineFaithful(el, info.kind, base) && ok; ms.push(performance.now() - t0); }
        ms.sort((a, b) => a - b);
        return { chars: raw.length, kind: info.kind, ok, first: ms[ms.length - 1], median: ms[3], max: ms[6] };
      }, { line: lines[i] });
      out.cost[parts[i][0]] = r;
      console.log(`COST ${parts[i][0]}: ${r.chars} chars, kind ${KIND[r.kind]}, faithful ${r.ok}, median ${r.median.toFixed(1)} ms, max ${r.max.toFixed(1)} ms`);
    }
  }
  /** A dev server that watches the tree reloads the page when another agent saves a file: boot again. */
  async function ensureApp(orig, name) {
    const ok = await page.evaluate(() => !!(window.__mdr && window.__fg)).catch(() => false);
    if (ok) return;
    out.reloads++;
    await sleep(1500);
    await B.boot('mode=split', false);
    await attach();
    await B.loadDoc(orig, name.split('/').pop());
  }
  for (const name of DOCS) {
    const text = readRoot(name);
    await B.loadDoc(text, name.split('/').pop());
    const orig = await B.source();
    const ol = orig.split('\n');
    let blocks = (await B.blocks()).filter((b) => ol.slice(b.startLine - 1, b.startLine - 1 + b.lineCount).some((l) => l.trim() !== ''));
    const all = blocks.length;
    if (blocks.length > SAMPLE) {
      const step = blocks.length / SAMPLE;
      blocks = Array.from({ length: SAMPLE }, (_, i) => blocks[Math.floor(i * step)]);
    }
    const doc = { blocks: all, walked: blocks.length, sessions: 0, gate: 0, earlier: {}, other: 0, noPoint: 0, wrote: 0 };
    out.docs[name] = doc;
    const t0 = Date.now();
    for (const b of blocks) {
      const label = `${name}:${b.startLine} ${KIND[b.kind]}`;
      for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await ensureApp(orig, name);
        if (MODE === 'direct') {
          await B.mountLine(b.startLine);
          const r = await page.evaluate(({ line }) => {
            const pv = window.__mdr.app.preview;
            const info = pv.blockAtLine(line);
            const el = pv.elementOfBlock(info.id);
            const { fid, ser, ie } = window.__fg;
            const raw = window.__mdr.app.getText().split('\n').slice(info.startLine - 1, info.startLine - 1 + info.lineCount);
            while (raw.length && raw[raw.length - 1].trim() === '') raw.pop();
            const content = raw.join('\n');
            if (![0, 1, 2, 3, 4, 5, 7].includes(info.kind)) return { earlier: 'kind' };
            if (content.length > ie.MAX_EDIT_CHARS) return { earlier: 'length' };
            const why = ser.unsupportedReason(el, content);
            if (why !== null) return { earlier: why };
            let fence;
            if (info.kind === 2) {
              const m = /^( {0,3})(`{3,}|~{3,})/.exec(raw[0]);
              if (m) {
                const ch = m[2][0];
                const re = new RegExp(`^ {0,3}\\${ch}{${m[2].length},}[ \\t]*$`);
                let close = null;
                for (let i = 1; i < raw.length; i++) if (re.test(raw[i])) { close = i === raw.length - 1 ? raw[i] : undefined; break; }
                fence = close === undefined ? undefined : { open: raw[0], close };
              } else if (/^( {4}|\t)/.test(raw[0])) fence = { indent: '    ' };
            }
            const hints = { ...ser.sourceStyleHints(content), fence, editing: true };
            const before = fid.fidelityStats().refusals;
            const base = ser.serializeBlock(el, info.kind, hints);
            const ok = fid.baselineFaithful(el, info.kind, base);
            return ok ? { ok } : { ok, last: fid.fidelityStats().last, refusalsBefore: before };
          }, { line: b.startLine });
          if (r.earlier) { doc.earlier[r.earlier] = (doc.earlier[r.earlier] ?? 0) + 1; break; }
          if (r.ok) { doc.sessions++; break; }
          doc.gate++;
          const m = r.last;
          out.gate.push({ block: label, src: ol.slice(b.startLine - 1, b.startLine - 1 + Math.min(b.lineCount, 6)).join('\n').slice(0, 400), baseline: m.baseline.slice(0, 400), shown: m.shown.slice(Math.max(0, m.at - 80), m.at + 120), rendered: m.rendered.slice(Math.max(0, m.at - 80), m.at + 120) });
          break;
        }
        // ---- click mode: the real path
        // A block off screen is brought in by scrollToLine, whose navigation anchor re-applies the line at the
        // top edge for 600 ms: let it expire, or the layout moves between taking the point and the click.
        const visible = await page.evaluate((line) => { const pv = window.__mdr.app.preview; const i = pv.blockAtLine(line); return pv.isLineVisible(line) && !!pv.elementOfBlock(i.id); }, b.startLine);
        if (!visible) { await B.mountLine(b.startLine); await sleep(650); }
        let pt = await B.textPoint(b.startLine, 'first');
        if (!pt) {
          pt = await page.evaluate((line) => {
            const pv = window.__mdr.app.preview;
            const el = pv.elementOfBlock(pv.blockAtLine(line).id);
            const t = el?.querySelector('.md-math, img, hr, td, th, li, p, pre, h1, h2, h3, h4, h5, h6');
            if (!t) return null;
            const r = t.getBoundingClientRect();
            return r.width > 0 ? { x: r.left + Math.min(4, r.width / 2), y: r.top + r.height / 2 } : null;
          }, b.startLine);
        }
        // the point must hit this block now (an Esc before may have re-rendered and moved the layout)
        const hits = (p) => page.evaluate(({ x, y, line }) => {
          const pv = window.__mdr.app.preview;
          const w = pv.elementOfBlock(pv.blockAtLine(line).id);
          const e = document.elementFromPoint(x, y);
          return !!(w && e && w.contains(e));
        }, { ...p, line: b.startLine });
        // (mountLine's scrollToLine keeps re-applying its line at the top edge for 600 ms, which undoes the
        // centring scroll of textPoint: wait for that anchor to expire and take the point again)
        for (let k = 0; pt && k < 3 && !(await hits(pt)); k++) { await sleep(700); pt = await B.textPoint(b.startLine, 'first'); }
        if (pt && !(await hits(pt))) { out.other.push(`${label}: the click point does not hit the block`); pt = null; }
        if (!pt) { doc.noPoint++; out.other.push(`${label}: no point to click`); break; }
        const s0 = await page.evaluate(() => ({ v: window.__mdr.version(), text: window.__mdr.app.getText(), ref: window.__fg.fid.fidelityStats().refusals, calls: window.__fg.fid.fidelityStats().calls }));
        await page.evaluate(() => getSelection().removeAllRanges());
        await page.mouse.click(pt.x, pt.y);
        let ed = null;
        for (let i = 0; i < 8 && !ed; i++) { await sleep(40); ed = await B.editing(); }
        const s1 = await page.evaluate(() => window.__fg.fid.fidelityStats());
        if (ed) {
          doc.sessions++;
          if (s1.calls === s0.calls) out.errors.push(`${label}: session without a gate call (module instance?)`);
          await page.keyboard.press('Escape');
        } else if (s1.refusals > s0.ref && s1.last.id !== String(b.id)) {
          if (attempt === 0) { await sleep(700); continue; }        // the click reached another block: once more
          doc.other++;
          out.other.push(`${label}: the click reached block ${s1.last.id} instead of ${b.id}`);
        } else if (s1.refusals > s0.ref) {
          doc.gate++;
          const m = s1.last;
          out.gate.push({ block: label, src: ol.slice(b.startLine - 1, b.startLine - 1 + Math.min(b.lineCount, 6)).join('\n').slice(0, 400), baseline: m.baseline.slice(0, 400), shown: m.shown.slice(Math.max(0, m.at - 80), m.at + 120), rendered: m.rendered.slice(Math.max(0, m.at - 80), m.at + 120) });
        } else {
          const why = await page.evaluate(({ line }) => {
            const pv = window.__mdr.app.preview;
            const info = pv.blockAtLine(line);
            const el = pv.elementOfBlock(info.id);
            const { ser, ie } = window.__fg;
            const raw = window.__mdr.app.getText().split('\n').slice(info.startLine - 1, info.startLine - 1 + info.lineCount);
            while (raw.length && raw[raw.length - 1].trim() === '') raw.pop();
            const content = raw.join('\n');
            if (![0, 1, 2, 3, 4, 5, 7].includes(info.kind)) return 'kind';
            if (el?.hasAttribute('data-mdr-x')) return 'data-mdr-x';
            if (content.length > ie.MAX_EDIT_CHARS) return 'length';
            const r = el ? ser.unsupportedReason(el, content) : 'unmounted';
            return r === null ? null : `unsupported:${r}`;
          }, { line: b.startLine });
          if (why) doc.earlier[why] = (doc.earlier[why] ?? 0) + 1;
          else {
            doc.other++;
            const at = await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName.toLowerCase()}${e.className ? '.' + String(e.className).split(' ')[0] : ''}` : 'none'; }, pt);
            out.other.push(`${label}: no session, no refusal (clicked ${at})`);
          }
        }
        await sleep(30);
        const s2 = await page.evaluate(() => ({ v: window.__mdr.version(), text: window.__mdr.app.getText() }));
        if (s2.text !== s0.text || s2.v !== s0.v) {
          doc.wrote++;
          out.wrote.push({ block: label, versions: [s0.v, s2.v], sameText: s2.text === s0.text });
          await B.loadDoc(orig, name.split('/').pop());
        }
        break;
      } catch (err) {
        const msg = String(err?.message ?? err).split('\n')[0];
        await page.keyboard.press('Escape').catch(() => {});
        if (attempt === 0 && /destroyed|navigation|reading 'app'|reading 'fid'|__fg|__mdr/.test(msg)) continue;   // a reload: once more
        out.errors.push(`${label}: ${msg}`);
        break;
      }
      }
    }
    for (const [k, v] of Object.entries(doc)) if (typeof v === 'number') bump(k, v);
    for (const [k, v] of Object.entries(doc.earlier)) bump(`earlier:${k}`, v);
    console.log(`DOC ${name}: ${all} blocks, walked ${doc.walked} in ${((Date.now() - t0) / 1000).toFixed(0)} s — sessions ${doc.sessions}, gate ${doc.gate}, earlier ${JSON.stringify(doc.earlier)}, other ${doc.other}, no point ${doc.noPoint}, wrote ${doc.wrote}`);
    dump();
  }
  out.pageErrors = pageErrors.slice(0, 10);
  console.log(`TOTAL ${JSON.stringify(out.totals)}`);
  for (const g of out.gate) console.log(`GATE ${g.block}\n  src      ${JSON.stringify(g.src)}\n  baseline ${JSON.stringify(g.baseline)}\n  shown    ${g.shown}\n  rendered ${g.rendered}`);
  for (const w of out.wrote) console.log(`WROTE ${w.block} ${JSON.stringify(w)}`);
  for (const o of out.other.slice(0, 40)) console.log(`OTHER ${o}`);
  for (const e of out.errors.slice(0, 40)) console.log(`ERROR ${e}`);
  console.log(`DONE gate ${out.gate.length} wrote ${out.wrote.length} errors ${out.errors.length} pageErrors ${pageErrors.length} reloads ${out.reloads}`);
} catch (err) {
  console.log(`FATAL ${err?.stack ?? err}`);
  process.exitCode = 2;
} finally {
  dump();
  clearTimeout(TIMEOUT);
  try { await browser?.close(); } catch { /* */ }
}
