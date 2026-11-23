// bench/verify/review-dispose.mjs — AppHandle.dispose() tears down preview/worker/sync/listeners but never destroys
// the CodeMirror view (EditorApi has no dispose; createEditor keeps rAF handles + scroll listener + registry.onChange),
// and createTheme never removes its matchMedia listener. Checks what survives a dispose().
// Run: node bench/verify/review-dispose.mjs
import { openPage, gotoApp, loadDoc, waitIdle, sleep, report } from './review-lib.mjs';

const { browser, page, errors } = await openPage();
try {
  await gotoApp(page, 'mode=split');
  await loadDoc(page, 'small.md');
  await waitIdle(page);
  const r = await page.evaluate(async () => {
    const app = window.__mdr.app;
    let cursorEvents = 0;
    app.editor.onCursor(() => { cursorEvents++; });
    app.dispose();
    const afterDispose = {
      cmEditorInDom: !!document.querySelector('.cm-editor'),
      previewInDom: !!document.querySelector('.mdr-preview'),
      hooksRemoved: window.__mdr === undefined,
    };
    // the editor is still live: typing into it still runs the update listener + rAF cursor notifications
    app.editor.view.dispatch({ changes: { from: 0, insert: 'z' } });
    await new Promise((r) => setTimeout(r, 100));
    afterDispose.editorStillDispatches = cursorEvents > 0;
    afterDispose.editorVersionAfter = app.editor.version;
    return afterDispose;
  });
  console.log(r);
  report('review-dispose', [
    { name: '.cm-editor removed from DOM after dispose()', value: String(!r.cmEditorInDom), target: 'true', pass: !r.cmEditorInDom },
    { name: 'editor update listener / rAF cursor notifications stop after dispose()', value: `still firing: ${r.editorStillDispatches}`, target: 'stopped', pass: !r.editorStillDispatches },
    { name: 'preview removed, hooks removed', value: `preview in DOM: ${r.previewInDom}, hooks removed: ${r.hooksRemoved}`, target: 'false / true', pass: !r.previewInDom && r.hooksRemoved },
  ]);
  console.log('errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
}
