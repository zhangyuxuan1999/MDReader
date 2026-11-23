// src/shared/slug.ts — the ONE heading-slug rule, shared by the worker (which mints the slugs stored in
// OutlineEntry.slug and in the exported HTML ids) and the preview (which normalises a `#fragment` before
// looking it up). resolveAnchor depends on the two being byte-identical, so there must be exactly one
// implementation: lower-case, whitespace runs to '-', everything but letters/digits/'_'/'-' dropped.
// The leading/trailing trim is a no-op for the worker (headingText already trims) and matters only for a
// hand-written fragment such as `#%20foo`.
export function slugify(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '');
}
