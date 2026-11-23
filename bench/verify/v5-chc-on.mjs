// bench/verify/v5-chc-on.mjs — challenge-c, switch ON (the dev server's default with the test hooks): the capture element
// (fix-session-e B3) and the WAIT answer of the tick (fix-session-f A1) around a session. Per case: the source, the bus
// toasts, the capture textareas left under the preview root, and the preview's scrollable height against the one before
// the session.
// Run: MDR_PORT=5487 node bench/verify/v5-chc-on.mjs [case ...]
// Cases: esc-box-same, esc-box-other, live-ticks-other, three-waits, wait-slow, wait-scroll, wait-switch-off,
// wait-docreplace, wait-mode, wait-ime. Global timeout 10 min. Writes nothing into the tree.
process.env.MDR_SCRATCH = process.env.MDR_SCRATCH || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v5-chc/on';
const { openB, sleep, globalTimeout, clickText, waitSession, load, J } = await import('./v4-sesa-lib.mjs');
const B = await openB();
const stop = globalTimeout(600_000, B.close);
const { page } = B;
const only = process.argv.slice(2);
const DOC = 'Intro para text here\n\n- [ ] one\n- [ ] two\n- [ ] three\n\nMiddle para\n\n- [ ] four\n- [ ] five\n\n' + Array.from({ length: 60 }, (_, i) => `Filler ${i} paragraph words`).join('\n\n') + '\n';
const results = [];
const boxAt = (i) => page.evaluate((i) => { const b = document.querySelectorAll('.mdr-preview input[type="checkbox"]')[i]; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, i);
const state = () => page.evaluate(() => ({ src: window.__mdr.app.getText().slice(0, 140), toasts: window.__t.slice(), caps: document.querySelectorAll('.mdr-preview textarea').length, sh: document.querySelector('.mdr-preview').scrollHeight, editing: !!document.querySelector('.mdr-preview [contenteditable="true"]') }));
async function slow(ms) {
  await page.evaluate((ms) => {
    const pv = window.__mdr.app.preview;
    if (!window.__origDelta) { window.__origDelta = pv.applyStructureDelta.bind(pv); window.__origHtml = pv.applyHtml.bind(pv); }
    window.__delayMs = ms;
    pv.applyStructureDelta = (m) => { if (window.__delay) { setTimeout(() => window.__origDelta(m), window.__delayMs); return true; } return window.__origDelta(m); };
    pv.applyHtml = (m) => { if (window.__delay) setTimeout(() => window.__origHtml(m), window.__delayMs); else window.__origHtml(m); };
    window.__delay = ms > 0;
  }, ms);
}
async function prep(doc = DOC) {
  await page.evaluate(() => { window.__delay = false; });
  await page.keyboard.press('Escape').catch(() => {});
  await load(B, doc);
  await page.evaluate(() => { window.__t = []; if (!window.__hk) { window.__hk = true; window.__mdr.app.bus.on('toast', (e) => window.__t.push(e.text)); } });
  return (await state()).sh;
}
async function session(needle, k = 1) { await clickText(page, needle, k, { side: 'right' }); const v = await waitSession(page); if (!v.editing) throw new Error('no session on ' + needle); await sleep(60); }
function report(name, sh0, s, expect) {
  const bad = [];
  if (s.caps) bad.push('capture textarea left: ' + s.caps);
  if (Math.abs(s.sh - sh0) > 40) bad.push(`scrollHeight ${s.sh} vs ${sh0}`);
  for (const [k, v] of Object.entries(expect || {})) if (k === 'has' ? !v.every((x) => s.src.includes(x)) : k === 'lacks' ? v.some((x) => s.src.includes(x)) : false) bad.push(`${k} ${J(v)}`);
  const r = { name, ok: !bad.length, bad, ...s };
  results.push(r); console.log(name, J(r));
}
const CASES = {
  async 'esc-box-same'() { const sh0 = await prep(); await session('two'); await page.keyboard.type('Z'); await page.keyboard.press('Escape'); const p = await boxAt(2); await page.mouse.click(p.x, p.y); await sleep(2500); report('esc-box-same', sh0, await state(), { has: ['twZo', '- [x] three'] }); },
  async 'esc-box-other'() { const sh0 = await prep(); await session('Intro'); await page.keyboard.type('Q'); await page.keyboard.press('Escape'); const p = await boxAt(3); await page.mouse.click(p.x, p.y); const sh = await page.evaluate(() => document.querySelectorAll('.mdr-preview input[type="checkbox"]')[3].checked); await sleep(2000); const s = await state(); s.shownAtOnce = sh; report('esc-box-other', sh0, s, { has: ['IQntro', '- [x] four'] }); },
  async 'live-ticks-other'() { const sh0 = await prep(); await session('Intro'); await page.keyboard.type('abc'); for (const i of [0, 3, 4]) { const p = await boxAt(i); await page.mouse.click(p.x, p.y); await sleep(60); } await page.keyboard.type('def'); await sleep(1500); const s = await state(); report('live-ticks-other', sh0, s, { has: ['Iabcntro', '- [x] one', '- [x] four'] }); },
  async 'three-waits'() { const sh0 = await prep(); for (const [needle, box] of [['one', 1], ['four', 4], ['two', 0]]) { await session(needle); await page.keyboard.type('K'); await page.keyboard.press('Escape'); const p = await boxAt(box); await page.mouse.click(p.x, p.y); await sleep(120); } await sleep(3000); report('three-waits', sh0, await state(), { has: ['oKne', 'fKour', 'tKwo'] }); },
  async 'wait-slow'() { const sh0 = await prep(); await slow(900); await session('two'); await page.keyboard.type('S'); await page.keyboard.press('Escape'); const p = await boxAt(0); await page.mouse.click(p.x, p.y); await sleep(500); const mid = await state(); await sleep(4000); const s = await state(); s.capsDuring = mid.caps; report('wait-slow', sh0, s, { has: ['twSo', '- [x] one'] }); },
  async 'wait-scroll'() { const sh0 = await prep(); await slow(900); await session('two'); await page.keyboard.type('W'); await page.keyboard.press('Escape'); const p = await boxAt(0); await page.mouse.click(p.x, p.y); await page.mouse.wheel(0, 3000); await sleep(4000); report('wait-scroll', sh0, await state(), { has: ['twWo'] }); },
  async 'wait-switch-off'() { const sh0 = await prep(); await slow(900); await session('two'); await page.keyboard.type('O'); await page.keyboard.press('Escape'); const p = await boxAt(0); await page.mouse.click(p.x, p.y); await sleep(100); await page.keyboard.press('Shift+Meta+e'); await sleep(4000); const s = await state(); await page.keyboard.press('Shift+Meta+e'); report('wait-switch-off', sh0, s, { has: ['twOo'] }); },
  async 'wait-docreplace'() { const sh0 = await prep(); await slow(1500); await session('two'); await page.keyboard.type('R'); await page.keyboard.press('Escape'); const p = await boxAt(0); await page.mouse.click(p.x, p.y); await sleep(100); await page.evaluate(() => { window.__delay = false; window.__mdr.loadText('New doc\n\n- [ ] alpha\n- [ ] beta\n- [ ] gamma\n', 'new.md'); }); await sleep(4000); report('wait-docreplace', sh0, await state(), { lacks: ['[x]'] }); },
  // a new task item made by Enter in the session, Esc, then at once the box of the task BELOW it (ordinals shift)
  async 'enter-item-box-below'() { for (const d of [0, 900]) { const sh0 = await prep(); if (d) await slow(d); await session('two', 2); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('nu'); await page.keyboard.press('Escape'); const info = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]')).slice(0, 5).map((b) => (b.closest('li')?.textContent || '').trim())); const idx = info.findIndex((t) => t.startsWith('three')); const p = await boxAt(idx); await page.mouse.click(p.x, p.y); await sleep(d * 3 + 2500); const s = await state(); s.boxesAtClick = info; report('enter-item-box-below-' + d, sh0, s, { has: ['- [x] three'], lacks: ['- [x] nu', '[x] two', '[x] one'] }); } },
  async 'del-item-box-below'() { for (const d of [0, 900]) { const sh0 = await prep(); if (d) await slow(d); await session('two', 2); await page.keyboard.press('End'); for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Escape'); const info = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]')).slice(0, 5).map((b) => (b.closest('li')?.textContent || '').trim())); const idx = info.findIndex((t) => t.startsWith('three')); const p = await boxAt(idx); await page.mouse.click(p.x, p.y); await sleep(d * 3 + 2500); const s = await state(); s.boxesAtClick = info; report('del-item-box-below-' + d, sh0, s, { has: ['- [x] three'], lacks: ['[x] one'] }); } },
  async 'wait-mode'() { const sh0 = await prep(); await slow(900); await session('two'); await page.keyboard.type('M'); await page.keyboard.press('Escape'); const p = await boxAt(0); await page.mouse.click(p.x, p.y); await sleep(100); await page.evaluate(() => window.__mdr.mode('preview')); await sleep(4000); await page.evaluate(() => window.__mdr.mode('split')); await sleep(500); report('wait-mode', sh0, await state(), { has: ['twMo'] }); },
};
try {
  await B.boot('mode=split');
  for (const [n, fn] of Object.entries(CASES)) {
    if (only.length && !only.some((o) => n.startsWith(o))) continue;
    for (let r = 0; r < Number(process.env.MDR_RUNS || 1); r++) {
      try { await fn(); } catch (e) { results.push({ name: n, ok: false, err: String(e.message) }); console.log(n, 'ERR', String(e.message).slice(0, 300)); }
    }
  }
} finally {
  console.log('summary', J({ cases: results.length, bad: results.filter((r) => !r.ok).map((r) => r.name) }));
  stop(); await B.close();
}
