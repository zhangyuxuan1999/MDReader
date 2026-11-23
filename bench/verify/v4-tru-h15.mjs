// bench/verify/v4-tru-h15.mjs — verify-trust (stage 2d re-verification, round 3): variations of H15 (CONTRACT §11,
// smaller rules: when pickMarkers() finds no free marker set the block is refused, nothing is written) beyond the
// original paste into "Glyphs: end": a block that holds every candidate at session start, the 4-free / 5-free
// boundary reached by typing one character, candidates split between an attribute value (href) or a formula's TeX
// and the text, a table cell, a list of 10 items (the per-item fast path), a heading.
//   MDR_URL=http://localhost:5433/?mode=split node bench/verify/v4-tru-h15.mjs [case ...]
// PASS conditions per case are printed; the source is compared byte for byte. Writes nothing. Global timeout 110 s.
import { chromium } from '@playwright/test';

const URL0 = process.env.MDR_URL || 'http://localhost:5433/?mode=split';
const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 110_000);
const C = (n) => String.fromCharCode(n);
const ALL = [];
for (let c = 0xe000; c <= 0xf8ff; c++) ALL.push(c);
for (let c = 0xfdd0; c <= 0xfdef; c++) ALL.push(c);
const str = (cps) => cps.map(C).join('');
const without = (skip) => str(ALL.filter((c) => !skip.includes(c)));
const TOAST = '此块请在源码中编辑';

async function load(page, doc) {
  await page.evaluate(() => window.__mdr.app.preview.endEditSession?.());
  await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable?.(true));
  await page.evaluate(({ t }) => window.__mdr.loadText(t, 'h15.md'), { t: doc });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(600);
}
const src = (page) => page.evaluate(() => window.__mdr.app.getText());
const state = (page) => page.evaluate(() => ({
  editing: !!document.querySelector('.mdr-preview .is-editing'),
  toast: Array.from(document.querySelectorAll('[class*="toast"]')).map((t) => t.textContent).join(' | '),
}));
async function clickOn(page, needle, k = 1) {
  const pt = await page.evaluate(({ needle, k }) => {
    const root = document.querySelector('.mdr-preview');
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i + k); r.setEnd(n, i + k + 1);
      const b = r.getBoundingClientRect();
      if (!b.width) continue;
      return { x: b.left + 1, y: b.top + b.height / 2 };
    }
    return null;
  }, { needle, k });
  if (!pt) throw new Error(`"${needle}" not shown`);
  await page.mouse.click(pt.x, pt.y);
  await sleep(250);
}
/** Pastes `text` at the session's caret (a synthetic ClipboardEvent; the real clipboard is slow for 6400 chars). */
const paste = (page, text) => page.evaluate((s) => {
  const el = document.querySelector('.mdr-preview .is-editing');
  if (!el) return false;
  const dt = new DataTransfer();
  dt.setData('text/plain', s);
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  return true;
}, text);
const settle = async (page) => { await sleep(300); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(200); };

const CASES = [
  {
    name: 'start-full', doc: `# H\n\nGlyphs ${str(ALL)} end\n`,
    run: async (page, orig) => {
      await clickOn(page, 'Glyphs', 2);
      const st = await state(page);
      const now = await src(page);
      return { ok: !st.editing && st.toast.includes(TOAST) && now === orig, detail: `session=${st.editing} toast=${st.toast.includes(TOAST)} unchanged=${now === orig}` };
    },
  },
  {
    name: 'four-left-type-one', doc: `# H\n\nGlyphs ${without([0xe100, 0xe101, 0xe102, 0xe103])} end\n`,
    run: async (page, orig) => {
      await clickOn(page, 'Glyphs', 2);
      const st0 = await state(page);
      await page.keyboard.type('Q');
      await settle(page);
      const mid = await src(page);
      await page.keyboard.type(C(0xe100));
      await settle(page);
      const st = await state(page);
      await page.keyboard.press('Escape');
      await settle(page);
      const now = await src(page);
      const exp = orig.replace('Glyphs', 'GlQyphs');
      return { ok: st0.editing && mid === exp && now === exp && !st.editing && st.toast.includes(TOAST), detail: `start=${st0.editing} Q written=${mid === exp} after U+E100: session=${st.editing} toast=${st.toast.includes(TOAST)} final==Q-only=${now === exp} (len ${now.length} vs ${exp.length})` };
    },
  },
  {
    name: 'five-left-type-one', doc: `# H\n\nGlyphs ${without([0xe100, 0xe101, 0xe102, 0xe103, 0xe104])} end\n`,
    run: async (page, orig) => {
      await clickOn(page, 'Glyphs', 2);
      await page.keyboard.type(C(0xe104));
      await settle(page);
      await page.keyboard.press('Escape');
      await settle(page);
      const now = await src(page);
      const exp = orig.replace('Glyphs', 'Gl' + C(0xe104) + 'yphs');
      return { ok: now === exp, detail: `written exactly=${now === exp} (len ${now.length} vs ${exp.length}); extra lines ${now.split('\n').length - exp.split('\n').length}` };
    },
  },
  {
    name: 'href-plus-paste', doc: `# H\n\nSee [the link](https://e.com/${encodeURIComponent('x')}?q=${str(ALL.slice(0, 3000))}) end\n`,
    run: async (page, orig) => {
      await clickOn(page, 'end', 1);
      const st0 = await state(page);
      await paste(page, str(ALL.slice(3000)));
      await settle(page);
      const st = await state(page);
      await page.keyboard.press('Escape');
      await settle(page);
      const now = await src(page);
      // (fix-serial, round 4, rule 4: expectation changed by the lead's decision J19, CONTRACT section 11 "Smaller
      // rules": pickMarkers considers link destinations as linkDest decodes them. The source writes these 3000 code
      // points raw in the destination, so they are written raw again and are not free; with the pasted rest no
      // four are free: H15, the block is refused, nothing is written. Was: "the paste is written".)
      const exp = orig;
      return { ok: now === exp && st.toast.includes(TOAST), detail: `start=${st0.editing} session after=${st.editing} toast=${st.toast.includes(TOAST)} unchanged=${now === exp} (len ${now.length} vs ${exp.length})` };
    },
  },
  {
    name: 'tex-plus-paste', doc: `# H\n\nFormula $\\text{${str(ALL.slice(0, 3000))}}$ and end\n`,
    run: async (page, orig) => {
      await clickOn(page, 'and end', 5);
      const st0 = await state(page);
      await paste(page, str(ALL.slice(3000)));
      await settle(page);
      const st = await state(page);
      await page.keyboard.press('Escape');
      await settle(page);
      const now = await src(page);
      return { ok: now === orig && (!st0.editing || st.toast.includes(TOAST)), detail: `start=${st0.editing} session after=${st.editing} toast=${st.toast.includes(TOAST)} unchanged=${now === orig}` };
    },
  },
  {
    name: 'table-cell', doc: '| a | b |\n|---|---|\n| cell one | two |\n',
    run: async (page, orig) => {
      await clickOn(page, 'cell one', 2);
      const st0 = await state(page);
      await paste(page, str(ALL));
      await settle(page);
      const st = await state(page);
      await page.keyboard.press('Escape');
      await settle(page);
      const now = await src(page);
      return { ok: st0.editing && now === orig && !st.editing && st.toast.includes(TOAST), detail: `start=${st0.editing} session after=${st.editing} toast=${st.toast.includes(TOAST)} unchanged=${now === orig}` };
    },
  },
  {
    name: 'list-10-items', doc: Array.from({ length: 10 }, (_, i) => `- item ${i}`).join('\n') + '\n',
    run: async (page, orig) => {
      await clickOn(page, 'item 5', 2);
      const st0 = await state(page);
      await page.keyboard.type('Z');
      await settle(page);
      const mid = await src(page);
      await paste(page, str(ALL));
      await settle(page);
      const st = await state(page);
      await page.keyboard.press('Escape');
      await settle(page);
      const now = await src(page);
      const exp = orig.replace('item 5', 'itZem 5');
      return { ok: st0.editing && mid === exp && now === exp && st.toast.includes(TOAST), detail: `start=${st0.editing} Z written=${mid === exp} session after=${st.editing} toast=${st.toast.includes(TOAST)} final==Z-only=${now === exp}` };
    },
  },
  {
    name: 'heading-same-frame', doc: '# Title here\n\ntext\n',
    run: async (page, orig) => {
      await clickOn(page, 'Title', 2);
      const st0 = await state(page);
      // a typed letter and the paste in the same frame: the letter is not written either (nothing is)
      await page.evaluate((s) => {
        document.execCommand('insertText', false, 'K');
        const el = document.querySelector('.mdr-preview .is-editing');
        const dt = new DataTransfer(); dt.setData('text/plain', s);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }, str(ALL));
      await settle(page);
      const st = await state(page);
      const now = await src(page);
      return { ok: now === orig && st.toast.includes(TOAST), detail: `start=${st0.editing} session after=${st.editing} toast=${st.toast.includes(TOAST)} unchanged=${now === orig} (the typed K is ${now.includes('K') ? 'written' : 'not written'})` };
    },
  },
  {
    name: 'cell-href-pct', doc: '| [x](https://e.com/?q=%EE%80%82) | b |\n|---|---|\n| one | two |\n',
    run: async (page, orig) => {
      await clickOn(page, 'one', 1);
      const st0 = await state(page);
      if (st0.editing) { await page.keyboard.type('W'); await settle(page); }
      await page.keyboard.press('Escape');
      await settle(page);
      const now = await src(page);
      const exp = orig.replace('| one', '| oWne');
      return { ok: now === orig || now === exp, detail: `start=${st0.editing} toast=${st0.toast.includes(TOAST)} result ${now === orig ? 'unchanged' : now === exp ? 'only W added' : JSON.stringify(now)}` };
    },
  },
  {
    name: 'cell-href-raw', doc: '| [x](https://e.com/?q=' + C(0xe002) + ') | b |\n|---|---|\n| one | two |\n',
    run: async (page, orig) => {
      await clickOn(page, 'one', 1);
      const st0 = await state(page);
      if (st0.editing) { await page.keyboard.type('W'); await settle(page); }
      await page.keyboard.press('Escape');
      await settle(page);
      const now = await src(page);
      const exp = orig.replace('| one', '| oWne');
      return { ok: now === orig || now === exp, detail: `start=${st0.editing} toast=${st0.toast.includes(TOAST)} result ${now === orig ? 'unchanged' : now === exp ? 'only W added' : JSON.stringify(now)}` };
    },
  },
  {
    name: 'para-href-nl', doc: 'See [x](https://e.com/?q=%EE%80%80) and more text here\n',
    run: async (page, orig) => {
      await clickOn(page, 'more', 1);
      const st0 = await state(page);
      if (st0.editing) { await page.keyboard.type('W'); await settle(page); }
      await page.keyboard.press('Escape');
      await settle(page);
      const now = await src(page);
      return { ok: !now.includes(C(0xe000)) || orig.includes(C(0xe000)), detail: `start=${st0.editing} result ${JSON.stringify(now)}` };
    },
  },
  {
    name: 'split-href-caret', doc: 'See [x](https://e.com/?q=' + C(0xe001) + ') first line\nsecond line words\n',
    run: async (page, orig) => {
      await clickOn(page, 'words', 0);
      const st0 = await state(page);
      if (!st0.editing) return { ok: true, detail: 'no session' };
      await page.keyboard.press('Enter');
      await sleep(400);
      await page.keyboard.type('N');
      await settle(page);
      await page.keyboard.press('Escape');
      await settle(page);
      const now = await src(page);
      const ok = /second line \n*\n?Nwords/.test(now) || now.includes('\n\nNwords');
      return { ok, detail: `result ${JSON.stringify(now)}` };
    },
  },

];

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(URL0, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  let fails = 0;
  for (const c of CASES) {
    if (only.length && !only.some((o) => c.name.includes(o))) continue;
    try {
      await load(page, c.doc);
      const orig = await src(page);
      const r = await c.run(page, orig);
      if (!r.ok) fails++;
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${c.name}  — ${r.detail}`);
    } catch (e) { fails++; console.log(`FAIL  ${c.name}  — threw ${String(e).split('\n')[0]}`); }
    await page.keyboard.press('Escape').catch(() => {});
  }
  console.log(`page errors: ${errs.length} ${errs.slice(0, 3).join(' | ').slice(0, 400)}`);
  console.log(`${fails} failing`);
  process.exitCode = fails ? 1 : 0;
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  process.exitCode = 2;
} finally {
  clearTimeout(killer);
  try { await browser?.close(); } catch { /* */ }
}
