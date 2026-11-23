// @vitest-environment jsdom
// test/r7-fp-export.test.ts — fix-pre (round 7, H3; CONTRACT §11 Checkpoint I): 导出 HTML of a document with a block that
// the sanitizer cannot take. In Chromium DOMPurify throws 'Illegal invocation' on a processing instruction named form
// (`<?form>` parsed as a ProcessingInstruction node); jsdom reads it as a comment (`<!--?form-->`) and never throws, so the
// sanitizer is wrapped here to throw as Chromium does on any HTML that holds one (both modules: the tree's and the frozen
// copy's of 0.2.0, test/fixtures/src-0.2.0). The real throw is covered in Chromium by bench/verify/r7-fp-export.mjs.
//   - HTML that does not throw: buildExportDocument's output is byte-identical to the released 0.2.0's;
//   - HTML that throws: the export succeeds, each top-level node that throws is the render-error box (the notice and the
//     node's HTML as text), every other node is what the sanitizer makes of it, nothing unsanitized is in the output.
// R7FP_PRE=1 runs the same cases with the frozen 0.2.0 code as the subject: the throwing cases fail there (the export
// throws, which the app shows as the toast 导出 HTML失败：Illegal invocation).
import { describe, expect, it, vi } from 'vitest';

const PI = /<(?:!--)?\?form/i;
vi.mock('../src/preview/sanitize', async (orig) => {
  const real = await orig<typeof import('../src/preview/sanitize')>();
  return { ...real, sanitizeHtmlString: (h: string) => { if (PI.test(h)) throw new TypeError('Illegal invocation'); return real.sanitizeHtmlString(h); } };
});
vi.mock('./fixtures/src-0.2.0/preview/sanitize', async (orig) => {
  const real = await orig<typeof import('./fixtures/src-0.2.0/preview/sanitize')>();
  return { ...real, sanitizeHtmlString: (h: string) => { if (PI.test(h)) throw new TypeError('Illegal invocation'); return real.sanitizeHtmlString(h); } };
});

const tree = await import('../src/app/App');
const frozen = await import('./fixtures/src-0.2.0/app/App');
const real = await vi.importActual<typeof import('../src/preview/sanitize')>('../src/preview/sanitize');
const subject = process.env.R7FP_PRE ? frozen.buildExportDocument : tree.buildExportDocument;

const exp = (build: typeof tree.buildExportDocument, html: string): string => build({ title: 't<1>', html, css: '.a{b:c}', theme: 'light' });
const bodyOf = (doc: string): string => doc.slice(doc.indexOf('<article class="mdr-preview__body markdown-body">') + 49, doc.lastIndexOf('</article>'));
const ERR_RE = /<div class="md-error"><p>[^<]*<\/p><pre>[^<]*<\/pre><\/div>/g;

const PLAIN = [
  '',
  '<p data-l="0">hi</p>\n',
  '<h1 data-l="0" id="t">T</h1>\n<p data-l="2">a <strong>b</strong> <a href="https://e.example/">l</a></p>\n',
  '<p>ok</p><script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">x</a><iframe src="https://e.org"></iframe>',
  '<ul data-l="0">\n<li data-l="0"><input type="checkbox" class="task-list-item-checkbox"> one</li>\n<li data-l="1"><input type="text"> two</li>\n</ul>\n',
  '<div data-mdr-x="1" data-md="x" data-l="3">reserved</div>\n<form><button>b</button></form><style>p{}</style>\n',
  '<p data-l="0"><span class="md-math"><span class="katex"><span class="katex-html" aria-hidden="true">E</span></span></span></p>\n',
  '<p data-l="0">a &lt;?form&gt; b <!-- c --> &amp; d</p>\n<pre data-l="2"><code class="language-js">x &lt; y</code></pre>\n',
  'text at top level <b>bold</b>\n<table data-l="0">\n<tbody>\n<tr data-l="2">\n<td>c</td>\n</tr>\n</tbody>\n</table>\n',
  '<math><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation></semantics></math>',
];
const THROW: Array<[string, string, number]> = [
  ['paragraph', '<p data-l="0">before</p>\n<p data-l="2"><?form></p>\n<p data-l="4">after</p>\n', 1],
  ['inline in a list item', '<ul data-l="0">\n<li data-l="0">a</li>\n<li data-l="1">b <?form ?> c</li>\n</ul>\n<p data-l="3">end</p>\n', 1],
  ['upper case in a div', '<div data-l="0"><?FORM x></div>\n<p data-l="2">y</p>\n', 1],
  ['two blocks, scripts around', '<p data-l="0">a <?form ?> b</p>\n<p data-l="2">mid <img src=x onerror="alert(1)"> <script>alert(2)</script></p>\n<p data-l="4">c <?form ?> d</p>\n', 2],
  ['script inside the throwing block', '<div data-l="0"><?form ?><script>alert(1)</script><img src=x onerror=alert(2)></div>\n<p data-l="2">after</p>\n', 1],
  ['only the throwing block', '<p data-l="0"><?form></p>', 1],
];

describe('H3: the export of a document whose sanitization does not throw is byte-identical to 0.2.0', () => {
  it.each(PLAIN.map((h, i) => [i, h]))('document %i', (_i, html) => {
    expect(exp(tree.buildExportDocument, html as string)).toBe(exp(frozen.buildExportDocument, html as string));
  });
});

describe('H3: a document with a block that the sanitizer cannot take exports', () => {
  it.each(THROW)('%s', (_name, html, boxes) => {
    let doc = '';
    expect(() => { doc = exp(subject, html); }).not.toThrow();
    const body = bodyOf(doc);
    const found = body.match(ERR_RE) ?? [];
    expect(found.length).toBe(boxes);
    for (const b of found) {
      expect(b).toContain('<p>渲染此段落时出错：Illegal invocation</p>');
      expect(b).toMatch(/<pre>[^<]*&lt;(?:!--)?\?form/i);
    }
    // outside the boxes: every other top-level node as the sanitizer makes it, in order; nothing unsanitized
    const outside = body.split(ERR_RE);
    const t = document.createElement('template');
    t.innerHTML = html;
    const pieces = Array.from(t.content.childNodes).map((n) => { const o = document.createElement('template'); o.content.append(n.cloneNode(true)); return o.innerHTML; });
    const kept = pieces.filter((p) => !PI.test(p)).map((p) => real.sanitizeHtmlString(p)).join('');
    expect(outside.join('')).toBe(kept);
    expect(outside.join('')).not.toMatch(/<script|\son[a-z]+=|<\?|<!--\?/i);
    // the head is the one every export has
    expect(doc.slice(0, doc.indexOf('<body>'))).toBe(exp(frozen.buildExportDocument, '').slice(0, exp(frozen.buildExportDocument, '').indexOf('<body>')));
  });

  it('the released 0.2.0 throws on the same documents (the toast 导出 HTML失败：Illegal invocation)', () => {
    for (const [, html] of THROW) expect(() => exp(frozen.buildExportDocument, html)).toThrow('Illegal invocation');
  });
});
