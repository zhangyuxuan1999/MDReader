// bench/verify/v6-vo-stand.mjs — verify-off (0.2.0 stage 2f, round 5, rule L2): the STAND-IN (INLINE_EDIT_OFF, the
// candidate) against the REAL module with the switch off (the last candidate, a build of the snapshot taken before round 5) and
// 0.1.1, for a REAL USER (no ?perf=1; nothing stored = off). The preview's calls into the session API (keepsRemoved,
// afterStructure, afterMount, isEditingTarget, the tick's taskLine) happen while the editor changes the structure fast:
// blocks added, split, merged, removed, replaced, a giant document, ticks 0 to 400 ms after an edit, scrolling that
// mounts and evicts blocks. After every step: the source, the number of blocks, the preview's text (hash), the boxes,
// toasts, focus, editing elements.
//   node bench/verify/v6-vo-stand.mjs <port> <outfile.json> [group ...]     groups: S G (default both)
//   node bench/verify/v6-vo-stand.mjs cmp <a.json> <b.json>
// Global timeout 115 s. Starts no server. Writes only the outfile.
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const NL = String.fromCharCode(10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.argv[2] === 'cmp') {
  const a = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')), b = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  let same = 0, diff = 0;
  for (const g of Object.keys(a.res)) {
    const x = a.res[g], y = b.res[g];
    if (!y) { console.log(`MISSING ${g}`); continue; }
    const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => !['ed', 'hint'].includes(k) && JSON.stringify(x[k]) !== JSON.stringify(y[k]));
    if (!keys.length) { same++; continue; }
    diff++;
    console.log(`DIFF ${g}: ` + keys.map((k) => `${k}: a=${JSON.stringify(x[k])?.slice(0, 160)} b=${JSON.stringify(y[k])?.slice(0, 160)}`).join(' | '));
  }
  console.log(`same=${same} diff=${diff}; errors a=${JSON.stringify(a.errors)} b=${JSON.stringify(b.errors)}`);
  process.exit(diff ? 1 : 0);
}
const port = process.argv[2];
const outFile = process.argv[3];
const groups = process.argv.slice(4).length ? process.argv.slice(4) : ['S', 'G'];
const task = (i) => `- [ ] task ${i} item`;
const DOC = ['# Stand-in doc', '', ...Array.from({ length: 40 }, (_, i) => (i % 4 === 1 ? [task(i), task(i + 100), ''] : [`Para ${i} words of the stand-in check.`, ''])).flat()].join(NL);
const GIANT = ['# Giant', '', ...Array.from({ length: 2500 }, (_, i) => (i % 25 === 3 ? [task(i), ''] : [`Giant paragraph ${i} with a few words.`, ''])).flat()].join(NL);
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const browser = await chromium.launch({ headless: true });
const res = {}, errors = [];
try {
  const fresh = async (doc) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => { try { localStorage.removeItem('mdr.previewEdit'); } catch {} });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.goto(`http://localhost:${port}/`);
    await page.waitForSelector('.cm-content', { timeout: 30000 });
    await sleep(500);
    const dt = await page.evaluateHandle((t) => { const d = new DataTransfer(); d.items.add(new File([t], 'stand.md', { type: 'text/markdown' })); return d; }, doc);
    for (const ev of ['dragenter', 'dragover', 'drop']) await page.dispatchEvent('.mdr-preview', ev, { dataTransfer: dt });
    await page.waitForFunction(() => document.querySelectorAll('.mdr-preview .md-block').length > 5, null, { timeout: 15000 });
    await sleep(800);
    await page.evaluate(() => {
      window.__toastLog = [];
      const seen = new WeakSet();
      new MutationObserver(() => { for (const e of document.querySelectorAll('.mdr-toast__text')) if (!seen.has(e)) { seen.add(e); window.__toastLog.push(e.textContent); } }).observe(document.body, { childList: true, subtree: true });
    });
    return { ctx, page };
  };
  const view = (page, fn, arg) => page.evaluate(([f, a]) => {
    const c = document.querySelector('.cm-content');
    const v = (c.cmTile && c.cmTile.root && c.cmTile.root.view) || (c.cmView && c.cmView.rootView && c.cmView.rootView.view);
    return new Function('v', 'a', f)(v, a);
  }, [fn, arg]);
  const obs = (page) => page.evaluate(() => {
    const c = document.querySelector('.cm-content');
    const v = (c.cmTile && c.cmTile.root && c.cmTile.root.view) || (c.cmView && c.cmView.rootView && c.cmView.rootView.view);
    const h = (s) => s.length + ':' + [...s].reduce((x, ch) => (x * 31 + ch.charCodeAt(0)) | 0, 7);
    const blocks = [...document.querySelectorAll('.mdr-preview .md-block')];
    const src = v.state.doc.toString();
    return {
      src: h(src),
      srcHead: src.slice(0, 50),
      blocks: blocks.length,
      ptext: h(blocks.map((b) => b.textContent).join('|')),
      checks: [...document.querySelectorAll('.mdr-preview input[type=checkbox]')].map((x) => (x.checked ? 1 : 0)).join(''),
      ticked: (src.match(/- \[x\]/g) || []).length,
      toasts: window.__toastLog.slice(),
      active: document.activeElement ? document.activeElement.nodeName : null,
      ed: document.querySelectorAll('.mdr-preview .is-editing, .mdr-preview [contenteditable="true"]').length,
    };
  });
  const tick = async (page, needle) => {
    const ok = await page.evaluate((t) => {
      const li = [...document.querySelectorAll('.mdr-preview li')].find((x) => x.textContent.includes(t));
      if (!li) return null;
      const box = li.querySelector('input[type=checkbox]'); box.scrollIntoView({ block: 'center' });
      const r = box.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, needle);
    if (!ok) throw new Error('no task ' + needle);
    await page.mouse.click(ok.x, ok.y);
  };
  const atLine = (page, needle, where = 'end') => view(page, `const i = v.state.doc.toString().indexOf(a[0]); const ln = v.state.doc.lineAt(i); v.focus(); v.dispatch({ selection: { anchor: a[1] === 'end' ? ln.to : ln.from } });`, [needle, where]);
  const S = {
    'split-fast-tick0': async (p) => { await atLine(p, 'Para 2 words'); for (let i = 0; i < 6; i++) { await p.keyboard.press('Enter'); await p.keyboard.press('Enter'); await p.keyboard.type('new' + i); } await tick(p, 'task 5 item'); },
    'merge-fast-tick50': async (p) => { await atLine(p, 'Para 7 words', 'start'); for (let i = 0; i < 4; i++) await p.keyboard.press('Backspace'); await sleep(50); await tick(p, 'task 9 item'); },
    'delete-blocks-tick0': async (p) => { await atLine(p, 'Para 10 words', 'start'); for (let i = 0; i < 8; i++) await p.keyboard.press('Shift+ArrowDown'); await p.keyboard.press('Backspace'); await tick(p, 'task 17 item'); },
    'paste-block-tick0': async (p) => { await atLine(p, 'Para 3 words'); await p.keyboard.press('Enter'); await p.keyboard.insertText(NL + Array.from({ length: 30 }, (_, i) => `Pasted ${i} line.` + NL).join(NL)); await tick(p, 'task 13 item'); },
    'undo-redo-tick0': async (p) => { await p.keyboard.press('Meta+Z'); await p.keyboard.press('Meta+Z'); await p.keyboard.press('Meta+Z'); await p.keyboard.press('Meta+Shift+Z'); await tick(p, 'task 21 item'); },
    'edit-task-line-tick0': async (p) => { await atLine(p, 'task 25 item'); await p.keyboard.type(' more'); await tick(p, 'task 25 item'); },
    'edit-task-line-tick20': async (p) => { await atLine(p, 'task 29 item'); await p.keyboard.type(' x'); await sleep(20); await tick(p, 'task 29 item'); },
    'edit-task-line-tick100': async (p) => { await atLine(p, 'task 33 item'); await p.keyboard.type(' y'); await sleep(100); await tick(p, 'task 33 item'); },
    'del-line-above-tick0': async (p) => { await atLine(p, 'task 37 item', 'start'); await p.keyboard.press('Shift+End'); await p.keyboard.press('Backspace'); await p.keyboard.press('Backspace'); await tick(p, 'task 137 item'); },
    'edit-above-tick150': async (p) => { await atLine(p, 'Stand-in doc'); await p.keyboard.press('Enter'); await p.keyboard.type('top'); await sleep(150); await tick(p, 'task 101 item'); },
    'edit-above-tick400': async (p) => { await atLine(p, 'Stand-in doc'); await p.keyboard.press('Enter'); await p.keyboard.type('top2'); await sleep(400); await tick(p, 'task 105 item'); },
    'replace-all-tick0': async (p) => { await p.click('.cm-content'); await p.keyboard.press('Meta+A'); await p.keyboard.insertText(['# Replaced', '', task(900), task(901), ''].join(NL)); await tick(p, 'task 901 item').catch(() => {}); },
    'mode-preview-tick': async (p) => { await p.click('[data-cmd="view.mode.preview"]'); await sleep(300); await tick(p, 'task 900 item'); await sleep(200); await p.click('[data-cmd="view.mode.split"]'); },
    'rapid-ticks': async (p) => { await tick(p, 'task 900 item'); await sleep(30); await tick(p, 'task 901 item'); await sleep(30); await tick(p, 'task 900 item'); },
  };
  const G = {
    'giant-scroll-tick': async (p) => { await p.mouse.move(900, 400); for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, 3000); await sleep(80); } await sleep(400); const t = await p.evaluate(() => [...document.querySelectorAll('.mdr-preview li')].map((l) => l.textContent.trim()).find((x) => /task \d+ item/.test(x)) || null); await tick(p, t || 'task 503 item'); },
    'giant-edit-top-tick0': async (p) => { await atLine(p, 'Giant paragraph 0 '); await p.keyboard.press('Enter'); await p.keyboard.type('inserted'); const t = await p.evaluate(() => [...document.querySelectorAll('.mdr-preview li')].map((l) => l.textContent.trim()).filter((x) => /task \d+ item/.test(x)).pop() || null); await tick(p, t || 'task 503 item'); },
    'giant-delete-mid-tick': async (p) => { await atLine(p, 'Giant paragraph 1200 ', 'start'); for (let i = 0; i < 40; i++) await p.keyboard.press('Shift+ArrowDown'); await p.keyboard.press('Backspace'); await sleep(60); const t = await p.evaluate(() => [...document.querySelectorAll('.mdr-preview li')].map((l) => l.textContent.trim()).filter((x) => /task \d+ item/.test(x))[0] || null); await tick(p, t || 'task 1203 item'); },
    'giant-type-scroll': async (p) => { await atLine(p, 'Giant paragraph 10 '); await p.keyboard.type('abcdef'); await p.mouse.move(900, 400); await p.mouse.wheel(0, -20000); await sleep(300); await p.keyboard.type('gh'); },
    'giant-selall-delete-undo': async (p) => { await p.click('.cm-content'); await p.keyboard.press('Meta+A'); await p.keyboard.press('Backspace'); await sleep(200); await p.keyboard.press('Meta+Z'); await sleep(400); },
  };
  for (const g of groups) {
    const cur = await fresh(g === 'G' ? GIANT : DOC);
    for (const [name, fn] of Object.entries(g === 'G' ? G : S)) {
      let err = null;
      try { await fn(cur.page); } catch (e) { err = String(e.message).split(NL)[0].slice(0, 100); }
      await sleep(900);
      const o = await obs(cur.page); o.err = err;
      res[g + ':' + name] = o;
    }
    await cur.ctx.close();
  }
  fs.writeFileSync(outFile, JSON.stringify({ port, res, errors }, null, 1));
  console.log(`done ${Object.keys(res).length} steps; errors=${errors.length}; step errors=${Object.entries(res).filter(([, o]) => o.err).map(([k, o]) => k + ':' + o.err).join(' ; ')}`);
} finally {
  clearTimeout(KILL);
  await browser.close();
}
