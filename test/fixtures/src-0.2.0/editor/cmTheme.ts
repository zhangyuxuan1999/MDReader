// src/editor/cmTheme.ts — CodeMirror theme built from the --mdr-* design tokens (tokens.css, E4).
// One spec serves both light and dark because the tokens flip; the `dark` flag only switches
// CodeMirror's own defaults (.cm-dark) so the Compartment can toggle it.
import { EditorView } from '@codemirror/view';
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

const spec = {
  '&': { backgroundColor: 'var(--mdr-bg)', color: 'var(--mdr-fg)' },
  '.cm-scroller': {
    fontFamily: 'var(--mdr-font-sans)',
    fontSize: 'var(--mdr-font-size)',
    lineHeight: 'var(--mdr-line-height)',
  },
  '.cm-content': { caretColor: 'var(--mdr-fg)', padding: '12px 0' },
  '.cm-line': { padding: '0 16px 0 8px' },
  '.cm-gutters': {
    backgroundColor: 'var(--mdr-bg)',
    color: 'var(--mdr-fg-muted)',
    borderRight: '1px solid var(--mdr-border)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '36px' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--mdr-active-line)', color: 'var(--mdr-fg)' },
  '.cm-activeLine': { backgroundColor: 'var(--mdr-active-line)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--mdr-fg)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--mdr-selection)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--mdr-selection)' },
  '.cm-searchMatch': { backgroundColor: 'var(--mdr-selection)', outline: '1px solid var(--mdr-accent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--mdr-accent)', color: 'var(--mdr-accent-fg)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--mdr-selection)',
    outline: '1px solid var(--mdr-border)',
  },
  '.cm-nonmatchingBracket': { color: 'var(--mdr-danger)' },
  '.cm-panels': { backgroundColor: 'var(--mdr-bg-elevated)', color: 'var(--mdr-fg)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--mdr-border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--mdr-border)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--mdr-bg-elevated)',
    color: 'var(--mdr-fg)',
    border: '1px solid var(--mdr-border)',
    boxShadow: 'var(--mdr-shadow)',
  },
};

const light = EditorView.theme(spec, { dark: false });
const dark = EditorView.theme(spec, { dark: true });

/** Theme extension for the given mode; used as the content of the theme Compartment. */
export function cmTheme(isDark: boolean): Extension {
  return isDark ? dark : light;
}

/** Markdown-specific highlighting layered above defaultHighlightStyle (which stays as fallback). */
export const mdHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700', fontSize: '1.5em' },
  { tag: t.heading2, fontWeight: '700', fontSize: '1.3em' },
  { tag: t.heading3, fontWeight: '700', fontSize: '1.15em' },
  { tag: [t.heading4, t.heading5, t.heading6, t.heading], fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--mdr-link)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--mdr-link)' },
  {
    tag: t.monospace,
    fontFamily: 'var(--mdr-font-mono)',
    fontSize: '0.92em',
    color: 'var(--mdr-code-fg)',
    backgroundColor: 'var(--mdr-code-bg)',
    borderRadius: '3px',
  },
  { tag: t.quote, color: 'var(--mdr-fg-muted)' },
  { tag: t.contentSeparator, color: 'var(--mdr-fg-muted)' },
  { tag: t.labelName, color: 'var(--mdr-fg-muted)' },
  { tag: t.processingInstruction, color: 'var(--mdr-accent)' },
]);
