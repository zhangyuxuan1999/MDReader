// bench/electron/v2-shell-doclink.mjs — verify-shell (0.2.0 stage 2a): can a DOCUMENT navigate the
// app window away (K1 says "not reachable from the UI")? A Markdown file with an SVG <a> / an image-map
// <area> whose href is protocol-relative (//mdreader/…, which DOMPurify keeps and which resolves to
// app://mdreader/…) is opened; a plain click on the link in the preview is made; then we check:
// the window URL, whether a later open-file is shown, and whether a dirty window can still be closed
// and the app quit.
//   MDR_TARGET=staging|baseline MDR_V2_TMP=<dir> node bench/electron/v2-shell-doclink.mjs [case ...]
// Cases: svg404 svgApp area404 html404
import * as L from './v2-shell-lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const { sleep, check } = L;
L.watchdog(Number(process.env.MDR_TIMEOUT_MS || 200000), 'doclink');

const BODIES = {
  svg404: '<svg width="260" height="40"><a href="//mdreader/nonexistent.md"><text x="5" y="25" font-size="20">V2-CLICK-ME</text></a></svg>',
  svgApp: '<svg width="260" height="40"><a href="//mdreader/index.html"><text x="5" y="25" font-size="20">V2-CLICK-ME</text></a></svg>',
  area404: '<img alt="V2-CLICK-ME" width="200" height="60" usemap="#m" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="><map name="m"><area shape="rect" coords="0,0,200,60" href="//mdreader/nonexistent.md" alt="V2-CLICK-ME"></map>',
  html404: '<a href="//mdreader/nonexistent.md">V2-CLICK-ME</a>',
};

async function run(name) {
  const ctx = await L.launch(`doclink-${name}`);
  const { app } = ctx;
  try {
    const page = await L.firstReady(app);
    if (process.env.MDR_PREVIEW_EDIT === '1') { await L.menuClick(app, 'view.togglePreviewEdit'); await sleep(400); } // 0.2.0 only: in-preview editing on
    const file = path.join(L.TMP, `v2-doclink-${name}.md`);
    fs.writeFileSync(file, `# 标题 doclink\n\n正文 marker-doclink\n\n${BODIES[name]}\n\n结尾段落\n`, 'utf8');
    await L.emitOpen(app, file);
    await L.waitMain(app, (s) => (s.title || '').includes('doclink'), 8000);
    await sleep(800);
    const html = await L.execMain(app, "(document.querySelector('.mdr-preview__body')?.innerHTML || '').match(/<svg[\\s\\S]*?<\\/svg>|<map[\\s\\S]*?<\\/map>|<a [^>]*V2[^<]*<\\/a>|<a [^>]*>V2-CLICK-ME<\\/a>/)?.[0] || ''");
    // make the document dirty first (unsaved work), in the editor
    await L.makeDirty(app, 'UNSAVED-WORK');
    await sleep(Number(process.env.MDR_DIRTY_WAIT || 0)); // e.g. 4000: let the renderer store its draft first
    const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL());
    // a plain click on the link in the preview
    let clicked = false;
    // fix-shell (stage 2b) harness repair: when the shell cancels the navigation, Playwright's click
    // waits for a navigation that never comes and times out although the click WAS delivered (same on
    // baseline for an https link). Count the clicks the page saw, from the main process.
    await L.execMain(app, "(() => { window.__v2DocClicks = 0; document.addEventListener('click', () => { window.__v2DocClicks++; }, true); return 1; })()");
    try {
      const sel = name === 'area404' ? '.mdr-preview__body img[usemap]' : (name === 'html404' ? '.mdr-preview__body a' : '.mdr-preview__body svg text');
      const el = page.locator(sel).first();
      await el.scrollIntoViewIfNeeded({ timeout: 3000 });
      await el.click({ timeout: 4000 });
      clicked = true;
    } catch (e) {
      console.log(`  click failed: ${String(e && e.message).split('\n')[0]}`);
    }
    await sleep(2000);
    const pageClicks = await L.execMain(app, 'window.__v2DocClicks');
    if (!clicked && pageClicks > 0) { console.log(`  the page saw ${pageClicks} click(s): delivered`); clicked = true; }
    const st = await app.evaluate(({ BrowserWindow }) => {
      const ws = BrowserWindow.getAllWindows();
      return { windows: ws.length, url: ws[0]?.webContents.getURL(), title: ws[0]?.getTitle() };
    });
    const kept = await L.mainSnap(app);
    const stillThere = (kept.title || '').includes('doclink') && (kept.editor || '').includes('UNSAVED-WORK');
    const navigated = st.url !== before || !stillThere;
    console.log(`  ${name}: sanitized=${JSON.stringify(html).slice(0, 220)} clicked=${clicked} before=${before} after=${JSON.stringify(st)}`);
    if (name === 'svgApp') {
      // the reloaded page lost the window's document: is the unsaved text at least offered back when
      // the same file is opened again?
      await sleep(1500);
      await L.emitOpen(app, file);
      await sleep(2500);
      const back = await L.execMain(app, "({ title: document.title, offer: document.body.innerText.includes('发现未保存的草稿'), hasEdit: (document.querySelector('.cm-content')?.textContent || '').includes('UNSAVED-WORK') })");
      console.log(`  svgApp: same file opened again → ${JSON.stringify(back)}`);
    }
    // a double-clicked document afterwards
    const d = L.makeDoc(`doclink-after-${name}`);
    await L.emitOpen(app, d.file);
    const g = await L.waitMain(app, (x) => (x.buttons || []).includes('丢弃'), 3000);
    if (g.ok) await L.clickBtn(app, '丢弃');
    const m = await L.mainShows(app, d, 6000);
    // can the user still close the window (the document was dirty) and quit?
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await sleep(1500);
    const q = await L.mainSnap(app);
    if ((q.buttons || []).includes('不保存')) { await L.clickBtn(app, '不保存'); await sleep(1000); }
    const afterClose = await L.mainSnap(app);
    const exited = new Promise((res) => app.process().once('exit', (code) => res({ code })));
    await app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 10); }).catch(() => {});
    const ex = await Promise.race([exited, sleep(5000).then(() => null)]);
    check(`[doclink] ${name}: a plain click on a document link leaves the app page in place; later doc shown; window closable; app quits`,
      clicked && !navigated && m.ok && !!ex,
      `clicked=${clicked} navigated=${navigated} url=${st.url} editsStillShown=${stillThere} (${L.describe(kept)}) laterDocShown=${m.ok} (${L.describe(m.s)}) afterClose=${L.describe(afterClose)} quitExit=${JSON.stringify(ex)}`);
  } finally {
    await L.hardQuit(ctx);
  }
}

const pick = process.argv.slice(2);
const list = pick.length ? pick : Object.keys(BODIES);
console.log(`target: ${L.TARGET} ${L.APP_DIR}`);
try {
  for (const n of list) {
    try { await run(n); } catch (e) { check(`[doclink] ${n} threw`, false, String(e && e.stack || e).slice(0, 300)); }
  }
} finally {
  await L.cleanup();
}
process.exit(L.summary() ? 1 : 0);
