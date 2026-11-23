// bench/verify/v5-offa-drop.mjs — verify-off-app: J25 / U17 drops, J23 null blocks and J13 ticks at the app
// level by variation, switch OFF, candidate production build vs 0.1.1 (trusted CDP drags; real mouse clicks).
//   MDR_PORT=5486 MDR_BASE_PORT=5496 MDR_TMP=<scratch> node bench/verify/v5-offa-drop.mjs [case|prefix* ...] [--list]
// Temp files under MDR_TMP (deleted at exit). Global timeout 115 s.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleep, runCases, snap, clickBtn } from './v5-offa-lib.mjs';

const dir = fs.mkdtempSync(path.join(process.env.MDR_TMP || os.tmpdir(), 'v5-offa-drop-'));
const mk = (n, t, mode) => { const f = path.join(dir, n); fs.writeFileSync(f, t); if (mode != null) fs.chmodSync(f, mode); return f; };
const F = {
  lockedMd: mk('locked.md', '# L\n', 0o000),
  lockedMarkdown: mk('锁定.markdown', '# L2\n', 0o000),
  lockedTxt: mk('locked.txt', 'L3\n', 0o000),
  a: mk('a.md', '# A\n'),
  b: mk('b.md', '# B\n'),
  txt: mk('n.txt', 'plain\n'),
  gone: mk('gone.md', '# G\n'),
  crlf: mk('crlf.md', '# C\r\n\r\nline\r\n'),
  bom: mk('bom.md', String.fromCharCode(0xfeff) + '# BOM\n'),
};
process.on('exit', () => { try { for (const f of Object.values(F)) { try { fs.chmodSync(f, 0o644); } catch {} } fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
const DOC = '# 标题\n\nalpha line\n\nsecond line\n';
async function drop(page, files, { before } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const pt = await page.evaluate(() => { const r = document.querySelector('.mdr-preview').getBoundingClientRect(); return { x: r.left + 80, y: r.top + 60 }; });
  const data = { items: [], files, dragOperationsMask: 1 | 2 | 16 };
  try {
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: pt.x, y: pt.y, data });
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: pt.x, y: pt.y, data });
    if (before) before();
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: pt.x, y: pt.y, data });
  } finally { await cdp.detach().catch(() => {}); }
}
const load = async (page, t, n = 'base.md') => { await page.evaluate(([x, y]) => window.__mdr.app.loadText(x, y), [t, n]); await sleep(800); };
const dirty = (page) => page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: v.state.doc.length, insert: 'X' } }); });
const out = async (page) => { const s = await snap(page); return { ...s, seen: await page.evaluate(() => (window.__toasts || []).slice()) }; };
const C = {};
for (const [k, files] of Object.entries({ lockedMd: [F.lockedMd], lockedMarkdown: [F.lockedMarkdown], lockedTxt: [F.lockedTxt], 'locked-then-ok': [F.lockedMd, F.a], 'two-md': [F.a, F.b], 'txt-md': [F.txt, F.a], crlf: [F.crlf], bom: [F.bom] })) {
  for (const d of ['clean', 'dirty']) {
    C[`drop-${k}-${d}`] = async (page) => {
      await load(page, DOC);
      if (d === 'dirty') await dirty(page);
      await drop(page, files);
      await sleep(1200);
      const s1 = await out(page);
      if (s1.dialogs.length) { await clickBtn(page, '丢弃'); await sleep(1000); return { first: s1, then: await out(page) }; }
      return { first: s1 };
    };
  }
}
C['drop-gone-dirty'] = async (page) => {
  await load(page, DOC); await dirty(page);
  await drop(page, [F.gone], { before: () => fs.rmSync(F.gone) });
  await sleep(1200);
  const s1 = await out(page);
  fs.writeFileSync(F.gone, '# G\n');
  if (s1.dialogs.length) { await clickBtn(page, '丢弃'); await sleep(1000); return { first: s1, then: await out(page) }; }
  return { first: s1 };
};
// J23: HTML DOMPurify cannot turn into a fragment, and neighbours
for (const [k, h] of Object.entries({ bang: '<!div>', frameset: '<frameset>', html: '<html>', body: '<body>x', head: '<head>', doctype: '<!DOCTYPE html>', frame: '<frame>', noframes: '<noframes>', cdata: '<![CDATA[x]]>', pi: '<?php x ?>' })) {
  C[`null-${k}`] = async (page) => {
    await load(page, `first paragraph\n\n${h}\n\nlast paragraph\n`);
    await sleep(400);
    return { blocks: await page.evaluate(() => [...document.querySelectorAll('.mdr-preview .md-block')].map((b) => b.innerText)), err: await page.evaluate(() => (window.__toasts || []).slice()) };
  };
}
// J13 at the app level: the source line a click changes (switch OFF), real clicks
const TDOC = 'Intro paragraph.\n\n- [ ] one\n- [ ] two\n  - [ ] nested\n\n> - [ ] quoted\n\n1. [ ] ordered\n\n| a |\n|---|\n| <input type="checkbox"> raw |\n\n- <label>wrap <input type="checkbox"></label> lab\n- [ ] after label\n';
const clickAt = async (page, sel, i = 0, fx = 0.5) => {
  const p = await page.evaluate(([s, k, x]) => { const e = document.querySelectorAll(s)[k]; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width * x, y: r.top + r.height / 2 }; }, [sel, i, fx]);
  if (!p) return false;
  await page.mouse.click(p.x, p.y); await sleep(500); return true;
};
for (const [k, act] of Object.entries({
  'box-0': (p) => clickAt(p, '.mdr-preview li.task-list-item > input', 0),
  'box-nested': (p) => clickAt(p, '.mdr-preview li li.task-list-item > input', 0),
  'box-quoted': (p) => clickAt(p, '.mdr-preview blockquote input', 0),
  'box-ordered': (p) => clickAt(p, '.mdr-preview ol input', 0),
  'raw-cell': (p) => clickAt(p, '.mdr-preview td input', 0),
  'label-wrap-text': (p) => clickAt(p, '.mdr-preview label', 0, 0.1),
  'item-text': (p) => clickAt(p, '.mdr-preview li.task-list-item', 1, 0.6),
  'box-then-undo-editor': async (p) => { await clickAt(p, '.mdr-preview li.task-list-item > input', 1); await p.evaluate(() => window.__mdr.app.editor.focus()); await p.keyboard.press('Meta+z'); await sleep(500); },
  'box-twice': async (p) => { await clickAt(p, '.mdr-preview li.task-list-item > input', 0); await sleep(300); await clickAt(p, '.mdr-preview li.task-list-item > input', 0); },
  'space-key': async (p) => { await p.evaluate(() => document.querySelectorAll('.mdr-preview li.task-list-item > input')[1].focus()); await p.keyboard.press('Space'); await sleep(500); },
})) {
  C[`tick-${k}`] = async (page) => {
    await load(page, TDOC);
    await sleep(400);
    await act(page);
    const text = await page.evaluate(() => window.__mdr.app.getText());
    const tdl = TDOC.split('\n');
    const changed = text.split('\n').map((l, i) => (l !== tdl[i] ? i + 1 + ':' + l : null)).filter(Boolean);
    return { changed, boxes: await page.evaluate(() => [...document.querySelectorAll('.mdr-preview input[type=checkbox]')].map((b) => (b.checked ? 1 : 0)).join('')), seen: await page.evaluate(() => (window.__toasts || []).slice()) };
  };
}
const bad = await runCases(C, { timeoutMs: 115_000 });
process.exit(bad ? 1 : 0);
