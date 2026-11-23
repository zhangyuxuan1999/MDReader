// bench/verify/review-typing-cm.mjs — isolates the mid-document keystroke cost to CodeMirror's language config.
// Inside the app page (same module instances, found via Vite's dep URLs) a standalone EditorView is created over
// the app's current text with (A) markdown({codeLanguages: languages}) as createEditor.ts does, (B) markdown()
// without nested code languages, (C) no language at all. Each variant: jump to the middle, wait 3 s, 20 keystrokes.
// Run: node bench/verify/review-typing-cm.mjs
import { openPage, gotoApp, loadDoc, waitIdle, installMonitor, resetMonitor, readMonitor, sleep, r1, report } from './review-lib.mjs';

const DOC = process.env.DOC || 'large.md';
const { browser, page, errors } = await openPage();
try {
  await gotoApp(page, 'mode=edit');
  await loadDoc(page, DOC);
  await waitIdle(page);
  await installMonitor(page);
  await sleep(3000);
  const ok = await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((e) => e.name).concat(Array.from(document.scripts).map((s) => s.src));
    const find = (n) => { const u = urls.find((x) => x.includes(`/.vite/deps/${n}.js`)); if (!u) throw new Error('dep not found: ' + n); return u; };
    const [state, view, lang, md, data] = await Promise.all(['@codemirror_state', '@codemirror_view', '@codemirror_language', '@codemirror_lang-markdown', '@codemirror_language-data'].map((n) => import(find(n))));
    window.__cm = { state, view, lang, md, data, text: window.__mdr.app.getText() };
    // hide the app, host the standalone views
    document.getElementById('app').style.display = 'none';
    const host = document.createElement('div'); host.id = 'cmhost'; host.style.cssText = 'position:fixed;inset:0;background:#fff;';
    document.body.appendChild(host);
    return true;
  });
  if (!ok) throw new Error('setup failed');
  const variants = { A: 'markdown + codeLanguages (createEditor.ts)', B: 'markdown, no codeLanguages', C: 'no language extension' };
  const rows = [];
  for (const [key, label] of Object.entries(variants)) {
    const mid = await page.evaluate(async (key) => {
      const { state, view, lang, md, data, text } = window.__cm;
      const host = document.getElementById('cmhost'); host.replaceChildren();
      const exts = [view.lineNumbers(), lang.syntaxHighlighting(lang.defaultHighlightStyle, { fallback: true }), view.EditorView.lineWrapping];
      if (key === 'A') exts.push(md.markdown({ base: md.markdownLanguage, codeLanguages: data.languages }));
      if (key === 'B') exts.push(md.markdown({ base: md.markdownLanguage }));
      const v = new view.EditorView({ state: state.EditorState.create({ doc: text, extensions: exts }), parent: host });
      v.dom.style.height = '100%';
      window.__cmView = v;
      const doc = v.state.doc; let line = Math.floor(doc.lines / 2);
      for (let i = 0; i < 2000; i++) { const t = doc.line(line + i).text; if (t.length > 20 && !/^\s*(#|```|~~~|\||[-*+]\s|>|\d+\.)/.test(t)) { line += i; break; } }
      const pos = doc.line(line).from + 5;
      v.dispatch({ selection: { anchor: pos }, effects: view.EditorView.scrollIntoView(pos, { y: 'center' }) });
      v.focus();
      return line;
    }, key);
    await sleep(3000);
    await resetMonitor(page);
    const t0 = await page.evaluate(() => performance.now());
    for (let i = 0; i < 20; i++) { await page.keyboard.type('x'); await sleep(120); }
    await sleep(400);
    const mon = await readMonitor(page);
    const lt = mon.longtasks.filter((t) => t.start >= t0).map((t) => r1(t.dur));
    const row = { key, label, mid, over20: mon.over20, frames: mon.frames, p95: r1(mon.p95), maxGap: r1(mon.maxGap), longtasks: lt };
    rows.push(row);
    console.log(row);
    await page.evaluate(() => window.__cmView.destroy());
  }
  report(`review-typing-cm ${DOC} (standalone CodeMirror, 20 keystrokes at the middle)`, rows.map((r) => ({ name: `${r.key}: ${r.label}`, value: `frames > 20 ms ${r.over20}/${r.frames}, p95 gap ${r.p95} ms, max ${r.maxGap} ms, long tasks ${JSON.stringify(r.longtasks)}`, target: 'no frames > 20 ms', pass: r.over20 <= 2 })));
  console.log('errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
}
