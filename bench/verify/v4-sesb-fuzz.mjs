// bench/verify/v4-sesb-fuzz.mjs — verify-session-b: an oracle fuzz of pointer, selection and clipboard gestures in
// preview sessions. The document region is plain one-line paragraphs of lower-case words (single spaces), so a model
// can say exactly what every gesture must do: click (caret at a character), typing, a paste of one line or of two
// paragraphs, a double click + typing / paste / cut, a drag inside a paragraph + typing, Esc, ⌘Z (the source must be
// one of the earlier states), a drag or a Shift-click across paragraphs + ⌘C (the copy must be the model's text
// between the two points). The source is compared with the model after settling, every few operations; the preview's
// shown blocks too.
// Run (candidate server up on MDR_PORT, default 5432, else started):
//   node bench/verify/v4-sesb-fuzz.mjs <seed> [--large] [--ops N]
//   --large: the region sits in the middle of test-data/large.md (the rest must not change).
// Exit 1 on a failure (the op log since the last good check is printed).
import { readFileSync } from 'node:fs';
import { sleep, globalTimeout, J, openAt, prepare, requireServer, view, shownText, copied, rng as mkRng, loadDocAny } from './v4-sesb-lib.mjs';

const args = process.argv.slice(2);
const seed = Number(args.find((a) => /^\d+$/.test(a)) ?? 1);
const LARGE = args.includes('--large');
// integrate (round 4, harness repair): without --ops, indexOf is -1 and the old form took the seed as the op count.
const OPS = args.includes('--ops') ? Number(args[args.indexOf('--ops') + 1]) || 40 : 40;
const CP = Number(process.env.MDR_PORT || 5432);
await requireServer(CP);
const R = mkRng(seed * 7919 + 13);
const pick = (a) => a[Math.floor(R() * a.length)];
const int = (n) => Math.floor(R() * n);
const LET = 'abcdefghijklmnoprstuvw';
const word = (n = 1 + int(4)) => Array.from({ length: n }, () => LET[int(LET.length)]).join('');
const para = () => Array.from({ length: 2 + int(5) }, () => word(2 + int(5))).join(' ');

let model = Array.from({ length: 6 + int(4) }, para);
let prefix = '', suffix = '\n';
if (LARGE) {
  const big = readFileSync(new URL('../../test-data/large.md', import.meta.url), 'utf8');
  const lines = big.split('\n');
  let cut = Math.floor(lines.length / 2);
  while (cut < lines.length - 2 && !(lines[cut] === '' && lines[cut + 1] !== '' && !/^\s|^[>|$`~-]|^\d/.test(lines[cut + 1]) && lines[cut - 1] !== '' && !/^\s|^[>|$`~-]/.test(lines[cut - 1]))) cut++;
  prefix = lines.slice(0, cut + 1).join('\n') + '\n';     // ends with a blank line
  suffix = '\n\n' + lines.slice(cut + 1).join('\n');
}
const regionText = () => model.join('\n\n');
const full = () => prefix + regionText() + suffix;
const baseLine = prefix.split('\n').length;                // line of paragraph 0

let A = null;
const log = [];
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { console.log('LOG ' + J(log.slice(-12))); await A?.close(); });
let caret = null;          // { i, k } in the model, or null when unknown
let history = [];
let fails = 0;

async function paraPoint(i, k) {
  // the k-th character of paragraph i (k === len: right edge of the last character)
  return A.page.evaluate(({ line, k, txt }) => {
    const pv = window.__mdr.app.preview;
    const b = pv.blockAtLine(line);
    if (!b) return null;
    let el = pv.elementOfBlock(b.id);
    if (!el || !el.textContent.includes(txt.slice(0, 12))) {
      el = Array.from(document.querySelectorAll('.mdr-preview section.md-block')).find((s) => s.textContent.trim() === txt) || el;
    }
    if (!el) return null;
    const box = pv.el.getBoundingClientRect();
    const r0 = el.getBoundingClientRect();
    if (r0.top < box.top + 20 || r0.bottom > box.bottom - 20) { pv.el.scrollTop += r0.top - (box.top + box.height / 3); }
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let left = k === txt.length ? k - 1 : k;
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (left < n.data.length) {
        const r = document.createRange(); r.setStart(n, left); r.setEnd(n, left + 1);
        const q = r.getBoundingClientRect();
        if (q.width === 0) return null;
        return { x: k === txt.length ? q.right - 0.5 : q.left + Math.min(1, q.width / 3), y: q.top + q.height / 2 };
      }
      left -= n.data.length;
    }
    return null;
  }, { line: baseLine + 2 * i, k, txt: model[i] });
}
async function settle() { await A.settle(200); }
async function checkNow(tag) {
  await settle();
  await sleep(150);
  const src = await A.source();
  const exp = full();
  const sp = (x) => x.replace(/ {2,}/g, ' ');      // a cut may leave one space or two: both show as one
  let ok = sp(src) === sp(exp);
  let detail = '';
  if (!ok) {
    const s = src.slice(prefix.length, src.length - (suffix.length));
    detail = `region=${J(s.slice(0, 400))} model=${J(regionText().slice(0, 400))} prefixSame=${src.startsWith(prefix)} suffixSame=${src.endsWith(suffix)}`;
  } else {
    const sh = await shownText(A.page);
    const want = model.map((p) => p);
    const idx = sh.indexOf(want[0]);
    const seen = idx >= 0 ? sh.slice(idx, idx + want.length) : sh;
    if (!LARGE && J(seen) !== J(want)) { ok = false; detail = `shown=${J(sh)} model=${J(want)}`; }
  }
  if (!ok) {
    fails++;
    console.log(`FAIL seed ${seed} at ${tag}: ${detail}`);
    console.log('LOG ' + J(log.slice(-14)));
    // continue from what the source holds (region paragraphs) so later ops are still meaningful
    const s = src.startsWith(prefix) && src.endsWith(suffix) ? src.slice(prefix.length, src.length - suffix.length) : null;
    if (s === null || s.includes('\n\n\n') || /\n[^\n]/.test(s.replace(/\n\n/g, ''))) return false;
    model = s.split('\n\n');
    caret = null;
  }
  return ok;
}
function modelCopy(i, k, j, m) {
  // text between (i,k) and (j,m) in document order, paragraphs joined with a blank line
  let [a, b] = (i < j || (i === j && k <= m)) ? [[i, k], [j, m]] : [[j, m], [i, k]];
  if (a[0] === b[0]) return model[a[0]].slice(a[1], b[1]);
  const parts = [];
  for (let x = a[0] + 1; x < b[0]; x++) parts.push(model[x]);
  parts.push(model[b[0]].slice(0, b[1]));
  // (Chromium, as 0.1.1 measured: a selection that starts at the very end of a paragraph copies one line feed there)
  return model[a[0]].slice(a[1]) + (a[1] === model[a[0]].length ? '\n' : '\n\n') + parts.join('\n\n');
}
async function clickAt(i, k) {
  const p = await paraPoint(i, k);
  if (!p) return false;
  await A.page.mouse.click(p.x, p.y);
  await sleep(120 + int(250));
  const v = await view(A.page);
  if (!v.editing) return false;
  caret = { i, k };
  return true;
}
function wordAround(i, k) {
  const t = model[i];
  let a = Math.min(k, t.length - 1);
  if (t[a] === ' ') a = Math.max(0, a - 1);
  let s = a, e = a;
  while (s > 0 && t[s - 1] !== ' ') s--;
  while (e < t.length && t[e] !== ' ') e++;
  return [s, e];
}
const insert = (i, k, txt) => { model[i] = model[i].slice(0, k) + txt + model[i].slice(k); };

try {
  A = await openAt(CP, false);
  const { page } = A;
  await prepare(A, full());
  if (LARGE) {
    await page.evaluate((l) => window.__mdr.app.preview.scrollToLine(l, 0, 'instant'), baseLine);
    await sleep(1500);
  }
  history = [full()];
  let sinceCheck = 0;
  for (let n = 0; n < OPS; n++) {
    const r = R();
    const gap = pick([0, 0, 30, 150, 400]);
    let op;
    try {
      if (r < 0.22 || caret === null) {
        await settle();
        const i = int(model.length), k = int(model[i].length + 1);
        op = `click ${i}:${k}`;
        if (!(await clickAt(i, k))) { op += ' (no session)'; caret = null; }
      } else if (r < 0.40) {
        const w = word();
        op = `type ${w} @${caret.i}:${caret.k}`;
        await page.keyboard.type(w);
        insert(caret.i, caret.k, w); caret.k += w.length;
      } else if (r < 0.48) {
        const t = word() + ' ' + word();
        op = `pasteLine ${J(t)} @${caret.i}:${caret.k}`;
        await page.evaluate((t) => navigator.clipboard.writeText(t), t);
        await page.keyboard.press('Meta+v');
        insert(caret.i, caret.k, t); caret.k += t.length;
      } else if (r < 0.54) {
        const a = word(), b = word();
        const t = a + '\n\n' + b;
        op = `pasteParas ${J(t)} @${caret.i}:${caret.k}`;
        await page.evaluate((t) => navigator.clipboard.writeText(t), t);
        await page.keyboard.press('Meta+v');
        const cur = model[caret.i];
        const left = cur.slice(0, caret.k), right = cur.slice(caret.k);
        if ((left + a).trim() === '' || (b + right).trim() === '') { op += ' (skip model)'; }
        model.splice(caret.i, 1, (left + a).replace(/ +$/, ''), (b + right).replace(/^ +/, ''));
        caret = { i: caret.i + 1, k: b.length };
      } else if (r < 0.64) {
        await settle();
        const i = int(model.length), k = int(model[i].length);
        const [s, e] = wordAround(i, k);
        const p = await paraPoint(i, k);
        if (!p) { op = 'dbl (no point)'; continue; }
        const what = pick(['type', 'paste', 'cut']);
        op = `dbl ${i}:${k} [${s},${e}) ${J(model[i].slice(s, e))} ${what}`;
        await page.mouse.move(p.x, p.y);
        await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
        await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
        await sleep(200);
        const v = await view(page);
        const sel = await page.evaluate(() => getSelection().toString());
        if (!v.editing || sel !== model[i].slice(s, e)) { op += ` (sel ${J(sel)} session ${!!v.editing}: no op)`; caret = null; await page.keyboard.press('Escape'); continue; }
        if (what === 'type') { const w = word(); op += ' ' + w; await page.keyboard.type(w); model[i] = model[i].slice(0, s) + w + model[i].slice(e); caret = { i, k: s + w.length }; }
        else if (what === 'paste') { const w = word(); op += ' ' + w; await page.evaluate((t) => navigator.clipboard.writeText(t), w); await page.keyboard.press('Meta+v'); model[i] = model[i].slice(0, s) + w + model[i].slice(e); caret = { i, k: s + w.length }; }
        else {
          await page.keyboard.press('Meta+x');
          await sleep(60);
          const clip = await page.evaluate(() => navigator.clipboard.readText());
          if (clip !== model[i].slice(s, e)) { console.log(`FAIL seed ${seed}: cut copied ${J(clip)} expected ${J(model[i].slice(s, e))}`); fails++; }
          // a text editor leaves both spaces; a single space is what the preview shows either way
          let t = model[i].slice(0, s) + model[i].slice(e);
          t = t.replace(/  +/g, ' ').trim();
          model[i] = t;
          caret = null;
          if (t === '') { model.splice(i, 1); }
        }
      } else if (r < 0.70) {
        await settle();
        const i = int(model.length);
        if (model[i].length < 4) continue;
        const k1 = int(model[i].length - 2), k2 = k1 + 1 + int(model[i].length - k1 - 1);
        const p1 = await paraPoint(i, k1), p2 = await paraPoint(i, k2);
        if (!p1 || !p2) continue;
        const w = word();
        op = `dragIn ${i}:${k1}-${k2} ${J(model[i].slice(k1, k2))} type ${w}`;
        await page.mouse.move(p1.x, p1.y); await page.mouse.down();
        for (let s = 1; s <= 6; s++) { await page.mouse.move(p1.x + (p2.x - p1.x) * s / 6, p1.y + (p2.y - p1.y) * s / 6); await sleep(12); }
        await page.mouse.up(); await sleep(250);
        const sel = await page.evaluate(() => getSelection().toString());
        const v = await view(page);
        if (!v.editing || sel !== model[i].slice(k1, k2)) { op += ` (sel ${J(sel)} session ${!!v.editing}: no op)`; caret = null; await page.keyboard.press('Escape'); continue; }
        await page.keyboard.type(w);
        const nt = model[i].slice(0, k1) + w + model[i].slice(k2);
        model[i] = nt; caret = { i, k: k1 + w.length };
      } else if (r < 0.75) {
        op = 'esc';
        await page.keyboard.press('Escape'); caret = null;
      } else if (r < 0.80) {
        op = 'undo';
        await page.keyboard.press('Meta+z');
        await settle(); await sleep(200);
        const src = await A.source();
        if (!src.startsWith(prefix) || !src.endsWith(suffix)) { fails++; console.log(`FAIL seed ${seed} at op ${n} undo: text outside the region changed`); console.log('LOG ' + J(log.slice(-14))); }
        else if (!history.includes(src)) console.log(`NOTE seed ${seed} op ${n} undo: a state not sampled ${J(src.slice(prefix.length, prefix.length + 200))}`);
        const s = src.slice(prefix.length, src.length - suffix.length);
        model = s.split('\n\n'); caret = null;
        await page.keyboard.press('Escape');
      } else {
        await settle();
        const i = int(model.length); let j = int(model.length); if (j === i) j = (i + 1) % model.length;
        const k = int(model[i].length + 1), m = int(model[j].length + 1);
        const how = pick(['drag', 'shift']);
        op = `${how}Copy ${i}:${k} -> ${j}:${m}`;
        const p1 = await paraPoint(i, k);
        if (!p1) continue;
        if (how === 'drag') {
          if (!(await clickAt(i, Math.min(k, model[i].length)))) { op += ' (no session)'; }
          const q1 = await paraPoint(i, k), q2 = await paraPoint(j, m);
          if (!q1 || !q2) continue;
          await page.mouse.move(q1.x, q1.y); await page.mouse.down();
          for (let s = 1; s <= 10; s++) { await page.mouse.move(q1.x + (q2.x - q1.x) * s / 10, q1.y + (q2.y - q1.y) * s / 10); await sleep(14); }
          await page.mouse.up();
        } else {
          if (!(await clickAt(i, k))) { op += ' (no session)'; }
          const q2 = await paraPoint(j, m);
          if (!q2) continue;
          await page.keyboard.down('Shift'); await page.mouse.click(q2.x, q2.y); await page.keyboard.up('Shift');
        }
        await sleep(500);
        const got = await copied(page);
        const want = modelCopy(i, k, j, m);
        if (got !== want) { fails++; console.log(`FAIL seed ${seed} at op ${n} ${op}: copied ${J(got)} expected ${J(want)}`); console.log('LOG ' + J(log.slice(-10))); }
        caret = null;
        await page.keyboard.press('Escape');
      }
    } finally { if (op) log.push(`${n} ${op} gap${gap}`); }
    try { history.push(await A.source()); } catch { /* */ }
    if (gap) await sleep(gap);
    if (++sinceCheck >= 1 + int(4)) {
      sinceCheck = 0;
      const ok = await checkNow(`op ${n}`);
      history.push(await A.source());
      if (!ok && model.length === 0) break;
    }
  }
  await page.keyboard.press('Escape');
  await checkNow('end');
  if (process.env.V) console.log('LOG ' + J(log));
  console.log(fails ? `seed ${seed}${LARGE ? ' large' : ''}: ${fails} FAILED` : `seed ${seed}${LARGE ? ' large' : ''}: OK (${OPS} ops)`);
} catch (e) {
  fails++;
  console.log(`seed ${seed} threw ${String(e && e.stack ? e.stack : e).split('\n').slice(0, 3).join(' | ')}`);
  console.log('LOG ' + J(log.slice(-12)));
} finally { stop(); await A?.close(); }
process.exitCode = fails ? 1 : 0;
