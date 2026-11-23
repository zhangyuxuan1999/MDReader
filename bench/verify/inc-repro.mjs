// bench/verify/inc-repro.mjs — reproduce incremental-segmentation drift: after keyboard edits the block
// structure / rendering differs from a fresh load of the identical text.
// Run: node bench/verify/inc-repro.mjs   (dev server on :5202)
import { openApp2, loadSettled, mountAllSettled, settle, assertEqualsReference, harness, finish, blocksHtml, canonical, diffCanonical, sleep } from './lib2.mjs';

const H = harness('inc-repro');
const app = await openApp2();
const { page } = app;

const structure = () => page.evaluate(() => {
  const p = window.__mdr.app.preview;
  const n = p.blockCount();
  const out = [];
  let line = 1;
  for (let i = 0; i < n; i++) { const b = p.blockAtLine(line); out.push(`${b.startLine}+${b.lineCount}:k${b.kind}`); line += b.lineCount; }
  return out;
});
const getText = () => page.evaluate(() => window.__mdr.app.getText());

async function compareWithFresh(label) {
  const s = await settle(page, 30_000);
  if (!s.ok) { H.fail(`${label}: worker did not settle`, s); return; }
  await mountAllSettled(page, 30_000);
  const text = await getText();
  const incStruct = await structure();
  const incHtml = await blocksHtml(page);
  await assertEqualsReference(page, H, `${label} (incremental state)`);
  await loadSettled(page, text, 'fresh.md');
  const freshStruct = await structure();
  const freshHtml = await blocksHtml(page);
  const same = JSON.stringify(incStruct) === JSON.stringify(freshStruct);
  const d = diffCanonical(canonical(freshHtml), canonical(incHtml));
  if (!same || d) H.fail(`${label}: incremental structure/rendering differs from a fresh load of the same text`, { text, incStruct, freshStruct, diff: d });
  else H.pass(`${label}: incremental == fresh`, `${incStruct.length} blocks`);
  return { text, incStruct, freshStruct };
}

// ---------------------------------------------------------------- 1. minimal: type a list with Enter continuation into an empty doc
await loadSettled(page, '', 'empty.md', { mountAll: false });
await page.evaluate(() => window.__mdr.app.editor.focus());
await page.keyboard.type('- a');
await page.keyboard.press('Enter');
await page.keyboard.type('b');
await page.keyboard.press('Enter');
await page.keyboard.press('Enter');
await page.keyboard.type('after');
await compareWithFresh('type "- a⏎b⏎⏎after" in an empty doc');

// ---------------------------------------------------------------- 2. the scenario from incremental.mjs (heading + list typed before an existing paragraph)
const base = '# Title\n\nIntro paragraph.\n\n- item one\n- item two\n';
await loadSettled(page, base, 'base.md', { mountAll: false });
await page.evaluate(() => window.__mdr.app.editor.gotoLine(2, 0));
await page.keyboard.type('#### Typed heading');
await page.keyboard.press('Enter');
await page.keyboard.type('- typed item');
await page.keyboard.press('Enter');
await page.keyboard.type('second typed item');
await page.keyboard.press('Enter');
await page.keyboard.press('Enter');
const r2 = await compareWithFresh('heading + list typed via Enter continuation before a paragraph');

// ---------------------------------------------------------------- 3. step by step: which keystroke introduces the drift?
await loadSettled(page, base, 'base.md', { mountAll: false });
await page.evaluate(() => window.__mdr.app.editor.gotoLine(2, 0));
const steps = [['type', '- typed item'], ['press', 'Enter'], ['type', 'second'], ['press', 'Enter'], ['press', 'Enter']];
for (const [kind, what] of steps) {
  if (kind === 'type') await page.keyboard.type(what); else await page.keyboard.press(what);
  await settle(page, 10_000);
  const text = await getText();
  const inc = await structure();
  // fresh structure via a second page would be cleaner; here: reload the same text in place afterwards is destructive, so
  // compute what a fresh segmentation gives by loading into a scratch copy at the end. Record now.
  console.log(`after ${kind} ${JSON.stringify(what)}: text=${JSON.stringify(text.slice(0, 80))} blocks=${JSON.stringify(inc)}`);
}
await compareWithFresh('step-by-step end state');

// ---------------------------------------------------------------- 4. programmatic (dispatch) equivalent of the same edits: is it the keyboard path or the worker?
await loadSettled(page, base, 'base.md', { mountAll: false });
const edits = ['- typed item', '\n- second', '\n- ', ]; // emulate CM's list continuation
await page.evaluate(() => window.__mdr.app.editor.gotoLine(2, 0));
for (const e of edits) {
  await page.evaluate((s) => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: v.state.selection.main.head, insert: s }, selection: { anchor: v.state.selection.main.head + s.length } }); }, e);
  await settle(page, 10_000);
}
// Enter on an empty item: CM replaces "- " with "" and inserts "\n"
await page.evaluate(() => { const v = window.__mdr.app.editor.view; const h = v.state.selection.main.head; v.dispatch({ changes: { from: h - 2, to: h, insert: '\n' }, selection: { anchor: h - 1 } }); });
await compareWithFresh('dispatch-emulated list continuation');

// ---------------------------------------------------------------- 5. undo after the keyboard sequence
await loadSettled(page, base, 'base.md', { mountAll: false });
await page.evaluate(() => window.__mdr.app.editor.gotoLine(2, 0));
await page.keyboard.type('- typed item');
await page.keyboard.press('Enter');
await page.keyboard.type('second');
await page.keyboard.press('Enter');
await page.keyboard.press('Enter');
await settle(page, 10_000);
await page.keyboard.press('Meta+z');
await settle(page, 10_000);
await compareWithFresh('undo ×1 after list typing');

finish(H, app);
await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
