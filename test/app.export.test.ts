// @vitest-environment jsdom
// test/app.export.test.ts — standalone HTML export (sanitized body, inlined stylesheets, no CDN stylesheet)
// and the mode-switch position plan.
import { describe, expect, it, vi } from 'vitest';
import { buildExportDocument, createProgressTracker, hasMath, planModeSwitch, relocateKatexFonts } from '../src/app/App';

describe('buildExportDocument', () => {
  it('inlines the CSS, never links an external stylesheet, and escapes the title', () => {
    const doc = buildExportDocument({ title: 'a<b>&"c"', html: '<p>hi</p>', css: '.x{color:var(--mdr-fg)}', theme: 'dark' });
    expect(doc).toContain('<style>.x{color:var(--mdr-fg)}');
    expect(doc).not.toContain('<link');
    expect(doc).not.toContain('cdn.jsdelivr.net');
    expect(doc).toContain('<title>a&lt;b&gt;&amp;&quot;c&quot;</title>');
    expect(doc).toContain('data-theme="dark"');
    expect(doc).toContain('<article class="mdr-preview__body markdown-body"><p>hi</p></article>');
  });

  it('sanitizes the exported body with the preview configuration', () => {
    const html = '<p>ok</p><script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">x</a><iframe src="https://e.org"></iframe>';
    const doc = buildExportDocument({ title: 't', html, css: '', theme: 'light' });
    const body = doc.slice(doc.indexOf('<article'));
    expect(body).toContain('<p>ok</p>');
    expect(body).not.toContain('<script');
    expect(body).not.toMatch(/onerror=/i);
    expect(body).not.toMatch(/href="javascript:/i);
    expect(body).not.toContain('<iframe');
  });

  it('keeps KaTeX markup and detects it', () => {
    const html = '<p><span class="katex"><span class="katex-html" aria-hidden="true">E=mc</span></span></p>';
    expect(hasMath(html)).toBe(true);
    expect(hasMath('<p>plain</p>')).toBe(false);
    expect(buildExportDocument({ title: 't', html, css: '', theme: 'light' })).toContain('class="katex-html"');
  });
});

describe('relocateKatexFonts', () => {
  it('points every font face at the versioned CDN, for dev paths and hashed build paths alike', () => {
    const css =
      "@font-face{font-family:KaTeX_AMS;src:url(/node_modules/katex/dist/fonts/KaTeX_AMS-Regular.woff2) format(\"woff2\")," +
      "url('/assets/KaTeX_Size1-Regular-BQhdFMY1.woff') format(\"woff\"),url(fonts/KaTeX_Main-BoldItalic.ttf) format(\"truetype\")}";
    const out = relocateKatexFonts(css);
    expect(out).toContain('url(https://cdn.jsdelivr.net/npm/katex@0.18.5/dist/fonts/KaTeX_AMS-Regular.woff2)');
    expect(out).toContain('url(https://cdn.jsdelivr.net/npm/katex@0.18.5/dist/fonts/KaTeX_Size1-Regular.woff)');
    expect(out).toContain('url(https://cdn.jsdelivr.net/npm/katex@0.18.5/dist/fonts/KaTeX_Main-BoldItalic.ttf)');
    expect(out).not.toContain('/node_modules/');
    expect(out).not.toContain('/assets/');
  });
});

describe('planModeSwitch', () => {
  it('captures from the pane that was visible and positions the pane the user will look at', () => {
    expect(planModeSwitch('split', 'preview')).toEqual({ master: 'editor', follower: 'preview' });
    expect(planModeSwitch('split', 'edit')).toEqual({ master: 'editor', follower: 'editor' });
    expect(planModeSwitch('preview', 'edit')).toEqual({ master: 'preview', follower: 'editor' });
    expect(planModeSwitch('preview', 'split')).toEqual({ master: 'preview', follower: 'editor' });
    expect(planModeSwitch('edit', 'split')).toEqual({ master: 'editor', follower: 'preview' });
    expect(planModeSwitch('edit', 'preview')).toEqual({ master: 'editor', follower: 'preview' });
  });
});

describe('createProgressTracker', () => {
  const track = (): { set: ReturnType<typeof vi.fn>; p: ReturnType<typeof createProgressTracker> } => {
    const set = vi.fn();
    return { set, p: createProgressTracker(set) };
  };
  const last = (set: ReturnType<typeof vi.fn>): unknown => set.mock.calls.at(-1)?.[0];

  it('reports the share of the blocks in flight that arrived, reaching 100% before idle', () => {
    const { set, p } = track();
    p.reset(true);
    expect(last(set)).toBeNull();
    p.requested([1, 2, 3, 4]);
    expect(last(set)).toBe(0);
    p.delivered(new Int32Array([1, 2]));
    expect(last(set)).toBe(0.5);
    p.requested([3, 4]); // a repeated request must not inflate the denominator
    expect(last(set)).toBe(0.5);
    p.delivered(new Int32Array([3, 4]));
    expect(last(set)).toBe(1);
    p.reset(false);
    expect(last(set)).toBeNull();
  });

  it('counts unrequested pushed blocks and stays quiet while inactive', () => {
    const { set, p } = track();
    p.reset(true);
    p.delivered(new Int32Array([9])); // auto-pushed window block, never in a `need`
    expect(last(set)).toBe(1);
    p.requested([10]);
    expect(last(set)).toBe(0.5);

    const b = track();
    b.p.reset(false); // small edit: no indicator at all
    b.p.requested([1, 2]);
    b.p.delivered(new Int32Array([1]));
    expect(b.set.mock.calls).toEqual([[null]]);
  });
});
