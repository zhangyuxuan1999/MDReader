// bench/electron/v3-shell-vectors.mjs — verify-shell (0.2.0 stage 2c), step 1: navigation vectors a
// DOCUMENT can carry, activated with real input (plain / Cmd / Shift / Alt / middle click, Enter on the
// focused link), with in-preview editing off and on; then injected page script as defence in depth.
// Main-process counters per action: did-start-navigation (main), will-navigate, will-frame-navigate,
// did-navigate, did-frame-navigate, did-create-window, will-download, shell.openExternal (stubbed: never
// opens a real browser). After every action: the window URL must still be the app page, the bridge
// present; at the end a probe document must be shown exactly once.
//   MDR_TARGET=staging|baseline MDR_V2_TMP=<scratch> node bench/electron/v3-shell-vectors.mjs [doc|script|all]
import * as L from './v2-shell-lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const { sleep, check } = L;
L.watchdog(Number(process.env.MDR_TIMEOUT_MS || 400000), 'v3-vectors');
const MODE = process.argv[2] || 'all';
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
const NX = 'app://mdreader/nonexistent.md';

// id -> html (each in its own paragraph); the clickable element carries the id (or for area: the img).
const VECTORS = [
  ['svg-href', `<svg width="120" height="24"><a id="svg-href" href="${NX}"><rect width="120" height="24" fill="#c33"/></a></svg>`],
  ['svg-xlink', `<svg width="120" height="24"><a id="svg-xlink" xlink:href="${NX}"><rect width="120" height="24" fill="#3c3"/></a></svg>`],
  ['svg-proto', '<svg width="120" height="24"><a id="svg-proto" href="//mdreader/index.html"><rect width="120" height="24" fill="#33c"/></a></svg>'],
  ['svg-set', `<svg width="120" height="24"><a id="svg-set" href="#v3-anchor"><set attributeName="href" to="${NX}" begin="0s"/><animate attributeName="href" values="${NX}" dur="1s" fill="freeze"/><rect width="120" height="24" fill="#cc3"/></a></svg>`],
  ['svg-https', '<svg width="120" height="24"><a id="svg-https" href="https://example.com/v3-svg"><rect width="120" height="24" fill="#3cc"/></a></svg>'],
  ['svg-fo', `<svg width="120" height="24"><foreignObject width="120" height="24"><a id="svg-fo" href="${NX}">FO-LINK</a></foreignObject></svg>`],
  ['math-href', `<math><mrow id="math-href" href="${NX}"><mi>x</mi><mo>+</mo><mi>y</mi></mrow></math>`],
  ['area', `<img id="area" width="120" height="24" usemap="#v3map" src="${GIF}"><map name="v3map"><area shape="rect" coords="0,0,120,24" href="${NX}"></map>`],
  ['t-top', `<a id="t-top" href="${NX}" target="_top">T-TOP</a>`],
  ['t-parent', `<a id="t-parent" href="${NX}" target="_parent">T-PARENT</a>`],
  ['t-named', `<a id="t-named" href="${NX}" target="v3frame">T-NAMED</a>`],
  ['t-self', '<a id="t-self" href="app://mdreader/index.html" target="_self">T-SELF</a>'],
  ['t-blank-app', `<a id="t-blank-app" href="${NX}" target="_blank">T-BLANK-APP</a>`],
  ['blank-https', '<a id="blank-https" href="https://example.com/v3-blank" target="_blank">BLANK-HTTPS</a>'],
  ['raw-https', '<a id="raw-https" href="https://example.com/v3-raw">RAW-HTTPS</a>'],
  ['proto-rel', '<a id="proto-rel" href="//mdreader/nonexistent.md">PROTO-REL</a>'],
  ['upper', '<a id="upper" href="APP://MDREADER/index.html">UPPER</a>'],
  ['ws-scheme', '<a id="ws-scheme" href=" app://mdreader/index.html ">WS-SCHEME</a>'],
  ['ent-scheme', '<a id="ent-scheme" href="app&#58;//mdreader/index.html">ENT-SCHEME</a>'],
  ['file', '<a id="file" href="file:///etc/hosts">FILE</a>'],
  ['blank-file', '<a id="blank-file" href="file:///etc/hosts" target="_blank">BLANK-FILE</a>'],
  ['mailto', '<a id="mailto" href="mailto:v3@example.com">MAILTO</a>'],
  ['blank-mailto', '<a id="blank-mailto" href="mailto:v3b@example.com" target="_blank">BLANK-MAILTO</a>'],
  ['download', '<a id="download" href="app://mdreader/index.html" download="v3.html">DOWNLOAD</a>'],
  ['dl-https', '<a id="dl-https" href="https://example.com/v3-dl" download target="_blank">DL-HTTPS</a>'],
  ['img-in-a', `<a href="${NX}"><img id="img-in-a" width="120" height="24" src="${GIF}"></a>`],
  ['relative', '<a id="relative" href="other.md">RELATIVE</a>'],
  ['js', '<a id="js" href="javascript:location.href=\'app://mdreader/nonexistent.md\'">JS</a>'],
  ['data', '<a id="data" href="data:text/html,hi">DATA</a>'],
  ['md-link', `[MD-LINK](${NX})`],
  ['md-proto', '[MD-PROTO](//mdreader/nonexistent.md)'],
  ['nested', `<a href="https://example.com/v3-outer" target="_blank"><svg width="120" height="24"><a id="nested" href="${NX}"><rect width="120" height="24" fill="#c3c"/></a></svg></a>`],
];
// elements that must not survive the sanitizer
const STATIC = [
  `<meta http-equiv="refresh" content="1;url=${NX}">`,
  '<base href="app://mdreader/v3base/">',
  `<form action="${NX}"><input id="v3-submit" type="submit" value="GO"><input type="image" src="${GIF}"></form>`,
  `<button formaction="${NX}">BTN</button>`,
  `<iframe name="v3frame" src="${NX}"></iframe>`,
  `<iframe srcdoc="<a target=_top href=${NX}>x</a>"></iframe>`,
  `<object data="${NX}"></object>`,
  `<embed src="${NX}">`,
  `<link rel="prefetch" href="${NX}">`,
  `<portal src="${NX}"></portal>`,
  `<frameset><frame src="${NX}"></frameset>`,
];

function docText() {
  const parts = ['# 标题 v3vec', '', '正文 marker-v3vec', '', '<h2 id="v3-anchor">anchor</h2>', ''];
  for (const [id, html] of VECTORS) parts.push(`段落 ${id}: ${html} 尾`, '');
  parts.push(...STATIC.flatMap((s) => [s, '']), '结尾段落', '');
  return parts.join('\n');
}

const instrument = (app) => app.evaluate(({ BrowserWindow, shell, session, app: a }) => {
  globalThis.__v3 = { ev: [], ext: [], dl: [] };
  shell.openExternal = async (u) => { globalThis.__v3.ext.push(String(u)); };
  session.defaultSession.on('will-download', (e, item) => { globalThis.__v3.dl.push(item.getURL()); e.preventDefault(); });
  const hook = (w) => {
    const wc = w.webContents;
    if (wc.__v3) return;
    wc.__v3 = true;
    const log = (s) => globalThis.__v3.ev.push(s);
    wc.on('did-start-navigation', (d) => { if (d && d.isMainFrame && !d.isSameDocument) log(`start ${d.url}`); else if (d && d.isMainFrame) log(`samedoc ${d.url}`); else log(`substart ${d && d.url}`); });
    wc.on('will-navigate', (e, url) => { setImmediate(() => log(`will-navigate ${url}${e.defaultPrevented ? ' PREVENTED' : ' ALLOWED'}`)); });
    wc.on('will-frame-navigate', (d) => { if (d && !d.isMainFrame) log(`will-frame-navigate ${d.url}`); });
    wc.on('did-navigate', (_e, url) => log(`did-navigate ${url}`));
    wc.on('did-frame-navigate', (_e, url, _c, _t, main) => { if (!main) log(`did-frame-navigate ${url}`); });
    wc.on('did-create-window', (_w, d) => log(`did-create-window ${d && d.url}`));
  };
  for (const w of BrowserWindow.getAllWindows()) hook(w);
  a.on('browser-window-created', (_e, w) => hook(w));
});
const takeLog = (app) => app.evaluate(({ BrowserWindow }) => {
  const r = { ...globalThis.__v3, url: BrowserWindow.getAllWindows()[0]?.webContents.getURL(), windows: BrowserWindow.getAllWindows().length };
  globalThis.__v3 = { ev: [], ext: [], dl: [] };
  return r;
});

const APP_URL_RE = /^app:\/\/mdreader\/index\.html$|^http:\/\/localhost:\d+\/(\?perf=1)?$/;

async function boxOf(page, id) {
  return page.evaluate((i) => {
    const e = document.getElementById(i);
    if (!e) return null;
    let r = e.getBoundingClientRect();
    let scrolled = false;
    if (r.top < 80 || r.bottom > innerHeight - 80) { e.scrollIntoView({ block: 'center' }); r = e.getBoundingClientRect(); scrolled = true; }
    return { scrolled, x: r.left + Math.min(r.width / 2, 20), y: r.top + r.height / 2, w: r.width, h: r.height, tag: e.localName, href: e.getAttribute('href') ?? e.getAttributeNS('http://www.w3.org/1999/xlink', 'href') };
  }, id);
}

let ctx = null;
let page = null;
async function fresh(label) {
  if (ctx) await L.hardQuit(ctx);
  ctx = await L.launch(label);
  page = await L.firstReady(ctx.app);
  await instrument(ctx.app);
  return ctx;
}
async function openVectorDoc() {
  const file = path.join(L.TMP, 'v3-vectors.md');
  fs.writeFileSync(file, docText(), 'utf8');
  await L.emitOpen(ctx.app, file);
  await L.waitMain(ctx.app, (s) => (s.title || '').includes('v3-vectors'), 10000);
  await sleep(1200);
  await takeLog(ctx.app);
}

/** Is in-preview editing on? Click a plain paragraph and look for a contenteditable block. */
async function editingState() {
  const b = await page.evaluate(() => {
    const p = [...document.querySelectorAll('.mdr-preview__body p')].find((x) => x.textContent.includes('marker-v3vec'));
    if (!p) return null;
    p.scrollIntoView({ block: 'center' });
    const r = p.getBoundingClientRect();
    return { x: r.left + 10, y: r.top + r.height / 2 };
  });
  if (!b) return null;
  await sleep(700);
  await page.mouse.click(b.x, b.y);
  await sleep(300);
  const on = await page.evaluate(() => !!document.querySelector('.mdr-preview__body [contenteditable="true"]'));
  await page.keyboard.press('Escape');
  await sleep(300);
  return on;
}

async function withKey(k, fn) { await page.keyboard.down(k); try { await fn(); } finally { await page.keyboard.up(k); } }
const ACTIONS = {
  click: async (b) => page.mouse.click(b.x, b.y),
  cmd: async (b) => withKey('Meta', () => page.mouse.click(b.x, b.y)),
  shift: async (b) => withKey('Shift', () => page.mouse.click(b.x, b.y)),
  alt: async (b) => withKey('Alt', () => page.mouse.click(b.x, b.y)),
  middle: async (b) => page.mouse.click(b.x, b.y, { button: 'middle' }),
  enter: async (_b, id) => { await page.evaluate((i) => { const e = document.getElementById(i); e?.focus(); }, id); await page.keyboard.press('Enter'); },
};

async function attackDoc(editLabel) {
  const bad = [];
  let ext = 0;
  for (const [id] of VECTORS) {
    for (const [an, act] of Object.entries(ACTIONS)) {
      const b = await boxOf(page, id);
      if (!b) { if (an === 'click') console.log(`  (${id}: not in DOM after sanitize)`); break; }
      if (an === 'click' && b.w === 0) console.log(`  (${id}: zero size)`);
      let b2 = b;
      if (b.scrolled) { await sleep(700); b2 = await boxOf(page, id); } // the navigation anchor of scrollIntoView
      await act(b2, id);
      await sleep(450);
      await page.keyboard.press('Escape').catch(() => {});
      const r = await takeLog(ctx.app);
      const nav = r.ev.filter((e) => /^start |^did-navigate|ALLOWED|did-frame-navigate|did-create-window/.test(e));
      ext += r.ext.length;
      const urlOk = APP_URL_RE.test(r.url || '');
      const extBad = r.ext.filter((u) => !/^https?:\/\//.test(u));
      const line = `${editLabel} ${id}/${an} [${b2?.tag} ${b2?.href}] ev=${JSON.stringify(r.ev)} ext=${JSON.stringify(r.ext)} dl=${JSON.stringify(r.dl)} url=${r.url}`;
      if (!urlOk || nav.some((e) => /did-navigate|ALLOWED|did-create-window/.test(e)) || r.dl.length || extBad.length || r.windows !== 1) {
        bad.push(line);
        console.log(`  BAD ${line}`);
        if (!urlOk) { await fresh(`relaunch-${id}`); await openVectorDoc(); if (editLabel === 'edit-off') await setEdit(false); }
      } else if (process.env.V3_VERBOSE) console.log(`  ok ${line}`);
      else if (r.ext.length || r.ev.length) console.log(`  · ${id}/${an}: ev=${r.ev.length ? JSON.stringify(r.ev) : '-'} ext=${JSON.stringify(r.ext)}`);
    }
  }
  check(`[doc ${editLabel}] no vector navigates, creates a window, downloads, or opens a non-http URL`, bad.length === 0, `${bad.length} bad; external opens=${ext}`);
}

async function setEdit(want) {
  const cur = await editingState();
  if (cur !== want) { await L.menuClick(ctx.app, 'view.togglePreviewEdit'); await sleep(500); }
  return editingState();
}

async function staticSurvivors() {
  return page.evaluate(() => [...document.querySelectorAll('.mdr-preview__body :is(meta,base,form,button,iframe,object,embed,link,portal,frame,frameset,input:not([type=checkbox]),set,animate)')].map((e) => e.outerHTML.slice(0, 120)));
}

async function probe(label) {
  const d = L.makeDoc(`probe-${label}`);
  await L.emitOpen(ctx.app, d.file);
  const m = await L.mainShows(ctx.app, d, 10000);
  await sleep(300);
  const n = (await L.openSends(ctx.app, d.file)).length;
  check(`[${label}] probe document shown once afterwards`, m.ok && n === 1, `${L.describe(m.s)} sends=${n}`);
}

// ---- page-script vectors (defence in depth): what reaches the main process, and what the window shows
const SCRIPT = [
  ['location.href app 404', `location.href = '${NX}'`],
  ['location.assign app', "location.assign('app://mdreader/index.html?v3=1')"],
  ['location.replace app', "location.replace('app://mdreader/index.html?v3=2')"],
  ['location.reload', 'location.reload()'],
  ['location.href about:blank', "location.href = 'about:blank'"],
  ['location.href about:srcdoc', "location.href = 'about:srcdoc'"],
  ['location.href data:', "location.href = 'data:text/html,<h1>v3</h1>'"],
  ['location.href blob:', "location.href = URL.createObjectURL(new Blob(['<h1>v3 blob</h1>'], { type: 'text/html' }))"],
  ['location.href file:', "location.href = 'file:///etc/hosts'"],
  ['location.href javascript:', "location.href = 'javascript:void(document.title=\"JS-RAN\")'"],
  ['location.href https', "location.href = 'https://example.com/v3-loc'"],
  ['location.href mailto', "location.href = 'mailto:v3loc@example.com'"],
  ['history.pushState + reload', "history.pushState({}, '', '/v3-pushed'); location.reload()"],
  ['history.pushState + back', "history.pushState({}, '', '/v3-pushed2'); history.back()"],
  ['history.go(0)', 'history.go(0)'],
  ['meta refresh', `(() => { const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=${NX}'; document.head.appendChild(m); })()`],
  ['base + link click', `(() => { const b = document.createElement('base'); b.href = 'app://mdreader/v3/'; document.head.appendChild(b); const a = document.createElement('a'); a.href = 'x.md'; document.body.appendChild(a); a.click(); a.remove(); b.remove(); })()`],
  ['form submit', `(() => { const f = document.createElement('form'); f.action = '${NX}'; document.body.appendChild(f); f.submit(); f.remove(); })()`],
  ['form requestSubmit', `(() => { const f = document.createElement('form'); f.action = '${NX}'; f.method = 'post'; document.body.appendChild(f); f.requestSubmit(); f.remove(); })()`],
  ['iframe src', `(() => { const f = document.createElement('iframe'); f.src = '${NX}'; document.body.appendChild(f); setTimeout(() => f.remove(), 800); })()`],
  ['iframe srcdoc top link', `(() => { const f = document.createElement('iframe'); f.srcdoc = '<a id=x target=_top href=${NX}>x</a><script>document.getElementById("x").click()<\\/script>'; document.body.appendChild(f); f.onload = () => { try { f.contentDocument.getElementById('x').click(); } catch {} setTimeout(() => f.remove(), 500); }; })()`],
  ['iframe about:blank top nav', `(() => { const f = document.createElement('iframe'); document.body.appendChild(f); try { f.contentWindow.top.location.href = '${NX}'; } catch (e) { document.title = 'ERR ' + e.message; } setTimeout(() => f.remove(), 500); })()`],
  ['object data', `(() => { const o = document.createElement('object'); o.data = '${NX}'; document.body.appendChild(o); setTimeout(() => o.remove(), 800); })()`],
  ['embed src', `(() => { const o = document.createElement('embed'); o.src = '${NX}'; document.body.appendChild(o); setTimeout(() => o.remove(), 800); })()`],
  ['window.open app', `window.open('${NX}')`],
  ['window.open about:blank', "(() => { const w = window.open('about:blank'); return String(w); })()"],
  ['window.open _self', `window.open('${NX}', '_self')`],
  ['window.open _top', `window.open('${NX}', '_top')`],
  ['window.open https', "window.open('https://example.com/v3-open')"],
  ['window.open file', "window.open('file:///etc/hosts')"],
  ['window.open mailto', "window.open('mailto:v3open@example.com')"],
  ['a.click target=_top app', `(() => { const a = document.createElement('a'); a.href = '${NX}'; a.target = '_top'; document.body.appendChild(a); a.click(); a.remove(); })()`],
  ['a.click download app', "(() => { const a = document.createElement('a'); a.href = 'app://mdreader/index.html'; a.download = 'v3.html'; document.body.appendChild(a); a.click(); a.remove(); })()"],
  ['a.click download blob', "(() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['x'])); a.download = 'v3.txt'; document.body.appendChild(a); a.click(); a.remove(); })()"],
  ['svg a.dispatch click', `(() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const a = document.createElementNS('http://www.w3.org/2000/svg', 'a'); a.setAttribute('href', '${NX}'); s.appendChild(a); document.body.appendChild(s); a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); s.remove(); })()`],
  ['location.hash', "location.hash = '#v3-hash'"],
  ['window.close', 'window.close()'],
];

async function attackScript() {
  const bad = [];
  for (const [name, js] of SCRIPT) {
    await takeLog(ctx.app);
    await L.execMain(ctx.app, `(() => { try { ${js}; return 'ok'; } catch (e) { return 'threw ' + e.message; } })()`).catch((e) => String(e));
    await sleep(1300);
    const r = await takeLog(ctx.app);
    const urlOk = APP_URL_RE.test((r.url || '').replace(/#.*$/, ''));
    const navd = r.ev.some((e) => /did-navigate|ALLOWED|did-create-window/.test(e));
    const extBad = r.ext.filter((u) => !/^https?:\/\//.test(u));
    const line = `${name}: ev=${JSON.stringify(r.ev)} ext=${JSON.stringify(r.ext)} dl=${JSON.stringify(r.dl)} url=${r.url} windows=${r.windows}`;
    const alive = r.windows === 1 ? await L.execMain(ctx.app, 'typeof window.mdrNative + "|" + !!document.querySelector(".cm-content")').catch(() => 'dead') : 'nowin';
    if (!urlOk || navd || r.dl.length || extBad.length || r.windows !== 1 || alive !== 'object|true') {
      bad.push(`${line} alive=${alive}`);
      console.log(`  BAD ${line} alive=${alive}`);
      await fresh(`relaunch-${name}`);
    } else {
      console.log(`  ok ${line}`);
    }
  }
  check('[script] no page-script vector navigates the window or breaks the app page', bad.length === 0, `${bad.length} bad`);
  await probe('after-script');
}

try {
  console.log(`target: ${L.TARGET} ${L.APP_DIR}`);
  if (MODE === 'doc' || MODE === 'all') {
    await fresh('v3vec-doc');
    await openVectorDoc();
    const surv = await staticSurvivors();
    check('[doc] sanitizer removed meta/base/form/button/iframe/object/embed/link/portal/frame/set/animate', surv.length === 0, JSON.stringify(surv));
    const st0 = await editingState();
    console.log(`  preview editing initially: ${st0}`);
    await setEdit(false);
    await attackDoc('edit-off');
    const on = await setEdit(true);
    console.log(`  preview editing now: ${on}`);
    await attackDoc('edit-on');
    await probe('after-doc');
  }
  if (MODE === 'script' || MODE === 'all') {
    await fresh('v3vec-script');
    await attackScript();
  }
} catch (e) {
  check('threw', false, String(e && e.stack || e).slice(0, 400));
} finally {
  if (ctx) await L.hardQuit(ctx);
  const f = L.summary();
  await L.cleanup();
  process.exit(f ? 1 : 0);
}
