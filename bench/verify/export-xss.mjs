// bench/verify/export-xss.mjs — does script/on* content from the markdown source execute when the exported HTML is opened?
// Run: node bench/verify/export-xss.mjs   (dev server on :5202)
import { openApp, loadAndSettle, harness, sleep } from './lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const H = harness('export-xss');
const app = await openApp();
const { page } = app;
const doc = '# T\n\n<script>document.title = "PWNED-" + document.title</script>\n\n<img src=x onerror="document.body.dataset.pwned = \'1\'">\n\n[js](javascript:document.body.dataset.pwned2=1)\n';
await loadAndSettle(page, doc, 'xss-export.md');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), page.evaluate(() => window.__mdr.app.registry.run('file.exportHtml'))]);
const html = readFileSync(await dl.path(), 'utf8');
const out = process.env.SCRATCH ? process.env.SCRATCH + '/xss-export.html' : '/private/tmp/xss-export.html';
writeFileSync(out, html);
const p2 = await app.context.newPage();
await p2.goto('file://' + out);
await sleep(500);
const r = await p2.evaluate(() => ({ title: document.title, pwned: document.body.dataset.pwned ?? null, hasScript: !!document.querySelector('script'), jsHref: document.querySelector('a[href^="javascript"]')?.getAttribute('href') ?? null }));
console.log('exported file opened via file://:', JSON.stringify(r), 'size', html.length);
if (r.title.startsWith('PWNED-') || r.pwned === '1') H.fail('export: <script>/onerror from the markdown source execute when the exported .html is opened (preview sanitises, export does not)', r);
else H.pass('export: no script execution');
if (r.jsHref) H.fail('export: javascript: link kept in the exported document', r); else H.pass('export: javascript: link neutralised');
await p2.close();
await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
