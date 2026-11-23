// bench/verify/r7-fs-table.mjs — fix-save (round 7, rule R7 = N11) in headless Chromium, switch OFF: the table of
// test/r7-fs-web*.test.ts with the real app, the real worker, real OPFS files and IndexedDB drafts.
// Kinds of replacement (打开… another file / the same file, a recent entry: another / the same, 新建, a file drop)
// x the moment of the request (0, 50, 500 ms into a save slowed to 1.5 s; "bound": the wait shortened to 300 ms so it
// runs out during the save) x the save's outcome (writes, fails, never settles: the wait is then shortened to 1.2 s)
// x the answer where a question is asked (取消 / 丢弃). Invariants per row:
//   I1 the text typed before the save is on disk or in a draft (except an informed 丢弃: the question came after the
//      failure was reported, R2);  I2 no draft holding it after a save that wrote;  I3 a document shown clean holds what
//      its file holds;  I4 no question left; with the wait on and a save that wrote, no question at all.
// Candidate only: the tree's Vite dev server (the wait is shortened through the dev module /src/app/App.ts).
//   MDR_PORT=5461 MDR_TMP=<scratch> node bench/verify/r7-fs-table.mjs [case|prefix* ...] [--list]
// Global timeout 115 s: run it by prefix (e.g. "open-0-*").
import { sleep, runCases, snap, clickBtn, opfsWrite, opfsRead, pickerReturns, openOpfs, slowWrites, allDrafts, typeEnd } from './v5-offa-lib.mjs';

process.env.MDR_ONLY = 'cand';
const SLOW = 1500;
// the app's own instance of the module: after a hot update Vite imports it as /src/app/App.ts?t=…
const setWait = (page, ms) => page.evaluate(async (v) => {
  const u = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/src\/app\/App\.ts(\?|$)/.test(n)) || '/src/app/App.ts';
  const m = await import(u);
  m.SAVE_WAIT.ms = v;
  m.SAVE_WAIT.gestureMs = Math.min(v, 4000);
  return u;
}, ms);
const dialogUp = (page) => page.evaluate(() => !!document.querySelector('.mdr-dialog'));
async function untilDialog(page, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await dialogUp(page)) return true; await sleep(40); }
  return false;
}
const savePending = (page) => page.evaluate(() => !!window.__r7Pending);
/** slowWrites plus a flag the page keeps while a slowed close is pending (a write in flight). */
async function slow(page, ms, mode) {
  await slowWrites(page, ms, mode);
  await page.evaluate(() => {
    const P = FileSystemFileHandle.prototype;
    const cw = P.createWritable;
    P.createWritable = async function (...a) {
      const w = await cw.apply(this, a);
      const close = w.close.bind(w);
      w.close = async () => { window.__r7Pending = (window.__r7Pending || 0) + 1; try { return await close(); } finally { window.__r7Pending--; } };
      return w;
    };
  });
}
async function drop(page, name) {
  // a real OPFS file cannot be dropped through CDP; write it to disk? No: drop by synthesising the drop event with
  // the OPFS file's File object, as the browser hands it over (read at once, no handle).
  await page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory();
    const f = await (await root.getFileHandle(n)).getFile();
    const dt = new DataTransfer();
    dt.items.add(new File([await f.text()], n, { type: 'text/markdown' }));
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    document.querySelector('.cm-content').dispatchEvent(ev);
  }, name);
}
async function recent(page, name) {
  await page.click('.mdr-toolbar__file');
  await sleep(150);
  await page.evaluate((n) => { const li = [...document.querySelectorAll('.mdr-recent li')].find((e) => e.textContent === n); if (li) li.click(); }, name);
}
const requests = {
  open: async (page) => { await pickerReturns(page, 'o.md'); await page.evaluate(() => { void window.__mdr.app.registry.run('file.open'); }); },
  'open-same': async (page) => { await pickerReturns(page, 's.md'); await page.evaluate(() => { void window.__mdr.app.registry.run('file.open'); }); },
  recent: (page) => recent(page, 'o.md'),
  'recent-same': (page) => recent(page, 's.md'),
  new: (page) => page.evaluate(() => { void window.__mdr.app.registry.run('file.new'); }),
  drop: (page) => drop(page, 'o.md'),
};

const C = {};
const J = {};
for (const kind of Object.keys(requests)) {
  for (const moment of [0, 50, 500, 'bound']) {
    for (const outcome of ['ok', 'fail', 'never']) {
      const asks = !(typeof moment === 'number' && outcome === 'ok');
      for (const ans of asks ? ['取消', '丢弃'] : ['-']) {
        const name = `${kind}-${moment}-${outcome}-${ans}`;
        C[name] = async (page) => {
          // o.md first, then s.md: both are in the recent list
          await openOpfs(page, 'o.md', '# O\n');
          await openOpfs(page, 's.md', '# S\n');
          const wait = moment === 'bound' ? 300 : outcome === 'never' ? 1200 : 10_000;
          await setWait(page, wait);
          await slow(page, outcome === 'never' ? 600_000 : SLOW, outcome === 'fail' ? 'fail' : 'ok');
          await typeEnd(page, 'typed');
          await page.keyboard.press('Meta+s');
          if (typeof moment === 'number') await sleep(moment);
          else await sleep(20);
          await requests[kind](page);
          const o = { asked: false, whileSaving: null, reportedFirst: null, early: false };
          if (typeof moment === 'number' && outcome !== 'never') {
            await sleep(150);
            o.early = await dialogUp(page);
          }
          const limit = typeof moment === 'number' && outcome !== 'never' ? SLOW + 1500 : wait + 1500;
          if (await untilDialog(page, limit)) {
            o.asked = true;
            o.whileSaving = await savePending(page);
            o.reportedFirst = (await page.evaluate(() => (window.__toasts || []).slice())).some((t) => /保存失败/.test(t));
            if (ans !== '-') await clickBtn(page, ans);
          }
          // the save settles (or not), the replacement runs, the worker's draft debounce passes
          await sleep(outcome === 'never' ? 1500 : SLOW + 1300);
          await page.evaluate(() => { window.__slow = false; });
          const s = await snap(page);
          const drafts = (await allDrafts(page)).filter((x) => x.k.startsWith('mdr.draft')).map((x) => x.text);
          const title = s.title;
          const shown = title.replace(/^● /, '');
          return { ...o, title, text: s.text, dialogs: s.dialogs, disk: await opfsRead(page, 's.md'), shownDisk: /\.md$/.test(shown) ? await opfsRead(page, shown) : null, drafts };
        };
        J[name] = (c) => {
          if (!c || c.error) return 'error ' + (c && c.error);
          const p = [];
          const informed = ans === '丢弃' && c.asked && !c.whileSaving && outcome === 'fail';
          const somewhere = /typed/.test(c.disk ?? '') || c.drafts.some((t) => /typed/.test(t ?? '')) || (c.title === '● s.md' && /typed/.test(c.text));
          if (!informed && !somewhere) p.push('I1 typed nowhere');
          if (informed && !c.reportedFirst) p.push('failure not reported before the question');
          if (outcome === 'ok' && c.drafts.some((t) => /typed/.test(t ?? '')) && !c.title.startsWith('●')) p.push('I2 draft left after the save wrote');
          if (!c.title.startsWith('●') && c.shownDisk !== null && c.text !== c.shownDisk) p.push(`I3 shown as saved: ${JSON.stringify(c.text)} vs disk ${JSON.stringify(c.shownDisk)}`);
          if (c.dialogs.length) p.push('I4 question left');
          if (typeof moment === 'number' && outcome === 'ok') {
            if (c.asked || c.early) p.push('I4 asked although the save wrote');
            const want = kind === 'new' ? '' : kind === 'open' || kind === 'recent' || kind === 'drop' ? '# O\n' : '# S\ntyped';
            if (c.text !== want) p.push(`replacement shows ${JSON.stringify(c.text)}, want ${JSON.stringify(want)}`);
          }
          if (typeof moment === 'number' && outcome === 'fail' && (c.early || !c.asked || c.whileSaving || !c.reportedFirst)) p.push(`fail: early=${c.early} asked=${c.asked} whileSaving=${c.whileSaving} reported=${c.reportedFirst}`);
          return p.length ? p.join('; ') : null;
        };
      }
    }
  }
}
const bad = await runCases(C, { judge: J, timeoutMs: 115_000 });
process.exit(bad ? 1 : 0);
