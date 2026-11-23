// bench/verify/v3-fid-noop.mjs — verify-fidelity (0.2.0 stage 2c), U12 gate direction 2 in the DOCUMENT: for every
// block, a real click, type "Q", wait for the frame flush (the edit is written), Backspace (the baseline is written
// back: the serializer's normalised form of the untouched block), Esc. Then compare, in the live preview, the
// canonical form of the previous, the edited and the next block before and after (what the user sees around the
// edit), and check that no line outside the block changed (I2). A difference means the gate passed a baseline
// that renders differently in its document (references, neighbours, segmentation).
// Needs (or starts, detached, and leaves running) a Vite on MDR_PORT (v2-ses-lib.mjs). Writes only MDR_OUT.
// Env: MDR_DOCS (comma list, paths relative to the project root or absolute), MDR_OUT, MDR_TIMEOUT, MDR_SAMPLE.
import { writeFileSync } from 'node:fs';
import { openB, sleep, J, globalTimeout, readRoot } from './v2-ses-lib.mjs';

const DOCS = (process.env.MDR_DOCS ?? 'README.md').split(',');
const OUT = process.env.MDR_OUT ?? '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v3-fid/noop.json';
const SAMPLE = Number(process.env.MDR_SAMPLE ?? 400);
let B = null;
const out = { docs: {}, diffs: [], outside: [], errors: [] };
const dump = () => { try { writeFileSync(OUT, JSON.stringify(out, null, 2)); } catch { /* */ } };
const stop = globalTimeout(Number(process.env.MDR_TIMEOUT ?? 110_000), async () => { dump(); await B?.close(); });

/** Canonical form of the blocks from the one before `line` to the one after line `last` (the edited region,
 *  which a split may have turned into several blocks), joined. */
const around = (line, last) => B.page.evaluate(async ({ line, last }) => {
  const fid = await import('/src/preview/fidelity.ts');
  const pv = window.__mdr.app.preview;
  const n = window.__mdr.app.editor.view.state.doc.lines;
  const first = pv.blockAtLine(line);
  let l = line > 1 ? pv.blockAtLine(first.startLine - 1).startLine : first.startLine;
  const parts = [];
  let after = 0;
  while (l <= n) {
    const x = pv.blockAtLine(l);
    if (!x || x.id < 0 || x.lineCount < 1) break;
    const el = pv.elementOfBlock(x.id);
    parts.push(el ? fid.canonicalForm(el).replace(/<(\/?)del>/g, '<$1s>') : '(unmounted)');
    if (x.startLine > last) { if (++after >= 1) break; }
    l = x.startLine + x.lineCount;
  }
  return { parts: parts.join(''), start: first.startLine, count: first.lineCount };
}, { line, last });

try {
  B = await openB();
  await B.boot('mode=split');
  for (const name of DOCS) {
    const text = name.startsWith('/') ? (await import('node:fs')).readFileSync(name, 'utf8') : readRoot(name);
    await B.loadDoc(text, name.split('/').pop());
    const orig = await B.source();
    const ol = orig.split('\n');
    let blocks = (await B.blocks()).filter((b) => [0, 1, 3, 4, 5].includes(b.kind) && ol.slice(b.startLine - 1, b.startLine - 1 + b.lineCount).some((l) => l.trim() !== ''));
    if (blocks.length > SAMPLE) { const step = blocks.length / SAMPLE; blocks = Array.from({ length: SAMPLE }, (_, i) => blocks[Math.floor(i * step)]); }
    const d = { walked: 0, sessions: 0, wrote: 0, diffs: 0, outside: 0 };
    out.docs[name] = d;
    for (const b of blocks) {
      try {
        await B.loadDoc(orig, name.split('/').pop());
        await B.mountLine(b.startLine);
        await sleep(650);
        const before = await around(b.startLine, b.startLine + b.lineCount - 1);
        const pt = await B.textPoint(b.startLine, 'first');
        if (!pt) continue;
        d.walked++;
        await B.page.evaluate(() => getSelection().removeAllRanges());
        await B.page.mouse.click(pt.x, pt.y);
        let ed = null;
        for (let i = 0; i < 8 && !ed; i++) { await sleep(40); ed = await B.editing(); }
        if (!ed) continue;
        d.sessions++;
        await B.page.keyboard.type('Q');
        await sleep(150);
        await B.page.keyboard.press('Backspace');
        await sleep(150);
        await B.page.keyboard.press('Escape');
        await B.settle(300);
        const src = await B.source();
        if (src !== orig) d.wrote++;
        const nl = src.split('\n');
        // I2: the lines before the block and after it (counted from the end) are untouched
        const headOk = nl.slice(0, b.startLine - 1).join('\n') === ol.slice(0, b.startLine - 1).join('\n');
        const tailN = ol.length - (b.startLine - 1 + b.lineCount);
        const tailOk = nl.slice(nl.length - tailN).join('\n') === ol.slice(ol.length - tailN).join('\n');
        if (!headOk || !tailOk) { d.outside++; out.outside.push({ doc: name, line: b.startLine, before: ol.slice(b.startLine - 1, b.startLine - 1 + b.lineCount).join('\n'), after: src.slice(0, 2000) }); }
        await B.mountLine(b.startLine);
        await sleep(650);
        const after = await around(b.startLine, b.startLine + b.lineCount - 1 + (nl.length - ol.length));
        if (after.parts !== before.parts) {
          d.diffs++;
          out.diffs.push({ doc: name, line: b.startLine, srcBefore: ol.slice(b.startLine - 1, b.startLine - 1 + b.lineCount).join('\n').slice(0, 500), srcAfter: nl.slice(b.startLine - 1, b.startLine - 1 + b.lineCount + (nl.length - ol.length)).join('\n').slice(0, 500), before: before.parts.slice(0, 1500), after: after.parts.slice(0, 1500) });
        }
      } catch (err) {
        out.errors.push(`${name}:${b.startLine}: ${String(err?.message ?? err).split('\n')[0]}`);
        await B.page.keyboard.press('Escape').catch(() => {});
      }
    }
    console.log(`DOC ${name}: ${J(d)}`);
    dump();
  }
  for (const x of out.diffs) console.log(`DIFF ${x.doc}:${x.line}\n  src  ${J(x.srcBefore)}\n  now  ${J(x.srcAfter)}\n  was  ${J(x.before)}\n  is   ${J(x.after)}`);
  for (const x of out.outside) console.log(`OUTSIDE ${x.doc}:${x.line} ${J(x.before)}`);
  for (const e of out.errors.slice(0, 20)) console.log(`ERROR ${e}`);
  console.log(`DONE diffs ${out.diffs.length} outside ${out.outside.length} errors ${out.errors.length} pageErrors ${B.pageErrors.length}`);
} finally {
  dump();
  stop();
  await B?.close();
}
