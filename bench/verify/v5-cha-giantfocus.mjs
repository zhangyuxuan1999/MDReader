// bench/verify/v5-cha-giantfocus.mjs — challenge-a (round 4): P-F's longer click wait (RESUME_MS, extended while the
// block's re-render is pending) at NATURAL timing. A session on a "giant" block (a paragraph with N inline formulas:
// its worker HTML > 256 KB mounts only after GIANT_SETTLE_MS) ends with Esc; the user clicks back into it, then
// (`gap` ms later, before the giant HTML mounted) clicks into the EDITOR pane at the end of the document and types
// EDIT at `per` ms per key. Everything typed must go to the editor; the preview must not take the focus back.
// Run: MDR_PORT=5485 node bench/verify/v5-cha-giantfocus.mjs   (N=400 formulas; RUNS=n)
// Writes nothing into the tree.
import { openB, sleep, globalTimeout, J, check, summary, view, pointOf, waitSession, load } from './v4-sesa-lib.mjs';

const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), B.close);
const { page } = B;
const N = Number(process.env.N || 400);
const PARA = 'MARKER start ' + Array.from({ length: N }, (_, i) => `$a_{${i}}$ and`).join(' ') + ' end.';
const doc = 'Top para.\n\n' + PARA + '\n\nEnd para.\n';
let bad = 0;
try {
  await B.boot('mode=split');
  for (const [gap, per] of [[80, 150], [150, 150], [250, 120]]) {
    for (let run = 0; run < Number(process.env.RUNS ?? 1); run++) {
      const nm = `giant-esc-click-editor-gap${gap}-per${per}${run ? '#' + run : ''}`;
      try {
        await load(B, doc);
        await sleep(1500);
        const p = await pointOf(page, 'MARKER', 2); await page.mouse.click(p.x, p.y); await sleep(800);
        const v0 = await waitSession(page);
        if (!v0.editing) throw new Error('no first session');
        await page.keyboard.press('Escape');
        await sleep(30);
        const p2 = await pointOf(page, 'MARKER', 4); await page.mouse.click(p2.x, p2.y);
        await sleep(gap);
        const e = await page.evaluate(() => { const v = window.__mdr.app.editor.view; const c = v.coordsAtPos(0); return { x: c.left + 1, y: (c.top + c.bottom) / 2 }; });
        await page.mouse.click(e.x, e.y);
        await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ selection: { anchor: 0 } }); });
        for (const ch of 'EDIT') { await page.keyboard.type(ch); await sleep(per); }
        await sleep(2500);
        await B.settle(300);
        const v = await view(page);
        const want = 'EDIT' + doc;
        const line = v.src.split('\n').find((l) => l.includes('MARK')) ?? '';
        if (!check(nm, v.src === want, `head=${J(v.src.slice(0, 16))} markerLine=${J(line.slice(0, 24))} editing=${!!v.editing}`)) bad++;
      } catch (e) { bad++; check(nm, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
      try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
    }
  }
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
