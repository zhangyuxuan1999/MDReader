// bench/verify/v4-app-export.mjs — verify-app (0.2.0 stage 2d). Export (HTML download) and print (print media)
// during a live session: text typed 0 ms ago, an emptied block, a session on a paragraph that starts with an
// inline formula (U21 spacer). The export must hold the typed text and no session artefacts; in print media no
// session UI may be visible. Prints RESULT lines.
//   MDR_PORT=5436 node bench/verify/v4-app-export.mjs
// Needs the renderer already listening. Writes nothing into the tree (the download is read and discarded).
import fs from 'node:fs';
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const B = await openBrowser();
const { page } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const ZW = [0x200b, 0xfeff].map((c) => String.fromCharCode(c));
const DOC = ['# 标题', '', '甲段落文字。', '', '$x+y$ 开头是公式的段落', '', '乙段落文字。', ''].join('\n');
const artefacts = (full) => { const html = full.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<head[\s\S]*?<\/head>/i, ''); return {
  contenteditable: /contenteditable/i.test(html), isEditing: /is-editing/.test(html), mdrUi: /data-mdr-ui/.test(html),
  capture: /mdr-capture|<textarea/i.test(html), zw: ZW.some((z) => html.includes(z)),
}; };
async function exportNow() {
  const dl = page.waitForEvent('download', { timeout: 8000 });
  await page.evaluate(() => { void window.__mdr.app.registry.run('file.exportHtml'); });
  const d = await dl;
  const p = await d.path();
  const html = fs.readFileSync(p, 'utf8');
  return html;
}
const printInfo = () => page.evaluate((ZW) => {
  const pv = document.querySelector('.mdr-preview');
  const vis = (e) => { const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && e.getClientRects().length > 0; };
  const ui = [...document.querySelectorAll('[data-mdr-ui], .mdr-toast, .mdr-statusbar, .mdr-toolbar, textarea')].filter(vis).map((e) => e.className || e.tagName).slice(0, 6);
  const ed = pv.querySelector('.is-editing');
  return { visibleUi: ui, editingOutline: ed ? getComputedStyle(ed).outlineStyle + '/' + getComputedStyle(ed).boxShadow.slice(0, 30) : null, zwInPreview: ZW.some((z) => pv.textContent.includes(z)) };
}, ZW);
try {
  await B.boot('mode=split');
  const start = async (needle) => {
    await page.keyboard.press('Escape');
    await B.loadDoc(DOC);
    await sleep(500);
    const line = DOC.split('\n').findIndex((l) => l.includes(needle)) + 1;
    await B.clickLine(line, 'first', needle);
    await B.caretAt(needle);
  };
  await start('乙段落');
  await page.keyboard.type('XY');
  let html = await exportNow();
  out('E1 export 0 ms after typing XY', { hasXY: html.includes('乙段落XY') || html.includes('乙段落文字。XY'), ...artefacts(html) });
  await start('乙段落');
  await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await page.keyboard.press('Backspace');
  html = await exportNow();
  out('E2 export 0 ms after emptying 乙', { has乙: html.includes('乙段落'), ...artefacts(html) });
  await start('开头是');
  html = await exportNow();
  out('E3 export with a session on a formula-start paragraph', artefacts(html));
  out('P0 session before print media', await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing')));
  await page.emulateMedia({ media: 'print' });
  await sleep(200);
  out('P1 print media with that session live', await printInfo());
  await page.emulateMedia({ media: 'screen' });
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  console.log('BASE', BASE);
}
