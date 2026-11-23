// bench/verify/review-xss.mjs — XSS sweep through the LIVE preview (sanitize.ts config + the
// HTML_FLAG_TRUSTED innerHTML path in createPreview.mountItem).
// Run: node bench/verify/review-xss.mjs   (dev server on :5205)
import { openPage, gotoApp, waitIdle, sleep } from './review-lib.mjs';

const VECTORS = [
  ['script tag', '<script>window.__pwn.push("script")</script>'],
  ['img onerror', '<img src=x onerror="window.__pwn.push(\'img-onerror\')">'],
  ['svg onload', '<svg onload="window.__pwn.push(\'svg-onload\')"></svg>'],
  ['body onfocus/autofocus', '<input autofocus onfocus="window.__pwn.push(\'autofocus\')">'],
  ['iframe srcdoc', '<iframe srcdoc="<script>parent.__pwn.push(\'iframe\')<\\/script>"></iframe>'],
  ['a javascript:', '[x](javascript:window.__pwn.push("a-js"))'],
  ['a javascript raw', '<a href="javascript:window.__pwn.push(\'raw-a-js\')" id="rawa">x</a>'],
  ['img src js', '<img src="javascript:window.__pwn.push(\'img-js\')">'],
  ['details ontoggle', '<details open ontoggle="window.__pwn.push(\'ontoggle\')"><summary>s</summary>b</details>'],
  ['style tag', '<style>body{background:red}</style>'],
  ['form/button', '<form action="//evil"><button formaction="//evil">go</button></form>'],
  ['object/embed', '<object data="x"></object><embed src="x">'],
  ['math annotation', '<math><semantics><annotation encoding="application/x-tex"><img src=x onerror="window.__pwn.push(\'mathml\')"></annotation></semantics></math>'],
  ['svg use xlink', '<svg><use href="data:image/svg+xml;base64,PHN2ZyBpZD0ieCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48c2NyaXB0PndpbmRvdy5fX3B3bi5wdXNoKCJ1c2UiKTwvc2NyaXB0Pjwvc3ZnPiN4"/></svg>'],
  ['fence info attr break', '```js" onload="window.__pwn.push(\'fence-info\')\ncode\n```'],
  ['fence info tag break', '```js><img src=x onerror=window.__pwn.push("fence-tag")>\ncode\n```'],
  ['fence lang quote', '```" onmouseover="window.__pwn.push(1)\nx\n```'],
  ['html_block first tag', '<div id="a" onmouseover="window.__pwn.push(\'div\')">hi</div>'],
  ['unknown scheme a', '<a href="data:text/html;base64,PHNjcmlwdD5wYXJlbnQuX19wd24ucHVzaCgiZGF0YSIpPC9zY3JpcHQ+">d</a>'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=//evil">'],
  ['base href', '<base href="//evil/">'],
];

const page0 = await openPage();
const { browser, page, errors } = page0;
await gotoApp(page, 'mode=preview');
await page.evaluate(() => { window.__pwn = []; });
page.on('dialog', (d) => { window.__dialog = true; d.dismiss(); });

const findings = [];
for (const [name, src] of VECTORS) {
  await page.evaluate(async (s) => {
    window.__pwn = [];
    await window.__mdr.loadText('# t\n\n' + s + '\n', 'xss.md');
  }, src);
  await waitIdle(page).catch(() => {});
  await sleep(250);
  const r = await page.evaluate(() => ({
    pwn: window.__pwn.slice(),
    html: document.querySelector('.mdr-preview__body')?.innerHTML.slice(0, 600) ?? '',
    scripts: document.querySelectorAll('.mdr-preview script, .mdr-preview iframe, .mdr-preview object, .mdr-preview embed, .mdr-preview style, .mdr-preview form, .mdr-preview base, .mdr-preview meta').length,
    jsHrefs: Array.from(document.querySelectorAll('.mdr-preview [href], .mdr-preview [src]'))
      .map((e) => e.getAttribute('href') || e.getAttribute('src'))
      .filter((h) => h && /^\s*(javascript|data:text\/html|vbscript)/i.test(h)),
    onattrs: Array.from(document.querySelectorAll('.mdr-preview *'))
      .flatMap((e) => Array.from(e.attributes).map((a) => a.name))
      .filter((n) => n.startsWith('on')),
  }));
  const bad = r.pwn.length || r.scripts || r.jsHrefs.length || r.onattrs.length;
  console.log(`${bad ? 'FAIL' : 'ok  '} ${name.padEnd(26)} pwn=${JSON.stringify(r.pwn)} dangerTags=${r.scripts} jsUrls=${JSON.stringify(r.jsHrefs)} on*=${JSON.stringify(r.onattrs)}`);
  if (bad) findings.push({ name, src, ...r });
}

console.log('\nconsole/page errors:', errors.slice(0, 10));
console.log('__RESULT__' + JSON.stringify({ findings }));
await browser.close();
