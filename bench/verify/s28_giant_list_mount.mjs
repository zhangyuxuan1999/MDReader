// s28 — isolate the "big list block never mounts" symptom from s27(E): how long does a single
// List block of N loose task items stay .is-pending after the worker goes idle?
// Run: node bench/verify/s28_giant_list_mount.mjs
import { launch, open, settle, structureCheck, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();

async function probe(label, gen) {
  await page.evaluate(async (src) => { await window.__mdr.loadText(new Function('return (' + src + ')')()(), 'probe.md'); }, gen.toString());
  const s = await settle(page, 120000);
  const t0 = Date.now();
  const state = await page.evaluate(async () => {
    const t0 = performance.now();
    const read = () => {
      const b = document.querySelector('.md-block');
      return b ? { pending: b.classList.contains('is-pending'), slow: b.classList.contains('is-slow'), stale: b.classList.contains('is-stale'), len: b.innerHTML.length, h: Math.round(b.getBoundingClientRect().height) } : null;
    };
    const first = read();
    let mountedAt = -1;
    while (performance.now() - t0 < 20000) {
      await new Promise((r) => setTimeout(r, 100));
      const r = read();
      if (r && !r.pending && r.len > 0) { mountedAt = Math.round(performance.now() - t0); break; }
    }
    return { first, last: read(), mountedAt, htmlMsgs: window.__wmsgs.html };
  });
  const sc = await structureCheck(page);
  C.check(`[${label}] worker settled`, s.ok, s);
  C.check(`[${label}] block mounts within 20 s of idle`, state.mountedAt >= 0, { ...state, blocks: sc.blocks, kinds: sc.kinds });
  C.measure(`[${label}] ms from idle to mounted`, state.mountedAt, '< 2000', state.mountedAt >= 0 && state.mountedAt < 2000);
  const cb = await page.evaluate(() => document.querySelectorAll('.md-block input[type=checkbox]').length);
  C.check(`[${label}] task checkboxes rendered`, cb > 0, `checkboxes=${cb}`);
  return { state, sc, cb };
}

try {
  await open(page, '?mode=split');
  await settle(page, 60000);
  await probe('500 loose tasks (1 List block)', () => { let t = ''; for (let i = 0; i < 500; i++) t += `- [ ] task ${i}\n\n`; return t; });
  await probe('2000 loose tasks (1 List block)', () => { let t = ''; for (let i = 0; i < 2000; i++) t += `- [ ] task ${i}\n\n`; return t; });
  const r4000 = await probe('4000 loose tasks (1 List block)', () => { let t = ''; for (let i = 0; i < 4000; i++) t += `- [ ] task ${i}\n\n`; return t; });
  await probe('4000 tight tasks (1 List block)', () => { let t = ''; for (let i = 0; i < 4000; i++) t += `- [ ] task ${i}\n`; return t; });

  // Does it ever mount? wait a long time on the 4000-loose case.
  if (r4000.state.mountedAt < 0) {
    await page.evaluate(async () => { let t = ''; for (let i = 0; i < 4000; i++) t += `- [ ] task ${i}\n\n`; await window.__mdr.loadText(t, 'probe.md'); });
    await settle(page, 120000);
    const long = await page.evaluate(async () => {
      const t0 = performance.now();
      const read = () => { const b = document.querySelector('.md-block'); return b ? { pending: b.classList.contains('is-pending'), slow: b.classList.contains('is-slow'), len: b.innerHTML.length } : null; };
      while (performance.now() - t0 < 60000) { await new Promise((r) => setTimeout(r, 250)); const r = read(); if (r && !r.pending && r.len > 0) return { mountedAt: Math.round(performance.now() - t0), ...r }; }
      return { mountedAt: -1, ...read(), htmlMsgs: window.__wmsgs.html };
    });
    C.check('[4000 loose tasks] mounts within 60 s', long.mountedAt >= 0, long);
    // does a scroll / mountAll rescue it?
    const rescue = await page.evaluate(async () => {
      await window.__mdr.app.preview.mountAll();
      await new Promise((r) => setTimeout(r, 1500));
      const b = document.querySelector('.md-block');
      return { pending: b?.classList.contains('is-pending'), len: b?.innerHTML.length, checkboxes: document.querySelectorAll('.md-block input[type=checkbox]').length };
    });
    C.check('[4000 loose tasks] mountAll() mounts it', rescue.pending === false && rescue.len > 0, rescue);
  }

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
} finally {
  report('s28 giant list mount', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
