import { chromium } from '@playwright/test';
const b = await chromium.launch(); const ctx = await b.newContext({viewport:{width:1400,height:900}});
const p = await ctx.newPage();
const ce=[],pe=[]; p.on('console',m=>m.type()==='error'&&ce.push(m.text())); p.on('pageerror',e=>pe.push(String(e)));
await p.goto('http://localhost:5202/?doc=/test-data/small.md&mode=preview');
await p.waitForFunction(()=>!!window.__mdr,null,{timeout:90000});
await p.evaluate(()=>window.__mdr.waitIdle());
await p.waitForTimeout(1500);
const r = await p.evaluate(()=>({
  hooks: ['app','loadText','loadUrl','marks','samples','waitIdle','mode','version'].filter(k=>!(k in window.__mdr)),
  mode: window.__mdr.app.layout.getMode(),
  blocks: document.querySelectorAll('.md-block').length,
  mounted: document.querySelectorAll('.md-block:not(.is-pending)').length,
  h: document.querySelectorAll('.mdr-preview__body h1,h2,h3').length,
  toc: document.querySelectorAll('.mdr-toc__item').length,
  marks: window.__mdr.marks().map(m=>m.name),
  title: document.title,
}));
console.log(JSON.stringify(r,null,1));
console.log('consoleErrors', JSON.stringify(ce.filter(e=>!/404|Failed to load resource/.test(e))), 'pageErrors', JSON.stringify(pe));
await b.close();
