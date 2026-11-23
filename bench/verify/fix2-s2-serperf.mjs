// bench/verify/fix2-s2-serperf.mjs — fix-serial-2 (stage 2b, G6 serializer side): times serializeBlock in
// Chromium on large single blocks. Needs a running Vite on MDR_PORT (default 5311); does not start one.
// Budget (U8 / task): ≤ 60 ms (median) for a 55 000-character paragraph and for a 1 000-line block. The
// "shape" rows run every character class the serializer treats specially at 20 000 and 40 000 characters;
// a pass that is linear doubles, a quadratic one quadruples (ratio printed; > 3 is reported as SUPERLINEAR);
// the 60 000 column is MAX_EDIT_CHARS, the largest block a session edits (info).
// Prints one MEAS line per case, exit 1 on a budget miss or a superlinear shape.
// Usage: MDR_PORT=5311 node bench/verify/fix2-s2-serperf.mjs [runs]
import { chromium } from '@playwright/test';

const PORT = Number(process.env.MDR_PORT) || 5311;
const RUNS = Number(process.argv[2]) || 5;
const timer = setTimeout(() => { console.error('global timeout'); process.exit(2); }, 110_000);
let browser;
let miss = 0;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  // a module URL as the document: no Vite client, so no reload while other agents edit src/
  await page.goto(`http://localhost:${PORT}/src/shared/types.ts`, { waitUntil: 'load' });
  const res = await page.evaluate(async (runs) => {
    const m = await import('/src/preview/serialize.ts');
    const words = ['alpha', 'beta', '中文', 'gamma', 'delta', '测试', 'x*y', 'a_b', '#1', 'e-mail', '$5', '[x]', 'a&b'];
    const prose = (n) => { let s = ''; for (let i = 0; s.length < n; i++) s += words[i % words.length] + ' '; return s.slice(0, n); };
    const sec = () => { const w = document.createElement('section'); w.className = 'md-block'; return w; };
    const para = (fill) => { const w = sec(); const p = document.createElement('p'); fill(p); w.appendChild(p); return w; };
    const textP = (s) => para((p) => { p.textContent = s; });
    const time = (build, kind, n) => {
      const ts = [];
      let len = 0;
      for (let r = 0; r < n; r++) {
        const el = build();
        document.body.appendChild(el);
        const t0 = performance.now();
        const md = m.serializeBlock(el, kind, { editing: true });
        ts.push(performance.now() - t0);
        len = md.length;
        el.remove();
      }
      ts.sort((a, b) => a - b);
      return { median: ts[Math.floor(ts.length / 2)], max: ts[ts.length - 1], len };
    };
    const budget = {
      'p55k-one-line': () => textP(prose(55000)),
      'p55k-1000-soft-lines': () => { const l = prose(54); return textP(Array.from({ length: 1000 }, () => l).join('\n')); },
      'p55k-1000-br-lines': () => para((p) => { const l = prose(54); for (let i = 0; i < 1000; i++) { if (i) p.appendChild(document.createElement('br')); p.appendChild(document.createTextNode(l)); } }),
      'p55k-1000-br-nbsp-lines': () => para((p) => { const l = prose(52) + ' '; for (let i = 0; i < 1000; i++) { if (i) p.appendChild(document.createElement('br')); p.appendChild(document.createTextNode(l)); } }),
    };
    const out = { budget: {}, shapes: {} };
    for (const [name, build] of Object.entries(budget)) out.budget[name] = time(build, 0, runs);
    const rep = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
    const shapes = {
      spaces: (n) => textP('a' + ' '.repeat(n) + 'b'),
      'space-nbsp': (n) => textP('a' + rep('  ', n) + 'b'),
      nbsp: (n) => textP('a' + ' '.repeat(n) + 'b'),
      tabs: (n) => textP('a' + '\t'.repeat(n) + 'b'),
      'soft-breaks': (n) => textP('a' + rep('\n', n) + 'b'),
      'space-newline': (n) => textP('a' + rep(' \n', n) + 'b'),
      amp: (n) => textP(rep('&amp;', n)),
      amps: (n) => textP(rep('&', n)),
      tilde: (n) => textP(rep('~', n)),
      'tilde-x': (n) => textP(rep('~x', n)),
      backslash: (n) => textP(rep('\\', n)),
      star: (n) => textP(rep('*', n)),
      hash: (n) => textP(rep('#', n)),
      'hash-space': (n) => textP(rep('# ', n)),
      dash: (n) => textP(rep('-', n)),
      'dash-space': (n) => textP(rep('- ', n)),
      pipe: (n) => textP(rep('|', n)),
      'pipe-dash': (n) => textP(rep('|-', n)),
      dollar: (n) => textP(rep('$', n)),
      'dollar-x': (n) => textP(rep('$x', n)),
      brackets: (n) => textP(rep('[a]', n)),
      lt: (n) => textP(rep('<a', n)),
      underscore: (n) => textP(rep('_', n)),
      pua: (n) => textP(rep('', n)),
      'heading-hash': (n) => { const w = sec(); const h = document.createElement('h2'); h.textContent = rep('a #', n); w.appendChild(h); return w; },
      'heading-spaces': (n) => { const w = sec(); const h = document.createElement('h2'); h.textContent = 'a' + ' '.repeat(n) + '#'; w.appendChild(h); return w; },
      'strong-many': (n) => para((p) => { for (let i = 0; i < n / 10; i++) { const s = document.createElement('strong'); s.textContent = 'bold'; p.appendChild(s); p.appendChild(document.createTextNode(' text ')); } }),
      'strong-glued': (n) => para((p) => { for (let i = 0; i < n / 10; i++) { const s = document.createElement(i % 2 ? 'strong' : 'em'); s.textContent = 'bold'; p.appendChild(s); } }),
      'links-many': (n) => para((p) => { for (let i = 0; i < n / 30; i++) { const a = document.createElement('a'); a.href = 'https://e.com/' + i; a.textContent = 'https://e.com/' + i; p.appendChild(a); p.appendChild(document.createTextNode(' x ')); } }),
      'code-many': (n) => para((p) => { for (let i = 0; i < n / 10; i++) { const c = document.createElement('code'); c.textContent = 'c' + i; p.appendChild(c); p.appendChild(document.createTextNode(' ')); } }),
      'code-ticks': (n) => para((p) => { const c = document.createElement('code'); c.textContent = rep('`a', n); p.appendChild(c); }),
      'br-many': (n) => para((p) => { for (let i = 0; i < n / 5; i++) { p.appendChild(document.createTextNode('abcd')); p.appendChild(document.createElement('br')); } p.appendChild(document.createTextNode('z')); }),
      'br-only': (n) => para((p) => { for (let i = 0; i < n / 4; i++) p.appendChild(document.createElement('br')); p.appendChild(document.createTextNode('z')); }),
      'span-many': (n) => para((p) => { for (let i = 0; i < n / 10; i++) { const s = document.createElement('span'); s.setAttribute('style', 'color:red'); s.textContent = 'abc'; p.appendChild(s); } }),
      'kbd-many': (n) => para((p) => { for (let i = 0; i < n / 10; i++) { const s = document.createElement('kbd'); s.textContent = 'abc'; p.appendChild(s); p.appendChild(document.createTextNode('$~[')); } }),
      'paras-many': (n) => { const w = sec(); for (let i = 0; i < n / 20; i++) { const p = document.createElement('p'); p.textContent = 'paragraph ' + i + ' $~['; w.appendChild(p); } return w; },
      'list-items': (n) => { const w = sec(); const u = document.createElement('ul'); for (let i = 0; i < n / 20; i++) { const li = document.createElement('li'); li.textContent = 'item ' + i; u.appendChild(li); } w.appendChild(u); return w; },
      'table-rows': (n) => { const w = sec(); const t = document.createElement('table'); const tb = document.createElement('tbody'); for (let i = 0; i < n / 20; i++) { const tr = document.createElement('tr'); for (let j = 0; j < 2; j++) { const td = document.createElement('td'); td.textContent = 'c' + i + '|'; tr.appendChild(td); } tb.appendChild(tr); } t.appendChild(tb); w.appendChild(t); return w; },
      'quote-lines': (n) => { const w = sec(); const q = document.createElement('blockquote'); const p = document.createElement('p'); p.textContent = rep('quoted line\n', n); q.appendChild(p); w.appendChild(q); return w; },
      'nested-strong': (n) => para((p) => { let cur = p; for (let i = 0; i < Math.min(n / 50, 400); i++) { const s = document.createElement(i % 2 ? 'strong' : 'em'); s.appendChild(document.createTextNode('x ')); cur.appendChild(s); cur = s; } }),
    };
    for (const [name, build] of Object.entries(shapes)) {
      const a = time(() => build(20000), 0, 1);
      if (a.median > 2000) { out.shapes[name] = { a: a.median, b: NaN, ratio: Infinity }; continue; }
      const b = time(() => build(40000), 0, 1);
      const c = time(() => build(60000), 0, 1);   // MAX_EDIT_CHARS
      out.shapes[name] = { a: a.median, b: b.median, c: c.median, ratio: b.median / Math.max(a.median, 1) };
    }
    return out;
  }, RUNS);
  for (const [name, r] of Object.entries(res.budget)) {
    const ok = r.median <= 60;
    if (!ok) miss++;
    console.log(`MEAS  ${name} median ${r.median.toFixed(1)} ms, max ${r.max.toFixed(1)} ms (out ${r.len} chars) (budget 60 ms) ${ok ? 'ok' : 'MISS'}`);
  }
  for (const [name, r] of Object.entries(res.shapes)) {
    const bad = r.b > 20 && r.ratio > 3 || r.a > 2000;
    if (bad) miss++;
    console.log(`SHAPE ${name.padEnd(16)} 20k ${r.a.toFixed(1).padStart(8)} ms  40k ${String(r.b.toFixed?.(1) ?? r.b).padStart(8)} ms  60k ${String(r.c?.toFixed?.(1) ?? '-').padStart(8)} ms  x${r.ratio.toFixed(1)}${bad ? '  SUPERLINEAR' : ''}`);
  }
} finally {
  await browser?.close();
  clearTimeout(timer);
}
process.exit(miss ? 1 : 0);
