// bench/verify/v5-offp-fuzz.mjs — verify-off-preview (0.2.0, round 4 verification): a differential fuzz of the
// preview with 预览可编辑 OFF, the candidate against 0.1.1, built on bench/verify/v5-offd-lib.mjs (same observations,
// same diff). Different from v5-offd-fuzz.mjs: documents it never loads (CJK / RTL / emoji / combining marks, raw HTML
// of every kind the sanitizer keeps, footnotes, reference links, a 2000-row table, a 5000-item list, a 100 000-char
// paragraph), conditions chosen at random per seed (dark theme, narrow / wide window, CSS zoom), word / line drags
// (double- and triple-click drags), Shift+arrow extension of a pointer selection, a copy after most selections,
// editor typing interleaved right before a gesture (no settle), and optionally (--after) the switch turned ON, a
// session used (type, Esc, a click elsewhere), the switch turned OFF and the document reloaded, before the run.
//   MDR_PORT=5485 MDR_BASE_PORT=5495 MDR_CAND_PERF=1 MDR_STRICT_CLIP=1 node bench/verify/v5-offp-fuzz.mjs <seed>
//        [--ops n] [--doc intl|raw|big|longpara|mix] [--after] [--replay file [--upto k]]
// Exit 0 same, 1 differs, 3 timeout. Writes its op list to $MDR_SCRATCH/offp-<seed>.json. Nothing into the tree.
import * as L from './v5-offd-lib.mjs';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const seed = Number(argv.find((a) => /^\d+$/.test(a)) ?? 1);
const nOps = Number(opt('--ops', 40));
const replay = opt('--replay', null);
const upto = Number(opt('--upto', 1e9));
const AFTER = argv.includes('--after');
L.globalTimeout(Number(process.env.MDR_TIMEOUT || 280000));

const cp = (n) => String.fromCodePoint(n);
const ZWJ = cp(0x200d);
const FAMILY = cp(0x1f469) + ZWJ + cp(0x1f469) + ZWJ + cp(0x1f467);
const COMB = 'e' + cp(0x301) + cp(0x302);
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAIAAAB/FOjAAAAAE0lEQVR4nGP4z8BAEmIY1TBsNQAAa/x/gXSyPv0AAAAASUVORK5CYII=';
const DOCS = {
  intl: [
    '# 国际化 标题 עברית', '',
    '中文段落：这是一个很长的中文句子，用来测试选择和复制，包含**粗体文字**和*斜体*以及`代码`。日本語の文章もあります。한국어 문장도 있습니다。这一句再长一点，让它在预览里折行两次以上，方便拖动选择跨越行尾。', '',
    'עברית: זהו משפט בעברית עם **מודגש** ו-[קישור](https://example.com/he) בתוכו, ועוד כמה מילים כדי שהשורה תהיה ארוכה.', '',
    'العربية: هذه جملة عربية مع *مائل* ورقم 123 داخلها، وبعض الكلمات الإضافية لجعل السطر أطول.', '',
    `Mixed: English 中文 עברית العربية 123 mixed in one line, emoji ${cp(0x1f600)}${cp(0x1f44d)}${cp(0x1f3fd)} and family ${FAMILY} (ZWJ), combining ${COMB} marks.`, '',
    '| 列一 | עמודה | col |', '|---|---|---|', `| 单元格 | תא | ${cp(0x1f600)} |`, '| 第二行 | שורה | two |', '',
    '- [ ] q1 任务 中文', '- [ ] q2 משימה עברית', `- [x] q3 emoji ${cp(0x1f389)} task`, '',
    '> 引用 中文 quote with עברית and $x^2$ formula', '',
    '```', `code 中文 ${cp(0x1f600)}`, '```', '',
    '1. 第一项', '2. פריט שני', '3. third', '',
    'End 结束 סוף.', '',
  ].join('\n'),
  raw: [
    '# Raw kinds', '',
    'Text with <kbd>Ctrl</kbd>+<kbd>C</kbd>, H<sub>2</sub>O and x<sup>2</sup>, <abbr title="t">abbr</abbr>, <mark>marked</mark>, <ins>ins</ins> <del>del</del>, <small>small</small>, <q>quoted</q>, <cite>cite</cite>, <var>v</var>, <samp>samp</samp>.', '',
    '<details>', '<summary>Summary line here</summary>', '', 'Inside details paragraph with **bold** words.', '', '</details>', '',
    '<details open>', '<summary>Open summary</summary>', '', 'Open details body text.', '', '</details>', '',
    '<a name="anchor1"></a>Named anchor paragraph. Jump [to anchor](#anchor1) and [to foot](#fn1).', '',
    `<img src="${IMG}" alt="raw img" width="32"> image paragraph with text after.`, '',
    '<div align="center">Centered div text</div>', '',
    '<p>A raw paragraph with <b>b</b> and <i>i</i> and <u>u</u> and <s>s</s>.</p>', '',
    '<dl><dt>Term</dt><dd>Definition text</dd></dl>', '',
    '<table><tr><th>H1</th><th>H2</th></tr><tr><td>c1</td><td>c2</td></tr></table>', '',
    'Footnote ref[^a] and another[^b] in a paragraph.', '',
    '[^a]: Footnote A text.', '[^b]: Footnote B with `code` and **bold**.', '',
    'Ref link [ref one][r1] and [r2] and [collapsed][].', '',
    '[r1]: https://example.com/r1 "Title one"', '[r2]: https://example.com/r2', '[collapsed]: https://example.com/c', '',
    'Line with hard break  ', 'second line after break.', '',
    'Last paragraph.', '',
  ].join('\n'),
  big: [
    '# Big', '', 'Intro paragraph above the table.', '',
    '| n | name | value |', '|---|---|---|',
    ...Array.from({ length: 2000 }, (_, i) => `| ${i} | row name ${i} | value ${i * 7} |`), '',
    ...Array.from({ length: 5000 }, (_, i) => `- item ${i} text`), '',
    'Tail paragraph.', '',
  ].join('\n'),
  longpara: [
    '# Long', '', 'Short before.', '',
    Array.from({ length: 16000 }, (_, i) => ['lorem', 'ipsum', 'dolor', '中文', 'sit'][i % 5]).join(' ').slice(0, 100000), '',
    'Short after.', '',
  ].join('\n'),
};
DOCS.mix = [DOCS.intl, DOCS.raw].join('\n');
DOCS.ticks = [
  '# Tasks 任务', '', 'Intro paragraph with **bold** and a [link](https://example.com/t).', '',
  '- [ ] t1 中文任务', '- [x] t2 משימה', '  - [ ] t3 nested $x^2$', '  - [ ] t4 nested ![i](x.png)', '- [ ] t5 plain', '',
  '1. [ ] t6 ordered', '2. [x] t7 ordered', '', '> - [ ] t8 quoted', '> - [ ] t9 quoted', '',
  '* [ ] t10 star', '+ [ ] t11 plus', '', 'Middle paragraph.', '', '- [ ] t12 same', '- [ ] t12 same', '', 'End.', '',
].join('\n');
const BOXES = argv.includes('--boxes');
const DOC_ORDER = ['intl', 'raw', 'mix', 'intl', 'raw', 'longpara', 'mix', 'big'];

const KEYS = ['Shift+ArrowRight', 'Shift+ArrowLeft', 'Shift+ArrowDown', 'Shift+ArrowUp', 'Shift+End', 'Shift+Home', 'Alt+Shift+ArrowRight',
  'Meta+Shift+ArrowRight', 'ArrowDown', 'ArrowRight', 'Space', 'Shift+Space', 'PageDown', 'PageUp', 'Home', 'End', 'Tab', 'Shift+Tab', 'Enter',
  'a', 'Backspace', 'Delete', 'Escape', 'Meta+a', 'Meta+b', 'Meta+i', 'Meta+e', 'Meta+k', 'Alt+ArrowUp', 'Control+a', 'Control+e', 'Meta+ArrowDown'];

async function facts(S) {
  return S.page.evaluate(() => {
    const root = document.querySelector('.mdr-preview');
    const box = root.getBoundingClientRect();
    const vis = [];
    for (const s of root.querySelectorAll('section.md-block')) {
      const r = s.getBoundingClientRect();
      if (r.height > 0 && r.bottom > box.top + 6 && r.top < box.bottom - 6 && s.textContent.trim() && !s.querySelector('input:not(li > input), label')) vis.push([Number(s.dataset.id), s.textContent.length]);
    }
    const ed = document.querySelector('.cm-scroller');
    const boxes = Array.from(root.querySelectorAll('li input[type="checkbox"]')).filter((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.top > box.top + 4 && r.bottom < box.bottom - 4; }).length;
    return { vis, boxes, pvShown: box.width > 50, edShown: !!ed && ed.getBoundingClientRect().width > 50 };
  });
}

function genOp(R, F) {
  const at = () => { const [b, len] = R.pick(F.vis); return { b, o: R.int(Math.max(1, Math.min(len, 300))) }; };
  const ch = [];
  const add = (w, f) => { for (let i = 0; i < w; i++) ch.push(f); };
  if (F.pvShown && F.vis.length) {
    add(6, () => [['click', at(), { count: R.pick([1, 1, 2, 3]) }]]);
    add(3, () => [['click', at(), { mods: [R.pick(['Shift', 'Shift', 'Alt'])] }], ['key', 'Meta+c']]);
    add(8, () => [['drag', at(), at(), { count: R.pick([1, 1, 2, 3]) }], ['key', 'Meta+c']]);
    add(4, () => [['drag', at(), at()], ['key', R.pick(KEYS.slice(0, 8))], ['key', R.pick(KEYS.slice(0, 8))], ['key', 'Meta+c']]);
    add(2, () => [['drag', at(), { x: 1, y: R.pick([2, 500, 897]) }], ['key', 'Meta+c']]);
    add(2, () => [['click', at(), { button: 'right' }], ['key', 'Escape']]);
    add(2, () => [['wheel', { pane: 'pv', fx: 0.5, fy: 0.5 }, R.pick([-500, 300, 800])]]);
    add(1, () => [['scrollLine', Math.round(R() * 100) / 100]]);
    if (F.edShown) add(3, () => [['edit', { at: { edLine: 1 + R.int(6) }, text: R.pick(['x', ' 中', 'ab']), fast: true }], ['click', at(), { count: R.pick([1, 2]) }]]);
    if (F.edShown) add(2, () => [['drag', at(), at()], ['edit', { at: { edLine: 1 + R.int(6) }, text: 'q' }], ['key', 'Meta+c']]);
    add(1, () => [['drag', at(), at()], ['mode', 'preview'], ['key', 'Meta+c'], ['mode', 'split']]);
    add(1, () => [['dropText', at(), 'dropped 文本']]);
    if (BOXES && F.boxes) {
      add(8, () => [['click', { css: 'li input[type="checkbox"]', nth: R.int(F.boxes) }]]);
      add(2, () => [['click', { css: 'li input[type="checkbox"]', nth: R.int(F.boxes) }], ['click', { css: 'li input[type="checkbox"]', nth: R.int(F.boxes) }, { after: 50 }]]);
      if (F.edShown) add(3, () => [['edit', { at: { edLine: 1 + R.int(8) }, text: R.pick(['x', '\n', ' 中']) }], ['click', { css: 'li input[type="checkbox"]', nth: R.int(F.boxes) }]]);
      add(1, () => [['key', 'Tab'], ['key', 'Space']]);
    }
    add(1, () => [['pasteEvt', '<b>html</b> text']]);
  }
  add(6, () => [['key', R.pick(KEYS)]]);
  add(2, () => [['key', 'Meta+a'], ['key', 'Meta+c']]);
  add(1, () => [['key', 'Meta+x']]);
  add(1, () => [['type', R.pick(['abc', '中文', ' '])]]);
  add(1, () => [['ime', '字']]);
  add(1, () => [['mode', R.pick(['split', 'preview'])]]);
  return R.pick(ch)();
}

async function myReset(S, text, name) {
  const p = S.page;
  await p.evaluate(({ t, n }) => window.__mdr.loadText(t, n), { t: text, n: name });
  S.doc = name;
  await L.settle(S, text.length > 50000 ? 1500 : 300);
  await p.evaluate(() => { getSelection().removeAllRanges(); const a = document.activeElement; if (a && a !== document.body) a.blur(); const r = document.querySelector('.mdr-preview'); const s = document.querySelector('.cm-scroller'); if (s) s.scrollTop = 0; if (r) r.scrollTop = 0; });
  await L.settle(S, 700);
  await p.evaluate(() => navigator.clipboard.writeText('<<offp-none>>'));
  await p.evaluate(() => { const O = window.__offd; O.ev.length = 0; O.toasts.length = 0; O.errs.length = 0; });
  S.pageErrors.length = 0; S.navs.length = 0; S.pts = [];
}

async function useSessionThenOff(S) {
  // candidate only: switch ON, a session (type, Esc), a click elsewhere, a second session left by a mode switch, OFF
  const p = S.page;
  await p.evaluate(() => window.__mdr.app.registry.run('view.togglePreviewEdit'));
  await L.sleep(300);
  const pt = await p.evaluate(() => { const s = Array.from(document.querySelectorAll('.mdr-preview section.md-block p')).find((e) => e.textContent.length > 20); if (!s) return null; const r = s.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 6 }; });
  if (pt) {
    await p.mouse.click(pt.x, pt.y); await L.sleep(300);
    await p.keyboard.type('Z'); await L.sleep(200); await p.keyboard.press('Backspace'); await L.sleep(200);
    await p.keyboard.press('Escape'); await L.sleep(400);
    await p.mouse.click(pt.x + 40, pt.y); await L.sleep(300);
    await p.evaluate(() => window.__mdr.mode('preview')); await L.sleep(300);
    await p.evaluate(() => window.__mdr.mode('split')); await L.sleep(300);
  }
  await p.evaluate(() => window.__mdr.app.registry.run('view.togglePreviewEdit'));
  await L.sleep(400);
  // close the switch's toast (it would differ from 0.1.1 in the toasts field: it is removed below anyway)
  return await p.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed'));
}

// one step on both sides, then the lib's observations and diff; copied text/html is compared byte for byte (styles
// included, MDR_STRICT_CLIP) after the two origins (ports) are made equal: links are copied as absolute URLs
const normClip = (o) => { if (o && o.clip && typeof o.clip['text/html'] === 'string') o.clip['text/html'] = o.clip['text/html'].replace(/localhost:\d+/g, 'ORIGIN'); return o; };
async function runOne(P, st) {
  const isClip = st[0] === 'key' && /Meta\+[cx]$/.test(st[1]);
  let ec, eb;
  const [rc, rb] = await Promise.all([L.step(P.cand, st).catch((e) => { ec = e; return 'ERR ' + e.message; }), L.step(P.base, st).catch((e) => { eb = e; return 'ERR ' + e.message; })]);
  if (ec && eb && String(ec.message) === String(eb.message)) return { ok: true, skipped: ec.message };
  const look = async () => { const [c, b] = await Promise.all([L.obs(P.cand, { clip: isClip }), L.obs(P.base, { clip: isClip })]); return L.diff(normClip(c), normClip(b), {}); };
  let d = await look();
  if (d.length && rc === rb) { await L.sleep(900); const d2 = await look(); if (!d2.length) { L.transient.push({ step: st, first: L.fmtDiff(d) }); d = []; } else d = d2; }
  if (rc !== rb) d.unshift({ field: 'stepResult', cand: rc, base: rb, detail: '' });
  return d.length ? { ok: false, diffs: d } : { ok: true };
}

const R = L.rng(seed);
let plan;
if (replay) plan = JSON.parse(readFileSync(replay, 'utf8'));
else {
  const docName = opt('--doc', DOC_ORDER[seed % DOC_ORDER.length]);
  plan = {
    seed, docName, after: AFTER,
    theme: R() < 0.35 ? 'dark' : 'light',
    viewport: R.pick([{ width: 1400, height: 900 }, { width: 1400, height: 900 }, { width: 760, height: 820 }, { width: 2200, height: 1000 }]),
    zoom: R.pick([1, 1, 1, 0.67, 1.5]),
    mode: R() < 0.25 ? 'preview' : 'split',
    ops: null,
  };
}
const P = await L.openPair({ mode: plan.mode, viewport: plan.viewport });
let code = 0;
try {
  for (const S of [P.cand, P.base]) {
    await S.page.emulateMedia({ colorScheme: plan.theme });
    if (plan.zoom !== 1) await S.page.evaluate((z) => { document.documentElement.style.zoom = String(z); }, plan.zoom);
  }
  if (plan.after) console.log('after-session switch state:', await useSessionThenOff(P.cand));
  await Promise.all([myReset(P.cand, DOCS[plan.docName], plan.docName + '.md'), myReset(P.base, DOCS[plan.docName], plan.docName + '.md')]);
  const head = `seed=${plan.seed} doc=${plan.docName} theme=${plan.theme} vp=${plan.viewport.width}x${plan.viewport.height} zoom=${plan.zoom} mode=${plan.mode}${plan.after ? ' after' : ''}`;
  console.log(head);
  const ops = [];
  if (plan.ops) ops.push(...plan.ops.slice(0, upto));
  let res = await L.runBoth(P, [], {});   // the initial state only
  if (!res.ok) { console.log('INITIAL DIFF', L.fmtDiff(res.diffs)); code = 1; }
  for (let i = 0; code === 0 && i < (plan.ops ? ops.length : nOps); i++) {
    let group;
    if (plan.ops) group = [ops[i]];
    else { const F = await facts(P.cand); group = genOp(R, F); }
    for (const st of group) {
      if (!plan.ops) ops.push(st);
      res = await runOne(P, st);
      if (!res.ok) {
        console.log(`DIFF at op ${plan.ops ? i : ops.length - 1} ${JSON.stringify(st)}: ${L.fmtDiff(res.diffs)}`);
        if (process.env.MDR_VERBOSE) for (const d of res.diffs) console.log('  ', d.field, JSON.stringify(d.cand)?.slice(0, 600), '|', JSON.stringify(d.base)?.slice(0, 600));
        code = 1; break;
      }
      if (res.skipped) { /* both sides skipped this op the same way */ }
    }
  }
  if (!replay) L.writeJson(`${L.SCRATCH}/offp-${plan.seed}${plan.after ? '-after' : ''}.json`, { ...plan, ops });
  console.log(code === 0 ? `SAME after ${ops.length} ops` : `DIFFERS (ops in ${L.SCRATCH}/offp-${plan.seed}${plan.after ? '-after' : ''}.json)`);
  if (L.transient.length) console.log('transient (equal on a second look):', L.transient.length);
} catch (e) {
  console.log('ERROR', e && e.stack ? e.stack.slice(0, 600) : e); code = 2;
} finally {
  await L.closeAll();
  process.exit(code);
}
