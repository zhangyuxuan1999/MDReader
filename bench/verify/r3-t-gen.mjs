// bench/verify/r3-t-gen.mjs — fix-trust (stage 2d, round 3): the seeded raw-HTML generator of the U15 differential
// (CONTRACT §11, H1), shared by test/r3-t-reserved-diff.test.ts (jsdom) and bench/verify/r3-t-chromium.mjs (Chromium).
// Every generator returns a PAIR [reserved, neutral]: the same document twice, once with a reserved name ("data-l",
// "md-math", …) and once with a neutral twin that differs in exactly one letter (q), spelled alike (plain, upper
// case, decimal / hexadecimal reference with or without `;`, leading zeros); both spellings have the same length.
// Pure functions, no imports: the browser loads this file as it is.
const NUL = String.fromCharCode(0);
const FF = String.fromCharCode(12);
const CR = String.fromCharCode(13);
const VT = String.fromCharCode(11);
const SOH = String.fromCharCode(1);
const DEL = String.fromCharCode(0x7f);
const NBSP = String.fromCharCode(0xa0);

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = (r, a) => a[Math.floor(r() * a.length)];
export const cat = (...ps) => {
  let x = '', y = '';
  for (const p of ps) {
    if (typeof p === 'string') { x += p; y += p; } else { x += p[0]; y += p[1]; }
  }
  return [x, y];
};

/** The one varied letter: reserved `ch`, neutral `q`, spelled alike. */
function letter(r, ch) {
  const forms = [
    (c) => c, (c) => c, (c) => c,
    (c) => c.toUpperCase(),
    (c) => `&#${c.charCodeAt(0)};`,
    (c) => `&#${c.charCodeAt(0)}`,
    (c) => `&#x${c.charCodeAt(0).toString(16)};`,
    (c) => `&#X${c.charCodeAt(0).toString(16).toUpperCase()}`,
    (c) => `&#00${c.charCodeAt(0)};`,
  ];
  const f = pick(r, forms);
  return [f(ch), f('q')];
}
/** Expands a template: `@L` and `@M` are the varied letter (l / m), everything else is literal. */
export function tpl(r, t) {
  const parts = [];
  let i = 0;
  for (let j = t.indexOf('@'); j >= 0; j = t.indexOf('@', i)) {
    parts.push(t.slice(i, j));
    parts.push(letter(r, t[j + 1] === 'L' ? 'l' : 'm'));
    i = j + 2;
  }
  parts.push(t.slice(i));
  return cat(...parts);
}

const ATTR_NAMES = ['data-@L', 'data-@Lang', 'data-@Md', 'data-@Mdr-ui', 'data-@Md-block', 'data-@Mdr-x', 'DATA-@L', 'Data-@Md', 'data-@Mdx'];
const CLASS_TOKENS = ['@Md-math', '@Md-block', '@Mdr-x', '@Md-code', '@Md-math--display', '@MD-MATH'];
const SEPS = [' ', ' ', ' ', '\t', '\n', FF, '/', ' / ', CR, '  ', ''];
const VALUES = ['="7"', "='7'", '=7', '', ' = "7"', '="-4"', '=0', '="1"', '=-2'];
const CLASS_SEPS = [' ', '&Tab;', '&NewLine;', '&#9;', '&#x9;', '&#10', '&#12;', '&#13;', '&#32;', '\t', FF, '\n', CR,
  '&nbsp;', '&#160;', '&lowbar;', '&UnderBar;', '_', '-', '&amp;', NUL, '&#0;', '&#x20', '&#32', NBSP, '&fjlig;', VT, '.', ':'];

export function attrCarrier(r) {
  if (r() < 0.45) {
    const q = pick(r, ['"', "'", '']);
    const pre = pick(r, ['', '', 'a', 'x y', 'note']);
    const sep = pre ? pick(r, CLASS_SEPS) : (r() < 0.3 ? pick(r, CLASS_SEPS) : '');
    return cat(pick(r, SEPS) || ' ', pick(r, ['class', 'class', 'CLASS', 'Class']), '=', q, pre, sep, tpl(r, pick(r, CLASS_TOKENS)),
      r() < 0.2 ? ' z' : '', q);
  }
  return cat(pick(r, SEPS), tpl(r, pick(r, ATTR_NAMES)), pick(r, VALUES));
}

const TAGS = ['span', 'b', 'i', 'div', 'p', 'section', 'kbd', 'font', 'a', 'img', 'input', 'li', 'td', 'pre', 'code', 'details',
  'table', 'ul', 'em', 'sup', 'mark', 'u', 'q', 'abbr'];
export function tag(r) {
  const name = pick(r, TAGS);
  const attrs = [];
  if (r() < 0.15) attrs.push(' data-x=1');
  if (name === 'input') attrs.push(' type="checkbox"');
  if (name === 'a') attrs.push(' href="#x"');
  const c = attrCarrier(r);
  attrs.push(c);
  if (r() < 0.15) attrs.push(c);                                            // a duplicate attribute
  if (r() < 0.25) attrs.push(attrCarrier(r));
  const box = r() < 0.3 ? '<input type="checkbox"> ' : '';
  const k = r();
  if (k < 0.12) return cat('<svg><text', ...attrs, '>t</text></svg>');
  if (k < 0.2) return cat('<math><mi', ...attrs, '>x</mi></math>');
  if (k < 0.26) return cat('<svg><a href="#a"', ...attrs, '><text>t</text></a></svg>');
  if (k < 0.32) return cat('</', name, ...attrs, '>');                     // an end tag with attributes
  if (k < 0.36) return cat('<', name, ...attrs, '/>');
  if (name === 'img' || name === 'input') return cat('<', name, ...attrs, '>');
  return cat('<', name, ...attrs, '>', box, 'x</', name, '>');
}

const RAW = ['style', 'xmp', 'title', 'textarea', 'noembed', 'noframes', 'iframe', 'script', 'noscript'];
/** Wraps a tag in a context that hides it from one reader and not from the other. */
export function hide(r, t) {
  const e = pick(r, RAW);
  switch (Math.floor(r() * 24)) {
    case 0: case 1: case 2: return t;
    case 3: return cat(`<${e}><!--</${e}>`, t, '-->');
    case 4: return cat(`<${e}><!--</${e.toUpperCase()}>`, t, '-->');
    case 5: return cat(`<${e}><!--</${e} x>`, t, '-->');
    case 6: return cat('<style><![CDATA[</style x="a><b title=">', t, '"]]>');
    case 7: return cat(`<${e}>`, t, `</${e}>`);
    case 8: return cat('<!---->', t);
    case 9: return cat('<!-->', t);
    case 10: return cat('<!--->', t);
    case 11: return cat('<!-- a --!>', t);
    case 12: return cat('<!x>', t);
    case 13: return cat('<?x>', t);
    case 14: return cat('</ x>', t);
    case 15: return cat('<svg><![CDATA[', t, ']]></svg>');
    case 16: return cat('<svg><![CDATA[x]]>', t, '</svg>');
    case 17: return cat('<plaintext>', t);
    case 18: return cat('<template>', t, '</template>');
    case 19: return cat('<b title="', t, '">');
    case 20: return cat("<b title='>' ", t);
    case 21: return cat('<!-- ', t, ' -->');
    case 22: return cat('<svg><style><!--</style>', t, '--></svg>');
    default: return cat('<math><mi><mglyph><svg><style>', t, '</style></svg></mglyph></mi></math>');
  }
}

/** Inserts the same noise character at the same place in both variants (more parser states). The variants always
 *  have the same length (every spelling of the varied letter is as long for `q` as for `l` / `m`). */
export function noise(r, p) {
  if (r() > 0.25 || p[0].length !== p[1].length) return p;
  const ch = pick(r, ['<', '>', '"', "'", '=', ' ', '/', '!', '-', '\n', '&', ';', NUL, SOH, DEL, '`', '\\', '*', '_']);
  const at = Math.floor(r() * (p[0].length + 1));
  return [p[0].slice(0, at) + ch + p[0].slice(at), p[1].slice(0, at) + ch + p[1].slice(at)];
}

/** Puts raw HTML into a Markdown context (a whole document of one or more blocks). */
export function context(r, h) {
  switch (Math.floor(r() * 16)) {
    case 0: case 1: case 2: return cat('Read ', h, ' this');
    case 3: case 4: return h;                                             // an html_block when it starts a line with a tag
    case 5: return cat('- item ', h);
    case 6: return cat('- [ ] task ', h, '\n- [ ] other');
    case 7: return cat('> quoted ', h);
    case 8: return cat('| a |\n|---|\n| ', h, ' |');
    case 9: return cat('# h ', h);
    case 10: return cat('<div>\n\n', h, '\n\n</div>');
    case 11: return cat('<div>\n', h, '\n\npara\n\n</div>');
    case 12: return cat('para above\n', h);
    case 13: return cat('*', h, '*');
    case 14: return cat('text\n\n', h, '\n\nmore text');
    default: {
      // the tag cut by a blank line, inside a glued container and outside it
      const at = Math.floor(r() * (h[0].length + 1));
      if (h[0].length !== h[1].length) return cat('<p>\n', h, '\n</p>');
      const a = [h[0].slice(0, at), h[1].slice(0, at)];
      const b = [h[0].slice(at), h[1].slice(at)];
      return r() < 0.6 ? cat('<div>\n', a, '\n\n', b, '\n\n</div>') : cat(a, '\n\n', b);
    }
  }
}

/** Document text (or worker markup) read into a tag that a raw-HTML token of a glued container left open. */
export function absorbed(r) {
  const a = attrCarrier(r);
  const box = r() < 0.5 ? ' <input type="checkbox">' : '';
  switch (Math.floor(r() * 9)) {
    case 0: return cat("<div>\n<b title='\n\n'", a, " x='a'", box, '\n\n</div>');
    case 1: return cat("<p>\n<span title='\n\n'", a, " x='a'\n\n'", '\n\n</p>');
    case 2: return cat("<ul>\n<li title='\n\n'", a, " x='a'", box, '\n\n</li>\n</ul>');
    case 3: return cat('<div>\n<b \n\n', a, box, '\n\n</div>');
    case 4: return cat('<div>\n<span \n\n```js\nx\n```\n\n', a, '\n\n</div>');
    case 5: return cat("<details>\n<summary title='\n\n- [ ] '", a, " x='a'\n\n</summary>\n</details>");
    case 6: return cat("<pre title='</pre>\n'", a, " x='a'");
    case 7: return cat("<div>\n<b x=\n\n", a, ' y\n\n</div>');
    default: return cat("<section>\n<i title='\n\n# '", a, " z='q'\n\n</section>");
  }
}

/** Names that reach the DOM only through Markdown (no raw HTML at all). */
export function viaMarkdown(r) {
  const n = tpl(r, pick(r, ['@Md-math', 'data-@L', 'data-@Lang', 'data-@Md', '@Mdr-x', '@Md-block']));
  const m = pick(r, ['@Md-math', 'data-@L']);
  const n2 = tpl(r, m);
  switch (Math.floor(r() * 16)) {
    case 0: return cat('```', n, '\ncode\n```');
    case 1: return cat('```js ', n, '\ncode\n```');
    case 2: return cat('[a](https://e.com/x "', n, '")');
    case 3: return cat('![', n, '](x.png "', n2, '")');
    case 4: return cat('# ', n);
    case 5: return cat('a `', n, '` b');
    case 6: return cat('<https://e.com/', n, '>');
    case 7: return cat('see [^', n, '] and [', n2, ']');
    case 8: return cat('[x][', n, ']\n\n[', n, ']: https://e.com/', n2);
    case 9: return cat('*', n, '* and **', n2, '**');
    case 10: return cat('$', n, '$ and $$', n2, '$$');
    case 11: return cat('$\\htmlClass{', n, '}{x}$ $\\htmlData{', n2, '=1}{y}$');
    case 12: return cat('- [ ] ', n, '\n- [x] ', n2);
    case 13: return cat('| ', n, ' |\n|---|\n| ', n2, ' |');
    case 14: return cat('[', n, '](', n2, ')');
    default: return cat('https://e.com/', n, '?', n2);
  }
}

export function generate(r) {
  const k = r();
  if (k < 0.12) return absorbed(r);
  if (k < 0.24) return viaMarkdown(r);
  let h = hide(r, tag(r));
  if (r() < 0.3) h = cat(hide(r, tag(r)), ' ', h);
  return context(r, noise(r, h));
}

