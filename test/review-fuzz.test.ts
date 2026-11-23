// test/review-fuzz.test.ts — verifier: randomised edits through the real render core, cross-checked
// against a from-scratch segmentation / stats / outline / render of the same text.
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { flattenChanges } from '../src/editor/changes';
import { unpackHtml } from '../src/shared/protocol';
import {
  B_ID, B_KIND, B_LINES, B_START, BLOCK_STRIDE, DEFAULT_RENDER_OPTIONS,
  type FromWorker, type HtmlMsg, type StructureMsg, type StructureDeltaMsg, type OutlineEntry,
} from '../src/shared/types';
import { createRenderCore } from '../src/worker/core';
import { segmentAll, buildBlocks } from '../src/worker/segmenter';
import { blockCounts } from '../src/worker/stats';
import { buildOutline } from '../src/worker/outline';

// ---------------------------------------------------------------- deterministic PRNG
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x1234567) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)];

const WORDS = ['alpha', 'beta', 'gamma', '中文', '测试', 'δ', 'x', 'link', '[ref]', '[ref2][ref]', 'a*b*', '`c`', '$e=mc^2$', 'foo-bar', "it's"];
function genLine(r: () => number): string {
  const n = 1 + Math.floor(r() * 6);
  const ws: string[] = [];
  for (let i = 0; i < n; i++) ws.push(pick(r, WORDS));
  return ws.join(' ');
}
function genDoc(r: () => number, blocks: number): string {
  const out: string[] = [];
  for (let b = 0; b < blocks; b++) {
    const k = r();
    if (k < 0.2) out.push(`${'#'.repeat(1 + Math.floor(r() * 3))} ${genLine(r)}`);
    else if (k < 0.3) out.push('```' + pick(r, ['', 'js', 'ts']), genLine(r), genLine(r), '```');
    else if (k < 0.4) out.push(`- ${genLine(r)}`, `- [ ] ${genLine(r)}`, `  - ${genLine(r)}`);
    else if (k < 0.48) out.push(`> ${genLine(r)}`, `> ${genLine(r)}`);
    else if (k < 0.55) out.push(`| a | b |`, `|---|---|`, `| ${genLine(r)} | 1 |`);
    else if (k < 0.6) out.push(`[ref]: https://example.com/${Math.floor(r() * 3)} "t"`);
    else if (k < 0.65) out.push('$$', 'x^2', '$$');
    else if (k < 0.7) out.push('<!--', 'hidden', '-->');
    else if (k < 0.75) out.push(genLine(r), pick(r, ['===', '---']));
    else if (k < 0.8) out.push('---');
    else if (k < 0.85) out.push('~~~', genLine(r), '~~~');
    else out.push(genLine(r), genLine(r));
    const blanks = Math.floor(r() * 3);
    for (let i = 0; i < blanks; i++) out.push(pick(r, ['', ' ', '\t']));
  }
  return out.join('\n');
}

const INSERTS = ['\n', '\n\n', '# ', '```\n', '```', '- ', '> ', '$$', '$$\n', '[ref]: https://z.z\n', '---\n', '===\n', '|', '<!--', '-->', 'x', '中', ' ', '\t', '[ref]', '<pre>', '</pre>', '* * *', '1. '];

function randomChanges(r: () => number, doc: Text): ChangeSet {
  const n = 1 + Math.floor(r() * 3);
  const specs: { from: number; to: number; insert: string }[] = [];
  const len = doc.length;
  const used: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    let from = Math.floor(r() * (len + 1));
    let to = r() < 0.5 ? from : Math.min(len, from + Math.floor(r() * 40));
    if (r() < 0.05) { from = 0; to = len; }
    if (used.some(([a, b]) => from <= b && to >= a)) continue;
    used.push([from, to]);
    const insert = r() < 0.3 ? '' : r() < 0.7 ? pick(r, INSERTS) : genLine(r);
    specs.push({ from, to, insert });
  }
  if (specs.length === 0) specs.push({ from: 0, to: 0, insert: 'y' });
  return ChangeSet.of(specs, len);
}

// ---------------------------------------------------------------- core harness
let seed_math = true;
function harness() {
  const msgs: FromWorker[] = [];
  const core = createRenderCore((m) => { msgs.push(m); });
  let cursor = 0;
  const api = {
    core, msgs,
    take(): FromWorker[] { const out = msgs.slice(cursor); cursor = msgs.length; return out; },
    async drain(): Promise<FromWorker[]> {
      const deadline = Date.now() + 20000;
      const from = cursor;
      for (;;) {
        await new Promise((res) => setTimeout(res, 1));
        if (msgs.slice(from).some((m) => m.type === 'idle')) break;
        if (Date.now() > deadline) throw new Error('no idle within 20 s; last: ' + JSON.stringify(msgs.slice(-6).map((m) => [m.type, (m as { version?: number }).version])) + ' from=' + from + ' len=' + msgs.length);
      }
      return api.take();
    },
  };
  core.handle({ type: 'init', options: { ...DEFAULT_RENDER_OPTIONS, math: seed_math } });
  return api;
}

const structures = (ms: FromWorker[]) => ms.filter((m): m is StructureMsg => m.type === 'structure');
const anyStructure = (ms: FromWorker[]) =>
  ms.filter((m): m is StructureMsg | StructureDeltaMsg => m.type === 'structure' || m.type === 'structureDelta');
const htmls = (ms: FromWorker[]) => ms.filter((m): m is HtmlMsg => m.type === 'html');

/** Mirror of the preview's persistent structure array (CONTRACT §7): full resets, delta splices. */
function applyStruct(prev: number[], m: StructureMsg | StructureDeltaMsg): number[] {
  if (m.type === 'structure') return Array.from(m.blocks);
  const tail = prev.slice((m.index + m.removed) * BLOCK_STRIDE);
  if (m.lineDelta !== 0) for (let o = B_START; o < tail.length; o += BLOCK_STRIDE) tail[o] += m.lineDelta;
  return prev.slice(0, m.index * BLOCK_STRIDE).concat(Array.from(m.inserted), tail);
}

/** `edit` is queued and flushed in one task now: wait for the structure of that version. */
async function waitStructure(msgs: FromWorker[], version: number): Promise<void> {
  const deadline = Date.now() + 20000;
  for (;;) {
    if (msgs.some((m) => (m.type === 'structure' || m.type === 'structureDelta') && m.version === version)) return;
    if (Date.now() > deadline) throw new Error('no structure for version ' + version);
    await new Promise((r) => setTimeout(r, 1));
  }
}

interface Blk { id: number; start: number; count: number; kind: number }
function parse(s: StructureMsg): Blk[] {
  return parseArr(Array.from(s.blocks));
}
function parseArr(arr: number[]): Blk[] {
  const out: Blk[] = [];
  for (let o = 0; o < arr.length; o += BLOCK_STRIDE) out.push({ id: arr[o + B_ID], start: arr[o + B_START], count: arr[o + B_LINES], kind: arr[o + B_KIND] });
  return out;
}

function freshStats(lines: string[], blocks: Blk[]) {
  let chars = 0, charsNoSpace = 0, cjk = 0, latinWords = 0;
  for (const b of blocks) {
    const src = lines.slice(b.start - 1, b.start - 1 + b.count).join('\n');
    const c = blockCounts(src);
    chars += c.chars; charsNoSpace += c.charsNoSpace; cjk += c.cjk; latinWords += c.latinWords;
  }
  return { chars: blocks.length ? chars - 1 : 0, charsNoSpace, cjk, latinWords };
}

async function renderAll(text: string): Promise<Map<string, string>> {
  const h = harness();
  h.core.handle({ type: 'setDoc', docId: 'x', version: 1, text });
  const s = structures(h.take())[0];
  const blocks = parse(s);
  h.core.handle({ type: 'viewport', firstLine: 1, lastLine: Math.max(1, s.lineCount) });
  h.core.handle({ type: 'need', ids: blocks.map((b) => b.id) });
  const ms = await h.drain();
  const byId = new Map<number, string>();
  for (const m of htmls(ms)) for (const it of unpackHtml(m.batch)) byId.set(it.id, it.payload);
  const out = new Map<string, string>();
  for (const b of blocks) out.set(`${b.start}:${b.count}`, byId.get(b.id) ?? '<<missing>>');
  return out;
}

async function runFuzz(seed: number, steps: number, blocks: number) {
  const r = rng(seed);
  let text = genDoc(r, blocks);
  let doc = Text.of(text.split('\n'));
  const h = harness();
  h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text });
  let msgs = h.take();
  let arr = Array.from(structures(msgs)[0].blocks);
  let prev = parseArr(arr);
  let prevLines = text.split('\n');
  let version = 1;
  let outline: OutlineEntry[] = (msgs.find((m) => m.type === 'outline') as { items: OutlineEntry[] } | undefined)?.items ?? [];

  for (let step = 0; step < steps; step++) {
    const cs = randomChanges(r, doc);
    const changes = flattenChanges(cs);
    doc = cs.apply(doc);
    text = doc.toString();
    const lines = text === '' ? [] : text.split('\n');
    version++;
    h.core.handle({ type: 'edit', version, changes });
    await waitStructure(h.msgs, version);
    msgs = h.take();
    const s = anyStructure(msgs);
    expect(s.length, `step ${step} seed ${seed}: one structure per edit`).toBe(1);
    arr = applyStruct(arr, s[0]);
    const got = parseArr(arr);
    const ctx = `seed ${seed} step ${step} changes ${JSON.stringify(changes)}\nTEXT:\n${text}`;

    // 1. segmentation equals a from-scratch scan
    const want = segmentAll(lines).map((g) => ({ start: g.start + 1, count: g.count, kind: g.kind }));
    expect(got.map((b) => ({ start: b.start, count: b.count, kind: b.kind })), ctx).toEqual(want);
    expect(s[0].lineCount, ctx).toBe(lines.length);
    // ids unique
    expect(new Set(got.map((b) => b.id)).size, ctx).toBe(got.length);

    // 2. stats equal a from-scratch computation
    const fs = freshStats(lines, got);
    expect({ chars: s[0].stats.chars, charsNoSpace: s[0].stats.charsNoSpace, cjk: s[0].stats.cjk, latinWords: s[0].stats.latinWords }, ctx).toEqual(fs);

    // 3. changed ⊇ every surviving id whose source changed
    const changed = new Set(Array.from(s[0].changed));
    const prevById = new Map(prev.map((b) => [b.id, b]));
    for (const b of got) {
      const src = lines.slice(b.start - 1, b.start - 1 + b.count).join('\n');
      const p = prevById.get(b.id);
      if (!p) { expect(changed.has(b.id), `${ctx}\nnew id ${b.id} not in changed`).toBe(true); continue; }
      const psrc = prevLines.slice(p.start - 1, p.start - 1 + p.count).join('\n');
      if (psrc !== src) expect(changed.has(b.id), `${ctx}\nid ${b.id} content changed but not in changed\nOLD:${psrc}\nNEW:${src}`).toBe(true);
    }

    // 4. outline equals a from-scratch build
    const om = msgs.find((m) => m.type === 'outline') as { items: OutlineEntry[] } | undefined;
    if (om) outline = om.items;
    const freshBlocks = buildBlocks(lines, (() => { let n = 1; return () => n++; })());
    const wantOutline = buildOutline(freshBlocks, lines).entries.map((e) => ({ level: e.level, text: e.text, slug: e.slug, line: e.line }));
    expect(outline.map((e) => ({ level: e.level, text: e.text, slug: e.slug, line: e.line })), ctx).toEqual(wantOutline);

    prev = got;
    prevLines = lines;
  }

  // 5. rendered HTML of every block equals a fresh render of the final text
  const finalBlocks = prev;
  h.core.handle({ type: 'viewport', firstLine: 1, lastLine: Math.max(1, prevLines.length) });
  h.core.handle({ type: 'need', ids: finalBlocks.map((b) => b.id) });
  const ms = await h.drain();
  const byId = new Map<number, string>();
  for (const m of htmls(ms)) for (const it of unpackHtml(m.batch)) byId.set(it.id, it.payload);
  const fresh = await renderAll(text);
  for (const b of finalBlocks) {
    const key = `${b.start}:${b.count}`;
    expect(byId.get(b.id) ?? '<<missing>>', `seed ${seed} html mismatch at block ${key} (id ${b.id})\nTEXT:\n${text}`).toBe(fresh.get(key));
  }
}

// Test strategy (CONTRACT §11 decision T1): every 7th seed by default (43 seeds; 7 and 25 are coprime, so
// every document size 10 + seed % 25 still occurs), all 300 only with MDR_FULL_FUZZ=1.
const SEED_STEP = process.env.MDR_FULL_FUZZ === '1' ? 1 : 7;
describe('review: randomised edit fuzz through createRenderCore', () => {
  for (let seed = 1; seed <= 300; seed += SEED_STEP) {
    it(`seed ${seed}`, async () => {
      await runFuzz(seed, 120, 10 + (seed % 25));
    }, 30_000);
  }
});
