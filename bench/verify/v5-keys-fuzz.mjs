// bench/verify/v5-keys-fuzz.mjs — verify-session-keys (0.2.0 round 4 re-verification, switch ON, dev server).
// An invariant-checked fuzz of in-preview editing on documents whose blocks MERGE or re-interpret each other once a
// block between them is gone (two lists, two quotes, two indented code blocks, a paragraph over a setext underline,
// a table and the line under it), identical paragraphs, and inline atoms. Random ops: real clicks into random
// blocks (U7: the session starts on release), typed tokens, Enter, Backspace / Delete inside and at block edges,
// emptying a block (DOM select-all + Backspace), typing into the emptied element, Cmd-Z / Shift-Cmd-Z in the session,
// Esc, typing in the editor pane, and changes of the source while no session is live, all under random worker delays
// (a FIFO that keeps the worker's message order) and random pauses.
// Checks (each failure prints the seed and the op index):
//   C1 tokens: every token typed since the last destructive op appears EXACTLY once in the source at a checkpoint
//   C2 screen = source: at a checkpoint the preview's visible text before Esc equals its text after Esc + re-render
//   C3 no zero-width / marker characters ever in the source
//   C4 Cmd-Z in the editor until nothing changes gives the original document byte for byte; Shift-Cmd-Z until
//      nothing changes gives the final document byte for byte
//   C5 after a click and a typed token at rest (no delay), a live focused session exists
// Run: MDR_PORT=5481 node bench/verify/v5-keys-fuzz.mjs <seed> [--ops N] [--doc mix|dup|lists] [--large] [--nodelay]
// Global timeout 110 s (T_MS). Writes nothing into the tree.
import { readFileSync } from 'node:fs';
import { openBrowser, sleep } from './v2-app-lib.mjs';

const args = process.argv.slice(2);
const seed = Number(args[0] ?? 1);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OPS = Number(opt('--ops', 40));
const DOC = opt('--doc', ['mix', 'dup', 'lists'][seed % 3]);
const LARGE = args.includes('--large');
const NODELAY = args.includes('--nodelay');
const T_MS = Number(process.env.T_MS ?? 110_000);
const J = JSON.stringify;

function rng(s) { let x = (s * 2654435761) >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
const R = rng(seed);
const pick = (a) => a[Math.floor(R() * a.length)];
const DOCS = {
  mix: '# Title one\n\n- aaa\n- bbb\n\npara mid text\n\n- zzz\n- yyy\n\n> quote one\n\nplain two\n\n> quote two\n\n    code one\n\nmiddle words\n\n    code two\n\nmath $x^2$ end\n\nsetext top\n\n===\n\n| h1 | h2 |\n| --- | --- |\n| c1 | c2 |\n\nunder table\n\nlast para\n',
  dup: 'head line\n\ndup\n\ndup\n\ndup\n\n- same\n- same\n\n- same\n\n## same\n\n## same\n\nimg ![i](x.png) tail\n\nend line\n',
  lists: '1. one\n2. two\n\nsplit me\n\n3. three\n\n- [ ] task a\n- [x] task b\n\ngap words\n\n- [ ] task c\n\n* star\n\n+ plus\n\n> q1\n>\n> q2\n\nfinal\n',
};
let PRE = '', POST = '';
if (LARGE) {
  const lines = readFileSync(new URL('../../test-data/large.md', import.meta.url), 'utf8').split('\n');
  const fence = /^ {0,3}(`{3,}|~{3,})/; let open = false, a = -1;
  for (let k = 0; k < lines.length - 1; k++) {
    if (fence.test(lines[k])) open = !open;
    if (k >= 30000 && !open && lines[k].trim() === '' && /^[A-Za-z]/.test(lines[k - 1]) && /^## /.test(lines[k + 1])) { a = k; break; }
  }
  PRE = lines.slice(0, a + 1).join('\n') + '\n';
  POST = '\n' + lines.slice(a + 1).join('\n');
}
const ORIGINAL = PRE + DOCS[DOC] + POST;
const ZW = new RegExp('[' + [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((c) => String.fromCharCode(c)).join('') + String.fromCharCode(0xe000) + '-' + String.fromCharCode(0xf8ff) + ']');

const B = await openBrowser({ viewport: { width: 1400, height: 1000 } });
const { page } = B;
let failed = 0;
const fail = (k, msg) => { failed++; console.log(`FAIL seed=${seed} doc=${DOC}${LARGE ? ' large' : ''} op=${k} ${msg}`); };
const KILL = setTimeout(async () => { console.log(`TIMEOUT seed=${seed}`); try { await B.browser.close(); } catch { /* */ } process.exit(3); }, T_MS);
const log = [];
try {
  await B.boot('mode=split');
  await B.loadDoc(ORIGINAL);
  await sleep(500);
  // FIFO delayed worker (keeps the message order): every structure / delta / html waits `d` ms after the previous one.
  await page.evaluate(() => {
    const pv = window.__mdr.app.preview;
    const o = { s: pv.applyStructure.bind(pv), d: pv.applyStructureDelta.bind(pv), h: pv.applyHtml.bind(pv) };
    window.__wd = 0; let q = Promise.resolve(); let last = 0;
    const wrap = (f) => (m) => {
      if (!window.__wd) { f(m); return true; }
      const at = Math.max(last, performance.now() + window.__wd); last = at;
      window.__qn = (window.__qn || 0) + 1;
      q = q.then(() => new Promise((r) => setTimeout(() => { window.__qn--; try { f(m); } catch (e) { console.error(e); } r(); }, Math.max(0, at - performance.now()))));
      return true;
    };
    pv.applyStructure = wrap(o.s); pv.applyStructureDelta = wrap(o.d); pv.applyHtml = wrap(o.h);
    window.__toasts = []; window.__mdr.app.bus.on('toast', (t) => window.__toasts.push(t.text));
  });
  const setDelay = (ms) => page.evaluate((ms) => { window.__wd = ms; }, ms);
  const src = () => page.evaluate(() => window.__mdr.app.getText());
  const idle = async (ms = 300) => {
    await setDelay(0); await sleep(ms);
    for (let i = 0; i < 3; i++) {
      await page.waitForFunction(() => !window.__qn, null, { timeout: 30000 });
      await page.evaluate(() => window.__mdr.waitIdle()); await sleep(250);
    }
  };
  /** Where a key typed now goes: a live session, the capture element of a waiting resume / click, the editor, nowhere. */
  const target = () => page.evaluate(() => {
    const a = document.activeElement;
    if (a && a.closest && a.closest('.cm-editor')) return 'editor';
    if (document.querySelector('.mdr-preview .is-editing') && a && a.closest && a.closest('.mdr-preview .is-editing')) return 'session';
    if (a && a.tagName === 'TEXTAREA' && a.closest('.mdr-preview')) return 'capture';
    return 'none:' + (a ? a.tagName + '.' + a.className : 'null');
  });
  const screen = () => page.evaluate(() => {
    const pv = document.querySelector('.mdr-preview');
    const c = pv.cloneNode(true);
    c.querySelectorAll('[data-mdr-ui], .edit-hint, textarea, .md-code__lang, button').forEach((e) => e.remove());
    c.querySelectorAll('.md-math, .katex').forEach((e) => e.replaceWith('§'));
    c.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, tr, td, th, div, br').forEach((e) => { e.before(' '); e.after(' '); });
    c.querySelectorAll('img').forEach((e) => e.replaceWith('¤'));
    c.querySelectorAll('input[type=checkbox]').forEach((e) => e.replaceWith(e.checked ? ' ☑ ' : ' ☐ '));
    const zw = new RegExp('[' + [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((x) => String.fromCharCode(x)).join('') + ']', 'g');
    return c.textContent.replace(zw, '').replace(/\s+/g, ' ').trim();
  });
  const session = () => page.evaluate(() => { const e = document.querySelector('.mdr-preview .is-editing'); return e ? { id: e.dataset.id, focused: document.activeElement === e || e.contains(document.activeElement), text: e.textContent.slice(0, 80) } : null; });
  async function clickRandom() {
    const pt = await page.evaluate((r) => {
      const pv = window.__mdr.app.preview.el;
      const box = pv.getBoundingClientRect();
      const nodes = [];
      const w = document.createTreeWalker(pv, NodeFilter.SHOW_TEXT, { acceptNode: (n) => {
        const p = n.parentElement;
        if (!p || p.closest('a[href], .md-math, .katex, [data-mdr-ui], button, .md-code__lang, textarea')) return 2;
        return n.data.trim() ? 1 : 2;
      } });
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const rr = n.parentElement.getBoundingClientRect();
        if (rr.bottom > box.top + 5 && rr.top < box.bottom - 5) nodes.push(n);
      }
      if (!nodes.length) return null;
      const n = nodes[Math.floor(r[0] * nodes.length)];
      const i = Math.min(n.data.length - 1, Math.floor(r[1] * n.data.length));
      const rg = document.createRange(); rg.setStart(n, i); rg.setEnd(n, i + 1);
      const rect = rg.getClientRects()[0] ?? rg.getBoundingClientRect();
      if (!rect || rect.width === 0) return null;
      const right = r[2] < 0.5;
      const x = right ? rect.right - 1 : rect.left + 1, y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !pv.contains(hit)) return null;       // covered (a toast in the overlay): no click
      return { x, y, t: n.data.slice(0, 20) };
    }, [R(), R(), R()]);
    if (!pt) return 'noclick';
    await page.mouse.click(pt.x, pt.y);
    return `click(${J(pt.t)})`;
  }
  let tokN = 0;
  let toastSeen = 0;
  let escPending = false;     // an Esc since the last click: keys typed into the preview now go nowhere (as in 0.1.1)
  const live = new Set();        // tokens typed since the last destructive op
  const tokToast = new Map();    // token -> number of toasts when it was typed
  const OPSET = [
    ['click', 14], ['type', 22], ['enter', 6], ['bs', 5], ['del', 4], ['homebs', 6], ['enddel', 5], ['empty', 6],
    ['typeempty', 0], ['undo', 7], ['redo', 4], ['esc', 4], ['editortype', 3], ['remote', 3], ['pause', 5], ['check', 6],
  ];
  const total = OPSET.reduce((a, b) => a + b[1], 0);
  const choose = () => { let x = R() * total; for (const [k, w] of OPSET) { if ((x -= w) < 0) return k; } return 'type'; };
  const speedDelay = () => pick([0, 0, 10, 40, 120]);
  async function checkpoint(k, why) {
    await idle(350);
    const s1 = await screen();
    const sess = await session();
    await page.keyboard.press('Escape');
    await idle(400);
    const s2 = await screen();
    const text = await src();
    if (ZW.test(text)) fail(k, `C3 invisible char in source ${J(text.match(ZW)[0].charCodeAt(0).toString(16))}`);
    if (s1 !== s2) {
      let f = 0; while (f < s1.length && s1[f] === s2[f]) f++;
      fail(k, `C2 (${why}) screen before Esc != after: …${J(s1.slice(Math.max(0, f - 40), f + 60))} vs …${J(s2.slice(Math.max(0, f - 40), f + 60))} session=${J(sess)}`);
    }
    const allToasts = await page.evaluate(() => window.__toasts.slice());
    for (const t of live) {
      const c = text.split(t).length - 1;
      // P-G: keys dropped WITH the toast (a wait given up, a refused resume) are told, not lost
      if (c === 0 && allToasts.slice(tokToast.get(t) ?? 0).includes('预览尚未更新完，刚才的输入没有写入')) continue;
      if (c !== 1) fail(k, `C1 token ${t} appears ${c} times (${why}) src=${J(text.slice(PRE.length, text.length - POST.length + 1 || undefined).slice(0, 600))}`);
    }
    live.clear();
    return text;
  }
  for (let k = 0; k < OPS; k++) {
    const op = choose();
    if (!NODELAY) await setDelay(pick([0, 0, 0, 40, 120, 300, 700]));
    let d = op;
    try {
      switch (op) {
        case 'click': d = await clickRandom(); live.clear(); escPending = false; await sleep(pick([0, 30, 100, 400])); break;
        case 'type': {
          const t = 'K' + String.fromCharCode(65 + (tokN % 26)) + String.fromCharCode(65 + Math.floor(tokN / 26) % 26); tokN++;
          const tg = await target();
          tokToast.set(t, await page.evaluate(() => window.__toasts.length));
          await page.keyboard.type(t, { delay: speedDelay() }); if (!tg.startsWith('none') && (!escPending || tg === 'editor')) live.add(t); d = `type ${t}->${tg}${escPending ? '(after esc)' : ''}`; break;
        }
        case 'enter': await page.keyboard.press('Enter'); break;
        case 'bs': await page.keyboard.press('Backspace'); live.clear(); break;
        case 'del': await page.keyboard.press('Delete'); live.clear(); break;
        case 'homebs': await page.keyboard.press('Home'); await page.keyboard.press('Backspace'); live.clear(); break;
        case 'enddel': await page.keyboard.press('End'); await page.keyboard.press('Delete'); live.clear(); break;
        case 'empty': {
          const ok = await page.evaluate(() => {
            const el = document.querySelector('.mdr-preview .is-editing'); if (!el) return false;
            const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true;
          });
          if (ok) { await page.keyboard.press('Backspace'); live.clear(); } d = ok ? 'empty' : 'empty(no session)'; break;
        }
        case 'undo': await page.keyboard.press('ControlOrMeta+z'); live.clear(); break;
        case 'redo': await page.keyboard.press('ControlOrMeta+Shift+z'); live.clear(); break;
        case 'esc': await page.keyboard.press('Escape'); escPending = true; break;
        case 'editortype': {
          const line = await page.evaluate((r) => { const v = window.__mdr.app.editor.view; const n = v.state.doc.lines; const pre = v.state.doc.toString().split('\n').length; void pre; const L = Math.max(1, Math.min(n, Math.floor(r * n) + 1)); const l = v.state.doc.line(L); v.dispatch({ selection: { anchor: l.to } }); v.focus(); return L; }, R());
          const t = 'E' + String.fromCharCode(65 + (tokN % 26)) + String.fromCharCode(65 + Math.floor(tokN / 26) % 26); tokN++;
          escPending = false;
          if (R() < 0.3) { await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); }
          await page.keyboard.type(t, { delay: speedDelay() }); live.add(t); d = `editortype ${t}@${line}`; break;
        }
        case 'remote': {
          if (await session()) { d = 'remote(skipped: session)'; break; }
          d = await page.evaluate((r) => {
            const v = window.__mdr.app.editor.view; const doc = v.state.doc; const txt = doc.toString();
            const blanks = []; for (let i = 1; i <= doc.lines; i++) if (doc.line(i).length === 0 && i > 1 && i < doc.lines) blanks.push(i);
            if (r[0] < 0.5 && blanks.length) { const L = doc.line(blanks[Math.floor(r[1] * blanks.length)]); v.dispatch({ changes: { from: L.from - 1, to: L.to } , userEvent: 'delete' }); return `remote join @${L.number}`; }
            const L = doc.line(Math.max(1, Math.floor(r[1] * doc.lines) + 1)); void txt;
            v.dispatch({ changes: { from: L.from, insert: 'ins para\n\n' }, userEvent: 'input.type' }); return `remote insert @${L.number}`;
          }, [R(), R()]);
          break;
        }
        case 'pause': await sleep(pick([50, 200, 600])); break;
        case 'check': await checkpoint(k, 'random'); d = 'check'; break;
      }
    } catch (e) { d += ` ERR ${String(e.message).split('\n')[0]}`; }
    const chg = await page.evaluate(() => {
      const t = window.__mdr.app.getText(); const p = window.__lastSrc ?? t; window.__lastSrc = t;
      if (t === p) return '';
      const a = p.split('\n'), b = t.split('\n'); let f = 0; while (f < a.length && f < b.length && a[f] === b[f]) f++;
      let ea = a.length - 1, eb = b.length - 1; while (ea >= f && eb >= f && a[ea] === b[eb]) { ea--; eb--; }
      return ` {L${f + 1}: ${JSON.stringify(a.slice(f, ea + 1).join('/'))}=>${JSON.stringify(b.slice(f, eb + 1).join('/'))}}`;
    }).catch(() => '');
    d += chg;
    const tn = await page.evaluate(() => window.__toasts.length).catch(() => 0);
    if (tn > toastSeen) { d += ` [toast x${tn - toastSeen}]`; toastSeen = tn; }
    log.push(`${k}:${d}`);
    if (process.env.MDR_VERBOSE) console.log(`  op ${k} ${d}`);
  }
  const finalSrc = await checkpoint(OPS, 'end');
  // C5 a click and a token at rest
  const c5 = await clickRandom(); await sleep(700); live.clear();
  const tk = 'ZQZ'; await page.keyboard.type(tk); await sleep(200);
  const s5 = await session();
  await sleep(500);
  const refusedNow = (await page.evaluate(() => window.__toasts.slice(-3))).includes('此块请在源码中编辑');
  if (c5 !== 'noclick' && !refusedNow && (!s5 || !s5.focused)) {
    const diag = await page.evaluate(() => {
      const a = document.activeElement;
      const cap = document.querySelector('.mdr-preview textarea');
      const pv = window.__mdr.app.preview;
      const blocks = Array.from(pv.el.querySelectorAll('.md-block')).filter((b) => { const r = b.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }).map((b) => `${b.dataset.id}:${b.className.replace('md-block', '').trim()}`).slice(0, 12);
      return { active: a ? `${a.tagName}.${a.className}` : null, capInDom: !!cap, blocks, sel: getSelection().rangeCount ? String(getSelection().anchorNode?.parentElement?.className) : null };
    });
    await sleep(3000);
    const later = await session();
    console.log(`C5DIAG seed=${seed} ${J(diag)} later=${J(later && later.text.slice(0, 40))} srcHasZQZ=${(await src()).includes('ZQZ')}`);
    if (process.env.MDR_STUCK) {
      // is the block stuck? wait past the longest wait bound, then click the same text again and type
      await sleep(8000);
      const t8 = await page.evaluate(() => window.__toasts.slice(-2));
      const blk = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview .md-block')).map((b) => `${b.dataset.id}:${b.className}`).join(' | '));
      const c6 = await clickRandom(); await sleep(800);
      await page.keyboard.type('ZYZ'); await sleep(1500);
      const s6 = await session();
      console.log(`C5STUCK seed=${seed} after8s toasts=${J(t8)} blocks=${blk} reclick=${c6} session=${J(s6 && s6.text.slice(0, 40))} written=${(await src()).includes('ZYZ')} active=${await page.evaluate(() => document.activeElement?.className)}`);
    }
  }
  if (c5 !== 'noclick' && !refusedNow && (!s5 || !s5.focused)) fail(OPS + 1, `C5 no live focused session after ${c5} + type: ${J(s5)}`);
  if (!refusedNow && c5 !== 'noclick') live.add(tk);
  if (process.env.MDR_VERBOSE) console.log(`C5 ${c5} session=${J(s5)} refused=${refusedNow} src=${J((await src()).slice(0, 400))}`);
  const finalSrc2 = await checkpoint(OPS + 1, 'C5');
  void finalSrc;
  // C4 undo all / redo all in the editor (CodeMirror's history); first redo whatever an undo of the fuzz left
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); });
  let prev = finalSrc2, n = 0;
  for (; n < 200; n++) { await page.keyboard.press('ControlOrMeta+Shift+z'); await sleep(15); const s = await src(); if (s === prev) { await sleep(120); if ((await src()) === prev) break; } prev = await src(); }
  const top = await src();
  n = 0;
  // the editor's own history depth (the app's instance of @codemirror/commands, found by its pre-bundled URL)
  const depth = () => page.evaluate(async () => {
    const u = performance.getEntriesByType('resource').map((e) => e.name).find((x) => x.includes('@codemirror_commands'));
    if (!u) return null;
    const m = await import(u);
    const st = window.__mdr.app.editor.view.state;
    return { undo: m.undoDepth(st), redo: m.redoDepth(st) };
  }).catch(() => null);
  const d0 = await depth();
  let noops = 0;
  for (; n < 200; n++) {
    await page.keyboard.press('ControlOrMeta+z'); await sleep(15);
    const s = await src();
    if (s === prev) {
      await sleep(120);
      if ((await src()) === prev) {
        const dd = d0 ? await depth() : null;
        if (!dd || dd.undo === 0) break;
        noops++;           // the history still holds steps: an undo that changed nothing (press again)
      }
    }
    if (process.env.MDR_VERBOSE) {
      const now = await src();
      const a = prev.split('\n'), b = now.split('\n'); let f = 0; while (f < a.length && f < b.length && a[f] === b[f]) f++;
      let ea = a.length - 1, eb = b.length - 1; while (ea >= f && eb >= f && a[ea] === b[eb]) { ea--; eb--; }
      console.log(`  undo ${n}: ${now === prev ? 'NO CHANGE ' + J(await depth()) : `L${f + 1} ${J(a.slice(f, ea + 1).join('/'))}=>${J(b.slice(f, eb + 1).join('/'))}`}`);
    }
    prev = await src();
  }
  if (noops) console.log(`NOTE seed=${seed} C4 ${noops} Cmd-Z presses in the editor changed nothing while the history still held steps`);
  const undone = await src();
  const d1 = await depth();
  if (process.env.MDR_VERBOSE) console.log(`DEPTH top=${J(d0)} afterUndoAll=${J(d1)} steps=${n}`);
  if (undone !== ORIGINAL) {
    const a = undone.split('\n'), b = ORIGINAL.split('\n'); let f = 0; while (f < a.length && a[f] === b[f]) f++;
    fail('C4', `undo-all (${n} steps, depth at top ${J(d0)}, after ${J(d1)}) != original at line ${f + 1}: ${J(a.slice(f, f + 3))} vs ${J(b.slice(f, f + 3))}`);
  }
  prev = undone;
  for (n = 0; n < 200; n++) { await page.keyboard.press('ControlOrMeta+Shift+z'); await sleep(15); const s = await src(); if (s === prev) { await sleep(120); if ((await src()) === prev) break; } prev = await src(); }
  const redone = await src();
  if (redone !== top) {
    const a = redone.split('\n'), b = top.split('\n'); let f = 0; while (f < a.length && a[f] === b[f]) f++;
    fail('C4', `redo-all (${n} steps) != top at line ${f + 1}: ${J(a.slice(f, f + 3))} vs ${J(b.slice(f, f + 3))}`);
  }
  const toasts = await page.evaluate(() => window.__toasts);
  console.log(`${failed ? 'FAILSEED' : 'OK'} seed=${seed} doc=${DOC}${LARGE ? ' large' : ''} ops=${OPS} toasts=${J(toasts)}`);
  if (failed || process.env.MDR_VERBOSE) console.log('OPS ' + log.join(' | '));
  if (failed) console.log('FINAL ' + J(finalSrc2.slice(PRE.length, finalSrc2.length - POST.length || undefined)));
} catch (e) {
  console.log(`ERROR seed=${seed} ${String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')}`);
  console.log('OPS ' + log.join(' | '));
  failed++;
} finally {
  clearTimeout(KILL);
  try { await B.browser.close(); } catch { /* */ }
  process.exit(failed ? 1 : 0);
}
