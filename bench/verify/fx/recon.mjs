import { launch, open, finish } from '../ux/lib.mjs';
const { browser, page, errors } = await launch();
await open(page, '?doc=/test-data/small.md&mode=split');
const info = await page.evaluate(() => ({
  html: document.documentElement.outerHTML.slice(0, 200),
  theme: document.documentElement.dataset.theme,
  appAttrs: (()=>{const a=document.querySelector('.mdr-app'); return a?Object.fromEntries([...a.attributes].map(x=>[x.name,x.value])):null})(),
  toolbar: [...document.querySelectorAll('.mdr-toolbar button')].map(b=>({cmd:b.dataset.cmd, t:b.textContent.trim(), title:b.title, cls:b.className, pressed:b.getAttribute('aria-pressed')})),
  status: [...document.querySelectorAll('.mdr-statusbar__item')].map(e=>({stat:e.dataset.stat, txt:e.textContent, hidden:e.hidden})),
  cmds: window.__mdr.app.registry.list().map(c=>({id:c.id,title:c.title,sc:c.shortcut,scope:c.scope})),
  toc: document.querySelector('.mdr-toc')?.outerHTML.slice(0,400),
  ls: Object.fromEntries(Object.entries(localStorage)),
  title: document.title,
  mdrKeys: Object.keys(window.__mdr),
}));
console.log(JSON.stringify(info, null, 1));
finish('recon', errors);
await browser.close();
