// bench/verify/v4-flow-drop.mjs — verify-flows (round-3 re-verification): U17 file drops beyond r3-p-drop.mjs.
// Trusted CDP drags. Each case runs on the candidate (MDR_URL, default http://localhost:5434/) and on the
// 0.1.1 baseline (MDR_BASE_URL, default 'http://localhost:5444/?perf=1'; '' skips it).
//   MDR_TMP=<scratch dir> node bench/verify/v4-flow-drop.mjs [case-prefix …]
// Temp files go to MDR_TMP (deleted at exit). Writes nothing into the tree. Global timeout 110 s.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleep, until, runBoth, snap, loadDoc, pointOf, cdpDrag, fileData, clickBtn, opfsOpen, opfsRead, storedDraft, seedDraft } from './v4-flow-lib.mjs';

const dir = fs.mkdtempSync(path.join(process.env.MDR_TMP || os.tmpdir(), 'v4-flow-drop-'));
const F = {
  a: path.join(dir, 'drop-a.md'),
  b: path.join(dir, 'drop-b.md'),
  txt: path.join(dir, 'notes.txt'),
  png: path.join(dir, 'pic.png'),
  mdDir: path.join(dir, 'folder.md'),
};
fs.writeFileSync(F.a, '# DROPPED A\n', 'utf8');
fs.writeFileSync(F.b, '# DROPPED B\n', 'utf8');
fs.writeFileSync(F.txt, 'plain TXT\n', 'utf8');
fs.writeFileSync(F.png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]));
fs.mkdirSync(F.mdDir);
const DOC = '# 标题\n\nalpha line\n\nsecond line\n';
const isA = (r) => r.text === '# DROPPED A\n';
const dirty = async (page) => page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: v.state.doc.length, insert: 'X' } }); });

const C = {};
// Several files: the CONTRACT (U17 as implemented) says the first Markdown file opens.
C['multi-png-first'] = {
  async run(page) {
    await loadDoc(page, DOC, 'base.md');
    const pt = await pointOf(page, '.mdr-preview section.md-block p');
    await cdpDrag(page, pt, fileData([F.png, F.a]));
    await sleep(1300);
    return snap(page);
  },
  expect: (r) => isA(r) && r.dialogs.length === 0,
};
C['multi-txt-md'] = {
  async run(page) {
    await loadDoc(page, DOC, 'base.md');
    const pt = await pointOf(page, '.mdr-preview section.md-block p');
    await cdpDrag(page, pt, fileData([F.txt, F.a]));
    await sleep(1300);
    return snap(page);
  },
  expect: (r) => (r.text === 'plain TXT\n' || isA(r)) && r.dialogs.length === 0,
};
// A file together with text/plain + text/uri-list (what Finder / a browser carry) on an editor line.
C['file-plus-text-line'] = {
  async run(page) {
    await loadDoc(page, DOC, 'base.md');
    const pt = await pointOf(page, '.cm-line', 0.1);
    await cdpDrag(page, pt, fileData([F.a], [{ mimeType: 'text/plain', data: 'PLAIN' }, { mimeType: 'text/uri-list', data: 'file://' + F.a }]));
    await sleep(1300);
    return snap(page);
  },
  expect: (r) => isA(r) && r.dialogs.length === 0 && !r.title.startsWith('●'),
};
C['file-plus-html-session'] = {
  async run(page) {
    await loadDoc(page, DOC, 'base.md');
    const pt = await pointOf(page, '.mdr-preview section.md-block:nth-of-type(2) p', 0.9);
    const p2 = pt || (await pointOf(page, '.mdr-preview p', 0.9));
    await page.mouse.click(p2.x, p2.y);
    await sleep(600);
    const live = await page.evaluate(() => !!document.querySelector('.mdr-preview [contenteditable="true"]'));
    await cdpDrag(page, p2, fileData([F.a], [{ mimeType: 'text/html', data: '<b>HTML</b>' }, { mimeType: 'text/plain', data: 'PLAIN' }]));
    await sleep(1300);
    return { ...(await snap(page)), live };
  },
  expect: (r) => isA(r) && r.dialogs.length === 0,
};
// Only the preview session is dirty (typing in a session), then a file is dropped on the session itself.
C['session-dirty-cancel'] = {
  async run(page) {
    await loadDoc(page, DOC, 'base.md');
    const pt = await pointOf(page, '.mdr-preview p', 0.95);
    await page.mouse.click(pt.x, pt.y);
    await sleep(500);
    await page.keyboard.press('End');
    await page.keyboard.type('QQ');
    await cdpDrag(page, pt, fileData([F.a]));
    await sleep(1300);
    const asked = await snap(page);
    await clickBtn(page, '取消');
    await sleep(600);
    await page.keyboard.type('R');
    await sleep(600);
    await page.keyboard.press('Escape');
    await sleep(500);
    return { asked: asked.dialogs, during: asked.text, ...(await snap(page)) };
  },
  expect: (r) => r.asked.length === 1 && r.text === '# 标题\n\nalpha lineQQR\n\nsecond line\n' && r.dialogs.length === 0,
};
// The emptied-block placeholder (U9): ⌘A + Backspace in a session, then a file dropped on the placeholder.
C['ghost-drop-cancel'] = {
  async run(page) {
    await loadDoc(page, DOC, 'base.md');
    const pt = await pointOf(page, '.mdr-preview p', 0.5);
    await page.mouse.click(pt.x, pt.y);
    await sleep(500);
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Backspace');
    await sleep(700);
    const before = await snap(page);
    const gp = (await pointOf(page, '.mdr-preview section.md-block.is-editing', 0.5, 0.5)) || pt;
    await cdpDrag(page, gp, fileData([F.a]));
    await sleep(1300);
    const asked = await snap(page);
    await clickBtn(page, '取消');
    await sleep(600);
    await page.keyboard.type('N');
    await sleep(800);
    return { before: before.text, asked: asked.dialogs, ...(await snap(page)) };
  },
  expect: (r) => r.asked.length === 1 && r.text === '# 标题\n\nN\n\nsecond line\n',
};
// A drop on an open question's own button / dialog box (the question of 新建 is up, document dirty).
C['drop-on-dialog'] = {
  async run(page) {
    await loadDoc(page, DOC, 'base.md');
    await dirty(page);
    await page.evaluate(() => { void window.__mdr.app.registry.run('file.new'); });
    await sleep(500);
    const pt = await pointOf(page, '.mdr-dialog__btn');
    await cdpDrag(page, pt, fileData([F.a]));
    await sleep(1000);
    const during = await snap(page);
    await clickBtn(page, '取消');
    await sleep(800);
    const mid = await snap(page);
    await clickBtn(page, '丢弃');
    await sleep(900);
    return { during: during.dialogs.length, duringText: during.text, mid: mid.dialogs.length, ...(await snap(page)) };
  },
  expect: (r) => r.during === 1 && r.duringText === DOC + 'X' && r.mid === 1 && isA(r) && r.dialogs.length === 0,
};
// Drops on text inputs: the find bar and the command palette.
C['drop-findbar'] = {
  async run(page) {
    await loadDoc(page, DOC, 'base.md');
    await page.evaluate(() => window.__mdr.app.editor.focus());
    await page.keyboard.press('Meta+f');
    await sleep(400);
    const pt = await pointOf(page, '.cm-search input, .cm-panel input');
    if (!pt) return { error: 'no find bar' };
    await cdpDrag(page, pt, fileData([F.a]));
    await sleep(1300);
    const val = await page.evaluate(() => document.querySelector('.cm-search input, .cm-panel input')?.value ?? null);
    return { ...(await snap(page)), val };
  },
  expect: (r) => isA(r) && r.dialogs.length === 0,
};
C['drop-palette'] = {
  async run(page) {
    await loadDoc(page, DOC, 'base.md');
    await page.evaluate(() => { void window.__mdr.app.registry.run('view.palette'); });
    await sleep(400);
    const pt = await pointOf(page, '.mdr-palette__input');
    if (!pt) return { error: 'no palette' };
    await cdpDrag(page, pt, fileData([F.a]));
    await sleep(1300);
    const val = await page.evaluate(() => document.querySelector('.mdr-palette__input')?.value ?? null);
    const open = await page.evaluate(() => !!document.querySelector('.mdr-palette:not([hidden])'));
    return { ...(await snap(page)), val, open };
  },
  expect: (r) => isA(r) && r.dialogs.length === 0,
};
// Two drops 20 ms apart on a dirty document: questions one at a time; 丢弃 then 取消.
C['two-drops-dirty'] = {
  async run(page) {
    await loadDoc(page, DOC, 'base.md');
    await dirty(page);
    await page.evaluate(() => {
      window.__maxD = 0;
      new MutationObserver(() => { window.__maxD = Math.max(window.__maxD, document.querySelectorAll('.mdr-dialog').length); }).observe(document.body, { childList: true, subtree: true });
    });
    const pt = await pointOf(page, '.cm-line', 0.2);
    await cdpDrag(page, pt, fileData([F.a]));
    await sleep(20);
    await cdpDrag(page, pt, fileData([F.b]));
    await sleep(1200);
    const q1 = await snap(page);
    await clickBtn(page, '丢弃');
    await sleep(1200);
    const after1 = await snap(page);
    if (after1.dialogs.length) await clickBtn(page, '取消');
    await sleep(600);
    const maxD = await page.evaluate(() => window.__maxD);
    return { q1: q1.dialogs.length, after1Text: after1.text, after1Dialogs: after1.dialogs.length, maxD, ...(await snap(page)) };
  },
  // The first 丢弃 opens A (clean then); B then opens without a question (A is clean).
  expect: (r) => r.q1 === 1 && r.maxD === 1 && r.text === '# DROPPED B\n' && r.dialogs.length === 0,
};
// A clean document with an unanswered recovery offer, then a drop: the dropped file opens; the crash draft
// stays stored (R4/R5) and is offered again when the document comes back.
C['drop-with-offer'] = {
  async run(page) {
    await seedDraft(page, { docId: 'text:off.md', version: 3, text: 'CRASH\n', at: Date.now() + 3600_000 });
    await loadDoc(page, 'orig\n', 'off.md');
    const offered = (await snap(page)).toasts.some((t) => t.includes('发现未保存的草稿'));
    const pt = await pointOf(page, '.cm-line', 0.2);
    await cdpDrag(page, pt, fileData([F.a]));
    await sleep(1300);
    const s1 = await snap(page);
    const stored = await storedDraft(page, 'text:off.md');
    await page.evaluate(() => window.__mdr.app.loadText('orig\n', 'off.md'));
    await sleep(900);
    const again = (await snap(page)).toasts.filter((t) => t.includes('发现未保存的草稿')).length;
    return { offered, openedA: isA(s1), dialogs: s1.dialogs, offerAfterDrop: s1.toasts.filter((t) => t.includes('发现未保存的草稿')).length, stored, again };
  },
  expect: (r) => r.offered && r.openedA && r.dialogs.length === 0 && r.offerAfterDrop === 0 && r.stored === 'CRASH\n' && r.again === 1,
};
// A folder whose name ends in .md (directory), on the web FSA backend.
C['folder-named-md'] = {
  async run(page) {
    await loadDoc(page, DOC, 'base.md');
    const pt = await pointOf(page, '.cm-line', 0.2);
    await cdpDrag(page, pt, fileData([F.mdDir]));
    await sleep(1500);
    return snap(page);
  },
  expect: (r) => r.text === DOC && r.dialogs.length === 0 && !r.title.startsWith('●') && r.toasts.length >= 1,
};
// The drag overlay after a drag that enters and then leaves the window without a drop, and after a drop.
C['overlay-leave'] = {
  async run(page) {
    await loadDoc(page, DOC, 'base.md');
    const pt = await pointOf(page, '.mdr-preview p');
    await cdpDrag(page, pt, fileData([F.a]), { steps: ['dragEnter', 'dragOver'] });
    await sleep(200);
    const during = await page.evaluate(() => !!document.querySelector('.is-dragover'));
    await cdpDrag(page, pt, fileData([F.a]), { steps: ['dragCancel'] });
    await sleep(300);
    return { during, ...(await snap(page)) };
  },
  expect: (r, b) => r.text === DOC && (!b || r.dragover === b.dragover),
};
// Drop while a slow save of the current (dirty) document is in flight; 丢弃 answered before the save ends.
// Afterwards the editor shows B: the title and the next ⌘S must belong to B, never to the saved file.
C['drop-during-save'] = {
  async run(page) {
    if (!(await opfsOpen(page, 's1.md', '# S1\n'))) return { error: 'open failed' };
    await page.evaluate(() => {
      const P = FileSystemFileHandle.prototype;
      const orig = P.createWritable;
      window.__slow = true;
      P.createWritable = async function (...a) {
        const w = await orig.apply(this, a);
        const close = w.close.bind(w);
        w.close = async () => { if (window.__slow) await new Promise((r) => setTimeout(r, 2500)); return close(); };
        return w;
      };
    });
    await page.evaluate(() => window.__mdr.app.editor.focus());
    await page.keyboard.press('End');
    await page.keyboard.type('typed');
    await page.keyboard.press('Meta+s');
    await sleep(150);
    const pt = await pointOf(page, '.cm-line', 0.5);
    await cdpDrag(page, pt, fileData([F.a]));
    await sleep(500);
    const q = await snap(page);
    await clickBtn(page, '丢弃');
    await sleep(3200);
    await page.evaluate(() => { window.__slow = false; });
    const afterSave = await snap(page);
    const disk1 = await opfsRead(page, 's1.md');
    // The user types into what they see (drop-a.md) and saves.
    await page.evaluate(() => window.__mdr.app.editor.focus());
    await page.keyboard.press('Meta+End');
    await page.keyboard.type('more');
    await page.keyboard.press('Meta+s');
    await sleep(1500);
    const disk2 = await opfsRead(page, 's1.md');
    return { asked: q.dialogs, afterSaveTitle: afterSave.title, afterSaveText: afterSave.text, disk1, disk2, title: (await snap(page)).title, onDiskA: fs.readFileSync(F.a, 'utf8') };
  },
  expect: (r) => r.disk1 === '# S1typed\n' && r.disk2 === '# S1typed\n' && !/s1\.md/.test(r.afterSaveTitle),
};

// More drop points on a CLEAN long document: the splitter, the editor's scrollbar, the gap between two preview
// blocks, the preview's scrollbar. Each must open the dropped file without a question and without mixing.
const LONG = Array.from({ length: 80 }, (_, i) => `para ${i}\n`).join('\n');
for (const [name, fn] of Object.entries({
  splitter: (p) => pointOf(p, '.mdr-gutter', 0.5, 0.5),
  'editor-scrollbar': (p) => p.evaluate(() => { const s = document.querySelector('.cm-scroller'); const r = s.getBoundingClientRect(); return { x: r.right - 4, y: r.top + 60 }; }),
  'preview-gap': (p) => p.evaluate(() => { const b = document.querySelectorAll('.mdr-preview section.md-block'); const r1 = b[1].getBoundingClientRect(); const r2 = b[2].getBoundingClientRect(); return { x: r1.left + 30, y: (r1.bottom + r2.top) / 2 }; }),
  'preview-scrollbar': (p) => p.evaluate(() => { const s = document.querySelector('.mdr-preview'); const r = s.getBoundingClientRect(); return { x: r.right - 4, y: r.top + 80 }; }),
})) {
  C[`at-${name}`] = {
    async run(page) {
      await loadDoc(page, LONG, 'long.md');
      const pt = await fn(page);
      if (!pt) return { error: 'no point' };
      await cdpDrag(page, pt, fileData([F.a]));
      await sleep(1300);
      return snap(page);
    },
    expect: (r) => isA(r) && r.dialogs.length === 0,
  };
}

// Same root cause without a drop: 新建 while the slow save is in flight, 丢弃, type, ⌘S.
C['new-during-save'] = {
  async run(page) {
    if (!(await opfsOpen(page, 's2.md', '# S2\n'))) return { error: 'open failed' };
    await page.evaluate(() => {
      const P = FileSystemFileHandle.prototype;
      const orig = P.createWritable;
      window.__slow = true;
      P.createWritable = async function (...a) {
        const w = await orig.apply(this, a);
        const close = w.close.bind(w);
        w.close = async () => { if (window.__slow) await new Promise((r) => setTimeout(r, 2500)); return close(); };
        return w;
      };
      window.showSaveFilePicker = async () => { throw new DOMException('cancelled', 'AbortError'); };
    });
    await page.evaluate(() => window.__mdr.app.editor.focus());
    await page.keyboard.press('End');
    await page.keyboard.type('typed');
    await page.keyboard.press('Meta+s');
    await sleep(150);
    await page.evaluate(() => { void window.__mdr.app.registry.run('file.new'); });
    await sleep(400);
    const q = await snap(page);
    await clickBtn(page, '丢弃');
    await sleep(3200);
    await page.evaluate(() => { window.__slow = false; });
    const afterSave = await snap(page);
    await page.evaluate(() => window.__mdr.app.editor.focus());
    await page.keyboard.type('NEW DOC TEXT');
    await page.keyboard.press('Meta+s');
    await sleep(1500);
    return { asked: q.dialogs, afterSaveTitle: afterSave.title, afterSaveText: afterSave.text, disk: await opfsRead(page, 's2.md'), title: (await snap(page)).title };
  },
  expect: (r) => r.disk === '# S2typed\n' && !/s2\.md/.test(r.afterSaveTitle),
};

// A dropped .md the browser cannot read (no permission), dirty document: what is said, and the document stays.
C['web-locked'] = {
  async run(page) {
    const f = path.join(dir, 'locked.md');
    fs.writeFileSync(f, '# L\n');
    fs.chmodSync(f, 0o000);
    try {
      await loadDoc(page, DOC, 'base.md');
      await dirty(page);
      const pt = await pointOf(page, '.cm-line', 0.2);
      await cdpDrag(page, pt, fileData([f]));
      await sleep(1500);
      const s1 = await snap(page);
      // Answer 丢弃 if asked (0.1.1 asks first): what does the build say then, and what is left?
      if (s1.dialogs.length) { await clickBtn(page, '丢弃'); await sleep(1200); return { ...(await snap(page)), askedFirst: s1.dialogs }; }
      return s1;
    } finally { fs.chmodSync(f, 0o644); }
  },
  expect: (r) => r.text === DOC + 'X' && r.dialogs.length === 0 && r.toasts.some((t) => t.includes('locked.md')),
};
// A file deleted after the drag started (between dragEnter and drop).
C['web-gone'] = {
  async run(page) {
    const f = path.join(dir, 'gone.md');
    fs.writeFileSync(f, '# G\n');
    await loadDoc(page, DOC, 'base.md');
    await dirty(page);
    const pt = await pointOf(page, '.cm-line', 0.2);
    await cdpDrag(page, pt, fileData([f]), { steps: ['dragEnter', 'dragOver'] });
    fs.rmSync(f);
    await cdpDrag(page, pt, fileData([f]), { steps: ['drop'] }).catch(() => {});
    await sleep(1500);
    const s1 = await snap(page);
    if (s1.dialogs.length) await clickBtn(page, '取消');
    return s1;
  },
  expect: (r) => r.text === DOC + 'X' && r.dialogs.length === 0 && r.toasts.some((t) => t.includes('gone.md')),
};
// Preview-only and editor-only modes.
for (const mode of ['preview', 'edit']) {
  C[`mode-${mode}`] = {
    async run(page) {
      await loadDoc(page, DOC, 'base.md');
      await page.evaluate((m) => window.__mdr.mode(m), mode);
      await sleep(600);
      const pt = await pointOf(page, mode === 'preview' ? '.mdr-preview section.md-block p' : '.cm-line', 0.3);
      await cdpDrag(page, pt, fileData([F.a]));
      await sleep(1300);
      return snap(page);
    },
    expect: (r) => isA(r) && r.dialogs.length === 0,
  };
}

// The same race with NO question: ⌘S on a CLEAN document (a habit), a drop while that save is in flight.
C['clean-save-drop'] = {
  async run(page) {
    if (!(await opfsOpen(page, 's3.md', '# S3\n'))) return { error: 'open failed' };
    await page.evaluate(() => {
      const P = FileSystemFileHandle.prototype;
      const orig = P.createWritable;
      window.__slow = true;
      P.createWritable = async function (...a) {
        const w = await orig.apply(this, a);
        const close = w.close.bind(w);
        w.close = async () => { if (window.__slow) await new Promise((r) => setTimeout(r, 1500)); return close(); };
        return w;
      };
    });
    await page.evaluate(() => window.__mdr.app.editor.focus());
    await page.keyboard.press('Meta+s');
    await sleep(150);
    const pt = await pointOf(page, '.cm-line', 0.5);
    await cdpDrag(page, pt, fileData([F.a]));
    await sleep(400);
    const opened = await snap(page);
    await sleep(2000);
    await page.evaluate(() => { window.__slow = false; });
    const later = await snap(page);
    await page.evaluate(() => window.__mdr.app.editor.focus());
    await page.keyboard.press('Meta+End');
    await page.keyboard.type('more');
    await page.keyboard.press('Meta+s');
    await sleep(1500);
    return { openedTitle: opened.title, openedDialogs: opened.dialogs, laterTitle: later.title, laterText: later.text, disk: await opfsRead(page, 's3.md') };
  },
  expect: (r) => r.disk === '# S3\n' && !/s3\.md/.test(r.laterTitle),
};

let code = 1;
try {
  code = (await runBoth(C)) ? 1 : 0;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
