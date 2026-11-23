// bench/verify/r6-cr-format.mjs — challenge-refs (0.2.0 stage 2g, fix round 6): M3 as a class. The session's own format
// commands (Cmd+B, Cmd+I, Cmd+E inline code, Cmd+K link) on part of, the whole of, and across the document's own styled
// spans (font-weight 600 / 300 / normal, font-style normal inside italic, text-decoration line-through, colour, nested
// spans; in a paragraph, a heading, a table cell, a list item), and a session undo after a command. For each case the
// look of every character of the block (bold, italic, line-through, colour, code, link) in the session after the
// commands is compared with the look after Esc (the block re-rendered from what the session wrote): the source must say
// what the screen showed. With an undo the look and the source must be the original ones. Also flags a style the
// document did not hold (font-size, font-family, rgb(), line-height) appearing in the source.
// Run: MDR_PORT=<dev server> node bench/verify/r6-cr-format.mjs [filter]   (T_MS: global timeout, default 110000)
// Writes nothing into the tree.
import { chromium } from '@playwright/test';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = process.argv[2] ?? '';
const T_MS = Number(process.env.T_MS ?? 110000);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, T_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// [name, block source, selection: [from-word, to-word] (from the start of the first to the end of the second; one word
// when equal), keys, undo after the keys]
const CASES = [
  ['w600-unbold-part', 'Para <span style="font-weight:600">heavy words</span> end text', ['heavy', 'heavy'], ['Meta+b']],
  ['w300-bold-part', 'Para <span style="font-weight:300">light words</span> end text', ['light', 'light'], ['Meta+b']],
  ['w300-bold-whole', 'Para <span style="font-weight:300">light words</span> end text', ['light', 'words'], ['Meta+b']],
  ['normalstyle-in-em', 'Para *x <span style="font-style:normal">upright words</span> y* end text', ['upright', 'upright'], ['Meta+i']],
  ['strike-bold-part', 'Para <span style="text-decoration:line-through">struck words</span> end text', ['struck', 'struck'], ['Meta+b']],
  ['strike-italic-whole', 'Para <span style="text-decoration:line-through">struck words</span> end text', ['struck', 'words'], ['Meta+i']],
  ['color-italic-across', 'Para <span style="color:red">red words</span> tail end text', ['words', 'tail'], ['Meta+i']],
  ['two-spans-bold', 'Para <span style="font-weight:bold">one</span> mid <span style="font-style:italic">two</span> end text', ['one', 'two'], ['Meta+b']],
  ['two-spans-italic', 'Para <span style="font-weight:bold">one</span> mid <span style="font-style:italic">two</span> end text', ['one', 'two'], ['Meta+i']],
  ['heading-normal-bold', '## Head <span style="font-weight:normal">light words</span> end text', ['light', 'light'], ['Meta+b']],
  ['cell-unbold', '| h | k |\n| --- | --- |\n| <span style="font-weight:bold">heavy words</span> | end text |', ['heavy', 'heavy'], ['Meta+b']],
  ['item-unitalic-part', '- Para <span style="font-style:italic">slanted words</span> end text\n- two', ['slanted', 'slanted'], ['Meta+i']],
  ['nested-color-bold', 'Para <span style="color:red">a <span style="font-weight:bold">heavy</span> b</span> end text', ['heavy', 'heavy'], ['Meta+b']],
  ['overlap-unbold', 'Para <span style="font-weight:bold">heavy words</span> end text', ['avy', 'wor'], ['Meta+b']],
  ['code-on-styled', 'Para <span style="font-weight:bold">heavy words</span> end text', ['heavy', 'heavy'], ['Meta+e']],
  ['link-on-styled', 'Para <span style="font-style:italic">slanted words</span> end text', ['slanted', 'slanted'], ['Meta+k', 'TYPE:https://e.example/l', 'Enter']],
  ['unbold-undo', 'Para <span style="font-weight:bold">heavy words</span> end text', ['heavy', 'heavy'], ['Meta+b'], true],
  ['unitalic-undo', 'Para <span style="font-style:italic;color:blue">slanted words</span> end text', ['slanted', 'words'], ['Meta+i'], true],
  ['unbold-type', 'Para <span style="font-weight:bold">heavy words</span> end text', ['heavy', 'heavy'], ['Meta+b', 'ArrowRight', 'TYPE:Q']],
  ['bold-unbold-italic', 'Para <span style="font-weight:bold;font-style:italic">heavy words</span> end text', ['words', 'words'], ['Meta+b', 'Meta+i', 'Meta+b']],
  ['em-styled-unitalic', 'Para <em style="color:green">green words</em> end text', ['green', 'green'], ['Meta+i']],
].filter((c) => c[0].includes(filter));

let bad = 0;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await page.goto(`http://localhost:${port}/?perf=1&mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  await page.addStyleTag({ content: '[class*="mdr-perf"] { visibility: hidden !important; pointer-events: none !important; }' });
  const look = () => page.evaluate(() => {
    const el = document.querySelector('.md-block.is-editing') ?? Array.from(document.querySelectorAll('.md-block')).find((b) => (b.textContent ?? '').includes('end text'));
    if (!el) return null;
    const tw = document.createTreeWalker(el, 4);
    const runs = [];
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const p = n.parentElement;
      if (p.closest('.mdr-linkbox, .katex')) continue;
      const cs = getComputedStyle(p);
      let deco = '';
      for (let a = p; a && a !== el.parentElement; a = a.parentElement) { const d = getComputedStyle(a).textDecorationLine; if (d && d !== 'none') deco = d; }
      const k = `${Number(cs.fontWeight) >= 600 ? 'B' : '-'}${cs.fontStyle === 'italic' ? 'I' : '-'}${deco.includes('line-through') ? 'S' : '-'}${p.closest('code') ? 'C' : '-'}${p.closest('a') ? 'L' : '-'}${cs.color}`;
      for (const ch of n.data.split(String.fromCharCode(0x200b)).join('').split(String.fromCharCode(0xfeff)).join('')) {
        if (ch.trim() === '') continue;
        const last = runs[runs.length - 1];
        if (last && last.k === k) last.t += ch; else runs.push({ k, t: ch });
      }
    }
    return runs.map((r) => `${r.t}[${r.k}]`).join(' ');
  });
  for (const [name, para, [from, to], keys, undo] of CASES) {
    await page.keyboard.press('Escape');
    const doc = `# Format\n\nfiller\n\n${para}\n\nlast paragraph\n`;
    await page.evaluate(([t]) => window.__mdr.loadText(t, 'format.md'), [doc]);
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(900);
    const at = await page.evaluate(() => {
      const root = window.__mdr.app.preview.el;
      const tw = document.createTreeWalker(root, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf('end text'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 2); const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; } }
      return null;
    });
    const before = await look();
    await page.mouse.click(at.x, at.y);
    await sleep(450);
    const sel = await page.evaluate(([a, b]) => {
      const el = document.querySelector('.md-block.is-editing');
      if (!el) return false;
      const tw = document.createTreeWalker(el, 4);
      let s0 = null, s1 = null;
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        if (!s0) { const i = n.data.indexOf(a); if (i >= 0) s0 = [n, i]; }
        if (s0) { const j = n === s0[0] ? n.data.indexOf(b, s0[1]) : n.data.indexOf(b); if (j >= 0 && !s1) s1 = [n, j + b.length]; }
      }
      if (!s0 || !s1) return false;
      const r = document.createRange(); r.setStart(s0[0], s0[1]); r.setEnd(s1[0], s1[1]);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return true;
    }, [from, to]);
    for (const k of keys) {
      if (k.startsWith('TYPE:')) await page.keyboard.type(k.slice(5), { delay: 10 }); else await page.keyboard.press(k);
      await sleep(k === 'Meta+k' ? 400 : 250);
    }
    await sleep(250);
    const shown = await look();
    if (undo) { await page.keyboard.press('Meta+z'); await sleep(600); }
    const shownAfterUndo = undo ? await look() : null;
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(700);
    const full = await page.evaluate(() => window.__mdr.app.getText());
    const out = full.replace(/^# Format\n\nfiller\n\n/, '').replace(/\n\nlast paragraph\n$/, '');
    const after = await look();
    const invented = /style="[^"]*(?:rgb|font-family|font-size|line-height)/.test(out);
    let ok;
    if (undo) ok = sel && out === para && after === before && shownAfterUndo === before;
    else ok = sel && shown === after && !invented && full.startsWith('# Format\n\nfiller\n\n') && full.endsWith('\n\nlast paragraph\n');
    if (sel && !ok) bad++;
    console.log(`${!sel ? 'n/a ' : ok ? 'ok  ' : 'FAIL'} ${name}: source=${JSON.stringify(out)}${invented ? ' INVENTED-STYLE' : ''}\n     before   ${before}\n     session  ${shown}${undo ? `\n     undone   ${shownAfterUndo}` : ''}\n     after    ${after}`);
  }
} finally { await browser.close(); clearTimeout(killer); }
console.log(`RESULT ${bad === 0 ? 'PASS' : 'FAIL'} bad=${bad} of ${CASES.length}`);
process.exit(bad === 0 ? 0 : 1);
