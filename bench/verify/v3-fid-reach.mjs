// bench/verify/v3-fid-reach.mjs — verify-fidelity (0.2.0 stage 2c): reachability of serializer / fidelity-gate
// defects with REAL clicks and keys in Chromium, and the U13 / U14 cases where they meet the serializer.
// Needs (or starts, detached, and leaves running) a Vite dev server on MDR_PORT (default 5381) via v2-ses-lib.mjs.
// Writes nothing into the tree. Usage: MDR_PORT=5381 node bench/verify/v3-fid-reach.mjs [case-name-substring ...]
// Prints PASS / FAIL per case with the source before and after; exit code 1 when a case fails.
import { openB, sleep, check, results, J, globalTimeout } from './v2-ses-lib.mjs';

const only = process.argv.slice(2);
let B = null;
const stop = globalTimeout(Number(process.env.MDR_TIMEOUT ?? 110_000), async () => { await B?.close(); });

/** In-page: canonical form of every block of the preview (fidelity.ts canonicalForm), <del> = <s>. */
const previewCanon = () => B.page.evaluate(async () => {
  const fid = await import('/src/preview/fidelity.ts');
  const root = document.querySelector('.mdr-preview__body') ?? document.querySelector('.mdr-preview');
  return Array.from(root.querySelectorAll('section.md-block')).map((s) => fid.canonicalForm(s).replace(/<(\/?)del>/g, '<$1s>')).join('\n');
});
const toast = () => B.page.evaluate(() => Array.from(document.querySelectorAll('[class*="toast"]')).map((t) => t.textContent).join(' | '));

async function start(doc, line, needle, load = true) {
  if (load) await B.loadDoc(doc, 'v3fid.md');
  await B.settle(300);
  await B.mountLine(line);
  await sleep(700);                                     // the navigation anchor of scrollToLine expires
  const pt = await B.textPoint(line, 'first', needle);
  if (!pt) throw new Error(`no point for ${needle}`);
  await B.page.mouse.click(pt.x, pt.y);
  for (let i = 0; i < 10; i++) { await sleep(40); if (await B.editing()) return true; }
  return false;
}
async function keys(ops) {
  for (const op of ops) {
    if (op.caretLi !== undefined) await B.page.evaluate((i) => {
      const li = document.querySelectorAll('.mdr-preview .is-editing li')[i];
      const r = document.createRange(); r.setStart(li, li.querySelector('input') ? 1 : 0); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }, op.caretLi);
    if (op.caret) await B.caretAt(op.caret, op.where ?? 'after');
    if (op.joined) await B.joined(op.joined, op.mode ?? 'after');
    if (op.type !== undefined) await B.page.keyboard.type(op.type, { delay: 25 });
    if (op.press) await B.page.keyboard.press(op.press);
    await sleep(op.wait ?? 60);
  }
}
async function finish() {
  await sleep(150);
  await B.page.keyboard.press('Escape');
  await B.settle(400);
  return B.source();
}

const CASES = [
  // ---- FID-1: a task item [x] in a document that defines [x] (the gate renders without the document's references)
  {
    name: 'task-ref-x', doc: '- [x] done\n- [ ] open\n\n[x]: https://ref.example/x\n', line: 1, click: 'done',
    ops: [{ caret: 'done' }, { type: 'Z' }],
    judge: async (src, before, after) => {
      const links = await B.page.evaluate(() => document.querySelector('.mdr-preview li')?.querySelectorAll('a').length ?? -1);
      return { ok: !src.includes('[x](') && links === 1, detail: `links in item 1 after edit: ${links}` };
    },
  },
  {
    name: 'task-ref-X-upper', doc: '- [X] done\n\n[x]: https://ref.example/x\n', line: 1, click: 'done',
    ops: [{ caret: 'done' }, { type: 'Z' }],
    judge: async (src) => ({ ok: !src.includes('](https://ref.example/x)'), detail: '' }),
  },
  // ---- G20 variation: a formula whose TeX starts and ends with a digit (math.ts's currency rule)
  { name: 'g20-currency-space', doc: '和 $1+2$x 结束\n', line: 1, click: '结束', ops: [{ caret: 'x', where: 'before' }, { type: ' ' }], expectMath: 1 },
  { name: 'g20-currency-delete-dot', doc: '面积 $3\\times4$.\n', line: 1, click: '面积', ops: [{ caret: '.', where: 'after' }, { press: 'Backspace' }], expectMath: 1 },
  { name: 'g20-currency-delete-cjk', doc: '等于 $10$。\n', line: 1, click: '等于', ops: [{ caret: '。', where: 'after' }, { press: 'Backspace' }], expectMath: 1 },
  // ---- three adjacent lists in one block: the gate refuses (nothing written; the toast)
  { name: 'adjacent-lists-refused', doc: '- a\n\n* b\n\n+ c\n', line: 1, click: 'a', ops: [], expectSession: true },
  // ---- U13 meets the serializer: Enter before whitespace whose next character is Markdown at a line start
  { name: 'u13-hash', doc: 'abc # def\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter' }], expect: 'abc\n\n\\# def\n' },
  { name: 'u13-dash', doc: 'abc - def\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter' }], expect: 'abc\n\n\\- def\n' },
  { name: 'u13-ordered', doc: 'abc 1. def\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter' }], expect: 'abc\n\n1\\. def\n' },
  { name: 'u13-gt-shift', doc: 'abc > def\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Shift+Enter' }], render: true },
  { name: 'u13-hash-shift', doc: 'abc # def\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Shift+Enter' }], render: true },
  { name: 'u13-dashes-shift', doc: 'abc - - -\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Shift+Enter' }], render: true },
  { name: 'u13-equals-shift', doc: 'abc ===\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Shift+Enter' }], render: true },
  { name: 'u13-in-bold', doc: '**abc def** x\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter' }], render: true },
  { name: 'u13-before-em', doc: 'abc *em* x\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter' }], render: true },
  { name: 'u13-before-link', doc: 'abc [l](https://e.example) x\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter' }], render: true },
  { name: 'u13-before-url', doc: 'abc https://e.example/x y\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter' }], render: true },
  { name: 'u13-li-hash', doc: '- abc # def\n- two\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter' }], render: true },
  { name: 'u13-quote-gt', doc: '> abc > def\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter' }], render: true },
  { name: 'u13-heading-hash', doc: '## abc # def\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter' }], render: true },
  { name: 'u13-cell-shift', doc: '| abc - def | b |\n|---|---|\n| c | d |\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Shift+Enter' }], render: true },
  // integrator (round 3): fails as before round 3 (identical on the snapshot taken before round 3): Enter at the end of 'abc' (a
  // paragraph block before the list block) shows an empty paragraph that has no source form until text is typed into
  // it (K16 / G11, accepted), so the session's DOM shows one empty <p> more than the re-render. Nothing is written.
  { name: 'u13-softbreak-dash', doc: 'abc\n- def\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter' }], render: true },
  { name: 'u13-math-after', doc: 'abc $x$ y\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter' }], render: true },
  // ---- Enter right before a non-editable atom (formula, image): an extra line break / the caret after the atom
  { name: 'atom-enter-formula', doc: 'abc $x$ y\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter', wait: 400 }, { type: 'Z' }], expect: 'abc\n\nZ$x$ y\n' },
  { name: 'atom-enter-formula-fast', doc: 'abc $x$ y\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter', wait: 0 }, { type: 'Z' }], expect: 'abc\n\nZ$x$ y\n' },
  { name: 'atom-shift-enter-formula', doc: 'abc $x$ y\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Shift+Enter', wait: 400 }, { type: 'Z' }], expect: 'abc  \nZ$x$ y\n' },
  { name: 'atom-enter-formula-li', doc: '- abc $x$ y\n- b\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter', wait: 400 }, { type: 'Z' }], expect: '- abc\n- Z$x$ y\n- b\n' },
  { name: 'atom-enter-image', doc: 'abc ![i](https://e.example/i.png) y\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter', wait: 400 }, { type: 'Z' }], expect: 'abc\n\nZ![i](https://e.example/i.png) y\n' },
  { name: 'atom-enter-image-fast', doc: 'abc ![i](https://e.example/i.png) y\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter', wait: 0 }, { type: 'Z' }], expect: 'abc\n\nZ![i](https://e.example/i.png) y\n' },
  // ---- typing right next to a link whose text is its URL (U11, real Chromium caret placement)
  { name: 'url-type-after', doc: 'see https://e.example/a now\n', line: 1, click: 'see', ops: [{ caret: 'https://e.example/a' }, { type: 'x' }], render: true },
  { name: 'url-type-before', doc: 'see https://e.example/a now\n', line: 1, click: 'see', ops: [{ caret: 'https', where: 'before' }, { type: 'v' }], render: true },
  { name: 'autolink-type-after', doc: 'see <https://e.example/a> now\n', line: 1, click: 'see', ops: [{ caret: 'https://e.example/a' }, { type: '.' }], render: true },
  { name: 'autolink-type-before', doc: 'see <https://e.example/a> now\n', line: 1, click: 'see', ops: [{ caret: 'see ' }, { press: 'Backspace' }, { type: '2' }], render: true },
  { name: 'email-type-before', doc: 'mail a@b.example now\n', line: 1, click: 'mail', ops: [{ caret: 'mail ' }, { press: 'Backspace' }], render: true },
  { name: 'url-cjk-after', doc: '见 https://e.example/a 网站\n', line: 1, click: '网站', ops: [{ caret: '网站', where: 'before' }, { press: 'Backspace' }], render: true },
  // ---- soft line breaks next to the typing point
  { name: 'soft-type-before-nl', doc: 'abc\ndef\n\nnext\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { type: 'Q' }], expect: 'abcQ\ndef\n\nnext\n' },
  { name: 'soft-type-after-nl', doc: 'abc\ndef\n\nnext\n', line: 1, click: 'def', ops: [{ caret: 'def', where: 'before' }, { type: 'Q' }], expect: 'abc\nQdef\n\nnext\n' },
  { name: 'soft-type-middle', doc: 'one two\nthree four\nfive\n', line: 1, click: 'four', ops: [{ caret: 'four' }, { type: 'Q' }], expect: 'one two\nthree fourQ\nfive\n' },
  { name: 'soft-type-cjk', doc: '第一行\n第二行\n', line: 1, click: '第一行', ops: [{ caret: '第一行' }, { type: 'Q' }], expect: '第一行Q\n第二行\n' },
  { name: 'soft-delete-near-nl', doc: 'abcd\nefg\n', line: 1, click: 'abcd', ops: [{ caret: 'abcd' }, { press: 'Backspace' }], expect: 'abc\nefg\n' },
  // ---- emptied items (G8 spellings), then edited again in a second session
  { name: 'empty-task-then-type', doc: '- [ ] a\n- [x] bb\n', line: 1, click: 'bb', ops: [{ caret: 'bb' }, { press: 'Backspace' }, { press: 'Backspace' }], again: { click: 'a', ops: [{ caretLi: 1 }, { type: 'Q' }] }, expect: '- [ ] a\n- [x] Q\n' },
  { name: 'empty-nested-first-then-type', doc: '- on\n  - aa\n  - b\n', line: 1, click: 'aa', ops: [{ caret: 'aa' }, { press: 'Backspace' }, { press: 'Backspace' }], again: { click: 'on', ops: [{ caretLi: 1 }, { type: 'Q' }] }, expect: '- on\n  - Q\n  - b\n' },
  // ---- U14: a first block with a leading blank line
  // integrator (round 3), harness repair: the typed stars are literal text, so the source must escape them (`abc*Q*`
  // would render as emphasis; was expect '\nabc*Q*\ndef\n\nnext\n'). Still fails by K20 (H9, accepted): typing next
  // to the soft line break joins the two source lines (written 'abc\\*Q\\* def').
  { name: 'u14-type', doc: '\nabc\ndef\n\nnext\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { type: '*Q*' }], expect: '\nabc\\*Q\\*\ndef\n\nnext\n' },
  { name: 'u14-enter', doc: '\nabc def\n\nnext\n', line: 1, click: 'abc', ops: [{ caret: 'abc' }, { press: 'Enter' }], expect: '\nabc\n\ndef\n\nnext\n' },
  { name: 'u14-hash-first', doc: ' \nabc\n\nnext\n', line: 1, click: 'abc', ops: [{ caret: 'abc', where: 'before' }, { type: '# ' }], render: true },
  { name: 'u14-dashes', doc: '\nabc\n\nnext\n', line: 1, click: 'abc', ops: [{ caret: 'abc', where: 'after' }, { press: 'Shift+Enter' }, { type: '---' }], render: true },
];

try {
  B = await openB();
  await B.boot('mode=split');
  for (const c of CASES) {
    if (only.length && !only.some((o) => c.name.includes(o))) continue;
    try {
      const ok = await start(c.doc, c.line, c.click);
      if (c.expectSession) {
        const t = await toast();
        check(c.name, ok, `session ${ok}; toast "${t.slice(0, 60)}"`);
        if (ok) await B.page.keyboard.press('Escape');
        continue;
      }
      if (!ok) {
        const why = await B.page.evaluate(async () => { const f = await import('/src/preview/fidelity.ts'); const st = f.fidelityStats(); return { refusals: st.refusals, last: st.last && { baseline: st.last.baseline, shown: st.last.shown.slice(0, 300), rendered: st.last.rendered.slice(0, 300) } }; });
        check(c.name, false, `no session started; toast "${(await toast()).slice(0, 40)}"; gate ${J(why)}`);
        continue;
      }
      const before = await previewCanon();
      await keys(c.ops);
      const shown = await B.page.evaluate(async () => {
        const fid = await import('/src/preview/fidelity.ts');
        const ed = document.querySelector('.mdr-preview .is-editing');
        return ed ? fid.canonicalForm(ed) : null;
      });
      let src = await finish();
      if (c.again) {
        const mid = src;
        if (!(await start(src, c.line, c.again.click, false))) { check(c.name, false, `second session did not start; after the first ${J(mid)}`); continue; }
        await keys(c.again.ops);
        src = await finish();
        c.mid = mid;
      }
      const after = await previewCanon();
      let ok2 = true, detail = '';
      if (c.expect !== undefined) { ok2 = src === c.expect; detail = `expected ${J(c.expect)}`; }
      if (c.expectMath !== undefined) {
        const n = await B.page.evaluate(() => document.querySelectorAll('.mdr-preview .md-math .katex').length);
        ok2 = n === c.expectMath; detail = `formulas rendered after the edit: ${n} (expected ${c.expectMath})`;
      }
      if (c.render) {
        // what the session showed (the edited block, possibly split) = what the written source renders to:
        // compared as the text of the whole preview with structure (one block may now be several)
        // (fix-session-b, r3: harness repair — the zero-width spaces a session keeps as caret positions (U21, before a
        // formula that starts a line; ⌘E's code) show nothing and are never written: not part of what was shown)
        const ZW = new RegExp(`[${String.fromCharCode(0x200b)}${String.fromCharCode(0xfeff)}]`, 'g');
        const strip = (s) => (s ?? '').replace(ZW, '').replace(/<(\/?)del>/g, '<$1s>').replace(/<br\/>(<\/[a-z0-9]+>)/g, '$1').split(String.fromCharCode(0xa0)).join(' ').replace(/ +/g, ' ').replace(/ (<\/)/g, '$1').replace(/(<[a-z0-9]+[^>]*>) /g, '$1');
        const wanted = strip(shown);
        const got = strip(after);
        ok2 = got.includes(wanted) || got.replace(/\n/g, '') .includes(wanted);
        detail = `session showed ${wanted}\n        after write: ${got.split('\n').join(' ¦ ')}`;
      }
      if (c.judge) { const r = await c.judge(src, before, after); ok2 = r.ok; detail = r.detail; }
      check(c.name, ok2, `src ${J(c.doc)} → ${c.mid !== undefined ? J(c.mid) + ' → ' : ''}${J(src)}  ${detail}`);
    } catch (err) {
      check(c.name, false, `error ${String(err?.message ?? err).split('\n')[0]}`);
      await B.page.keyboard.press('Escape').catch(() => {});
    }
  }
  if (B.pageErrors.length) console.log('PAGE ERRORS ' + J(B.pageErrors.slice(0, 5)));
  console.log(`\n${results.pass}/${results.pass + results.fail} passed; FAIL: ${results.fails.join(', ')}`);
  process.exitCode = results.fail ? 1 : 0;
} finally {
  stop();
  await B?.close();
}
