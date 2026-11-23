// src/worker/math.ts — own `$…$` / `$$…$$` markdown-it rules (CONTRACT §0) rendered with a lazily
// imported KaTeX. The plugin is registered only once KaTeX has loaded; blocks containing `$` wait.
import type { MarkdownIt, StateBlock, StateInline } from 'markdown-it';

export type MathOutput = 'html' | 'htmlAndMathml';

/**
 * HTML-text escaper shared with md.ts (it used to exist twice, identically). It lives in this module —
 * and not in a helper of its own — because `src/shared/*` is frozen and because math.ts must stay free
 * of runtime relative imports: bench/verify/lib.mjs imports this file directly under Node's TypeScript
 * stripping, which does not resolve extensionless specifiers.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface KatexLike {
  renderToString(tex: string, o: { throwOnError: boolean; displayMode: boolean; output: MathOutput; strict: 'ignore' }): string;
}

/** TeX longer than this is shown as plain text: KaTeX is linear but slow, and such input is never a
 *  formula (an unbalanced `$$` while editing turns the following prose into "math" until it is closed). */
const MAX_TEX_CHARS = 20000;

let katex: KatexLike | null = null;
let loading: Promise<boolean> | null = null;
let failed = false;

export function mathReady(): boolean {
  return katex !== null;
}

export function mathFailed(): boolean {
  return failed;
}

/** Imports KaTeX once; resolves true on success, false on failure (never rejects). */
export function loadMath(): Promise<boolean> {
  if (!loading) {
    loading = import('katex').then(
      (mod) => {
        katex = (mod.default ?? mod) as KatexLike;
        return true;
      },
      () => {
        failed = true;
        return false;
      },
    );
  }
  return loading;
}

/** `output` 'html' is used by the HTML export (CONTRACT §6) so formulas never show twice offline. */
export function renderTex(tex: string, display: boolean, output: MathOutput = 'htmlAndMathml'): string {
  if (!katex || tex.length > MAX_TEX_CHARS) return `<code>${escapeHtml(tex)}</code>`;
  // strict:'ignore' — CJK text inside math is routine in zh-CN documents; the default 'warn' logs one
  // console warning per character.
  return katex.renderToString(tex, { throwOnError: false, displayMode: display, output, strict: 'ignore' });
}

function outputOf(env: unknown): MathOutput {
  const o = (env as { mathOutput?: MathOutput } | null)?.mathOutput;
  return o === 'html' ? 'html' : 'htmlAndMathml';
}

function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10;
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/**
 * "From this offset on there is no valid closer" — memo per inline state (fix round).
 * Closer validity does not depend on the opener (except for the currency rule, hence the second
 * threshold for openers that are followed by a digit), so a failed scan from `pos` proves that no
 * opener at or after `pos` can succeed. Without it a paragraph of k unpaired `$` costs O(k²).
 */
interface NoCloser { max: number; from: number; digitFrom: number }
const noCloser = new WeakMap<object, NoCloser>();

/** `$…$` (opening `$` not followed by space; closing `$` not preceded by space/backslash, not followed by a digit) and inline `$$…$$`. */
function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  const max = state.posMax;
  if (src.charCodeAt(pos) !== 36) return false;
  if (src.charCodeAt(pos + 1) === 36) {
    const end = src.indexOf('$$', pos + 2);
    if (end < 0 || end + 2 > max) return false;
    if (!silent) {
      const t = state.push('math_display', 'span', 0);
      t.content = src.slice(pos + 2, end);
      t.markup = '$$';
    }
    state.pos = end + 2;
    return true;
  }
  const opener = src.charCodeAt(pos + 1);
  if (pos + 1 >= max || isWs(opener)) return false;
  // a price like `$5` opens math only when the closer does not look like a suffix price too
  // (`Price $5, then 5$ each.` is plain text; `$x = 5$` is math). SPEC 4.4.
  const openerDigit = isDigit(opener);
  const memo = noCloser.get(state);
  if (memo !== undefined && memo.max === max && pos >= (openerDigit ? memo.digitFrom : memo.from)) return false;
  let end = pos + 1;
  for (;;) {
    end = src.indexOf('$', end);
    if (end < 0 || end >= max) {
      const m = memo !== undefined && memo.max === max ? memo : { max, from: Infinity, digitFrom: Infinity };
      if (!openerDigit && pos < m.from) m.from = pos;
      if (pos < m.digitFrom) m.digitFrom = pos;
      noCloser.set(state, m);
      return false;
    }
    const prev = src.charCodeAt(end - 1);
    const after = src.charCodeAt(end + 1);
    const currency = openerDigit && isDigit(prev) && (end + 1 >= max || isWs(after));
    if (prev === 92 || isWs(prev) || isDigit(after) || currency) {
      end++;
      continue;
    }
    break;
  }
  if (end === pos + 1) return false;
  if (!silent) {
    const t = state.push('math_inline', 'span', 0);
    t.content = src.slice(pos + 1, end);
    t.markup = '$';
  }
  state.pos = end + 1;
  return true;
}

/**
 * Block `$$` … `$$` (closing on any line containing `$$`, like the segmenter); unclosed runs to the end.
 * `$$x$$ text` on one line is left to the paragraph/inline rules (display math inside a paragraph);
 * text after the closer on a later line becomes a paragraph of its own instead of being dropped.
 */
function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  let max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (pos + 2 > max || state.src.charCodeAt(pos) !== 36 || state.src.charCodeAt(pos + 1) !== 36) return false;
  let first = state.src.slice(pos + 2, max);
  let last = '';
  let trailing = '';
  let found = false;
  let next = startLine;
  const close = first.indexOf('$$');
  if (close >= 0) {
    if (first.slice(close + 2).trim() !== '') return false;
    first = first.slice(0, close);
    found = true;
  }
  if (silent) return true;
  while (!found) {
    next++;
    if (next >= endLine) break;
    pos = state.bMarks[next] + state.tShift[next];
    max = state.eMarks[next];
    if (pos < max && state.sCount[next] < state.blkIndent) break;
    const line = state.src.slice(pos, max);
    const idx = line.indexOf('$$');
    if (idx >= 0) {
      last = line.slice(0, idx);
      trailing = line.slice(idx + 2).trim();
      found = true;
    }
  }
  state.line = found ? next + 1 : next;
  const t = state.push('math_block', 'div', 0);
  t.block = true;
  t.markup = '$$';
  t.map = [startLine, state.line];
  const body = next > startLine ? state.getLines(startLine + 1, next, state.tShift[startLine], true) : '';
  t.content = (first.trim() ? first.trim() + '\n' : '') + body + (last.trim() ? last.trim() : '');
  if (trailing) {
    const open = state.push('paragraph_open', 'p', 1);
    open.map = [next, next + 1];
    const inline = state.push('inline', '', 0);
    inline.content = trailing;
    inline.map = [next, next + 1];
    inline.children = [];
    state.push('paragraph_close', 'p', -1);
  }
  return true;
}

export function mathPlugin(md: MarkdownIt): void {
  md.inline.ruler.before('escape', 'math_inline', mathInline);
  md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.renderer.rules.math_inline = (tokens, idx, _o, env) => `<span class="md-math">${renderTex(tokens[idx].content, false, outputOf(env))}</span>`;
  md.renderer.rules.math_display = (tokens, idx, _o, env) => `<span class="md-math md-math--display">${renderTex(tokens[idx].content, true, outputOf(env))}</span>`;
  md.renderer.rules.math_block = (tokens, idx, _o, env) => {
    const t = tokens[idx];
    const l = t.map ? ` data-l="${t.map[0]}"` : '';
    return `<div class="md-math md-math--block"${l}>${renderTex(t.content, true, outputOf(env))}</div>\n`;
  };
}
