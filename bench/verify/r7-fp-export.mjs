// bench/verify/r7-fp-export.mjs — fix-pre (round 7, H3): 导出 HTML of a document with a block that the sanitizer cannot
// take (DOMPurify throws on a processing instruction named form, in Chromium only). Two pages on the same dev server: the
// tree (/src) and the frozen copy of the released 0.2.0 (test/fixtures/src-0.2.0, the page's entry rewritten). Every
// document is loaded and exported through the real command (registry 'file.exportHtml'), the download read back.
//   - documents that do not throw: the tree's export is byte-identical to the frozen copy's (whole file; the body too);
//   - documents that throw: the frozen copy fails with the toast (as 0.2.0); the tree exports; its body holds one md-error
//     box per throwing block with the notice and the block's HTML as text; outside those boxes the body is exactly the
//     frozen copy's export of the same document with the instruction renamed (`<?forms`, which does not throw); no raw
//     processing instruction, script, event handler or javascript: URL in the body.
//   MDR_PORT=5468 node bench/verify/r7-fp-export.mjs
// Writes nothing in the tree. Global timeout 110 s.
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const PORT = Number(process.env.MDR_PORT) || 5468;
const ROOT = new URL('../../', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 110_000);

const PLAIN = [
  ['small', readFileSync(`${ROOT}test-data/small.md`, 'utf8')],
  ['raw-html', '# T\n\n<div class="x" onclick="alert(1)">a <b>b</b></div>\n\n<script>alert(2)</script>\n\n<img src=x onerror="alert(3)">\n\n[j](javascript:alert(4)) <?forms> <?input> text\n'],
  ['math', '# M\n\n$E=mc^2$ and\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n| a | b |\n|---|---|\n| <u>u</u> | `c` |\n'],
  ['pi-text', '- b <?form> c\n\n| <?form> | z |\n|---|---|\n\n> q <?form> r\n'],
  ['task-list', '- [ ] one\n- [x] two\n  - nested <span style="color:red">red</span>\n'],
];
const THROW = [
  ['p', 'before\n\n<p><?form></p>\n\nafter\n'],
  ['inline', 'para one\n\na <?form ?> b\n\n# after\n'],
  ['upper', 'x\n\n<div><?FORM x></div>\n\ny\n'],
  // the instruction as an HTML block of its own: the whole document throws, the block alone does not and shows nothing,
  // in the preview (rule SAN) as in the export (no box)
  ['pi-block-alone', 'before\n\n<?form>\n\nafter\n', 0],
  ['list-item', '- a\n- b <?form ?> c\n- d\n\nend\n'],
  ['table-cell', '| a | b |\n|---|---|\n| <?form ?> | z |\n\nend\n'],
  ['quote', '> q <?form ?> r\n\nend\n'],
  ['heading-link', '# h <?form ?>\n\n[x <?Form ?> y](https://e.example/)\n'],
  ['two', 'a <?form ?> b\n\nmid <img src=x onerror="alert(1)"> <script>alert(2)</script>\n\nc <?form ?> d\n'],
  ['with-math', '$x^2$ <?form ?>\n\n$$\ny\n$$\n'],
  ['div-script', '<div><?form ?><script>alert(1)</script><img src=x onerror=alert(2)></div>\n\nafter\n'],
];

async function open(which) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, acceptDownloads: true });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  if (which === 'frozen') {
    await page.route(`http://localhost:${PORT}/?*`, async (route) => {
      const r = await route.fetch();
      await route.fulfill({ response: r, body: (await r.text()).replace('/src/main.ts', '/test/fixtures/src-0.2.0/main.ts') });
    });
  }
  await page.goto(`http://localhost:${PORT}/?mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable?.(false));
  return { page, errs };
}
async function exportOf({ page }, text) {
  await page.evaluate(({ t }) => window.__mdr.loadText(t, 'doc.md'), { t: text });
  await page.evaluate(() => window.__mdr.waitIdle());
  await page.evaluate(() => document.querySelectorAll('.mdr-toast').forEach((t) => t.remove()));
  const dl = page.waitForEvent('download', { timeout: 4000 }).catch(() => null);
  await page.evaluate(() => window.__mdr.app.registry.run('file.exportHtml'));
  const d = await dl;
  let file = null;
  if (d) { const p = await d.path(); file = readFileSync(p, 'utf8'); }
  await sleep(100);
  const toast = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-toast')).map((t) => t.textContent).join(' | '));
  return { file, toast };
}
const bodyOf = (f) => f.slice(f.indexOf('<article'), f.lastIndexOf('</article>'));
const ERR_RE = /<div class="md-error"><p>[^<]*<\/p><pre>[^<]*<\/pre><\/div>/g;

let fails = 0;
const res = (ok, name, msg) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${msg}`); };
try {
  browser = await chromium.launch({ headless: true });
  const tree = await open('tree');
  const frozen = await open('frozen');
  for (const [name, text] of PLAIN) {
    const a = await exportOf(tree, text);
    const b = await exportOf(frozen, text);
    const ok = a.file !== null && b.file !== null && a.file === b.file;
    res(ok, `plain:${name}`, ok ? `identical (${a.file.length} bytes)` : `tree ${a.file?.length ?? a.toast} frozen ${b.file?.length ?? b.toast}${a.file && b.file && bodyOf(a.file) === bodyOf(b.file) ? ' (bodies equal)' : ''}`);
  }
  for (const [name, text, boxesWanted] of THROW) {
    const a = await exportOf(tree, text);
    const b = await exportOf(frozen, text);
    const renamed = await exportOf(frozen, text.replace(/<\?form/gi, (m) => m + 's'));
    const notes = [];
    if (b.file !== null || !/导出 HTML失败：/.test(b.toast)) notes.push(`frozen did not fail as 0.2.0 does (${b.toast})`);
    if (a.file === null) { res(false, `throw:${name}`, `tree export failed: ${a.toast}${notes.length ? '; ' + notes.join('; ') : ''}`); continue; }
    const body = bodyOf(a.file);
    const boxes = body.match(ERR_RE) ?? [];
    const expectBoxes = boxesWanted ?? (text.match(/<\?form/gi) ?? []).length;
    if (boxes.length !== expectBoxes) notes.push(`${boxes.length} error boxes, expected ${expectBoxes}`);
    for (const bx of boxes) if (!/渲染此段落时出错：/.test(bx) || !/&lt;\?form/i.test(bx)) notes.push(`box without notice or text: ${bx}`);
    const outside = body.replace(ERR_RE, '');
    if (/<\?|<script|\son[a-z]+=|javascript:/i.test(outside)) notes.push(`unsafe outside the boxes: ${outside.slice(0, 200)}`);
    if (a.toast) notes.push(`toast: ${a.toast}`);
    // outside the boxes: exactly the frozen export of the renamed document, its renamed blocks cut out the same way
    if (renamed.file === null) notes.push('renamed document did not export on the frozen copy');
    else {
      const rb = bodyOf(renamed.file);
      const parts = body.split(ERR_RE);
      let at = 0, ok = true;
      for (let k = 0; k < parts.length; k++) {
        const i = rb.indexOf(parts[k], at);
        if (i < 0 || (k === 0 && i !== 0)) { ok = false; break; }
        at = i + parts[k].length;
      }
      if (!ok || (parts.length && at !== rb.length)) notes.push(`blocks outside the boxes differ from the frozen export:\n   tree   ${JSON.stringify(body)}\n   frozen ${JSON.stringify(rb)}`);
      if (a.file.slice(0, a.file.indexOf('<article')) !== renamed.file.slice(0, renamed.file.indexOf('<article'))) notes.push('head differs from the frozen export');
    }
    res(notes.length === 0, `throw:${name}`, notes.length ? notes.join('; ') + `\n   body ${JSON.stringify(body.slice(0, 400))}` : `exported, ${boxes.length} box(es); frozen: ${b.toast}; sample ${JSON.stringify(boxes[0])}`);
  }
  console.log(`page errors: tree ${tree.errs.length} frozen ${frozen.errs.length} ${[...tree.errs, ...frozen.errs].slice(0, 2).join(' | ')}`);
  console.log(`${fails} failing`);
  process.exitCode = fails ? 1 : 0;
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  process.exitCode = 2;
} finally {
  clearTimeout(killer);
  try { await browser?.close(); } catch { /* */ }
}
