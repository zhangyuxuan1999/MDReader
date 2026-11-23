// @vitest-environment jsdom
// test/review-mount-distance.test.ts — verifier: the MountQueue flush must not read layout per queued item.
// It asks the preview for the centre index once per flush, and the preview answers from the model (the index
// updateWindow already computed for this frame) — so a flush reads scrollTop zero times. Counts the reads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreview } from '../src/preview/createPreview';
import { createBus } from '../src/shared/bus';
import { packHtml } from '../src/shared/protocol';
import { BLOCK_STRIDE, B_ID, B_KIND, B_LINES, B_START, BlockKind, type StructureMsg } from '../src/shared/types';

function structure(n: number, version = 1): StructureMsg {
  const blocks = new Int32Array(n * BLOCK_STRIDE);
  const changed = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    blocks[i * BLOCK_STRIDE + B_ID] = i + 1;
    blocks[i * BLOCK_STRIDE + B_START] = i + 1;
    blocks[i * BLOCK_STRIDE + B_LINES] = 1;
    blocks[i * BLOCK_STRIDE + B_KIND] = BlockKind.Prose;
    changed[i] = i + 1;
  }
  return { type: 'structure', version, blocks, changed, lineCount: n, outlineVersion: 0, stats: { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: n, readingMinutes: 0 } };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'requestIdleCallback', 'cancelIdleCallback'] }); });
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe('review: mount queue ordering reads', () => {
  it('counts scrollTop reads while flushing one 100-item batch', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const preview = createPreview({ parent, bus: createBus(), request: () => {}, viewport: () => {} });
    Object.defineProperty(preview.el, 'clientHeight', { value: 800, configurable: true });
    let reads = 0;
    Object.defineProperty(preview.el, 'scrollTop', { get: () => { reads++; return 0; }, set: () => {}, configurable: true });
    preview.applyStructure(structure(100));
    vi.advanceTimersByTime(50);   // wrappers + window
    const items = [];
    for (let i = 0; i < 100; i++) items.push({ id: i + 1, flags: 0, payload: `<p>${i}</p>` });
    const { batch } = packHtml(items);
    reads = 0;
    preview.applyHtml({ type: 'html', version: 1, batch });
    vi.advanceTimersByTime(20);   // one flush frame
    const mounted = preview.el.querySelectorAll('.md-block:not(.is-pending)').length;
    // eslint-disable-next-line no-console
    console.log(`review-mount-distance: scrollTop reads during flush = ${reads}, mounted = ${mounted}`);
    expect(mounted).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(2);   // was 72 for a 24-block flush; the centre now comes from the model
    preview.dispose();
  });
});
