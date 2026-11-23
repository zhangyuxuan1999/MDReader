// bench/verify/v8-vw-probe304.mjs — verify-web (0.2.0 stage 3): why the first request for assets/inlineEdit-*.js in a
// fresh browser context was reported as 304. One page load in a fresh headless context: press 预览可编辑 and print the
// request's full headers (conditional ones only), the response status, its headers of interest, and the CDP view
// (fromDiskCache / fromServiceWorker / status). Run: cd /Users/zyx/LocalDocuments/MDReader && node bench/verify/v8-vw-probe304.mjs [baseUrl]
import { chromium } from '@playwright/test';
const BASE = process.argv[2] ?? 'https://mdreader.cashbook2026.workers.dev';
const CHUNK = /\/assets\/inlineEdit-[^/]*\.js/;
const browser = await chromium.launch({ headless: true });
const kill = setTimeout(() => process.exit(3), 90000);
const out = { cdp: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1300, height: 860 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const ids = new Map();
  cdp.on('Network.requestWillBeSent', (e) => { if (CHUNK.test(e.request.url)) ids.set(e.requestId, { cond: Object.keys(e.request.headers).filter((h) => /^if-/i.test(h)) }); });
  cdp.on('Network.requestWillBeSentExtraInfo', (e) => { if (ids.has(e.requestId)) ids.get(e.requestId).wireCond = Object.keys(e.headers).filter((h) => /^if-/i.test(h)); });
  cdp.on('Network.responseReceived', (e) => { if (CHUNK.test(e.response.url)) out.cdp.push({ status: e.response.status, fromDiskCache: e.response.fromDiskCache, fromSW: e.response.fromServiceWorker, fromPrefetch: e.response.fromPrefetchCache, req: ids.get(e.requestId) }); });
  cdp.on('Network.responseReceivedExtraInfo', (e) => { if (ids.has(e.requestId)) ids.get(e.requestId).wireStatus = e.statusCode; });
  page.on('response', async (r) => {
    if (!CHUNK.test(r.url())) return;
    const rh = await r.request().allHeaders();
    out.playwright = { status: r.status(), reqCond: Object.keys(rh).filter((h) => h.startsWith('if-')), etag: !!r.headers()['etag'], cfCache: r.headers()['cf-cache-status'] ?? null };
  });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForSelector('.cm-content');
  await new Promise((r) => setTimeout(r, 2500));
  await page.click('button[data-cmd="view.togglePreviewEdit"]');
  await new Promise((r) => setTimeout(r, 2500));
  out.sw = await page.evaluate(async () => (navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 'none'));
  await context.close();
} finally { await browser.close(); clearTimeout(kill); }
console.log(JSON.stringify(out, null, 1));
