// bench/verify/v5-sw-user.mjs — verify-switch (round 4 verification): what a USER of the web page meets around the
// switch on a PRODUCTION build without ?perf=1 (no test hooks): a reload in the middle of a session (the draft must
// hold the text typed in the preview, the switch stays on), and two tabs of the same origin.
//   MDR_PORT=<candidate: vite preview of release/staging-0.2.0.noindex/dist> [MDR_BASE_PORT=<0.1.1 vite preview>]
//   node bench/verify/v5-sw-user.mjs [case-prefix]
// Cases: reload-session-<wait ms>, reload-editor (control: text typed in the editor pane, also run on 0.1.1),
// two-tabs. Headless Chromium, fresh context per case. Global timeout 110 s. Writes nothing into the tree.
import { chromium } from '@playwright/test';

const PORT = process.env.MDR_PORT || 5484;
const BASE_PORT = process.env.MDR_BASE_PORT || '';
const only = process.argv[2] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
let browser = null;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 110_000);

const DOC = '# Head\n\nAlpha paragraph text here.\n\nBeta paragraph text here.\n';
const pressed = (page) => page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? null);
const stored = (page, k = 'mdr.previewEdit') => page.evaluate((k) => { try { return localStorage.getItem(k); } catch { return 'ERR'; } }, k);
const editable = (page) => page.evaluate(() => document.querySelectorAll('.mdr-preview [contenteditable="true"]').length);
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text, .mdr-toast')].map((t) => t.textContent));
const source = (page) => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));

async function ready(page) {
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(600);
}
async function newPage(context, port) {
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  return page;
}
async function typeDoc(page) {
  await page.click('.cm-content');
  await page.keyboard.press('Meta+a');
  await page.keyboard.insertText(DOC);
  await sleep(1000);
}
async function clickPara(page, needle, dx = 30) {
  const p = await page.evaluate(({ t, dx }) => {
    const el = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes(t));
    if (!el) return null;
    const b = el.getBoundingClientRect(); return { x: b.left + dx, y: b.top + b.height / 2 };
  }, { t: needle, dx });
  if (!p) return false;
  await page.mouse.click(p.x, p.y);
  await sleep(400);
  return true;
}
/** After a reload: the draft record as stored and the restore offer's text, then accept the offer if there is one. */
async function afterReload(page) {
  const draft = await page.evaluate(() => { try { return Object.keys(localStorage).filter((k) => k.startsWith('mdr.draft')).map((k) => localStorage.getItem(k)).join('|'); } catch { return 'ERR'; } });
  for (let i = 0; i < 20 && !(await page.$('button:has-text("恢复")')); i++) await sleep(100);
  const offer = await toasts(page);
  const btn = await page.$('button:has-text("恢复")');
  if (btn) { await btn.click(); await sleep(800); }
  return { draftHasZQ: draft.includes('ZQ'), offer: offer.join(' | ').slice(0, 120), restored: (await source(page)).includes('ZQ'), src: (await source(page)).slice(0, 200) };
}

const CASES = {};
for (const wait of [0, 50, 400]) {
  CASES[`reload-session-${wait}`] = async () => {
    const context = await browser.newContext({ viewport: { width: 1300, height: 850 } });
    try {
      const page = await newPage(context, PORT);
      await typeDoc(page);
      await page.keyboard.press('Meta+Shift+KeyE'); await sleep(300);
      check(`reload-session-${wait}: switch on`, (await pressed(page)) === 'true' && (await stored(page)) === '1');
      await clickPara(page, 'Beta paragraph');
      check(`reload-session-${wait}: session`, (await editable(page)) === 1);
      await page.keyboard.type('ZQ');
      if (wait) await sleep(wait);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ready(page);
      await sleep(800);
      const r = await afterReload(page);
      console.log(`  ${JSON.stringify(r)}`);
      check(`reload-session-${wait}: the draft holds the text typed in the preview`, r.draftHasZQ || r.restored, JSON.stringify(r));
      check(`reload-session-${wait}: restored text has ZQ`, r.restored, r.src);
      check(`reload-session-${wait}: switch still on after the reload`, (await pressed(page)) === 'true' && (await stored(page)) === '1', `${await pressed(page)} ${await stored(page)}`);
      check(`reload-session-${wait}: no session after the reload until a click`, (await editable(page)) === 0);
    } finally { await context.close(); }
  };
}
for (const wait of [0, 50, 400]) CASES[`reload-editor-${wait}`] = async () => {
  for (const [tag, port] of [['cand', PORT], ...(BASE_PORT ? [['base', BASE_PORT]] : [])]) {
    const context = await browser.newContext({ viewport: { width: 1300, height: 850 } });
    try {
      const page = await newPage(context, port);
      await typeDoc(page);
      await page.keyboard.press('Meta+ArrowDown');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
      await page.keyboard.type('ZQ');
      if (wait) await sleep(wait);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ready(page); await sleep(800);
      const r = await afterReload(page);
      console.log(`  ${tag} ${JSON.stringify(r)}`);
      check(`reload-editor-${wait} ${tag}: draft restored`, r.restored, JSON.stringify(r));
    } finally { await context.close(); }
  }
};
CASES['two-tabs'] = async () => {
  const context = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  try {
    const a = await newPage(context, PORT);
    const b = await newPage(context, PORT);
    await a.bringToFront();
    await a.click('.cm-content');
    await a.keyboard.press('Meta+Shift+KeyE'); await sleep(300);
    check('two-tabs: A on, stored 1', (await pressed(a)) === 'true' && (await stored(a)) === '1');
    await b.bringToFront();
    const bp = await pressed(b);
    console.log(`  B after A turned on: pressed=${bp} stored=${await stored(b)}`);
    await typeDoc(b);
    await clickPara(b, 'Alpha paragraph');
    const bSess = await editable(b);
    console.log(`  B click: sessions=${bSess}`);
    check('two-tabs: B button and B behaviour agree', (bp === 'true') === (bSess === 1), `${bp} ${bSess}`);
    await b.keyboard.press('Meta+Shift+KeyE'); await sleep(300);
    console.log(`  B toggled: pressed=${await pressed(b)} stored=${await stored(b)} toasts=${JSON.stringify(await toasts(b))}`);
    const bNow = await pressed(b), bSt = await stored(b), bTo = await toasts(b);
    check('two-tabs: B toggle result agrees with its toast and storage', (bNow === 'true') === (bSt === '1') && bTo.some((t) => t.includes(bNow === 'true' ? '开' : '关')));
    await b.reload({ waitUntil: 'domcontentloaded' }); await ready(b);
    check('two-tabs: B reload shows the stored value', ((await pressed(b)) === 'true') === ((await stored(b)) === '1'), `${await pressed(b)} ${await stored(b)}`);
    await a.bringToFront();
    await typeDoc(a);
    await clickPara(a, 'Beta paragraph');
    console.log(`  A (pressed ${await pressed(a)}) click: sessions=${await editable(a)}`);
    check('two-tabs: A button and A behaviour agree', ((await pressed(a)) === 'true') === ((await editable(a)) === 1));
  } finally { await context.close(); }
};

try {
  browser = await chromium.launch({ headless: true });
  for (const [name, fn] of Object.entries(CASES)) {
    if (only && !name.startsWith(only)) continue;
    try { await fn(); } catch (e) { check(`${name} threw`, false, String(e && e.stack || e).slice(0, 300)); }
  }
} finally {
  clearTimeout(KILL);
  await browser?.close().catch(() => {});
  console.log(`v5-sw-user: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
