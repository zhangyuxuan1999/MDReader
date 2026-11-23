// src/preview/sanitize.ts — the single DOMPurify configuration for mounted block HTML (SPEC §5.5).
import DOMPurify, { type Config } from 'dompurify';

/** URLs with a scheme (http:, mailto:, …) or protocol-relative ones open in a new tab. */
const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

const BASE: Config = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  // DOMPurify's MathML profile omits <semantics>/<annotation>, which are exactly the wrapper KaTeX puts
  // its MathML in: stripping them keeps the annotation's TeX **text** as a stray text node directly under
  // <math>, so the block's textContent (copy, select, find, screen readers) carried every formula's source
  // outside the clipped .katex-mathml box. Both tags are inert containers — <annotation> holds text and its
  // children are still sanitized against the allowlist — so allowing them restores KaTeX's own output.
  ADD_TAGS: ['semantics', 'annotation'],
  ADD_ATTR: ['data-l', 'data-lang', 'target', 'encoding'],
  FORBID_TAGS: ['style', 'form', 'button', 'select', 'textarea', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['onerror', 'onload'],
};
const CONFIG: Config & { RETURN_DOM_FRAGMENT: true } = { ...BASE, RETURN_DOM_FRAGMENT: true };
const STRING_CONFIG: Config & { RETURN_DOM_FRAGMENT: false; RETURN_DOM: false } = { ...BASE, RETURN_DOM_FRAGMENT: false, RETURN_DOM: false };

/** Attribute names the app's own code gives meaning to inside a block (the serializer's placeholders, the edit
 *  session's markers): the worker emits none of them, so any that arrive came from the document (CONTRACT §11,
 *  U10 d). The wrapper's `data-mdr-x` is set by createPreview outside the sanitized fragment. */
const RESERVED_ATTR = /^data-(?:md|md-block|mdr-.*)$/is;
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (RESERVED_ATTR.test(data.attrName)) data.keepAttr = false;
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href');
    if (href && EXTERNAL_RE.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  } else if (node.tagName === 'INPUT' && (node.getAttribute('type') || '').toLowerCase() !== 'checkbox') {
    node.remove();
  }
});

/** Sanitizes worker-rendered HTML into a fragment ready for `replaceChildren`. For HTML that DOMPurify cannot parse into
 *  a body (a block that is `<!div>` alone, or starts with `<frameset>`) it returns null, which `replaceChildren` would
 *  show as the word "null" (J23): such a block shows nothing. */
export function sanitizeToFragment(html: string): DocumentFragment {
  return (DOMPurify.sanitize(html, CONFIG) as DocumentFragment | null) ?? document.createDocumentFragment();
}

/** Same configuration, string in / string out — for the standalone HTML export (CONTRACT §6). */
export function sanitizeHtmlString(html: string): string {
  return DOMPurify.sanitize(html, STRING_CONFIG);
}
