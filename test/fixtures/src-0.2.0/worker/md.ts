// src/worker/md.ts — the markdown-it instance and its rules (SPEC 4.4): data-l line attributes,
// wrapped fence/code_block/hr/image renderers, PLAIN fallback for oversize blocks, per-block try/catch.
import markdownIt, { type MarkdownIt, type RendererRule, type Token } from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import { HTML_FLAG_PLAIN, HTML_FLAG_RESERVED, HTML_FLAG_TRUSTED, type RenderOptions } from '../shared/types';
import { T } from '../shared/i18n';
import { highlightCode } from './highlight';
import { escapeHtml, mathPlugin, type MathOutput } from './math';

export interface Reference { href: string; title: string }
export type References = Record<string, Reference>;

export interface BlockEnv {
  [key: string | symbol]: unknown; // markdown-it's Env is an open record
  references: References;
  blockId?: number;
  /** Export only: 1-based heading line → slug, rendered as `id=` on the heading. */
  headingIds?: Map<number, string>;
  /** Skip highlight.js for this render (core.ts pushes escaped code while a big fence is being typed). */
  noHighlight?: boolean;
  /** KaTeX output (CONTRACT §6): the export asks for 'html' so formulas never render twice offline. */
  mathOutput?: MathOutput;
}

export interface Rendered { html: string; flags: number }

export interface Markdown {
  readonly md: MarkdownIt;
  readonly mathEnabled: boolean;
  /** Registers the `$` rules (call once KaTeX has loaded). */
  enableMath(): void;
  renderBlock(source: string, env: BlockEnv): Rendered;
  /** Whole document with heading ids (exportHtml). */
  renderDocument(text: string, references: References, headingIds: Map<number, string>, mathOutput?: MathOutput): string;
}

// `tr_open` carries a map for every header/body row, so Alt+click in a table lands on the row's own
// source line instead of the table's first line (SPEC 5.6 uses the nearest `data-l`).
const LINE_TOKENS = new Set(['paragraph_open', 'heading_open', 'list_item_open', 'blockquote_open', 'table_open', 'tr_open']);
/** Tokens whose HTML is built only from escaped source text (no user-authored markup survives). */
const TRUSTED_TOKENS = new Set(['fence', 'code_block']);
const FIRST_TAG = /^(\s*<[a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])/;

/** Names the app reserves for its own markers (CONTRACT §11, U10 a, U15 c), searched in decoded, lower-cased TEXT:
 *  `data-l` / `data-lang` followed by a character that cannot continue an attribute name (the end counts), `data-md`
 *  followed by anything (data-mdr… included), `md-` / `mdr-` not preceded by a character of a class token. */
const RESERVED_TEXT = /data-(?:lang|l)(?![a-z0-9_.:-])|data-md|(?<![a-z0-9_-])mdr?-/;
const NUM_REF = /&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));?/g;
/** An attribute value the HTML tokenizer may open: `=`, HTML whitespace, a quote (CR counts: the parser reads it as LF). */
const VALUE_OPEN = /=[\t\n\f\r ]*(["'])/g;
const TAG_START = /<\/?[a-z]/i;

/** Decodes numeric character references the way HTML decodes them in text and attribute values (U15 a): decimal or
 *  hexadecimal (x or X), greedy digits, with or without `;` (also before a letter or digit that cannot continue the
 *  number); 0, surrogates and code points past U+10FFFF become U+FFFD. The C1 remapping (&#x80; → €, …) is not
 *  applied: every value of that table, like the C1 control itself, is neither ASCII whitespace nor a-z, 0-9, `_`, `-`,
 *  so the scan's result is the same. Named references are left as they are: of the 2231 names of the table markdown-it
 *  ships (node_modules/entities 8), only &Tab; / &NewLine; give ASCII whitespace, only &lowbar; / &UnderBar; (`_`) and
 *  &fjlig; (`fj`) give a-z, 0-9, `_` or `-`, and all five end with `;`, which already counts as a separator below; the
 *  106 legacy names without `;` give only `"`, `&`, `<`, `>` and U+00A0–U+00FF (test/r3-t-reserved-scan.test.ts). */
function decodeNumericRefs(s: string): string {
  if (!s.includes('&#')) return s;
  return s.replace(NUM_REF, (_m, hex: string | undefined, dec: string | undefined) => {
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec!, 10);
    if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(cp);
  });
}

/** May the HTML tokenizer still be inside a tag (a tag name, an attribute, a quoted value) at the end of `html`? Then
 *  it reads the HTML the worker renders after this token (the next lines of a glued container: markup and document
 *  text) as attributes of a document element. A conservative test on the RAW text (character references never
 *  delimit tags): true when a tag start (`<` or `</` and a letter) follows the last `>`, when a value opened by `=`
 *  and a quote has no matching quote after it, or when one opened before the last `>` closes only after it (that `>`
 *  may sit inside the value). Every tag the tokenizer leaves open meets one of the three; many texts that close every
 *  tag do too (false positives, intended). Linear: the searches for quotes of one kind never overlap. */
function mayEndInTag(html: string): boolean {
  const gt = html.lastIndexOf('>');
  if (TAG_START.test(gt < 0 ? html : html.slice(gt + 1))) return true;
  VALUE_OPEN.lastIndex = 0;
  for (let m = VALUE_OPEN.exec(html); m; m = VALUE_OPEN.exec(html)) {
    const at = VALUE_OPEN.lastIndex - 1;
    const close = html.indexOf(m[1], at + 1);
    if (close < 0 || (at < gt && close > gt)) return true;
  }
  return false;
}

/** Does raw HTML text (an html_inline / html_block token's content: the document's own text) carry a reserved name
 *  (CONTRACT §11, U15)? A conservative TEXT scan, not an imitation of the HTML tokenizer: numeric character references
 *  decoded, lower-cased, then the substring rules of RESERVED_TEXT wherever the name sits (a comment, RAWTEXT or
 *  RCDATA content, CDATA, an attribute value, plain text); and a text that may end inside a tag (mayEndInTag). False
 *  positives are intended: they only make a raw-HTML block uneditable in the preview (K4); a false negative would let
 *  a document plant the app's markers in the block DOM. */
export function rawHtmlReserved(html: string): boolean {
  return RESERVED_TEXT.test(decodeNumericRefs(html).toLowerCase()) || mayEndInTag(html);
}

function tokensReserved(tokens: Token[]): boolean {
  for (const t of tokens) {
    if ((t.type === 'html_block' || t.type === 'html_inline') && rawHtmlReserved(t.content)) return true;
    // An image's children become its alt text, rendered as plain text: raw HTML there is never markup.
    if (t.children && t.type !== 'image' && tokensReserved(t.children)) return true;
  }
  return false;
}

function dataL(t: Token): string {
  return t.map ? ` data-l="${t.map[0]}"` : '';
}

/** Highlighted HTML for a fence, or null (unknown language, over the cap): highlight.ts's highlightCode. */
export type Highlighter = (code: string, lang: string, maxChars: number) => string | null;

export function createMarkdown(opts: RenderOptions): Markdown {
  return createMarkdownWith(opts, highlightCode);
}

/** createMarkdown with the highlighter passed in (null: every fence unhighlighted). The main thread's fidelity
 *  gate (CONTRACT §11, U12) imports only this, which keeps highlight.js out of the main bundle. */
export function createMarkdownWith(opts: RenderOptions, highlight: Highlighter | null): Markdown {
  const md = markdownIt({ html: true, linkify: opts.linkify, typographer: false, breaks: opts.breaks })
    .enable(['table', 'strikethrough'])
    .use(taskLists, { enabled: true, label: false });

  md.core.ruler.push('line_attrs', (state) => {
    const ids = (state.env as BlockEnv).headingIds;
    for (const t of state.tokens) {
      if (!t.map || !LINE_TOKENS.has(t.type)) continue;
      t.attrSet('data-l', String(t.map[0]));
      if (ids && t.type === 'heading_open') {
        const slug = ids.get(t.map[0] + 1);
        if (slug !== undefined) t.attrSet('id', slug);
      }
    }
  });

  md.renderer.rules.fence = (tokens, idx, _o, env) => {
    const t = tokens[idx];
    const info = t.info ? md.utils.unescapeAll(t.info).trim() : '';
    const lang = info.split(/\s+/)[0] ?? '';
    const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    const hl = highlight && opts.highlight && !(env as BlockEnv).noHighlight ? highlight(t.content, lang, opts.maxHighlightChars) : null;
    if (hl !== null) {
      return `<pre class="md-code"${dataL(t)}${langAttr}><code class="hljs language-${escapeHtml(lang)}">${hl}</code></pre>\n`;
    }
    return `<pre class="md-code md-code--unhighlighted"${dataL(t)}${langAttr}><code>${escapeHtml(t.content)}</code></pre>\n`;
  };
  md.renderer.rules.code_block = (tokens, idx) => {
    const t = tokens[idx];
    return `<pre class="md-code md-code--unhighlighted"${dataL(t)}><code>${escapeHtml(t.content)}</code></pre>\n`;
  };
  md.renderer.rules.hr = (tokens, idx) => `<hr${dataL(tokens[idx])}>\n`;
  // markdown-it emits html_block content verbatim, so the line attribute is injected into its first tag
  // (a wrapper element would break `<details>` regions that open and close in different blocks).
  md.renderer.rules.html_block = (tokens, idx) => {
    const t = tokens[idx];
    if (!t.map) return t.content;
    return t.content.replace(FIRST_TAG, `$1 data-l="${t.map[0]}"`);
  };
  const image: RendererRule = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet('loading', 'lazy');
    return image(tokens, idx, options, env, self);
  };

  let mathEnabled = false;
  const api: Markdown = {
    md,
    get mathEnabled() {
      return mathEnabled;
    },
    enableMath() {
      if (mathEnabled) return;
      mathEnabled = true;
      md.use(mathPlugin);
    },
    renderBlock(source, env) {
      if (source.length > opts.maxHtmlChars) return { html: source, flags: HTML_FLAG_PLAIN | HTML_FLAG_TRUSTED };
      try {
        const tokens = md.parse(source, env);
        let trusted = tokens.length > 0;
        for (const t of tokens) if (!TRUSTED_TOKENS.has(t.type)) trusted = false;
        // Scanned BEFORE rendering: the html_block rule injects the worker's own data-l afterwards (CONTRACT §11, U10 a).
        const reserved = !trusted && tokensReserved(tokens);
        return { html: md.renderer.render(tokens, md.options, env), flags: (trusted ? HTML_FLAG_TRUSTED : 0) | (reserved ? HTML_FLAG_RESERVED : 0) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { html: `<div class="md-error"><p>${T.renderError}：${escapeHtml(message)}</p><pre>${escapeHtml(source)}</pre></div>`, flags: 0 };
      }
    },
    renderDocument(text, references, headingIds, mathOutput) {
      return md.render(text, { references, headingIds, mathOutput } satisfies BlockEnv);
    },
  };
  return api;
}
