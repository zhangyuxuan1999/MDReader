// bench/verify/v5-chc-lib.mjs — challenge-c (0.2.0, round 4 end): shared helpers for v5-chc-ticks.mjs and
// v5-chc-tickfuzz.mjs. A page of the candidate (cand: MDR_PORT, dev server) or of the 0.1.1 build (base:
// MDR_BASE_PORT, vite preview, opened with ?perf=1 for the hooks), with mdr.previewEdit stored '0' before the app
// starts (MDR_ON=1 stores '1' instead). Every click on a task box is judged by the model:
//   the press went down on a task box whose own item text holds token T  =>  afterwards exactly the source line holding T
//   flipped its box (verdict right), or nothing changed and the toast 没有勾选… was shown (nothing+toast).
//   Anything else: WRONG (another line flipped), SILENT (nothing changed, no toast), TOAST-APPLIED (flipped + toast),
//   WAIT (applied, but the box did not show the tick at the first frame after the click).
// Writes nothing into the tree.
import { chromium } from '@playwright/test';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const J = JSON.stringify;
export const TOAST_NOT_TICKED = '没有勾选：该任务项刚被改动，请再点一次';

export async function openPage(target, opts = {}) {
  const port = target === 'base' ? process.env.MDR_BASE_PORT : process.env.MDR_PORT;
  if (!port) throw new Error('pass MDR_PORT (cand) or MDR_BASE_PORT (base)');
  const mode = opts.mode || 'split';
  const url = target === 'base' ? `http://localhost:${port}/?perf=1&mode=${mode}` : `http://localhost:${port}/?mode=${mode}${process.env.MDR_CAND_PERF ? '&perf=1' : ''}`;
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: opts.width || 1400, height: opts.height || 900 }, colorScheme: 'light' });
  const on = process.env.MDR_ON === '1' ? '1' : '0';
  await ctx.addInitScript((v) => { try { localStorage.setItem('mdr.previewEdit', v); } catch { /* */ } }, on);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90000 });
  await sleep(400);
  if (target === 'cand') {
    const pressed = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button,[role="button"]')).find((x) => /预览可编辑/.test((x.getAttribute('title') || '') + (x.getAttribute('aria-label') || '') + x.textContent));
      return b ? b.getAttribute('aria-pressed') : 'nobutton';
    });
    if (on === '0' && pressed === 'true') throw new Error('switch button is pressed although mdr.previewEdit = 0');
  }
  return { browser, page, errs };
}

/** Installs the press/change/toast recorder (idempotent per page). */
export async function install(page) {
  await page.evaluate((TOAST) => {
    const W = window.__chc = { presses: [], toasts: [], changes: [] };
    if (window.__chcHooked) return;
    window.__chcHooked = true;
    const ownText = (li) => { const c = li.cloneNode(true); c.querySelectorAll('ul,ol').forEach((x) => x.remove()); return (c.textContent || '').replace(/\s+/g, ' ').trim(); };
    document.addEventListener('pointerdown', (e) => {
      const w = window.__chc; const t = e.target;
      const rec = { t: performance.now(), doc: window.__mdr.app.getText(), version: window.__mdr.version?.() };
      if (t instanceof HTMLInputElement && t.type === 'checkbox' && t.closest('.mdr-preview')) {
        const li = t.closest('li');
        rec.box = true; rec.text = li ? ownText(li) : ''; rec.tok = (rec.text.match(/\bq\d+\b/) || [null])[0]; rec.checked = t.checked;
        window.__chcBox = t;
      } else { rec.box = false; rec.tag = t && t.tagName; window.__chcBox = null; }
      w.presses.push(rec);
    }, true);
    window.addEventListener('change', (e) => { const b = e.target; if (b instanceof HTMLInputElement) window.__chc.changes.push({ t: performance.now(), checked: b.checked }); });
    const onToast = (e) => window.__chc.toasts.push({ t: performance.now(), text: e.text });
    if (window.__mdr.app.bus?.on) window.__mdr.app.bus.on('toast', onToast);
    else {
      // 0.1.1 fallback: watch the toast region
      new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && /没有勾选/.test(n.textContent || '')) onToast({ text: n.textContent }); }).observe(document.body, { childList: true, subtree: true });
    }
    void TOAST;
  }, TOAST_NOT_TICKED);
  await page.evaluate(() => { window.__chc = { presses: [], toasts: [], changes: [] }; });
}

export const src = (page) => page.evaluate(() => window.__mdr.app.getText());
export async function load(page, doc, name = 'c.md') {
  await page.evaluate(() => { const el = document.querySelector('.mdr-preview'); if (el) el.scrollTop = 0; });
  await page.evaluate(([t, n]) => window.__mdr.loadText(t, n), [doc, name]);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(500);
}

/** Centre of the box whose item holds token `tok` (scrolled into view when asked). */
export async function boxPoint(page, tok, scroll = true) {
  return page.evaluate(([tok, scroll]) => {
    const ownText = (li) => { const c = li.cloneNode(true); c.querySelectorAll('ul,ol').forEach((x) => x.remove()); return (c.textContent || '').replace(/\s+/g, ' ').trim(); };
    const re = new RegExp('\\b' + tok + '\\b');
    const b = Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]')).find((x) => { const li = x.closest('li'); return li && re.test(ownText(li)); });
    if (!b) return null;
    if (scroll) b.scrollIntoView({ block: 'nearest' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, [tok, scroll]);
}

/** A real click on the box of `tok`; returns what the box showed at the first and the second frame after the click. */
export async function clickBox(page, tok, opts = {}) {
  const p = await boxPoint(page, tok, opts.scroll !== false);
  if (!p) return { nobox: true };
  await page.mouse.click(p.x, p.y);
  const shown = await page.evaluate(() => new Promise((res) => {
    const b = window.__chcBox; const a = [b ? b.checked : null];
    requestAnimationFrame(() => { a.push(b ? b.checked : null); requestAnimationFrame(() => { a.push(b ? b.checked : null); res(a); }); });
  }));
  return { shown };
}

/** Lines whose task box differs between two texts (same line count required, else null). */
function flipped(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  if (a.length !== b.length) return null;
  const out = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push({ line: i + 1, before: a[i], after: b[i] });
  return out;
}

/** Judges the LAST press against the model. */
export async function judge(page, settleMs = 1200) {
  await sleep(settleMs);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(200);
  const W = await page.evaluate(() => window.__chc);
  const after = await src(page);
  const pr = W.presses[W.presses.length - 1];
  if (!pr) return { verdict: 'NOPRESS' };
  if (!pr.box) return { verdict: 'miss', tag: pr.tag };
  const fl = flipped(pr.doc, after);
  const toast = W.toasts.filter((t) => t.t >= pr.t && /没有勾选/.test(t.text)).length;
  // at rest every box shows what its source line holds
  const mism = await page.evaluate(() => {
    const ownText = (li) => { const c = li.cloneNode(true); c.querySelectorAll('ul,ol').forEach((x) => x.remove()); return (c.textContent || '').replace(/\s+/g, ' ').trim(); };
    const d = window.__mdr.app.getText(); const out = [];
    for (const b of document.querySelectorAll('.mdr-preview input[type="checkbox"]')) {
      const li = b.closest('li'); const tok = li && (ownText(li).match(/\bq\d+\b/) || [null])[0]; if (!tok) continue;
      const m = new RegExp('^.*\\[([ xX])\\][^\\n]*\\b' + tok + '\\b', 'm').exec(d);
      if (m && (m[1] !== ' ') !== b.checked) out.push(tok + (b.checked ? ':shown-x' : ':shown-empty'));
    }
    return out;
  });
  const r = { tok: pr.tok, toast, was: pr.checked, ...(mism.length ? { MISMATCH: mism.slice(0, 5) } : {}) };
  if (fl === null) return { ...r, verdict: 'LINECOUNT', after: after.slice(0, 200) };
  if (fl.length === 0) return { ...r, verdict: toast ? 'nothing+toast' : 'SILENT' };
  const isFlip = (f) => f.before.replace(/\[[ xX]\]/, '[?]') === f.after.replace(/\[[ xX]\]/, '[?]');
  if (fl.length === 1 && isFlip(fl[0])) {
    const tok = (fl[0].after.match(/\bq\d+\b/) || [null])[0];
    if (tok !== pr.tok) return { ...r, verdict: 'WRONG', flipped: fl[0].after, pressedText: pr.text };
    // duplicates of the token in the source at the press make the model ambiguous
    const dup = (pr.doc.match(new RegExp('\\b' + pr.tok + '\\b', 'g')) || []).length;
    return { ...r, verdict: toast ? 'TOAST-APPLIED' : 'right', dup: dup > 1 ? dup : undefined, line: fl[0].line };
  }
  return { ...r, verdict: 'OTHER', fl: fl.slice(0, 4) };
}

/** Slow-worker hook of v3-ses-preview.mjs: structure deltas and HTML reach the preview `ms` later. */
export async function slowWorker(page, ms) {
  await page.evaluate((ms) => {
    const pv = window.__mdr.app.preview;
    if (!window.__origDelta) { window.__origDelta = pv.applyStructureDelta.bind(pv); window.__origHtml = pv.applyHtml.bind(pv); }
    window.__delayMs = ms;
    pv.applyStructureDelta = (m) => { if (window.__delay) { setTimeout(() => window.__origDelta(m), window.__delayMs); return true; } return window.__origDelta(m); };
    pv.applyHtml = (m) => { if (window.__delay) setTimeout(() => window.__origHtml(m), window.__delayMs); else window.__origHtml(m); };
    window.__delay = ms > 0;
  }, ms);
}

/** Editor-pane edits, each a function run in the page (v = the CodeMirror view, d = its text, L(tok) = the line
 *  object holding token tok). They dispatch what the editor's own commands dispatch, or press real keys outside. */
export const PAGE_EDITS = {
  'multi-cursor-type': `const ch=[L('q2').from, L('q6').from+3, L('q9').to].map(p=>({from:p,insert:'Z'})); v.dispatch({changes:ch,userEvent:'input.type'});`,
  'multi-cursor-enter': `const ch=[L('q2').to, L('q4').to].map(p=>({from:p,insert:'\\n'})); v.dispatch({changes:ch,userEvent:'input'});`,
  'multi-line-col0': `const ch=['q1','q2','q3','q4','q5'].map(t=>({from:L(t).from,insert:'X'})); v.dispatch({changes:ch,userEvent:'input.type'});`,
  'replace-one-own': `const l=L('q5'); const i=l.text.indexOf('q5'); v.dispatch({changes:{from:l.from+i,to:l.from+i+2,insert:'q5'},userEvent:'input.replace'});`,
  'replace-one-above': `const l=L('q3'); const i=l.text.indexOf('q3'); v.dispatch({changes:{from:l.from+i+3,to:l.from+i+4,insert:'W'},userEvent:'input.replace'});`,
  'replace-all-word': `const ch=[];const re=/word/g;let m;while((m=re.exec(d)))ch.push({from:m.index,to:m.index+4,insert:'WORD'});v.dispatch({changes:ch,userEvent:'input.replace.all'});`,
  'replace-all-box': `const ch=[];const re=/\\[ \\]/g;let m;while((m=re.exec(d)))ch.push({from:m.index+1,to:m.index+2,insert:' '});v.dispatch({changes:ch,userEvent:'input.replace.all'});`,
  'indent-sel': `const ch=['q3','q4','q5','q6'].map(t=>({from:L(t).from,insert:'  '})); v.dispatch({changes:ch,userEvent:'input.indent'});`,
  'outdent-nested': `const l=L('q2'); v.dispatch({changes:{from:l.from,to:l.from+2},userEvent:'delete.dedent'});`,
  'toggle-other': `const l=L('q4'); const i=l.text.indexOf('['); v.dispatch({changes:{from:l.from+i+1,to:l.from+i+2,insert:'x'},userEvent:'input'});`,
  'toggle-own': `const l=L('q5'); const i=l.text.indexOf('['); v.dispatch({changes:{from:l.from+i+1,to:l.from+i+2,insert:'x'},userEvent:'input'});`,
  'drop-above': `v.dispatch({changes:{from:L('q3').from,insert:'- [ ] n1 dropped\\n'},userEvent:'input.drop'});`,
  'drop-text-mid': `const l=L('q4'); v.dispatch({changes:{from:l.to,insert:' dropped text'},userEvent:'input.drop'});`,
  'move-drop-lines': `const a=L('q2'), b=L('q3'); const t=d.slice(a.from,b.to+1); v.dispatch({changes:[{from:a.from,to:b.to+1},{from:L('q8').to+1,insert:t}],userEvent:'move.drop'});`,
  'paste5000-above': `const t=Array.from({length:5000},(_, i)=>'pasted '+i).join('\\n')+'\\n'; v.dispatch({changes:{from:0,insert:t},userEvent:'input.paste'});`,
  'paste-same-list': `const a=L('q1'), b=L('q9'); v.dispatch({changes:{from:a.from,to:b.to,insert:d.slice(a.from,b.to)},userEvent:'input.paste'});`,
  'paste-list-shifted': `const a=L('q1'); v.dispatch({changes:{from:a.from,insert:'- [ ] n1 new\\n- [ ] n2 new\\n'},userEvent:'input.paste'});`,
  'sort-lines': `const ls=['q3','q4','q5','q6'].map(L); const tx=ls.map(l=>l.text).sort().reverse(); v.dispatch({changes:{from:ls[0].from,to:ls[3].to,insert:tx.join('\\n')},userEvent:'input'});`,
  'swap-block-up': `const a=L('q2'), b=L('q3'), c=L('q4'); v.dispatch({changes:[{from:a.from,to:b.to+1},{from:c.to,insert:'\\n'+d.slice(a.from,b.to)}],userEvent:'move.line'});`,
  'join-into-own': `const l=L('q5'); v.dispatch({changes:{from:l.to,to:l.to+1},userEvent:'delete.backward'});`,
  'join-own-into-prev': `const l=L('q5'); v.dispatch({changes:{from:l.from-1,to:l.from},userEvent:'delete.backward'});`,
  'insert-line-before-own-eol': `const l=L('q4'); v.dispatch({changes:{from:l.to,insert:'\\n- [ ] n1 inserted'},userEvent:'input'});`,
  'insert-at-own-col0-nl': `const l=L('q5'); v.dispatch({changes:{from:l.from,insert:'- [ ] n1 typed\\n'},userEvent:'input'});`,
  'split-own-text': `const l=L('q5'); v.dispatch({changes:{from:l.to-2,insert:'\\n'},userEvent:'input'});`,
  'split-own-box': `const l=L('q5'); const i=l.text.indexOf('['); v.dispatch({changes:{from:l.from+i+1,insert:'\\n'},userEvent:'input'});`,
  'delete-list-above-blank': `const a=L('q1'); const b=L('q4'); v.dispatch({changes:{from:a.from,to:b.to+1},userEvent:'delete'});`,
  'blank-before-own': `const l=L('q5'); v.dispatch({changes:{from:l.from-1,insert:'\\n'},userEvent:'input'});`,
  'blank-remove-between': `const i=d.indexOf('\\n\\n- [ ] q9'); if(i>=0) v.dispatch({changes:{from:i,to:i+1},userEvent:'delete'});`,
  'undo50': `__UNDO50__`,
  'heading-above': `v.dispatch({changes:{from:0,insert:'# Title\\n\\n'},userEvent:'input'});`,
};

/** Runs a page edit with the editor focused (as a user would have it after working in the editor pane). */
export async function pageEdit(page, name) {
  const body = PAGE_EDITS[name];
  if (body === '__UNDO50__') {
    // 50 separate steps (each its own history event), then 50 undos, then 25 redos
    await page.evaluate(() => {
      const v = window.__mdr.app.editor.view; v.focus();
      const at = () => { const d = v.state.doc.toString(); return d.indexOf('Intro') + 5; };
      for (let i = 0; i < 50; i++) { v.dispatch({ changes: { from: at(), insert: i % 3 === 0 ? '\nx' + i : 'y' }, userEvent: 'input' }); v.dispatch({ effects: [] }); }
    });
    for (let i = 0; i < 50; i++) await page.keyboard.press('Meta+z');
    for (let i = 0; i < 25; i++) await page.keyboard.press('Meta+Shift+z');
    return;
  }
  await page.evaluate((body) => {
    const v = window.__mdr.app.editor.view; v.focus();
    const d = v.state.doc.toString();
    const L = (tok) => { const m = new RegExp('\\b' + tok + '\\b').exec(v.state.doc.toString()); if (!m) throw new Error('no ' + tok); return v.state.doc.lineAt(m.index); };
    // eslint-disable-next-line no-new-func
    new Function('v', 'd', 'L', body)(v, d, L);
  }, body);
}
