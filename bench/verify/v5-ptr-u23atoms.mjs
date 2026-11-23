// bench/verify/v5-ptr-u23atoms.mjs — verify-session-pointer: U23 (Enter then Backspace is nothing) at the START of a
// block that holds atoms. Click into the paragraph, Home (caret to the start of the line, J26), Enter, Backspace —
// keys only, at human speed — then Esc. The source must be byte-identical to the original. Observed on the candidate:
// every inline formula's TeX is written twice ($x$ -> $xx$) and, after Enter Q Backspace Backspace, an image becomes
// raw HTML with a style attribute the browser baked in. Also prints the session DOM right after the Backspace.
// Run (Vite of the tree on MDR_PORT, default 5482): node bench/verify/v5-ptr-u23atoms.mjs [name-substring]
//   RUNS=n repeats every case.
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, clickText, sessionOn } from './v5-ptr-lib.mjs';

const filter = process.argv[2] || '';
const C = [
  ['formula', 'Lead $x$ and more words.\n\nnext\n', ['Enter', 'Backspace']],
  ['formula-typed', 'Lead $x$ and more words.\n\nnext\n', ['Enter', 'Q', 'Backspace', 'Backspace']],
  ['image', 'Lead ![i](x.png) and more words.\n\nnext\n', ['Enter', 'Backspace']],
  ['image-typed', 'Lead ![i](x.png) and more words.\n\nnext\n', ['Enter', 'Q', 'Backspace', 'Backspace']],
  ['two-formulas-image', 'Lead $x$ and ![i](x.png) then $y$$z$ end.\n\nnext\n', ['Enter', 'Backspace']],
  ['bold-link', 'Lead **bold** and [link](http://e.x/) end.\n\nnext\n', ['Enter', 'Backspace']],
  ['bold-link-typed', 'Lead **bold** and [link](http://e.x/) end.\n\nnext\n', ['Enter', 'Q', 'Backspace', 'Backspace']],
  ['code-span', 'Lead `code` and *em* end.\n\nnext\n', ['Enter', 'Backspace']],
  ['second-para', 'First para here.\n\nLead $x$ and more words.\n\nnext\n', ['Enter', 'Backspace']],
  ['item', '- Lead $x$ item\n- other\n\nnext\n', ['Enter', 'Backspace']],
  ['quote', '> Lead $x$ quoted\n\nnext\n', ['Enter', 'Backspace']],
  ['heading', '## Lead $x$ head\n\nnext\n', ['Enter', 'Backspace']],
  ['plain-control', 'Lead plain and more words.\n\nnext\n', ['Enter', 'Backspace']],
];
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  for (const [name, doc, keys] of C) {
    if (filter && !name.includes(filter)) continue;
    for (let run = 1; run <= Number(process.env.RUNS || 1); run++) {
      try {
        await prepare(A, doc);
        await clickText(A.page, doc.includes('First') ? 'more' : 'Lead', 2); await sleep(350);
        await A.page.keyboard.press('Home'); await sleep(120);
        const live = await sessionOn(A.page);
        for (const k of keys) { if (k.length === 1) await A.page.keyboard.type(k); else await A.page.keyboard.press(k); await sleep(250); }
        await sleep(400);
        const dom = await A.page.evaluate(() => document.querySelector('.mdr-preview .is-editing')?.innerHTML.slice(0, 300) ?? null);
        await A.settle(150);
        const srcLive = await A.source();
        await A.page.keyboard.press('Escape'); await A.settle(250);
        const src = await A.source();
        check(`${name}#${run}`, live && src === doc, `live=${live} src=${show(src)}${src !== doc ? ` srcLive=${show(srcLive)} dom=${J(dom)}` : ''}`);
      } catch (e) { check(`${name}#${run}`, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
    }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
