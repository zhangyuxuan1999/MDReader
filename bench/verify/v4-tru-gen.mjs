// bench/verify/v4-tru-gen.mjs — verify-trust (stage 2d re-verification, round 3): a seeded document generator for the
// U15 attack (CONTRACT §11). Unlike bench/verify/r3-t-gen.mjs (pairs that differ in one letter of a planted name) this
// generator builds whole documents from a grammar of raw-HTML pieces (special content models, malformed comments,
// attribute syntax, character references) and Markdown containers, and puts reserved names mostly OUTSIDE raw tokens
// (escaped Markdown text, link titles, alt text, code spans, fence info), so the scan cannot see them literally; a
// reserved name then reaches the DOM only if the browser's parser reads that text as markup. A mutation step inserts
// HTML- and Markdown-significant characters, line breaks and container prefixes at random places.
// Pure functions, no imports (the browser loads this file through Vite as it is).
const C = (n) => String.fromCharCode(n);
const NUL = C(0), FF = C(12), VT = C(11), SOH = C(1), DEL = C(0x7f), NBSP = C(0xa0), NEL = C(0x85), LS = C(0x2028);
const ZWSP = C(0x200b), IDSP = C(0x3000), KELVIN = C(0x212a), BOM = C(0xfeff);

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
const pick = (r, a) => a[Math.floor(r() * a.length)];
const chance = (r, p) => r() < p;

// ------------------------------------------------------------------ reserved names and their spellings
const NAMES = ['data-l', 'data-lang', 'data-md', 'data-mdr-x', 'data-md-block', 'data-mdr-task', 'data-mdr-o', 'data-mdx'];
const CLASSES = ['md-math', 'md-block', 'mdr-x', 'md-math--block', 'md-math--display', 'md-code', 'md-math-src', 'md-codewrap', 'md-plain'];
function spellLetter(r, ch) {
  const n = ch.charCodeAt(0);
  switch (Math.floor(r() * 10)) {
    case 0: return `&#${n};`;
    case 1: return `&#${n}`;
    case 2: return `&#x${n.toString(16)};`;
    case 3: return `&#X${n.toString(16).toUpperCase()}`;
    case 4: return `&#000${n};`;
    case 5: return ch.toUpperCase();
    default: return ch;
  }
}
/** A reserved name spelled for an attribute VALUE context (references decode there) or literally. */
function spell(r, s, refs) {
  if (!refs || chance(r, 0.5)) return chance(r, 0.2) ? s.toUpperCase() : s;
  let out = '';
  for (const ch of s) out += chance(r, 0.25) ? spellLetter(r, ch) : ch;
  return out;
}
const SEP = [' ', '\t', '\n', FF, '&Tab;', '&NewLine;', '&#9;', '&#x0a;', '&#12', '&#32;', '&#x20', '&#13;', '&#x0D', ''];
function classValue(r, refs) {
  const t = spell(r, pick(r, CLASSES), refs);
  const before = chance(r, 0.5) ? pick(r, ['a', 'x y', 'task-list-item', 'katex', '']) + (refs ? pick(r, SEP) : pick(r, [' ', '\t', '\n'])) : '';
  return before + t + (chance(r, 0.3) ? ' z' : '');
}
/** `name=value` pieces that carry a reserved name, in every attribute syntax. */
function reservedAttr(r, refs) {
  const q = pick(r, ['"', "'", '']);
  if (chance(r, 0.45)) {
    const v = classValue(r, refs);
    return `${pick(r, ['class', 'CLASS', 'Class', 'cLaSs'])}${pick(r, ['=', ' = ', '=\n', '=' + FF])}${q}${q ? v : v.replace(/[\s]+/g, '')}${q}`;
  }
  const n = spell(r, pick(r, NAMES), false);
  return n + pick(r, ['="7"', "='0'", '=7', '', '="-4"', '=  "1"', '="2" ', '=' + NUL + '3']);
}

// ------------------------------------------------------------------ raw HTML pieces
const RAW_EL = ['style', 'script', 'xmp', 'title', 'textarea', 'noembed', 'noframes', 'iframe', 'noscript', 'plaintext', 'template'];
const TAGS = ['span', 'b', 'i', 'a', 'div', 'p', 'li', 'td', 'tr', 'table', 'select', 'option', 'font', 'kbd', 'img', 'input', 'details', 'summary', 'svg', 'math', 'pre', 'code', 'em', 'u', 'sup', 'q', 'abbr', 'button', 'form', 'object', 'embed', 'mark'];
const ATTR_SEP = [' ', ' ', '\t', '\n', FF, '/', ' / ', '  ', '\n\n'];
function neutralAttr(r) {
  return pick(r, ['title="x"', "title='y'", 'title=z', 'x', 'href="#a"', 'type="checkbox"', 'checked', 'alt="a>b"', "title='a\"b'", 'title="a\'b"', 'x=">"', "y='<b'", 'z=`q`', 'w="=\'"']);
}
function openTag(r, name, reserved, refs) {
  let s = '<' + (chance(r, 0.15) ? name.toUpperCase() : name);
  const n = Math.floor(r() * 3);
  for (let i = 0; i < n; i++) s += pick(r, ATTR_SEP) + neutralAttr(r);
  if (reserved) s += pick(r, ATTR_SEP) + reservedAttr(r, refs);
  if (chance(r, 0.2)) s += pick(r, ATTR_SEP) + neutralAttr(r);
  return s + pick(r, ['>', '>', '>', '/>', ' >', '']);
}
/** Comments of every malformed shape, CDATA, PIs, declarations. */
function oddMarkup(r, inner) {
  return pick(r, [
    `<!--${inner}-->`, `<!-->${inner}`, `<!--->${inner}`, `<!---->${inner}`, `<!--${inner}--!>`, `<!--${inner}--`, `<!--${inner}`,
    `<!-${inner}->`, `<!${inner}>`, `<?${inner}?>`, `<?${inner}>`, `<![CDATA[${inner}]]>`, `<!DOCTYPE ${inner}>`, `</ ${inner}>`,
    `</${inner}>`, `<!--<!--${inner}-->-->`, `<!-- -- ${inner} -- -->`, `<!--${inner}--!-->`, `<!--${inner}- ->`, `< ${inner}>`,
  ]);
}
/** A raw piece: an element of a special content model, or a nested foreign / table / select structure. */
function rawPiece(r, payload, refs) {
  const reserved = chance(r, 0.5);
  const name = pick(r, TAGS);
  switch (Math.floor(r() * 16)) {
    case 0: case 1: { const e = pick(r, RAW_EL); return `<${e}>${payload}</${pick(r, [e, e.toUpperCase(), e + ' x', e + '/', e + 'x', e + "\n'"])}>`; }
    case 2: { const e = pick(r, RAW_EL); return `<${e}>${oddMarkup(r, `</${e}>${chance(r, 0.5) ? openTag(r, name, true, refs) : ''}${payload}`)}`; }
    case 3: return `<svg>${pick(r, ['<style>', '<title>', '<desc>', '<foreignObject>', '<a>', ''])}${pick(r, ['<![CDATA[', ''])}${payload}${pick(r, [']]>', ''])}${pick(r, ['</style>', '</svg>', ''])}`;
    case 4: return `<math><mi>${pick(r, ['<mglyph>', '<malignmark>', '<annotation-xml encoding="text/html">', ''])}${pick(r, ['<style>', '<svg>', '<b>', ''])}${payload}</mi></math>`;
    case 5: return `<table>${pick(r, ['<tr>', '<td>', '<caption>', '', '<colgroup>', '<tbody>'])}${payload}${openTag(r, name, reserved, refs)}x${pick(r, ['</table>', ''])}`;
    case 6: return `<select>${pick(r, ['<option>', '<optgroup>', '<button>', '<div>', ''])}${payload}${openTag(r, name, reserved, refs)}</select>`;
    case 7: return `<p>${payload}<p>${openTag(r, name, reserved, refs)}</p></p>`;
    case 8: return oddMarkup(r, payload);
    case 9: return `<template>${payload}${openTag(r, name, reserved, refs)}</template>`;
    case 10: return `<noscript>${payload}</noscript>`;
    case 11: return `<plaintext>${payload}`;
    case 12: return openTag(r, name, reserved, refs) + payload + (chance(r, 0.5) ? `</${name}>` : '');
    case 13: return `<a href="#x">${payload}<a href="#y">${openTag(r, 'b', reserved, refs)}z</a>`;
    case 14: return `<b>${payload}<div>${openTag(r, name, reserved, refs)}</b>q</div>`;
    default: return openTag(r, name, reserved, refs);
  }
}

/** Text that holds a reserved name as PLAIN text (to be read as markup only by a broken parse). */
function nameText(r) {
  const n = chance(r, 0.6) ? pick(r, NAMES) + pick(r, ['=7', '="0"', "='-4'", '=1 ', ' ', '']) : 'class=' + pick(r, ['', '"', "'"]) + pick(r, CLASSES);
  return pick(r, ['', ' ', "'", '"', ' x=', "'>", '">', "' ", '" ']) + n + pick(r, ['', ' ', ' y', "'", '"', '>', ' />']);
}
/** A Markdown piece that carries reserved-name text without raw HTML. */
function mdCarrier(r) {
  const t = nameText(r);
  const plain = t.replace(/\n/g, ' ');
  switch (Math.floor(r() * 14)) {
    case 0: return plain;
    case 1: return `[${plain}](#x "${plain.replace(/"/g, '')}")`;
    case 2: return `![${plain}](x.png "${plain.replace(/"/g, '')}")`;
    case 3: return '`' + plain.replace(/`/g, '') + '`';
    case 4: return `*${plain}*`;
    case 5: return `$${plain.replace(/\$/g, '')}$`;
    case 6: return `<https://e.com/${plain.replace(/[\s<>]/g, '')}>`;
    case 7: return `https://e.com/?${plain.replace(/[\s<>]/g, '')}`;
    case 8: return `**${plain}**`;
    case 9: return `~~${plain}~~`;
    case 10: return `[${plain}]`;
    case 11: return `\\<b ${plain}>`;
    case 12: return `&lt;b ${plain}&gt;`;
    default: return plain + '  ';
  }
}

/** One inline mixture: raw HTML pieces with Markdown text in between. */
function inlineMix(r) {
  const parts = [];
  const n = 1 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const k = r();
    if (k < 0.4) parts.push(rawPiece(r, chance(r, 0.5) ? mdCarrier(r) : '', chance(r, 0.5)));
    else if (k < 0.85) parts.push(mdCarrier(r));
    else parts.push(pick(r, ['text', 'a b', '1.', '-', '>', '|', '#', '$', '\\', '&', '&amp;', '&#']));
  }
  return parts.join(pick(r, [' ', '', '\n', ' \n', '  \n']));
}

// ------------------------------------------------------------------ containers
function inContainer(r, body) {
  const lines = body.split('\n');
  switch (Math.floor(r() * 14)) {
    case 0: case 1: return body;
    case 2: return lines.map((l, i) => (i === 0 ? '- ' : '  ') + l).join('\n');
    case 3: return lines.map((l) => '- [ ] ' + l).join('\n');
    case 4: return lines.map((l) => '> ' + l).join('\n');
    case 5: return lines.map((l, i) => (i === 0 ? '> ' : '') + l).join('\n');   // lazy continuation
    case 6: return `| a | b |\n|---|---|\n| ${body.replace(/\n/g, ' ')} | x |`;
    case 7: return `# ${body.replace(/\n/g, ' ')}`;
    case 8: return `1. a\n2. ${lines.join('\n   ')}`;
    case 9: return `- [ ] a\n  - [x] ${lines.join('\n    ')}\n- [ ] c`;
    case 10: return `<div>\n\n${body}\n\n</div>`;
    case 11: return `<details>\n<summary>s</summary>\n${body}\n</details>`;
    case 12: return `para above\n${body}`;
    default: return `> - [ ] q\n>   ${lines.join('\n>   ')}`;
  }
}

/** Inserts significant characters, blank lines and container prefixes at random places. */
function mutate(r, s) {
  const k = Math.floor(r() * 4);
  for (let i = 0; i < k; i++) {
    const at = Math.floor(r() * (s.length + 1));
    const ins = pick(r, ['<', '>', '"', "'", '=', '/', '!', '-', '--', '\n', '\n\n', '\n> ', '\n- ', '\n  ', '\n\n  ', '&', '#', ';', NUL, SOH, DEL,
      VT, FF, '\r', '\r\n', NBSP, NEL, LS, ZWSP, IDSP, BOM, KELVIN, '`', '\\', '*', '_', '[', ']', '(', ')', '|', '$', '<!--', '-->', '<b ', "<b title='", '<b title="',
      '</b>', ']]>', '?>', '<![CDATA[', '<?', '<!', '<svg>', '</svg>', '<style>', '</style>', '<textarea>', '</textarea>']);
    s = s.slice(0, at) + ins + s.slice(at);
  }
  return s;
}

/** A tag left open (by several syntaxes) followed by Markdown text that carries a reserved name. */
function absorb(r) {
  const open = pick(r, [
    "<b title='", '<b title="', '<b', '<b ', '<b x=', "<b x='a'", '<b title=a', "<span title='>'", '<span title=">"', '<i\n',
    "<b title='\n", '<a href="#x" title=\'', '<img alt="', "<input type=checkbox title='", '<svg><a title="', '<math><mi title=\'',
    '</b title="', '<style></style title=\'', '<b/', '<b title', '<b title =', "<b title= '", '<b' + FF, '<b' + NBSP + "title='",
    '<b ' + NUL + "='", "<b ''", '<b "x"=\'', "<b ='", "<b x='a' y=\"", '<b x="' + "'" + '" y=\'',
  ]);
  const tail = pick(r, ['', "'", '"', '>', "'>", '">', ' x']);
  const mid = pick(r, ['\n', '\n\n', ' ', '\n\n- ', '\n> ', '\n\n# ', '\n\n| a |\n|---|\n| ', '\n\n```\n', '\n\n$$\n', '\n- [ ] ', '\n\n<div>\n\n']);
  return inContainer(r, open + mid + mdCarrier(r) + pick(r, ['\n', '\n\n', ' ']) + mdCarrier(r) + tail);
}

export function generate(r, mode = 0) {
  const blocks = [];
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    // mode 1: mostly tags left open across container lines, mutated twice
    const k = mode === 1 ? r() * 0.4 : r();
    let b;
    if (k < 0.3) b = absorb(r);
    else if (k < 0.55) b = inContainer(r, inlineMix(r));
    else if (k < 0.7) b = inContainer(r, rawPiece(r, mdCarrier(r), true) + '\n' + mdCarrier(r));
    else if (k < 0.8) b = '```' + pick(r, ['', 'md-math', 'x data-l=1', 'js class="md-math"', '"><b data-l=1>', '&#109;d-math', '`']) + '\n' + mdCarrier(r) + '\n```';
    else if (k < 0.9) b = inContainer(r, mdCarrier(r) + '\n' + mdCarrier(r));
    else b = inContainer(r, rawPiece(r, '', true) + '\n\n' + mdCarrier(r) + '\n' + rawPiece(r, mdCarrier(r), true));
    if (chance(r, 0.5)) b = mutate(r, b);
    if (mode === 1) b = mutate(r, mutate(r, b));
    blocks.push(b);
  }
  return blocks.join(pick(r, ['\n\n', '\n', '\n\n\n']));
}
