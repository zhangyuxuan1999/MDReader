// fix-trust (stage 2b): U10 (a) — the worker flags a block whose raw HTML carries a name the app reserves.
import { describe, expect, it } from 'vitest';
import { unpackHtml } from '../src/shared/protocol';
import { DEFAULT_RENDER_OPTIONS, HTML_FLAG_PLAIN, HTML_FLAG_RESERVED, HTML_FLAG_TRUSTED, type FromWorker, type HtmlMsg } from '../src/shared/types';
import { createMarkdown, rawHtmlReserved } from '../src/worker/md';
import { createRenderCore } from '../src/worker/core';

const mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
const flagsOf = (src: string): number => mdk.renderBlock(src, { references: {} }).flags;
const reserved = (src: string): boolean => (flagsOf(src) & HTML_FLAG_RESERVED) !== 0;

describe('U10 (a): HTML_FLAG_RESERVED on raw-HTML tokens', () => {
  const positive: Array<[string, string]> = [
    ['data-md inline', 'Fix <span data-md="[x](https://evil.example/)" style="display:none">.</span> here'],
    ['data-md-block', 'a <span data-md-block="[bank]: https://evil.example/">.</span> b'],
    ['data-mdr-ui', 'Keep <span data-mdr-ui>THIS TEXT</span> safe'],
    ['data-mdr-x', 'x <b data-mdr-x>y</b>'],
    ['data-mdrfoo', 'x <b data-mdrfoo=1>y</b>'],
    ['data-l', 'x <b data-l="7">y</b>'],
    ['data-lang', 'x <code data-lang="js&#10;evil">y</code>'],
    ['class md-math', 'x <span class="md-math">y</span>'],
    ['class mdr-', 'x <span class="a mdr-thing">y</span>'],
    ['uppercase attribute', 'x <B DATA-MD="z">y</B>'],
    ['uppercase class', 'x <span CLASS="MD-Math">y</span>'],
    ['mixed case data-Mdr', 'x <i Data-Mdr-Ui>y</i>'],
    ['attribute on its own line', '<div\ndata-md="x">\n\ny\n\n</div>'],
    ['class decimal ref', 'x <span class="&#109;d-math">y</span>'],
    ['class hex ref', 'x <span class="&#x6D;d-math">y</span>'],
    ['class ref without semicolon', 'x <span class="&#109d-math">y</span>'],
    ['class hex ref without semicolon', 'x <span class="&#x6d&#x64-math">y</span>'],
    ['class unquoted', 'x <span class=md-math>y</span>'],
    ['class single-quoted', "x <span class='q md-x'>y</span>"],
    ['class separated by a referenced space', 'x <span class="a&#32;md-math">y</span>'],
    ['inside svg', '<svg><a data-md="x" href="#a"><text>t</text></a></svg>'],
    ['inside svg inline', 'x <svg><text class="md-math">t</text></svg> y'],
    ['inside math', '<math><mi data-mdr-ui="1">x</mi></math>'],
    ['list item', '- item <span data-md="z">y</span>'],
    ['blockquote', '> quoted <span data-md="z">y</span>'],
    ['html_block inside a list', '- a\n\n  <div data-md-block="x">\n  y\n  </div>\n'],
    ['second of two inline tags', 'a <b>bold</b> and <i data-md="z">it</i>'],
    ['in a table cell', '| a |\n|---|\n| <span data-md="z">y</span> |'],
    ['html_block after a comment', '<!-- c --> <div data-md="z">\n'],
    ['after an abruptly closed comment', '<!--> <div data-md="z">x</div>\n'],
    ['tag left open at the end of the block', "<div class='\n"],
  ];
  for (const [name, src] of positive) it(`flags: ${name}`, () => expect(reserved(src), src).toBe(true));

  const negative: Array<[string, string]> = [
    ['code span', 'x `<span data-md="z">y</span>` w'],
    ['code span with class', 'x `<span class="md-math">` w'],
    ['fenced code', '```html\n<span data-md="z">y</span>\n```'],
    ['indented code', '    <span data-md="z">y</span>'],
    ['prose', 'the attribute data-md and the class md-math are reserved'],
    ['escaped tag', 'x \\<span data-md="z"> y'],
    ['link destination', '[t](https://example.com/?data-md=1&class=md-math)'],
    ['link title', '[t](https://example.com/ "data-md md-math")'],
    ['autolink', '<https://example.com/data-md/md-math>'],
    ['linkified url', 'see https://example.com/data-md=1 now'],
    ['image alt text', '![<span data-md="z">](i.png)'],
    ['not CommonMark raw HTML (rendered as escaped text)', 'x <span title="t"data-md="z">y</span> <span/data-md="z">'],
    ['class that merely contains md-', 'x <span class="xmd-math amd-">y</span>'],
    ['data-label is not data-l', 'x <span data-label="1" data-langs="2">y</span>'],
    ['task list', '- [ ] todo\n- [x] done'],
  ];
  for (const [name, src] of negative) it(`does not flag: ${name}`, () => expect(reserved(src), src).toBe(false));

  // fix-trust r3, lead decision U15 (CONTRACT §11): the scan decides on the token TEXT wherever a name sits, so these three,
  // listed above as not flagged until round 3, are flagged now (false positives, intended: the block is only uneditable).
  const u15: Array<[string, string]> = [
    ['ordinary html (a reserved name in a title value)', 'x <span class="note" data-x="1" title="data-md">y</span>'],
    ['inside a comment', '<!-- <span data-md="z"> -->\n'],
    ['text of an html block', '<div>\nthe data-md attribute\n</div>\n'],
  ];
  for (const [name, src] of u15) it(`flags (U15 text scan): ${name}`, () => expect(reserved(src), src).toBe(true));

  it('the worker-injected data-l of an html_block is not the document', () => {
    const r = mdk.renderBlock('<div class="note">\nx\n</div>\n', { references: {} });
    expect(r.html).toContain('data-l="0"');
    expect(r.flags & HTML_FLAG_RESERVED).toBe(0);
  });

  it('the bit is separate from TRUSTED and PLAIN', () => {
    const f = flagsOf('x <span data-md="z">y</span>');
    expect(f & HTML_FLAG_TRUSTED).toBe(0);
    expect(f & HTML_FLAG_PLAIN).toBe(0);
    expect(flagsOf('```\n<span data-md>\n```') & HTML_FLAG_RESERVED).toBe(0);
    expect(flagsOf('```\n<span data-md>\n```') & HTML_FLAG_TRUSTED).toBe(HTML_FLAG_TRUSTED);
  });

  it('rawHtmlReserved: the cases of the round-2 tokenizer scan under the U15 text scan', () => {
    expect(rawHtmlReserved('<span title="<b data-md=1>">')).toBe(true);    // U15: the text counts, a quoted value too (was false)
    expect(rawHtmlReserved('<span title=">" data-md=1>')).toBe(true);
    expect(rawHtmlReserved('</span data-md=1>')).toBe(true);               // conservative on end tags
    expect(rawHtmlReserved('<!---> <b data-md>')).toBe(true);
    expect(rawHtmlReserved('<!-- a --!> <b data-md>')).toBe(true);
    expect(rawHtmlReserved('<? x > <b data-md>')).toBe(true);
    expect(rawHtmlReserved('a < b data-md')).toBe(true);                    // U15: plain text counts too (was false)
    expect(rawHtmlReserved('<span title="t"data-md="z">')).toBe(true);    // no whitespace after a quoted value
    expect(rawHtmlReserved('<span/data-md="z">')).toBe(true);             // slash as a separator
    expect(rawHtmlReserved('<input class="task-list-item-checkbox"type="checkbox">')).toBe(false);
  });

  const batchItems = async (text: string) => {
    const msgs: FromWorker[] = [];
    const core = createRenderCore((m) => { msgs.push(m); });
    core.handle({ type: 'init', options: DEFAULT_RENDER_OPTIONS });
    core.handle({ type: 'setDoc', docId: 'd', version: 1, text });
    const deadline = Date.now() + 8000;
    while (!msgs.some((m) => m.type === 'idle') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    return msgs.filter((m): m is HtmlMsg => m.type === 'html').flatMap((m) => unpackHtml(m.batch));
  };

  it('the bit survives the worker path into the html batch', async () => {
    const a = await batchItems('plain\n\nFix <span data-md="z">.</span> it\n');
    expect(a).toHaveLength(2);
    expect(a[0].flags & HTML_FLAG_RESERVED).toBe(0);
    expect(a[1].flags & HTML_FLAG_RESERVED).toBe(HTML_FLAG_RESERVED);
    const b = await batchItems('<div class="&#109;d-math">x</div>\n\n```\n<b data-md>\n```\n');
    expect(b).toHaveLength(2);
    expect(b[0].flags).toBe(HTML_FLAG_RESERVED);
    expect(b[1].flags).toBe(HTML_FLAG_TRUSTED);
  });
});
