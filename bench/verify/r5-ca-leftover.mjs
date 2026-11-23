// bench/verify/r5-ca-leftover.mjs — challenge-atoms (stage 2f, fix round 5): P-G stamps (data-mdr-tex, data-mdr-ps) never
// leave the session. A block with an inline formula, a display formula, an image and a styled raw span; each case starts a
// session (click on "words"), then: (esc) Esc without a change; (type) X typed, Esc; (off) the switch turned off in the
// middle of the session (setPreviewEditable(false)); (join) a Backspace join of two items, Esc; (join-off) the same join, then the switch turned off; (copy) Cmd-C of the whole
// block during the session, then Esc and Cmd-C again outside it; (refused) a click on a block the session refuses (a
// reference definition in it). Checks: no stamp attribute anywhere in the preview afterwards; the clipboard's text/html
// (during and after the session) holds no stamp name; for esc/off/refused the source is the document.
// Run: MDR_PORT=5465 MDR_BASE_PORT=5476 node bench/verify/r5-ca-leftover.mjs      Global timeout 110 s (T_MS).
import { sleep, globalTimeout, check, summary, openAt, prepare, results, CP, show, clickText, sessionOn, copyKey } from './v5-ptr-lib.mjs';

const DOC = '- one $x^2$ first <span style="color:red">r</span>\n- Lead $$E=mc^2$$ ![i](x.png "t") words\n\npara words\n\n[d]: http://e.x/ refused words\n';
const stamps = (page) => page.evaluate(() => document.querySelectorAll('.mdr-preview [data-mdr-tex], .mdr-preview [data-mdr-ps]').length);
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 110_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  const { page } = A;
  for (const cn of ['esc', 'type', 'off', 'join', 'join-off', 'copy', 'refused']) {
    try {
      await prepare(A, DOC);
      const p = [];
      await clickText(page, cn === 'refused' ? 'refused' : 'words', 1); await sleep(400);
      const live = await sessionOn(page);
      const during = await stamps(page);
      let clipDuring = null, clipAfter = null;
      if (cn === 'type') await page.keyboard.type('X');
      if (cn === 'join' || cn === 'join-off') {
        await page.evaluate(() => {
          const el = document.querySelector('.mdr-preview .is-editing');
          const tw = document.createTreeWalker(el, 4);
          for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf('Lead'); if (i >= 0) { getSelection().setBaseAndExtent(n, i, n, i); return; } }
        });
        await page.keyboard.press('Backspace');
      }
      if (cn === 'copy') {
        await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); const r = document.createRange(); r.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(r); });
        clipDuring = await copyKey(page);
      }
      await sleep(300);
      if (cn === 'off' || cn === 'join-off') await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable?.(false));
      else await page.keyboard.press('Escape');
      await A.settle(500);
      if (cn === 'copy') {
        await page.evaluate(() => { const pv = document.querySelector('.mdr-preview .md-block'); const r = document.createRange(); r.selectNodeContents(pv); getSelection().removeAllRanges(); getSelection().addRange(r); });
        clipAfter = await copyKey(page);
      }
      const after = await stamps(page);
      const src = await A.source();
      if (cn !== 'refused' && !live) p.push('no session');
      if (cn !== 'refused' && during === 0) p.push('no stamps during the session (unexpected)');
      if (after !== 0) p.push(`stamps left: ${after}`);
      for (const [k, c] of [['during', clipDuring], ['after', clipAfter]]) if (c && /data-mdr-(tex|ps)/.test(c.html)) p.push(`clipboard ${k} holds a stamp`);
      if (/^(esc|off|refused)$/.test(cn) && src !== DOC) p.push('source changed');
      if (cn === 'refused' && live) p.push('refused block started a session');
      if (/^join/.test(cn) && !src.includes('first <span style="color:red">r</span>Lead $$E=mc^2$$ ![i](x.png "t") words')) p.push('join not written as shown');
      check(cn, p.length === 0, `${p.join(', ')} live=${live} stampsDuring=${during} after=${after} clipDuringHasMdrO=${clipDuring ? /data-mdr-o/.test(clipDuring.html) : 'n/a'} src=${show(src)}`);
    } catch (e) { check(cn, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
