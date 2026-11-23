// @vitest-environment jsdom
// test/review-export-xss.test.ts — verifier (fixed): the live preview sanitizes every block with DOMPurify;
// exportHtml (core.ts → md.renderDocument → App.buildExportDocument) must run the same sanitizer over the
// exported body so <script>, on* handlers and javascript: URLs never reach the downloaded document.
import { describe, expect, it } from 'vitest';
import { createRenderCore } from '../src/worker/core';
import { DEFAULT_RENDER_OPTIONS, type FromWorker } from '../src/shared/types';
import { buildExportDocument } from '../src/app/App';

async function exportOf(text: string): Promise<string> {
  const msgs: FromWorker[] = [];
  const core = createRenderCore((m) => { msgs.push(m); });
  core.handle({ type: 'init', options: { ...DEFAULT_RENDER_OPTIONS, math: false } });
  core.handle({ type: 'setDoc', docId: 'd', version: 1, text });
  core.handle({ type: 'exportHtml', requestId: 1 });
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 5));
    const m = msgs.find((x) => x.type === 'exportHtml');
    if (m && m.type === 'exportHtml') return m.html;
  }
  throw new Error('no exportHtml reply');
}

describe('review: exported HTML is not sanitized', () => {
  it('strips <script>, inline event handlers and javascript: links like the preview does', async () => {
    const md = [
      '# t', '',
      '<script>alert(1)</script>', '',
      '<img src=x onerror="alert(2)">', '',
      '[click](javascript:alert(3))', '',
      '<iframe src="https://example.com"></iframe>',
    ].join('\n');
    const html = await exportOf(md);
    const doc = buildExportDocument({ title: 't', html, css: '', theme: 'light' });
    const body = doc.slice(doc.indexOf('<article'));
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).not.toMatch(/onerror=/i);
    expect(body).not.toMatch(/href="javascript:/i);
    expect(body).not.toContain('<iframe');
  });
});
