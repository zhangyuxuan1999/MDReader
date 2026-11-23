// bench/verify/r3-ib-atom-start.mjs — fix-session-b (round 3): U21, a caret before a formula or an image that starts
// a line. For each document and way of getting to the line start (⌘←, Home, Ctrl+A, a click left of the first
// character), types Q and prints where the caret was and the written source; PASS when Q stands before the atom.
// Also a plain-text control (does the key move the caret at all in a session under this Chromium?).
//   MDR_PORT=5411 node bench/verify/r3-ib-atom-start.mjs [name-filter]          (exit code 1 on a failure)
import zlib from 'node:zlib';
import { openB, sleep, globalTimeout, J, check, summary, view, clickText } from './v3-ses-lib.mjs';

const filter = process.argv[2] || '';
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 110_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
async function waitSession(ms = 1500) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await view(page); if (v.editing && !v.capFocused) return v; await sleep(30); }
  return view(page);
}
const caretInfo = () => page.evaluate(() => {
  const s = getSelection();
  if (!s.rangeCount) return null;
  const n = s.focusNode;
  return { node: n.nodeType === 3 ? 'text:' + JSON.stringify(n.data.slice(0, 12)) : n.nodeName, off: s.focusOffset, inMath: !!(n.parentElement ?? n).closest?.('.md-math') };
});
/** A click at the start of the line that holds `needle`: in a list item on its marker (left of the content), else on
 *  the first pixel column of the line (there is no padding: that is the first thing on the line itself). */
async function clickLineStart(needle) {
  const pt = await page.evaluate((needle) => {
    const ed = document.querySelector('.mdr-preview .is-editing');
    const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.data.includes(needle)) continue;
      const line = n.parentElement.closest('p, li, h1, h2, td');
      const r = document.createRange(); r.setStart(n, n.data.indexOf(needle)); r.collapse(true);
      const y = r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2;
      const lr = line.getBoundingClientRect();
      return { x: line.tagName === 'LI' ? lr.left - 6 : lr.left + 3, y, li: line.tagName === 'LI' };
    }
    return null;
  }, needle);
  if (!pt) throw new Error('no line for ' + needle);
  await page.mouse.click(pt.x, pt.y);
  return pt;
}

/** A 40×20 grey PNG (a 1×1 image is too small to click on its left half). */
function png(w, h) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w + 1) * h, 0x88); for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return 'data:image/png;base64,' + Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const IMG = png(40, 20);
const DOCS = [
  ['math', '$x$ d\n\nz\n', ' d', 'Q$x$ d\n\nz\n'],
  ['math-li', '- $x$ d\n- e\n', ' d', '- Q$x$ d\n- e\n'],
  ['math-after-br', 'abc  \n$x$ d\n\nz\n', ' d', 'abc  \nQ$x$ d\n\nz\n'],
  ['img', `![i](${IMG}) d\n\nz\n`, ' d', `Q![i](${IMG}) d\n\nz\n`],
  ['plain', 'abc d\n\nz\n', ' d', 'Qabc d\n\nz\n'],
];
const WAYS = ['Meta+ArrowLeft', 'Home', 'Control+a', 'click', 'click-fresh'];

let bad = 0;
try {
  await B.boot('mode=split');
  for (const [dn, doc, needle, want] of DOCS) {
    for (const way of WAYS) {
      const name = `${dn}-${way}`;
      if (filter && !name.includes(filter)) continue;
      try {
        await B.loadDoc(doc);
        await B.mountLine(1);
        await sleep(650);
        await clickText(page, ' d', 1, { side: 'right' });
        if (!(await waitSession()).editing) throw new Error('no session');
        await B.caretAt(needle, 'after');
        if (way === 'click') await clickLineStart(needle);
        else if (way === 'click-fresh') {
          // the first click on the block (no session yet) at the line start
          await page.keyboard.press('Escape'); await settle();
          const pt = await page.evaluate((needle) => {
            const root = document.querySelector('.mdr-preview');
            const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let n = w.nextNode(); n; n = w.nextNode()) {
              if (!n.data.includes(needle)) continue;
              const line = n.parentElement.closest('p, li, h1, h2, td');
              const r = document.createRange(); r.setStart(n, n.data.indexOf(needle)); r.collapse(true);
              const lr = line.getBoundingClientRect();
              return { x: line.tagName === 'LI' ? lr.left - 6 : lr.left + 3, y: r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2 };
            }
            return null;
          }, needle);
          await page.mouse.click(pt.x, pt.y);
          await waitSession();
        } else await page.keyboard.press(way);
        await sleep(80);
        const c = await caretInfo();
        await page.keyboard.type('Q');
        await settle();
        const src = await B.source();
        // a click at the start of a paragraph line that starts with a formula is ON the formula: it opens the TeX
        // source (as every click on a formula in a session does) — INFO
        const info = way.startsWith('click') && /^math(-after-br)?$/.test(dn);
        const ok = src === want;
        const short = (x) => J(x).replace(IMG, 'IMG');
        if (info) console.log(`INFO  ${name}  — caret=${J(c)} src=${short(src)} want=${short(want)}`);
        else if (!check(name, ok, `caret=${J(c)} src=${short(src)} want=${short(want)}`)) bad++;
      } catch (e) { bad++; check(name, false, 'threw ' + String(e.message).split('\n')[0]); }
      try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
    }
  }
  console.log('pageErrors', J(B.pageErrors.slice(0, 3)), 'console', J(B.consoleErrors.filter((x) => !/DevTools|Download/.test(x)).slice(0, 3)));
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
