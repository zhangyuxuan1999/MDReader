// bench/verify/v7-vf-links.mjs — verify-refs (round 6): S5 and the N2 class on edited links. Bare URLs and autolinks
// whose path holds percent-escapes of invisible characters (and visible ones), in a list item, a table cell, a heading
// and a quote; links and images with such destinations. Three sessions one after the other on what the previous one
// wrote: (1) a character typed inside the URL's link text, (2) another one at a second place of the same link text,
// (3) one typed after the link. The session starts with a click on plain text of the block; the caret is then put into
// the link's text (a click on the link itself would follow it).
// Checks after each session: every href / src in the preview is the original one; the link texts show the original
// characters plus what was typed; no character that is not plainly visible was added raw; the guard's console lines.
// Run: MDR_PORT=<server with hooks> node bench/verify/v7-vf-links.mjs [filter]   (T_MS, default 110000)
import { launch, openApp, load, source, toasts, clickAt, esc, rawAdded, show, globalTimeout, sleep } from './v7-vf-lib.mjs';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = new RegExp(process.argv[2] ?? '.');
const T_MS = Number(process.env.T_MS ?? 110000);

const U = {
  zwsp: 'https://e.example/docs/a%E2%80%8Bb/c',
  shy: 'https://e.example/word%C2%ADbreak',
  rlo: 'https://e.example/file%E2%80%AEtxt.exe',
  idsp: 'https://e.example/path%E3%80%80with%E3%80%80gap',
  nbsp: 'https://e.example/x%C2%A0y',
  zh: 'https://e.example/docs/%E4%B8%AD%E6%96%87/intro',
  lrm: 'https://e.example/he%E2%80%8Eb',
  fffc: 'https://e.example/o%EF%BF%BCc',
};
const ctx = {
  item: (u) => `# Links\n\n- 第一项 plain words\n- 见 ${u} 这里 tail words\n- 第三项\n`,
  itemAuto: (u) => `# Links\n\n- 第一项 plain words\n- 见 <${u}> 这里 tail words\n- 第三项\n`,
  cell: (u) => `# Links\n\n| 名称 | 地址 |\n| --- | --- |\n| tail words | ${u} |\n| 二 | 三 |\n`,
  cellAuto: (u) => `# Links\n\n| 名称 | 地址 |\n| --- | --- |\n| tail words | <${u}> |\n`,
  heading: (u) => `# Links\n\n## 参考 ${u} tail words\n\n正文\n`,
  quote: (u) => `# Links\n\n> 引用 <${u}> tail words\n`,
  mdlink: (u) => `# Links\n\n参见 [文档链接](${u} "标题") 和 ![图](${u}.png) tail words\n`,
};
const CASES = [];
for (const [uk, u] of Object.entries(U)) for (const [ck, f] of Object.entries(ctx)) CASES.push([`${ck}-${uk}`, f(u), ck === 'mdlink' ? '文档链接' : 'example']);
const FILTERED = CASES.filter((c) => filter.test(c[0]));

const facts = (A) => A.page.evaluate(() => {
  const root = window.__mdr.app.preview.el;
  return {
    href: Array.from(root.querySelectorAll('a[href], img[src]')).map((e) => e.getAttribute('href') ?? e.getAttribute('src')),
    text: Array.from(root.querySelectorAll('a[href]')).map((e) => e.textContent),
  };
});
/** Caret into the link text of the live session: after `needle`+`off` inside the first <a>. */
const linkCaret = (A, needle, off) => A.page.evaluate(([needle, off]) => {
  const el = document.querySelector('.md-block.is-editing'); if (!el) return false;
  const a = el.querySelector('a'); if (!a) return false;
  const tw = document.createTreeWalker(a, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf(needle); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + off); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } }
  return false;
}, [needle, off]);
const endCaret = (A) => A.page.evaluate(() => {
  const el = document.querySelector('.md-block.is-editing'); if (!el) return false;
  const tw = document.createTreeWalker(el, 4); let last = null;
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if (n.data.includes('tail words')) last = n;
  if (!last) return false; const r = document.createRange(); r.setStart(last, last.data.indexOf('tail words') + 10); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true;
});

let browser;
const stop = globalTimeout(T_MS, async () => browser?.close());
let bad = 0, refused = 0;
try {
  browser = await launch();
  const A = await openApp(browser, port, { perf: true });
  for (const [name, doc, needle] of FILTERED) {
    A.guard.length = 0;
    await load(A, doc, name + '.md');
    const f0 = await facts(A);
    const t0 = await toasts(A);
    let typed = '', note = [];
    const steps = [['Z', (A) => linkCaret(A, needle, 3)], ['Y', (A) => linkCaret(A, needle.slice(0, 2), 1)], ['W', (A) => endCaret(A)]];
    let wantText = f0.text.slice();
    let ok = true;
    for (const [ch, place] of steps) {
      const on = await clickAt(A, 'tail words', 0, 3);
      if (!on) { note.push(`${ch}:no-session toast=${(await toasts(A)) - t0}`); if ((await toasts(A)) > t0) refused++; ok = ok && true; break; }
      const placed = await place(A);
      if (!placed) { note.push(`${ch}:no-caret`); await esc(A); break; }
      await A.page.keyboard.type(ch); typed += ch;
      await sleep(250);
      await esc(A);
      const f1 = await facts(A);
      const out = await source(A);
      const added = rawAdded(doc, out, typed);
      const hrefSame = JSON.stringify(f1.href) === JSON.stringify(f0.href);
      // the first link's text: the original with the typed characters (where the caret was)
      const t1 = (f1.text[0] ?? '');
      const textOk = ch === 'W' ? t1 === wantText[0] : t1.split('Z').join('').split('Y').join('') === f0.text[0] && t1.includes(ch);
      wantText = f1.text.slice();
      const good = !added.length && hrefSame && textOk && !A.guard.length;
      if (!good) ok = false;
      note.push(`${ch}:${good ? 'ok' : 'BAD'}${added.length ? ' raw+=' + added.join(',') : ''}${hrefSame ? '' : ' href ' + show(f0.href.join(' ')) + ' -> ' + show(f1.href.join(' '))}${textOk ? '' : ' text ' + show(f0.text[0]) + ' -> ' + show(t1)}`);
      if (!good || process.env.VERBOSE) note.push('src ' + show(out.split('\n').filter((l) => /e\.example/.test(l)).join(' / ')));
    }
    if (!ok) bad++;
    console.log(`${ok ? 'ok ' : 'BAD'} ${name}: guard=${A.guard.length} ${note.join(' | ')}`);
  }
  console.log(`RESULT bad=${bad} refused=${refused} of ${FILTERED.length}`);
} finally { stop(); await browser?.close(); }
