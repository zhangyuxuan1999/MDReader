// bench/verify/v6-von-linktext.mjs — verify-on (0.2.0 stage 2f, fix round 5 verification): the browser form of
// test/v6-von-linktext.test.ts. A bare URL / autolink whose source holds a percent-escaped invisible or blank character
// (%E2%80%AE RLO, %E2%80%8E LRM, %E2%80%8C ZWNJ, %C2%AD SHY, %E3%80%80 ideographic space) is shown by the worker with
// that character decoded in the link's text. The user edits the URL's text in a session — a character typed in the
// middle of the URL, and (second gesture) a typed character at the very end of the URL's text — then Esc. Checks: no
// invisible / blank character raw in the source that the source did not hold raw (the user typed only Z / Q).
// Run: MDR_PORT=5482 MDR_BASE_PORT=5483 node bench/verify/v6-von-linktext.mjs     (5493 = the pre-r5 copy)
// Global timeout T_MS (default 110 s). Writes nothing into the tree.
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, clickText, sessionOn } from './v5-ptr-lib.mjs';

const CP_LIST = [0x202e, 0x200e, 0x200c, 0xad, 0x3000];
const BLANK = [0x115f, 0x1160, 0x3164, 0xffa0, 0x2800];
const VISIBLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
const rawOf = (s) => Array.from(s).filter((c) => c !== ' ' && c !== '\n' && (!VISIBLE.test(c) || BLANK.includes(c.codePointAt(0)))).map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase());
const hexOf = (s) => Array.from(s).map((c) => (c.codePointAt(0) > 0x7e ? `<U+${c.codePointAt(0).toString(16).toUpperCase()}>` : c)).join('');

let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 110_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, !!process.env.MDR_PERFQ);
  const { page } = A;
  for (const cp of CP_LIST) {
    const u = `https://e.example/a${encodeURIComponent(String.fromCodePoint(cp))}b`;
    for (const [shape, doc] of [['bare', `See ${u} here\n\nsecond words\n`], ['autolink', `- See <${u}> here\n- second words\n`]]) {
      for (const gesture of ['middle', 'end']) {
        const name = `${shape}/U+${cp.toString(16).toUpperCase()}/${gesture}`;
        try {
          await prepare(A, doc);
          await clickText(page, 'here', 2); await sleep(400);
          const live = await sessionOn(page);
          const placed = await page.evaluate((gesture) => {
            const a = document.querySelector('.mdr-preview .is-editing a');
            const t = a && [...a.childNodes].find((n) => n.nodeType === 3);
            if (!t) return false;
            const k = gesture === 'middle' ? 'https://e.example/'.length : t.data.length;
            getSelection().setBaseAndExtent(t, k, t, k);
            return true;
          }, gesture);
          await page.keyboard.type(gesture === 'middle' ? 'Z' : 'Q'); await A.settle(350);
          await page.keyboard.press('Escape'); await A.settle(350);
          const src = await A.source();
          const added = rawOf(src).length - rawOf(doc).length;
          check(name, live && placed && added <= 0, `live=${live} placed=${placed} rawAdded=${J(rawOf(src))} src=${J(hexOf(src))}`);
        } catch (e) { check(name, false, 'threw ' + String(e?.message ?? e).split('\n')[0]); }
      }
    }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
