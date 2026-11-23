// bench/verify/v2-rev-browser.mjs — verify-review (stage 2a, 0.2.0): browser repros of the code review.
// Run from the project root:  MDR_PORT=5287 node bench/verify/v2-rev-browser.mjs [case …]
// Cases (default: all): rev1 (forged data-md / data-mdr-ui attributes), race (a resume survives a
// document replacement), sec (⌘K javascript:, text/html paste). Starts its own Vite on MDR_PORT (kills
// only that port), writes nothing into the tree, global timeout 100 s.
import { startServer, stopServer, openBrowser, check, note, sleep, finish } from './inline-verify-lib.mjs';

const want = new Set(process.argv.slice(2));
const on = (c) => want.size === 0 || want.has(c);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); stopServer(); process.exit(3); }, 100_000);

await startServer();
const B = await openBrowser();
const { page } = B;
const isMac = process.platform === 'darwin';
const MOD = isMac ? 'Meta' : 'Control';

try {
  await B.boot('mode=split');

  // ------------------------------------------------------------------ REV-1 end to end
  if (on('rev1')) {
    // Stage 2b (integrator): under U10 (c) a block whose raw HTML carries a reserved name is refused, so the
    // click starts no session; type only when one started (harness repair: caretAt needs a live session).
    const typeAt = async (label, needle, text) => {
      const live = await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
      note(`${label}: session started`, String(live));
      if (live) { await B.caretAt(needle); await page.keyboard.type(text); }
      return live;
    };
    const doc = '# Notes\n\nFix the typo here <span data-md="[bank login](https://evil.example/phish)" style="display:none">.</span> please\n\nEnd.\n';
    await B.loadDoc(doc, 'rev1.md');
    const shown = await page.evaluate(() => {
      const pv = window.__mdr.app.preview;
      const el = pv.elementOfBlock(pv.blockAtLine(3).id);
      return el ? el.innerText.trim() : null;
    });
    note('rev1: paragraph as the preview shows it', JSON.stringify(shown));
    await B.clickLine(3, 'first', 'typo');
    await typeAt('rev1', 'typo', 's');
    await B.esc();
    const src = await B.source();
    const line3 = src.split('\n')[2];
    note('rev1: source line 3 after typing one "s"', JSON.stringify(line3));
    const links = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview a[href]')).map((a) => `${a.textContent} -> ${a.getAttribute('href')}`));
    note('rev1: links in the preview afterwards', JSON.stringify(links));
    // Refused under U10 (c): the source stays the document itself, whose own attribute holds the text.
    check('rev1: the hidden data-md payload is NOT written into the source', src === doc || !src.includes('](https://evil.example/phish)'), `line 3 = ${JSON.stringify(line3)}`);

    const doc2 = 'Keep <span data-mdr-ui>THIS TEXT</span> safe and sound\n';
    await B.loadDoc(doc2, 'rev1b.md');
    await B.clickLine(1, 'first', 'safe');
    await typeAt('rev1b', 'sound', '!');
    await B.esc();
    const src2 = await B.source();
    check('rev1: text inside a data-mdr-ui span survives an edit of its paragraph', src2.includes('THIS TEXT'), `source = ${JSON.stringify(src2)}`);

    // Beyond the edited block: the hidden payload is a link reference definition placed BEFORE the
    // document's own one, so it wins (first definition) and a link in ANOTHER paragraph changes target.
    const doc3 = '# Notes\n\nFix the typo here <span data-md="&#10;&#10;[bank]: https://evil.example/phish" data-md-block style="display:none">.</span> please\n\nPay at [the bank][bank] today.\n\n[bank]: https://bank.example/\n';
    await B.loadDoc(doc3, 'rev1c.md');
    const hrefOf = () => page.evaluate(() => [...document.querySelectorAll('.mdr-preview a')].find((a) => a.textContent === 'the bank')?.getAttribute('href') ?? null);
    const before = await hrefOf();
    await B.clickLine(3, 'first', 'typo');
    await typeAt('rev1c', 'typo', 's');
    await sleep(300);
    await B.esc();
    await sleep(400);
    const after = await hrefOf();
    const src3 = await B.source();
    note('rev1c: source after typing one "s" in paragraph 1', JSON.stringify(src3));
    check('rev1c: the link in paragraph 2 keeps its target after an edit of paragraph 1', after === before, `before ${before} → after ${after}`);
  }

  // ------------------------------------------------------------------ race: resume across a document replacement
  if (on('race')) {
    // The worker's structure delta for a split is delayed by 400 ms (a slow worker / a loaded machine),
    // widening the resume window that is ~30 ms on an idle machine. While the resume waits, App replaces
    // the document (openFile — here __mdr.loadText, the same openFile every open / drop / recent / OS
    // document / 重新载入 / 恢复草稿 goes through). previewEdit.commit() returns early because no session is
    // live (session === null during a resume), so the resume survives setDoc.
    const A = 'alpha one two three\n\nbeta four five six\n\ngamma seven\n';
    const N = 'NEW DOC first para\n\nNEW DOC second para\n\nNEW DOC third\n';
    await B.loadDoc(A, 'a.md');
    await B.clickLine(3, 'first', 'four');
    await B.caretAt('four');
    await page.evaluate(() => {
      const pv = window.__mdr.app.preview;
      const orig = pv.applyStructureDelta.bind(pv);
      const origHtml = pv.applyHtml.bind(pv);
      window.__delay = true;
      // a slow worker: its structure deltas AND its HTML batches arrive 400 ms late (order kept)
      pv.applyStructureDelta = (m) => { if (window.__delay) { setTimeout(() => orig(m), 400); return true; } return orig(m); };
      pv.applyHtml = (m) => { if (window.__delay) setTimeout(() => origHtml(m), 400); else origHtml(m); };
    });
    await page.keyboard.press('Enter');            // split: "beta four" | " five six"
    await sleep(60);
    const cap = await page.evaluate(() => document.activeElement?.className ?? '');
    note('race: focus while the resume waits', cap);
    await page.keyboard.type('QQ');                // queued for the resumed session (U4)
    await page.evaluate(async (N) => { window.__delay = false; await window.__mdr.loadText(N, 'other.md'); }, N);
    await sleep(1200);
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(300);
    const after = await B.source();
    const ed = await B.editing();
    note('race: new document source afterwards', JSON.stringify(after));
    note('race: session afterwards', JSON.stringify(ed));
    check('race/split: the newly opened document is untouched (no keys of the old session replayed into it)', after === N, `diff: ${JSON.stringify(after)}`);
    check('race/split: no session runs in the newly opened document by itself', ed === null, JSON.stringify(ed));
    await B.esc();

    // Same, for the two resumes that are accepted by structure VERSION (minVersion): a U3 merge and a U1 undo.
    // After setDoc the new document's structure version is higher than any minVersion of the old one.
    for (const variant of ['merge', 'undo']) {
      await page.evaluate(() => { window.__delay = false; });
      await B.loadDoc(A, `a-${variant}.md`);
      await B.clickLine(3, 'first', 'four');
      if (variant === 'merge') {
        await B.caretAt('beta', 'before');
      } else {
        await B.caretAt('six');
        await page.keyboard.type(' xyz');
        await sleep(900);                           // its own undo step
      }
      await page.evaluate(() => { window.__delay = true; });
      if (variant === 'merge') await page.keyboard.press('Backspace');
      else await page.keyboard.press(`${MOD}+z`);
      await sleep(60);
      const capV = await page.evaluate(() => document.activeElement?.className ?? '');
      await page.keyboard.type('QQ');
      await page.evaluate(async (N) => { window.__delay = false; await window.__mdr.loadText(N, 'other.md'); }, N);
      await sleep(1200);
      await page.evaluate(() => window.__mdr.waitIdle());
      await sleep(300);
      const afterV = await B.source();
      const edV = await B.editing();
      note(`race/${variant}: focus while waiting / session afterwards`, `${capV} / ${JSON.stringify(edV)}`);
      check(`race/${variant}: the newly opened document is untouched (no keys of the old session replayed into it)`, afterV === N, `source now ${JSON.stringify(afterV)}`);
      check(`race/${variant}: no session runs in the newly opened document by itself`, edV === null, JSON.stringify(edV));
      await B.esc();
    }
    // A modal question asked while the resume waits (新建 on a dirty document; on the desktop also the
    // close question): the guard's isDirty() → previewEdit.commit() does not cancel the resume either, and
    // the session that resumes a moment later takes the focus away from the dialog's buttons.
    await page.evaluate(() => { window.__delay = false; });
    await B.loadDoc(A, 'a-dialog.md');
    await B.clickLine(3, 'first', 'four');
    await B.caretAt('beta', 'before');
    await page.evaluate(() => { window.__delay = true; });
    await page.keyboard.press('Backspace');
    await sleep(30);
    await page.evaluate(() => { void window.__mdr.app.registry.run('file.new'); });
    await sleep(80);
    const f1 = await page.evaluate(() => ({ dialog: !!document.querySelector('.mdr-dialog'), active: document.activeElement?.className ?? '', text: document.activeElement?.textContent?.slice(0, 20) }));
    await page.evaluate(() => { window.__delay = false; });
    await sleep(900);
    const f2 = await page.evaluate(() => ({ dialog: !!document.querySelector('.mdr-dialog'), active: document.activeElement?.className ?? '', text: document.activeElement?.textContent?.slice(0, 40) }));
    note('race/dialog: focus right after the question appeared', JSON.stringify(f1));
    note('race/dialog: focus after the resume completed', JSON.stringify(f2));
    check('race/dialog: the discard question keeps the focus while it is on screen', !f2.dialog || /mdr-dialog__btn/.test(f2.active), JSON.stringify(f2));
    await page.keyboard.press('Escape');
    await sleep(200);
    const f3 = await page.evaluate(() => ({ dialog: !!document.querySelector('.mdr-dialog') }));
    check('race/dialog: Escape answers the question (取消)', !f3.dialog, JSON.stringify(f3));
    // clean up a dialog that is still up
    await page.evaluate(() => { const b = document.querySelector('.mdr-dialog__btn'); if (b) b.click(); });
    await sleep(200);
    await page.evaluate(() => { window.__delay = false; });
  }

  // ------------------------------------------------------------------ security probes (expected to hold)
  if (on('sec')) {
    await B.loadDoc('Link here please\n\nSecond para\n', 'sec.md');
    await B.clickLine(1, 'first', 'here');
    await B.caretAt('here');
    await page.keyboard.press(`${MOD}+k`);
    await sleep(100);
    await page.keyboard.type('javascript:alert(document.domain)');
    await page.keyboard.press('Enter');
    await sleep(150);
    let popups = 0, dialogs = 0;
    page.context().on('page', () => { popups++; });
    page.on('dialog', () => { dialogs++; });
    const pt = await page.evaluate(() => {
      const a = document.querySelector('.mdr-preview .is-editing a[href]');
      if (!a) return null;
      const r = a.getBoundingClientRect();
      return { x: r.left + 3, y: r.top + r.height / 2, href: a.getAttribute('href') };
    });
    note('sec: live link during the session', JSON.stringify(pt));
    if (pt) { await page.keyboard.down(MOD); await page.mouse.click(pt.x, pt.y); await page.keyboard.up(MOD); await sleep(500); }
    note('sec: ⌘-click on it', `popups=${popups} dialogs=${dialogs}`);
    await B.esc();
    const src = await B.source();
    const live = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview a[href]')).map((a) => a.getAttribute('href')));
    note('sec: source after ⌘K javascript:', JSON.stringify(src.split('\n')[0]));
    check('sec: no javascript: link survives the re-render', !live.some((h) => /^\s*javascript:/i.test(h ?? '')), JSON.stringify(live));
    check('sec: ⌘-click on a typed javascript: link runs nothing', dialogs === 0, `popups=${popups} dialogs=${dialogs}`);

    // text/html paste: only text/plain is used
    await B.loadDoc('Paste target\n', 'paste.md');
    await B.clickLine(1, 'first', 'target');
    await B.caretAt('target');
    await page.evaluate(() => {
      const el = document.querySelector('.mdr-preview .is-editing');
      const dt = new DataTransfer();
      dt.setData('text/html', '<img src=x onerror="window.__pwn=1"><b data-md="INJECT">B</b>');
      dt.setData('text/plain', ' plain');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await sleep(100);
    await B.esc();
    const src2 = await B.source();
    const pwn = await page.evaluate(() => window.__pwn === 1);
    check('sec: a text/html paste inserts its text/plain only', src2 === 'Paste target plain\n' && !pwn, JSON.stringify(src2));
  }
} catch (err) {
  check('script', false, String(err && err.stack ? err.stack : err).split('\n').slice(0, 4).join(' | '));
} finally {
  clearTimeout(killer);
  note('page errors', JSON.stringify(B.pageErrors.slice(0, 5)));
  await B.browser.close().catch(() => {});
  stopServer();
  finish();
}
