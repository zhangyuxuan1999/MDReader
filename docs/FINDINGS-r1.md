# Verification round 1 findings

## Lens (agent a5c79ec22ed5b8835)

Robustness/edge-case verification of MDReader against a private Vite server on :5204 (killed afterwards). 17 Playwright scripts under /Users/zyx/LocalDocuments/MDReader/bench/verify/ (s01–s12b) were re-run from scratch; every script captures console errors, page errors and worker restarts — none occurred in any scenario. PASSING: 2000-char typing burst (preview == fresh render, p95 latency 15.7 ms); typing while huge.md (340k lines) is still rendering (no edits lost, p95 15 ms); select-all+delete+undo on large.md (exact text, 0 blocks/zero stats when empty, structure identical after undo); 6 MB paste (58 ms dispatch, p95 21.6 ms afterwards, 191k blocks tile); replace-all with 1000 structure-changing matches (tiling, TOC 1000, incremental == fresh); 200-change single transaction (worker mirror in sync); worker error-event restart + toast + preview recovery, silent terminate detected after 10.0 s, give-up after 3 restarts/min with the editor still usable; indexedDB undefined / throwing; empty, whitespace, single char, CRLF, 100k empty lines, 50k headings (TOC collapsed, 50000 entries), 50k-line fence (PLAIN mount), 50-level nesting, 1 MB lines, binary garbage + lone surrogates, RTL, emoji, unclosed fence at top then closed (15001 blocks, 0 long tasks); hidden-tab typing then return (preview catches up, draft flushed); reload mid-edit on the untitled doc (draft offered, restored byte-exact, discard works); 50 theme flips (0 long tasks); 10 load/unload cycles of large.md (heap 8.5 -> 9.8 MB, no leak, no leftover wrappers). DEFECTS FOUND (all reproduced): [HIGH] hiding the TOC (Mod-Shift-O) or any viewport <= 900 px collapses the editor to 0 px and the preview to 6 px — the app is blank/unusable (grid auto-placement shifts panes when the aside is display:none); [HIGH] any block taller than 20 screens (e.g. a 2000-line fence or 1500-line paragraph inside medium.md) is evicted while the user is scrolled into its middle and never remounts — blank preview, also after typing there; [MEDIUM] switching to preview mode (split->preview, edit->preview, Mod-/) throws both panes to line 1; [MEDIUM] draft autosave silently stops after a renderer restart; [MEDIUM] 50k-heading doc: every keystroke in a heading causes ~200 ms long tasks; [LOW] multi-cursor editing not enabled; [LOW] 1 MB single line ~90 ms per keystroke; [LOW] edit->split leaves the preview 40 lines below the editor. Note: four FAIL lines printed by the pre-existing scripts are script-expectation bugs, not defects: s03 'stats after undo' (file-state label 未命名->未保存 is the spec's version!=savedVersion rule), s05 'one version bump' (loadText itself bumps the version; replace-all was one bump), s09 'TOC 49999' (the probe typed at col 0 of a heading, destroying it — s09c shows 50000), s09 'unclosedFenceTop still 1 block' (closing the fence on the LAST line correctly makes the whole doc one code block — s09c a/b/c).

### Findings (8)

- **[high] Hiding the TOC (or viewport <= 900 px) collapses the editor to 0 px and the preview to 6 px — app becomes blank**
  - file: src/styles/layout.css (lines 127-133 `.mdr-app[data-toc="closed"] .mdr-pane--toc{display:none}` and 372-378 `@media (max-width:900px)`), src/app/layout.ts
  - expected: With the TOC hidden the editor and preview share the full width (grid columns 0px / 1fr / 6px / 1fr). In edit or preview mode at any width the single pane fills the window.
  - actual: Computed grid-template-columns is correct ("0px 697px 6px 697px") but the aside is display:none, so grid auto-placement shifts every pane one column left: .mdr-pane--editor gets the 0 px TOC column (width 0), .mdr-gutter gets the 697 px editor column, .mdr-pane--preview gets the 6 px gutter column, the 4th column is empty. elementFromPoint over the editor hits DIV.mdr-gutter. Same at 500/700/900 px with the TOC attr 'open' (media query hides it) and in edit mode (editor 0 px, cols "0px 675px 0px 0px") and preview mode (preview 0 px) whenever the TOC is closed. Only 1100+ px with TOC open works.
  - repro: node bench/verify/s10c_toc_hidden_and_preview_switch.mjs (also s10b_layout_and_mode_position.mjs, s10_ui_stress.mjs (A)). Steps: open ?doc=/test-data/small.md&mode=split at 1400x900, press Mod-Shift-O (or resize to <= 900 px, or open with TOC closed persisted in localStorage mdr.toc=closed). Screenshot: bench/verify/out/s10c-1400-toc-hidden.png
  - fix: Keep the TOC aside in the grid flow when hidden (e.g. `.mdr-app[data-toc=closed] .mdr-pane--toc{width:0;overflow:hidden;border:0}` or visibility:hidden) or, more robustly, pin each pane to its column explicitly (`grid-column: 1..4` per pane / grid-template-areas) so display:none on a sibling cannot shift placement. Same for the edit/preview-mode rules that hide gutter/preview/editor. Add a layout smoke check at 500 px and with mdr.toc=closed to bench/smoke.mjs.
- **[high] Block taller than 20 screens is evicted while the user is scrolled inside it and never remounts (blank preview) — hits ordinary 2k-line fences and long paragraphs**
  - file: src/preview/createPreview.ts (runEvict, ~line 318: `if (Math.abs(tops[i] - rel) <= limit) continue; evict(id, i)` uses only the block's top edge; EVICT_SCREENS=20 line 19)
  - expected: A block that intersects the viewport (or the ±20H band) must stay mounted; scrolling into the middle of a 2000-line code block shows the code; typing inside it shows the updated code.
  - actual: 2000-line fence = 55.5 screens tall: 39/40 samples over 4 s are `.md-block.is-pending` with textContent length 0; all three elementFromPoint probes over the preview viewport hit the empty wrapper. 1500-line paragraph (50.6 screens): 39/39 samples empty. After typing inside the fence (editor-driven sync) it mounts once (~400 ms) and is evicted again 500 ms later, ending empty. Standalone 50k-line fence: mounted at t=0, empty from t=507 ms on, never re-requested (htmlMsgsDelta 0). The block's top is > 20H above scrollTop so runEvict evicts it even though it spans the viewport; the height is pinned so the user sees a blank area exactly where they are reading.
  - repro: node bench/verify/s12b_realistic_tall_block.mjs (medium.md + one 2000-line ```ts fence and one 1500-line paragraph inserted mid-doc; preview.scrollToLine into the middle of each, sample for 4 s; then cursor into its middle + one keystroke). Also node bench/verify/s12_tall_block_eviction.mjs (50k-line fence, 30k-item list, 20k-line paragraph) and s09b_followups.mjs (1).
  - fix: In runEvict measure the distance from the viewport to the block's interval [tops[i], tops[i]+heights[i]] (0 when it intersects [rel-limit, rel+limit]) instead of to tops[i]; additionally never evict indices in [winFirst, winLast]. Add s12b as a regression test (P8-style).
- **[medium] Switching to preview mode loses the reading position: both panes jump to line 1 (split->preview, edit->preview, Mod-/ cycle)**
  - file: src/app/App.ts applyMode (~line 348-360): `layout.setMode(m)` hides the editor (display:none resets scrollDOM.scrollTop to 0) BEFORE `sync.syncNow(prev === 'preview' ? 'preview' : 'editor')` reads editor.topVisible(); src/preview/scrollSync.ts syncNow
  - expected: SPEC §8: on mode change the shown pane lands on the same line — preview top ≈ line 7990; returning to split keeps ~8000 in both panes.
  - actual: split->preview: preview.topVisible() = 1 (scrollTop 32), editor scrollTop 0. preview->split afterwards: editor line 1, preview line 1. edit->preview: preview line 1. Mod-/ from split: preview line 1. 50 rapid cycles (10 ms or 100 ms) also end at line 1. split->edit keeps the editor (7991) — only transitions that hide the editor lose it. Cursor line survives (8000) but the viewport does not.
  - repro: node bench/verify/s10c_toc_hidden_and_preview_switch.mjs (2) and s10b_layout_and_mode_position.mjs (2). Steps: ?doc=/test-data/medium.md&mode=split, editor.gotoLine(8000) (editor top 7990, preview top 7993), then __mdr.mode('preview') or press Mod-/.
  - fix: In applyMode capture the master position before hiding anything: `const pos = prev==='preview' ? preview.topVisible() : editor.topVisible()` (or call sync.syncNow(prev-pane) BEFORE layout.setMode), then after setMode/setVisible position the shown pane from `pos`; alternatively let editor.setVisible(false) cache scrollTop and restore it in setVisible(true) before requestMeasure.
- **[medium] Draft autosave silently stops after a renderer (worker) restart**
  - file: src/app/workerClient.ts restart() (~line 130-142: re-sends `api.setDoc(...)` but never `draft('enable')`), src/worker/draft.ts (new worker starts with enabled=false), src/app/App.ts (draft('enable') only in openFile)
  - expected: After the restart the worker keeps autosaving: IDB draft version === editor version (35) within ~1 s of the last edit; flush on hidden writes the current text.
  - actual: IDB still holds version 14 (the pre-restart draft); no `draftSaved` message after the restart (draftSavedVersions=[14]); the flush on visibilitychange also writes nothing. All edits after a restart are unprotected until the next file open; a crash/reload afterwards loses them (and the recovery toast would offer the stale v14 text for real files).
  - repro: node bench/verify/s07_worker_kill.mjs section (B). Steps: ?doc=/test-data/medium.md&mode=split, type (draft v14 lands in IDB), dispatch an ErrorEvent('error') on the Worker (or terminate it) → toast 渲染器已重启, keep typing to version 35, wait 2.5 s, read IDB key mdr.draft:text:medium.md; also fire visibilitychange→hidden (flush).
  - fix: In workerClient.restart() after `api.setDoc(d.docId, d.version, d.text)` also `post({type:'draft', action:'enable'})` when drafts were enabled (track the last draft action in the client), or have App re-issue `w.draft('enable')` in onError(T.rendererRestarted)/onRestart. Add an assertion to s07 (B).
- **[medium] 50k-heading document: each keystroke inside a heading triggers ~200 ms main-thread long tasks (TOC rebuild)**
  - file: src/preview/toc.ts setOutline (full rebuild of 50k anchors on every outline change), src/app/App.ts onOutline
  - expected: SPEC P4: no main-thread task > 50 ms after load; typing in a heading should cost a few ms (outline diff is O(window)).
  - actual: 10 keystrokes → 21 long tasks, max 207 ms (loadText of the same doc: 3 long tasks max 205 ms). keydown→rAF p95 stays 25 ms because the rebuild lands after the frame, but the UI stalls ~200 ms per keystroke. With 3000 headings (large.md-like) it is 0 long tasks / max 0 ms, so only very large outlines are affected.
  - repro: node bench/verify/s09b_followups.mjs (3) and s09_edge_docs.mjs [headings50k]. Steps: loadText of 50000 lines `#..###### Heading i`, gotoLine(25000, col 12), type 10 characters.
  - fix: Make TocApi.setOutline incremental (patch only changed entries — the outline diff is already known to the worker) or rebuild in rAF slices / virtualise the TOC list when entries > ~5k; at minimum debounce the rebuild while typing continues.
- **[low] Multi-cursor editing is not enabled (allowMultipleSelections missing): dispatching several ranges collapses to one cursor, Alt+click cannot add cursors**
  - file: src/editor/createEditor.ts (~line 70-90 extension list: drawSelection() present, EditorState.allowMultipleSelections.of(true) absent)
  - expected: 3 (resp. 50) copies of the typed text; worker mirror equal to a fresh render (which it is for the single copy).
  - actual: Only 1 copy inserted (count=1 in both cases) — CM keeps just the main range. Not required by SPEC §7's extension list, so reported as polish; single-transaction multi-change edits (200 changes) do stay in sync with the worker.
  - repro: node bench/verify/s06_multicursor.mjs (a) and (c): view.dispatch({selection: EditorSelection.create([cursor(l10), cursor(l300), cursor(l800)])}) then keyboard.type('MULTI ').
  - fix: Add `EditorState.allowMultipleSelections.of(true)` (drawSelection already handles rendering) if multi-cursor is wanted; otherwise document it as unsupported.
- **[low] 1 MB single line: every keystroke costs ~85-90 ms of main-thread time (40 long tasks for 40 keystrokes)**
  - file: src/editor/createEditor.ts (EditorView.lineWrapping on a 1 MB line; CM/Chrome line layout), src/preview/createPreview.ts giant mount
  - expected: Input latency < 100 ms (robustness bar) — met; SPEC P5 budget is < 5 ms p95 main-thread per keystroke.
  - actual: keydown→next-frame p50/p95/max = 88.5/90.1/92 ms at end of line, 81.2/82.9/88.7 ms at start; 40 long tasks (max 91 ms) for 40 keystrokes; typing 40 chars takes 3.5 s wall. Editor does not hang and the 1 MB paragraph does mount (len 1000083).
  - repro: node bench/verify/s09b_followups.mjs (4): loadText('word '.repeat(200000)+'END'), type 40 chars at col 1000003 and at col 0.
  - fix: Consider disabling line wrapping / switching to a plain-text mode for lines beyond ~100k chars (CM's wrapped-line layout is the cost), or at least document the limit.
- **[low] edit->split: preview lands ~40 lines below the editor's top line after the editor pane is re-shown**
  - file: src/preview/scrollSync.ts syncNow / settle passes, src/app/App.ts applyMode
  - expected: Preview top line within a block of the editor top line (P10 ≤ 1 block).
  - actual: editor top 7991, preview top 8031 (scrollTop 235997) after the switch, consistently in three runs.
  - repro: node bench/verify/s10c_toc_hidden_and_preview_switch.mjs (2) 'edit->split' and s10b (2) 'split->edit->split'. Steps: medium.md split, gotoLine(8000), mode('edit'), mode('split').
  - fix: After sync.setEnabled(true) on return to split, run syncNow('editor') once more on the next frame after the preview has re-measured (the estimate→measured height delta of the newly mounted window shifts the target); or treat the ±1-block error as acceptable and note it.

### Measurements (32)

| name | value | target | pass |
|---|---|---|---|
| s01 2000-char typing burst (medium.md): input latency p95 / max (ms) | 15.7 / 18.3 | < 100 | ✅ |
| s01 burst: incremental preview == fresh render (6051 blocks) | 0 diffs, 0 long tasks > 100 ms | identical | ✅ |
| s02 typing while huge.md (340k lines) renders: edits lost / latency p95 (ms) | 0 lost / 15.2 | 0 / < 100 | ✅ |
| s03 large.md select-all+delete → undo: text exact, blocks 30002→0→30002 | exact; undo 30 ms wall, 1 long task 100 ms | exact | ✅ |
| s04 6 MB paste: dispatch ms / latency p95 after (ms) / time to idle (ms) | 58.3 / 21.6 / 565 | < 500 / < 100 / < 20000 | ✅ |
| s05 replace-all 1000 matches: tiling + TOC + fresh-render equality | 3000 blocks tile, TOC 1000, 0 diffs, 0 long tasks | consistent | ✅ |
| s06 200-change single transaction: worker mirror == fresh render | 0 diffs (137 blocks) | 0 diffs | ✅ |
| s06 multi-cursor typing: copies inserted with 3 / 50 cursors | 1 / 1 | 3 / 50 | ❌ |
| s07 worker error → restart + toast + preview recovery | restart in < 300 ms, toast 渲染器已重启, visible pending 0/9 | restart, toast, recover | ✅ |
| s07 silent terminate → detection after an edit (ms) | 10041 | ≈ 10000 (10 s silence) | ✅ |
| s07 draft version in IDB after restart vs editor version | 14 vs 35 | equal | ❌ |
| s07 give-up after 3 restarts/min: toast + editor usable + no further spawns | 渲染器多次崩溃 toast, typing ok, workers 4→4 | as spec | ✅ |
| s08 indexedDB undefined / open() throws: load, type, recent menu, flush | all ok, p95 15.4 / 15.3 ms, 0 errors | no errors | ✅ |
| s09 edge docs (empty, whitespace, 1 char, CRLF, 100k empty lines, 50k headings, 50k-line fence, 50-level list, 1 MB line, garbage+lone surrogates, RTL, emoji, unclosed fence): console/page errors, restarts | 0 / 0 / 0 across 15 docs | 0 | ✅ |
| s09 50k headings: TOC entries / collapsed | 50000 / true (s09c) | 50000 / collapsed | ✅ |
| s09b closing an unclosed fence at line 2 (35k-line doc): latency max / long tasks > 100 ms / blocks | 14.9 ms / 0 / 15001 | < 16 ms p95 / ≤ 1 | ✅ |
| s09b 50k headings, typing in a heading: long tasks per 10 keystrokes (count / max ms) | 21 / 207 | 0 > 50 ms (P4) | ❌ |
| s09b 3k headings, typing in a heading: long tasks (count / max ms) | 0 / 0 | 0 > 50 ms | ✅ |
| s09b 1 MB single line: keystroke latency p95 (ms) end / start of line | 90.1 / 82.9 | < 100 | ✅ |
| s10 500 px viewport: horizontal page overflow / typing latency p95 (ms) | none / 20 | none / < 100 | ✅ |
| s10b/s10c editor pane width with TOC hidden @1400 px / @900 px / edit mode TOC closed (px) | 0 / 0 / 0 (preview 6 px) | > 150 | ❌ |
| s10 hidden tab → typing → visible: preview catches up, draft version | ok, draft v39 == editor v39 | ok | ✅ |
| s10 reload mid-edit (untitled): draft offered / restored text exact / discard clears | yes / 83 == 83 chars / yes | yes | ✅ |
| s10 50 mode switches: long tasks (count / max ms) / final mode DOM consistent | 0 / 0 / consistent | < 50 ms (P12) | ✅ |
| s10c split→preview: preview top line (from editor line 7990) | 1 | ≈ 7990 | ❌ |
| s10 50 theme flips: long tasks (count / max ms) / final theme / persisted | 0 / 0 / light == start / mdr.theme=light | < 50 ms (P12) | ✅ |
| s11 heap after 10 load/unload cycles of large.md vs baseline (MB) | 9.8 vs 8.5 (×1.15); 0.04 MB/cycle | within +30 % | ✅ |
| s11 leftover .md-block wrappers / listeners after unload / Workers created | 0 / 126 == 126 / 1 | 0 / stable / 1 | ✅ |
| s12b 2000-line fence inside medium.md, scrolled into its middle: samples empty over 4 s | 39 / 40 (block 55.5 screens tall) | 0 | ❌ |
| s12b 1500-line paragraph inside medium.md, scrolled into its middle: samples empty over 4 s | 39 / 39 (50.6 screens) | 0 | ❌ |
| s12 standalone 50k-line fence / 30k-item list / 20k-line paragraph: stays mounted mid-block | empty from 507 ms on / never mounted / never mounted | mounted | ❌ |
| Console errors + page errors across all 17 scripts | 0 + 0 | 0 | ✅ |

## Lens (agent ac645b134d9495fc2)

Rendering-correctness verification of MDReader against markdown-it (same options) on a ~60-fixture corpus plus outline/stats/interaction/export checks. All scripts live under /Users/zyx/LocalDocuments/MDReader/bench/verify/ and need a dev server: `cd /Users/zyx/LocalDocuments/MDReader && (lsof -ti:5202 | xargs kill -9); npx vite --port 5202 --strictPort &` then `node bench/verify/<script>.mjs`. Server was killed afterwards; no processes left (the headless Chromiums still alive belong to the concurrent perf-lens script p11-p12-undo-mode.mjs).

What is solid: 42/54 corpus fixtures are semantically identical to markdown-it (headings, emphasis, links incl. far-away/late/case-insensitive reference definitions, images, ordered/nested/loose lists, task lists, fences ts/py/json/unknown/tilde/nested, tables with alignment, nested quotes with lists, hr, inline HTML incl. <img width>, multi-line <pre>/<table>/comments, CJK, heading right after a paragraph, blank-separated list items stay one list, fences with blank/'#' lines, unclosed fence, CRLF, trailing blanks, empty doc, escapes, lazy continuation, hard breaks, entities); the 20k one-line-block document (140,000 canonical lines) renders identically to markdown-it with a correct 2500-entry TOC; all 25 XSS payloads (script, onerror, javascript:/vbscript:/entity-encoded links, svg onload, ontoggle, iframe/object/embed/form/style/meta/base, DOM clobbering, checkbox onclick) are neutralised in the preview; TOC slug dedupe (-1/-2, CJK slugs) and live outline updates work; status-bar chars/words(CJK+latin)/reading minutes match independent counts on 8 fixtures and running totals after typing; editing a reference definition updates viewport links in ~38 ms and blocks scrolled into view later / after mountAll all use the new definition (deleting the definition reverts them in < 250 ms); export HTML contains every heading with deduped ids equal to the in-app slugs, hljs-highlighted ts/py code, resolved refs, KaTeX, tasks, tables; checkbox toggles round-trip through the source for -,*,+,ordered,nested,loose items and undo works.

Defects found (details in findings): HIGH — a 1 MB single paragraph freezes the main thread for ~33 s when its PLAIN fallback is mounted (and ~32 s again after each edit settles); attributed with a standalone probe to Chromium laying out a 1 MB line under `white-space: pre-wrap` (18.5 s) versus 1.3 s in a normal <p>. MEDIUM — <details>/<div align=center> README pattern renders the inner markdown outside the container (never collapsible/centred; SPEC §13 lists this as an accepted deviation, flagged anyway because it is ubiquitous); exported HTML executes <script>/onerror from the source when opened (preview sanitises, export does not) and is not standalone (KaTeX CSS from cdn.jsdelivr.net, formulas shown twice offline); task checkbox inside a blockquote does not toggle the source (DOM checkbox and source desync); text after a closing `$$` is silently dropped; indented code containing a blank line is split into two <pre>; an ATX heading indented inside a list item splits the list; a '#' line inside a <div> HTML block becomes an <h1>; reference definitions inside a fence/<pre> are honoured. LOW — ref definition right after a paragraph line honoured; multi-line ref definitions (title/URL on next line) lost; TOC text shows raw inline HTML/entities and image alt; 3-line setext heading missing from the TOC. Two failures reported by the earlier partial scripts turned out to be harness artefacts (big.mjs `startsWith('XYZ')`, interact.mjs ref-deletion wait racing the cursor-follow scroll) and are not reported.

### Findings (14)

- **[high] 1 MB single paragraph: main thread frozen ~33 s when the PLAIN block mounts (preview blank meanwhile), and ~32 s again after typing**
  - file: src/preview/createPreview.ts (PLAIN mount as pre.md-code--plain > code) / src/styles/preview.css:189 (`pre.md-code--plain code { white-space: pre-wrap }`) / src/shared/types.ts:30 (maxHtmlChars 200000)
  - expected: SPEC 4.4/5.5/§9: a block > maxHtmlChars is mounted as PLAIN text via textContent, deferred 500 ms after it is stable; SPEC §11 pathological.md includes a 5 MB paragraph and P7 allows at most one task > 100 ms for a giant block. The 1 MB text should appear within ~1-2 s and the UI stay responsive.
  - actual: Worker idle after 1078 ms, but the wrapper stays .is-pending for 35080 ms; longtask entries: 604 ms, 443 ms, then one of 33511 ms (main thread fully frozen). After typing 5 characters in split mode another 31976 ms long task occurs (re-mount of the giant block). Standalone probe with the same CSS: laying out the 1 MB text in `pre > code {white-space:pre-wrap; overflow-wrap:anywhere}` takes 18544 ms (300 KB: 1397 ms, 100 KB: 161 ms — superlinear), while the same text in a normal-wrapping <p> takes 1272 ms (300 KB: 126 ms). Keystroke→next-frame is ~420-490 ms in BOTH edit and split mode, so that part is CodeMirror's handling of a 1 MB line, not the preview. Note the paragraph is also shown as raw markdown (no **bold**/links) because it exceeds maxHtmlChars, which is spec-conformant (markdown-it renders it in 80 ms in node).
  - repro: node bench/verify/big-para2.mjs (then node bench/verify/layout-probe.mjs for the attribution). Loads '# Big paragraph\n\n<1 MB CJK+latin paragraph>\n\n## After\n\ntail', polls block 2's class and PerformanceObserver longtask; then types 5 chars in edit and split mode.
  - fix: Do not mount giant Prose/List/Quote blocks in a <pre>: use a normal-wrapping element (div/p with white-space:normal, overflow-wrap:anywhere) and split the text into several block-level chunks (e.g. one <p> per ~32-64 KB, or per source line) so each is laid out independently; keep <pre> only for Code-kind PLAIN blocks. Optionally raise maxHtmlChars for Prose and render markdown normally (80 ms/MB in the worker) since the layout cost, not markdown-it, is the bottleneck.
- **[medium] <details>/<div align=center> README pattern: markdown between the HTML tags is rendered outside the container (never collapsed / not centred)**
  - file: src/worker/segmenter.ts (blank line ends a block; only pre/script/style/textarea/comment tracked as HTML1) — SPEC §13 lists 'HTML blocks spanning blank lines' as an accepted deviation
  - expected: markdown-it (whole document): <details><summary>Show more</summary><p>HIDDEN-PARAGRAPH</p></details> — paragraph hidden while the details is closed; CENTERED-PARA inside the div with text-align:center.
  - actual: Blocks: '<details> <summary>Show more</summary> </details>', '<p>HIDDEN-PARAGRAPH</p>', '', '<div align="center"> </div>', '<p>CENTERED-PARA</p>'. details.open=false yet the paragraph has a 28 px visible height (insideDetails=false); CENTERED-PARA computed text-align is 'start'. Nested <details> flatten the same way.
  - repro: node bench/verify/render-extra.mjs (checks 1-2) and node bench/verify/render.mjs fixtures 'inline html', 'details with markdown inside (README pattern)', 'div align=center with blank lines inside', 'nested details'. Fixture: '<details>\n<summary>Show more</summary>\n\nHIDDEN-PARAGRAPH\n\n</details>\n\n<div align="center">\n\nCENTERED-PARA\n\n</div>\n'
  - fix: Treat an HTML block whose first line opens a container element (details/div/section/figure/table/…) without closing it as an HTML1-like state that ends at the matching closing-tag line (`</details>` at indent ≤ 3) so the whole container is one block, or post-process on mount: when a block ends with an unclosed container tag, adopt the following blocks until the block that holds its closing tag.
- **[medium] Exported HTML executes <script> / onerror handlers from the markdown source (preview sanitises, export does not)**
  - file: src/app/App.ts:469-476 (exportHtml) / src/worker/core.ts exportHtml (md.render with html:true, unsanitised)
  - expected: Exported document carries the same sanitised content as the preview (no <script>, no on* attributes) — a markdown file from an untrusted source should not become an executable HTML file with a file:// origin on export.
  - actual: document.title === 'PWNED-xss-export' and body.dataset.pwned === '1' after opening the exported file; the file contains the inline <script> and IMG[onerror] verbatim (javascript: links are neutralised by markdown-it itself).
  - repro: node bench/verify/export-xss.mjs — loads '# T\n\n<script>document.title = "PWNED-" + document.title</script>\n\n<img src=x onerror="document.body.dataset.pwned = \'1\'">', runs registry.run('file.exportHtml'), writes the download to a file and opens it via file://.
  - fix: Run the exported HTML through the same DOMPurify configuration (sanitize.ts) on the main thread before wrapping it in the template (RETURN_DOM_FRAGMENT → serialize), or at least strip script/style/on*/iframe/object/embed/form in the worker's exportHtml.
- **[medium] Exported HTML is not standalone: KaTeX stylesheet is loaded from cdn.jsdelivr.net, formulas render twice when offline**
  - file: src/app/App.ts:101-102 (buildExportDocument adds <link rel=stylesheet href="https://cdn.jsdelivr.net/npm/katex@0.18.5/dist/katex.min.css">)
  - expected: SPEC §8: exportHtml 'wraps in a standalone template with inlined CSS (?inline imports)'. No external resources; KaTeX output (htmlAndMathml) needs katex.min.css to hide .katex-mathml.
  - actual: link[href] = https://cdn.jsdelivr.net/npm/katex@0.18.5/dist/katex.min.css; offline the .katex-mathml span has display:inline (18 px tall) next to the .katex-html span, so the visible text reads '𝐸=𝑚𝑐2 E=mc2' and '∫01𝑥𝑑𝑥 ∫01xdx' — every formula shown twice, unstyled.
  - repro: node bench/verify/render-extra.mjs (check 7) — exports '# M\n\nInline $E=mc^2$ and\n\n$$\n\\int_0^1 x\\,dx\n$$' and opens the file in a page with cdn.jsdelivr.net requests aborted.
  - fix: Inline katex/dist/katex.min.css via `?inline` (fonts as data: URIs or accept system fallback), or at minimum add a `.katex-mathml{position:absolute;clip:rect(1px,1px,1px,1px);…}` fallback rule in the export template so an offline copy shows the formula once.
- **[medium] Task checkbox inside a blockquote does not toggle the source; preview checkbox and source disagree afterwards**
  - file: src/editor/commands.ts:26 (TASK_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\[( |x|X)\]/ — no `>` prefix) / src/editor/createEditor.ts:144 applySourceEdit
  - expected: SPEC 5.6: change → source:edit toggleTask → the editor toggles the first [ ]/[x] on that line → source becomes '> - [x] task in quote' and the block re-renders checked.
  - actual: Source line unchanged ('> - [ ] task in quote') while the DOM checkbox is now checked (wasChecked:false → domChecked:true); no re-render, so the preview silently shows a state the document does not have.
  - repro: node bench/verify/render-extra.mjs (check 2) or node bench/verify/interact.mjs ('task toggle: line 9'). Fixture '> - [ ] task in quote'; click the rendered checkbox.
  - fix: Let TASK_RE/LIST_MARK_RE skip any number of blockquote prefixes: /^\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])\s+\[( |x|X)\]/; and when applySourceEdit finds no toggle target, re-request the block so the checkbox snaps back.
- **[medium] Text after a closing `$$` is silently dropped from the preview**
  - file: src/worker/math.ts:115-146 (mathBlock: `first = first.slice(0, close)` and `last = line.slice(0, idx)` discard everything after the closer)
  - expected: Either the trailing text is rendered as a paragraph after the display math (VS Code / markdown-it-katex behaviour for a same-line closer), or the line is treated as inline math inside a paragraph — never lost.
  - actual: Preview textContent is 'x2x^2 x2 / a=ba = b a=b / end': both TRAILING-SAME-LINE and TRAILING-AFTER-CLOSER are absent from the DOM.
  - repro: node bench/verify/render-extra.mjs (check 3). Fixture '$$x^2$$ TRAILING-SAME-LINE\n\n$$\na = b\n$$ TRAILING-AFTER-CLOSER\n\nend'
  - fix: In mathBlock, if the opening line contains a closer with non-blank text after it, fall through (return false) so the paragraph/inline rule handles `$$…$$ text`; for a closing line with trailing text, push a paragraph token (or re-inject the remainder as a new line) instead of discarding it.
- **[medium] Indented code block containing a blank line is split into two <pre> blocks**
  - file: src/worker/segmenter.ts (blank line = boundary; glue only for List indent ≥ 2 and Quote; a block starting with 4 spaces is kind Prose)
  - expected: markdown-it: one <pre><code>indented code line 1\n# not a heading\n\nafter blank still code</code></pre>
  - actual: Two separate <pre><code> elements ('indented code line 1 # not a heading' and 'after blank still code'), i.e. an extra visual gap/box in the middle of one code block.
  - repro: node bench/verify/render.mjs — fixture 'indented code': 'para\n\n    indented code line 1\n    # not a heading\n\n    after blank still code\n\npara2\n'
  - fix: Add a glue rule: when the block's first line is indented ≥ 4 spaces (or a tab) and the next non-blank line is too, do not end the block at the blank line.
- **[medium] ATX heading indented inside a list item breaks the list apart**
  - file: src/worker/segmenter.ts (rule 3: `/^ {0,3}#{1,6}(\s|$)/` starts a new block even when the line is a list-item continuation)
  - expected: markdown-it: <ul><li><p>item</p><h1>heading in item</h1></li><li><p>item2</p><h2>h2 directly</h2></li></ul> (one list).
  - actual: <ul><li>item</li></ul><h1>heading in item</h1><ul><li>item2</li></ul>… — the list is cut into two lists with a top-level h1/h2 between them, and the headings appear in the TOC as top-level entries ('heading in list (2 spaces)' in outline-stats.mjs).
  - repro: node bench/verify/render.mjs — fixture 'heading indented inside list item': '- item\n\n  # heading in item\n\n- item2\n  ## h2 directly\n'
  - fix: In rule 3 only split on a heading line when the current block is not a List (or when the heading's indent is < the list's content indent).
- **[medium] '#' line inside a <div> HTML block (no blank lines) is split out and rendered as an <h1>**
  - file: src/worker/segmenter.ts (HTML kind only suppresses heading splitting for pre/script/style/textarea/comment; CommonMark type-6 blocks like <div> end only at a blank line)
  - expected: markdown-it: <div>\n# inside div\n</div> (raw text inside the div; no heading) followed by <div><h1>real heading after blank</h1></div>.
  - actual: '<div></div><h1>inside div</h1>' plus '<div></div><h1>real heading after blank</h1>' — the first '#' line becomes a real heading (also in the TOC). This case has no blank lines, so it is not the SPEC §13 accepted deviation.
  - repro: node bench/verify/render.mjs — fixture 'div html block containing # line': '<div>\n# inside div\n</div>\n\n<div>\n\n# real heading after blank\n\n</div>\n'
  - fix: When a block's first line matches the HTML kind (`/^ {0,3}<[a-zA-Z!/?]/`) and the block has not yet hit a blank line, do not apply rule 3 (headings) inside it.
- **[medium] Reference definitions inside a code fence or <pre> are honoured as definitions**
  - file: src/worker/segmenter.ts / core.ts (hasRef = /^ {0,3}\[[^\]]+\]:\s/m on the raw block source, and refs rebuilt from every matching line regardless of Code/Html kind)
  - expected: markdown-it: 'use [x] here' / 'use [y] here' stay literal text (a definition inside a fence/pre is code).
  - actual: 'use <a href="https://example.com/fence">x</a> here' and 'use <a href="https://example.com/pre">y</a> here'. (Indented-code case is handled correctly.)
  - repro: node bench/verify/render-extra.mjs (check 4). Fixtures '```\n[x]: https://example.com/fence\n```\n\nuse [x] here\n' and '<pre>\n[y]: https://example.com/pre\n</pre>\n\nuse [y] here\n'
  - fix: Compute hasRef only for blocks whose kind is not Code/Html (and skip lines inside a fence/HTML1 region when collecting definition lines).
- **[low] A definition line directly after a paragraph line is treated as a reference definition (CommonMark: it cannot interrupt a paragraph)**
  - file: src/worker/core.ts refs rebuild (definition lines are parsed in isolation from their block)
  - expected: markdown-it: <p>text [notref]: <a href="https://example.com/n">https://example.com/n</a></p><p>use [notref]</p>
  - actual: <p>text <a href="https://example.com/n">notref</a>: <a>https://example.com/n</a></p><p>use <a href="https://example.com/n">notref</a></p> — the paragraph text itself becomes a link and the later shortcut reference resolves.
  - repro: node bench/verify/render.mjs — fixture 'ref definition immediately after paragraph': 'text\n[notref]: https://example.com/n\n\nuse [notref]\n'
  - fix: Only collect a definition line when it is the first line of its block or the previous line is blank / another definition (i.e. it starts a paragraph).
- **[low] Multi-line reference definitions lose the title (next line) or the whole definition (URL on the next line)**
  - file: src/worker/core.ts refs rebuild (only the lines matching the definition regex are concatenated; continuation lines are dropped) — SPEC §13 accepts multi-line titles
  - expected: <a href="https://example.com/a" title="Title on next line">a</a>; <a href="https://example.com/b">b</a>
  - actual: First: link without title attribute. Second: '[b]' stays plain text (unresolved).
  - repro: node bench/verify/render.mjs — fixtures 'link reference with title on next line' ('[a]\n\n[a]: https://example.com/a\n  "Title on next line"\n') and 'multi-line ref definition url on next line' ('[b]\n\n[b]:\n  https://example.com/b\n')
  - fix: When collecting definition lines, also include following indented/quoted continuation lines up to the next blank line, and let markdown-it's reference rule parse the group.
- **[low] TOC entries show raw inline HTML and entities of the heading source; image alt text is prepended**
  - file: src/worker/outline.ts (text = first line stripped of #, *_~`, [text](url) only)
  - expected: TOC text equal to the rendered heading text: 'A & B c & # d' and 'with image' (image alt is not visible text).
  - actual: TOC items read 'A & B <b>c</b> &amp; \# d' (literal tags/entities, slug 'a--b-bcb-amp--d') and 'img with image'. Export ids use the same slugs, so anchors stay consistent; only the visible TOC text is wrong.
  - repro: node bench/verify/render-extra.mjs (check 6) / node bench/verify/outline-stats.mjs. Headings '##### A & B <b>c</b> &amp; \\# d' and '# ![img](https://x.y/i.png) with image'
  - fix: Strip tags (`<[^>]+>`), decode common entities, drop `![alt](url)` and unescape backslash escapes when building the outline text (keep the slug derivation in sync with exportHtml).
- **[low] Setext heading whose paragraph spans more than one line is rendered as <h1> but missing from the TOC**
  - file: src/worker/outline.ts / segmenter.ts rule 4 (only exactly-2-line setext blocks) — SPEC §13 accepted deviation
  - expected: TOC lists both headings (the preview shows H1 'first line second line' and H1 'ATX').
  - actual: TOC contains only 'ATX'; navigating to the first heading via the TOC or an anchor is impossible.
  - repro: node bench/verify/outline-stats.mjs ('outline: multi-line setext heading missing from the TOC'). Fixture 'first line\nsecond line\n==========\n\n# ATX\n'
  - fix: Detect setext by 'last line matches /^ {0,3}(=+|-+)\s*$/ and the block has ≥ 2 lines and is Prose kind'; text = the preceding lines joined by a space.

### Measurements (20)

| name | value | target | pass |
|---|---|---|---|
| Corpus fixtures semantically equal to markdown-it (render.mjs) | 42 of 54 checks pass (12 diffs listed as findings) | all equal except documented sanitisation | ❌ |
| 20k one-line blocks: preview equals markdown-it (big.mjs) | identical (140,000 canonical lines), 20000 blocks, 2500 TOC entries, last entry correct | identical | ✅ |
| 20k one-line blocks: loadText → worker idle / all blocks mounted (big.mjs) | 179 ms / 1744 ms | P3 idle < 20 s (informational) | ✅ |
| 1 MB paragraph: loadText → worker idle (big-para2.mjs) | 1078 ms | informational | ✅ |
| 1 MB paragraph: loadText → giant block content mounted (big-para2.mjs) | 35080 ms, with one 33511 ms main-thread long task | PLAIN mount deferred 500 ms after stable (~1-2 s); P7 ≤ 1 task > 100 ms | ❌ |
| 1 MB paragraph: long tasks while typing 5 chars in split mode (big-para2.mjs) | 8 tasks, max 31976 ms | P7: ≤ 1 task > 100 ms | ❌ |
| 1 MB paragraph: keystroke → next frame, edit mode (preview hidden) / split mode (big-para2.mjs) | max 439 ms / 492 ms (editor cost, same in both modes) | < 16 ms | ❌ |
| 1 MB paragraph: last keystroke → preview shows typed text (big-para2.mjs) | ≈ 1.5 s (after the ~32 s freeze) | informational | ✅ |
| Standalone layout of 1 MB single line: pre-wrap (app CSS) vs normal <p> (layout-probe.mjs) | 18544 ms vs 1272 ms (300 KB: 1397 vs 126 ms; 100 KB: 161 vs 19 ms) | attribution only | ❌ |
| 150 KB paragraph (below maxHtmlChars) rendered with inline markup (big.mjs) | 1250 <strong> elements, not plain | markdown rendered | ✅ |
| Reference-definition edit → link in viewport updated (interact.mjs) | 38 ms | < 1000 ms (eventually) | ✅ |
| Reference-definition deleted → visible blocks refreshed (render-extra.mjs) | < 250 ms (18 visible stale blocks → 0), blocks scrolled into view later also refreshed | eventually | ✅ |
| Definition added later resolves an earlier link after scrolling it into view (interact.mjs) | 38 ms after scroll | eventually | ✅ |
| Status-bar stats vs independent counts (outline-stats.mjs) | 8/8 fixtures exact (chars, CJK+latin words, reading minutes, empty doc hidden) + running totals after typing exact | exact | ✅ |
| XSS payloads neutralised in the preview (render.mjs) | 25/25 (no handler fired, no dangerous tags/attrs, __mdr intact, target=_blank has noopener) | 25/25 | ✅ |
| Task checkbox round-trip through the source (interact.mjs) | 9/10 lines toggle (-, *, +, ordered, nested, loose, with inline markup; undo restores); blockquote item fails | 10/10 | ❌ |
| Export HTML content (interact.mjs) | doctype+charset+<style>, 4 headings with ids export-title/section-a/section-a-1/中文-节, 3 code blocks with ts/py hljs spans, ref link, KaTeX, checkboxes, table; filename export-me.html; empty doc exports | all present | ✅ |
| Export HTML standalone / sanitised (interact.mjs, export-xss.mjs) | 1 external stylesheet (KaTeX CDN); inline <script> and IMG[onerror] present and executing on open | 0 external resources, no executable content | ❌ |
| TOC slug dedupe and anchor resolution (outline-stats.mjs) | #intro/#intro-1/#intro-2/#中文-标题 → lines 1/5/7/9; #missing → no nav; duplicate heading typed later gets -1 | correct lines | ✅ |
| Page errors / console errors across all scripts | 0 page errors, 0 console errors (fixture image 404s ignored) | 0 | ✅ |

## Lens (agent abc8016b7988669e7)

Features/UX verification of MDReader through the real UI (Playwright Chromium against my own vite server on :5203, since killed). I re-ran and finished the five partially written ux scripts (fixing six harness bugs in them: `page.mouse.click` silently ignores `modifiers` so Alt+click was never sent; CJK anchor hrefs are percent-encoded by markdown-it; in-page `File` objects had a fresh lastModified so the legacy draft could never be offered; localStorage touched on about:blank; init script ran before `<html>` existed and produced the 14 fake page errors; wrong CSS selector in the export check) and added five new ones. Every script captures console/page errors — the app itself produced none.

Confirmed defects: (HIGH) the main grid uses auto-placement, so preview mode renders a completely blank 0-px preview pane, and hiding the TOC or shrinking the window ≤ 900 px collapses the editor to 0 px with a 697-px gutter — preview mode and TOC-hidden split are unusable (screenshot grid-preview-mode.png). (MEDIUM) TOC/#anchor navigation into not-yet-mounted regions lands the heading up to 282 px off (−276 px = heading above the viewport); exact once blocks are measured, so it is the estimate-height settle logic. (MEDIUM) The dirty-guard dialog focuses 丢弃 and maps Enter to discard — one reflex keystroke destroys unsaved content. (MEDIUM) Cmd+F with focus in the preview does nothing (spec §13 says it is routed to the editor search). (MEDIUM) Editor→preview sync drift of 3 blocks / 5 lines at 1 of 20 random positions, stable after 1 s (P10 ≤ 1 block). (LOW) progress indicator tops out at 1 %; Backspace after list markers leaves invisible whitespace (upstream CM deleteMarkupBackward); undo groups toggle-wrap with the next keystroke; exported HTML links KaTeX CSS from a CDN; light-theme active TOC item contrast 3.97:1.

Everything else in SPEC §7/§8 works as specified: all shortcuts, toolbar state, mode buttons + persistence, ?mode=, TOC show/hide/active-follow/update-on-type, theme toggle persisted and stamped before first paint, palette (fuzzy filter, arrows, Enter, Esc, focus return, global shortcuts suppressed while open), zh-CN find/replace + goto line, bold/italic/code wrap/unwrap, link insertion incl. clipboard URL, headings, list continuation/Tab/Shift-Tab, task toggle from editor and preview, Alt+click, anchors (incl. CJK), external links new tab with noopener, relative-link toast, wheel/PageDown scroll sync both directions, cursor-follow, gutter drag persistence, drag & drop with dirty guard, title ●, status bar content, draft autosave/restore/discard/flush, legacy download save, export, 全部渲染, and visual sanity at 1400×900 / 1000×700 in light and dark (fonts, CJK line-height 28/16 px, no overlaps).

### Findings (10)

- **[high] Preview mode shows a blank 0-px preview pane; hiding the TOC or a window ≤ 900 px collapses the editor to 0 px (grid auto-placement shifts panes into hidden columns)**
  - file: src/styles/layout.css
  - expected: Preview mode: .mdr-pane--preview fills the main area (> 1000 px at 1400 px wide). Split with TOC closed (Mod-Shift-o): editor and preview each ≈ 697 px. Split at 800 px wide (TOC auto-collapsed by the media query): both panes ≈ 397 px.
  - actual: Preview mode (toc open): preview pane w=0 (x=240), page blank. Preview mode + toc closed: preview w=0. Split + toc closed at 1400 px: editor w=0, .mdr-gutter w=697, preview w=6. Split at 800×600: editor w=0, gutter w=397, preview w=6. Cause: .mdr-main uses grid-template-columns var(--toc-col) var(--edit-col) var(--gutter-col) var(--prev-col) with auto-placement; when .mdr-pane--toc / .mdr-pane--editor / .mdr-gutter get display:none the remaining items shift left into the 0-px columns. Edit mode works only because the hidden items are the trailing ones.
  - repro: node bench/verify/ux/06-grid.mjs (dev server: npx vite --port 5203 --strictPort). Also reproduced by bench/verify/ux/02-shell.mjs steps 'Mod-/ cycles…', 'Mod-/ works when focus is on the preview pane', 'Viewport resize keeps layout sane'. Screenshot: bench/verify/ux/shots/grid-preview-mode.png (toolbar + TOC, then an entirely empty page).
  - fix: Give each pane an explicit column: .mdr-pane--toc{grid-column:1} .mdr-pane--editor{grid-column:2} .mdr-gutter{grid-column:3} .mdr-pane--preview{grid-column:4} (or grid-template-areas). Re-run 06-grid.mjs and 02-shell.mjs afterwards; also re-check 'Switching preview→split keeps the same top line' (it currently passes vacuously because the 0-px preview cannot scroll).
- **[medium] TOC click / #anchor navigation lands the heading up to ±282 px from the preview top (off-screen) when the target region is not mounted yet**
  - file: src/preview/createPreview.ts (scrollToLine settle) + src/preview/scrollSync.ts (nav:gotoLine)
  - expected: After nav:gotoLine the target heading sits at the top edge of the preview (0 ± 4 px), like the editor cursor which lands on the correct line every time.
  - actual: Cold anchor click: heading at −276 px (above the viewport, invisible), preview.topVisible() line 317 vs target 305, 183 pending blocks. Cold TOC click: +282 px. Clicking the same target again (blocks mounted) → 0 px; after 全部渲染 (mountAll) → 0 px; editor-driven sync to the same line → −1 px. So the landing error is the cumulative estimate-vs-measured height error of blocks that mount after the one-frame re-check in scrollToLine.
  - repro: node bench/verify/ux/09-nav.mjs (150-paragraph doc; click the [跳到第二节](#第二节) link, then TOC item 第三节). Also bench/verify/ux/07-extra.mjs 'TOC click lands the heading at the preview top' on small.md (items #20/#33/#50 → +80.5 / −90 / +96 px) and bench/verify/ux/03-preview.mjs '#anchor link navigates both panes' (preview top line 291 vs target 308).
  - fix: Keep a pending navigation target (line, fraction) alive until the window settles: re-apply lineToScrollTop whenever applyHtml/ResizeObserver changes heights of blocks above the target (bounded to ~500 ms or until the next user scroll/idle), instead of a single next-frame re-check.
- **[medium] Dirty-guard dialog focuses the destructive 丢弃 button; pressing Enter discards unsaved content**
  - file: src/app/dialogs.ts
  - expected: With danger:true the default-focused button is 取消; Enter must not throw away the document (Mod-O/新建/drop → reflex Enter is a data-loss path).
  - actual: document.activeElement is '丢弃' (okBtn.focus()); the dialog keydown handler maps Enter → finish(true) regardless of focus; after Enter the document text is '' (content '重要内容' lost).
  - repro: node bench/verify/ux/07-extra.mjs step 'Dirty-guard dialog: pressing Enter immediately' (type text, click 新建, press Enter). Also bench/verify/ux/02-shell.mjs 'Dialog default focus is on the non-destructive button'. Screenshot bench/verify/ux/shots/dialog-toast-dark.png shows the focus ring on 丢弃.
  - fix: When o.danger, focus cancelBtn; let Enter activate the focused button only (remove the unconditional Enter → finish(true)), keep Escape → cancel.
- **[medium] Cmd+F with focus in the preview pane does not open the editor search panel (SPEC §13: 'Cmd+F is routed to the editor's search panel')**
  - file: src/app/shortcuts.ts / src/editor/commands.ts (edit.find registered with scope 'editor' only)
  - expected: .cm-search panel opens (zh-CN labels) with the editor focused.
  - actual: No panel appears within 1.5 s; the keystroke falls through to the browser's native find. Global shortcuts (Mod-/, Mod-Shift-o, Mod-Shift-l, Mod-Shift-p) do work from the same focus state, so only the editor-scope find is missing.
  - repro: node bench/verify/ux/10-final.mjs step 'Mod-b / Mod-f (editor-scope) with focus on the preview pane' and bench/verify/ux/07-extra.mjs 'Mod-f with focus in the preview pane'. Click inside .mdr-preview (focus lands on BODY), press Meta+f.
  - fix: In shortcuts.ts add a global fallback for Mod-f (and Mod-Alt-g) that, when the editor is visible but not focused, calls editor.focus() then registry.run('edit.find').
- **[medium] Editor→preview scroll sync drifts up to 3 blocks / 5 lines after settling (P10 target ≤ 1 block)**
  - file: src/preview/scrollSync.ts
  - expected: Block error ≤ 1 at every position (SPEC §11 P10).
  - actual: Max block error 3 (editor top line 17504 → preview top line 17509) at 1 of 20 positions, 2 at another; mean 0.60. Identical values at 350 ms and 1000 ms settle, so it is not transient. Preview→editor direction max 1; wheel-driven scrolling (20 screens each way) and PageDown×30 end at 0. Preview model vs DOM top block mismatches 0/20, so the drift is real layout drift after blocks mount (heights change after the follower was positioned and the master does not re-sync).
  - repro: node bench/verify/ux/07-extra.mjs step 'Editor→preview sync: 20 positions, 1 s settle' and bench/verify/ux/03-preview.mjs 'Editor → preview sync at 20 random positions' (medium.md, seeded LCG positions; wheel-elects the editor as master, sets scrollTop, waits 350 ms / 1000 ms, compares topVisible() of both panes via preview.blockAtLine).
  - fix: When measured heights change inside the current window while the editor is master and no user scroll is in flight, re-run one sync pass from the master (or extend the settle logic to fire again after applyHtml mounts).
- **[low] Render progress indicator only ever shows 渲染中 0% / 1% and then disappears**
  - file: src/app/App.ts (updateProgress: progressDone counts pushed HTML batch items; the worker only pushes blocks inside the auto-push window, background back-fill only warms the cache)
  - expected: Percentage rises monotonically toward 100% as the document renders (spec status bar example '渲染中 37%').
  - actual: 6 updates: '渲染中 0%', '渲染中 1%', then hidden on idle (417 ms). The number never reflects actual rendering progress.
  - repro: node bench/verify/ux/07-extra.mjs step 'Progress indicator reaches a meaningful percentage' (MutationObserver on [data-stat=progress] while loadUrl('/test-data/large.md')); also 03-preview 'Progress indicator'.
  - fix: Have the worker report rendered/total block counts (e.g. a periodic progress message or counts on each html/idle message) and drive the status bar from that.
- **[low] Backspace after a list/task marker leaves invisible indentation instead of removing the marker**
  - file: src/editor/keymap.ts (Backspace → @codemirror/lang-markdown deleteMarkupBackward)
  - expected: Per SPEC §8 table (Backspace = 删除标记): '- 乙' with the cursor after '- ' → '乙'; empty '- [ ] ' item → empty line.
  - actual: '- 乙' → '  乙' (2 leading spaces), second Backspace → '乙'. '- [ ] ' → 6 spaces (line looks empty but is whitespace), second Backspace → 2 spaces. This is upstream CodeMirror behaviour (marker replaced by blank space), so it may be an accepted deviation, but users get invisible whitespace and a stray continuation line.
  - repro: node bench/verify/ux/07-extra.mjs steps 'Backspace right after "- " on a list item' and 'Backspace on an empty task item'; also 01-editor 'Backspace removes list marker'.
  - fix: Wrap deleteMarkupBackward: when the cursor is directly after a list/task marker, delete the marker and its indentation entirely (fall back to the upstream command otherwise).
- **[low] Undo after cursor-only Mod-b (inserted ****) plus typing removes both the wrapper and the typed text in one step**
  - file: src/editor/commands.ts (toggle-wrap transactions are not isolated from the following input in history)
  - expected: First undo removes only 'x' leaving '普通段落 hello world****'.
  - actual: After one undo the line is '普通段落 hello world' (wrapper and typed char undone together because both happen within the 500 ms history group window and are adjacent).
  - repro: node bench/verify/ux/01-editor.mjs step 'Mod-b with cursor only inserts **** …' (Mod-b at end of line, type 'x', Meta+z).
  - fix: Dispatch the wrap transaction with annotations: [isolateHistory.of('full')] (or a distinct userEvent) so it forms its own undo step.
- **[low] Exported HTML is not standalone: KaTeX CSS is linked from cdn.jsdelivr.net**
  - file: src/app/App.ts (buildExportDocument)
  - expected: Spec §8: export 'wraps in a standalone template with inlined CSS (?inline imports)'; the file renders math offline.
  - actual: Output contains <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.18.5/dist/katex.min.css">; tokens/preview/hljs CSS are inlined, KaTeX is not, so math is unstyled without network access.
  - repro: node bench/verify/ux/04-files.mjs step 'Export HTML downloads a standalone .html' (document containing $E=mc^2$; inspect the downloaded exp.html).
  - fix: Inline katex/dist/katex.min.css via ?inline as well (accept the font limitation, or embed the woff2 fonts as data URIs behind a size check).
- **[low] Active TOC item text fails AA contrast in the light theme (3.97:1)**
  - file: src/styles/tokens.css / src/styles/preview.css (.mdr-toc__item.is-active colour)
  - expected: ≥ 4.5:1 for 13 px text (all other measured surfaces are ≥ 4.83:1; dark theme active item is 6.39:1).
  - actual: 3.97:1.
  - repro: node bench/verify/ux/05-visual.mjs 'Contrast' step (computed colour rgb(194,80,15) on rgb(239,235,227)); visible in bench/verify/ux/shots/split-light-1400x900.png (orange '子标题 1.1' on the beige highlight).
  - fix: Use a darker accent for text on the elevated/hover background (e.g. a --mdr-accent-text token) or keep the foreground colour and only tint the background.

### Measurements (27)

| name | value | target | pass |
|---|---|---|---|
| preview pane width in preview mode (1400 px, TOC open) | 0 px | > 600 px | ❌ |
| editor / gutter / preview widths, split + TOC closed (1400 px) | 0 / 697 / 6 px | ≈ 697 / 6 / 697 px | ❌ |
| editor / gutter / preview widths, split at 800×600 | 0 / 397 / 6 px | ≈ 397 / 6 / 397 px | ❌ |
| edit mode editor width (1400 px) | 1160 px | fills main area | ✅ |
| anchor click (cold) heading offset from preview top | -276 px | 0 ± 4 px | ❌ |
| TOC click (cold) heading offset from preview top | +282 px | 0 ± 4 px | ❌ |
| anchor/TOC click heading offset when blocks already mounted / after 全部渲染 | 0 px / 0 px | 0 ± 4 px | ✅ |
| editor→preview sync block error max (20 seeded positions, medium.md, 350 ms and 1000 ms settle) | 3 blocks (5 lines) | ≤ 1 block (P10) | ❌ |
| editor→preview sync block error mean | 0.60 | ≤ 1 | ✅ |
| preview→editor sync block error max (20 positions) | 1 | ≤ 1 | ✅ |
| preview model vs DOM top-block mismatches | 0 / 20 | 0 | ✅ |
| wheel editor 20 screens / wheel preview 20 screens / PageDown×30 — final block error | 0 / 0 / 0 | ≤ 1 | ✅ |
| edit → split mode switch keeps top line | editor 603 → preview 603 | ≤ 3 lines | ✅ |
| cursor-follow: preview shows the typed line after typing off-screen | visible within 900 ms | visible | ✅ |
| draft autosave latency (typing → 草稿已存) | 1029 ms | ≤ 1500 ms | ✅ |
| draft restore after reload (恢复 restores text, 丢弃 deletes, flush on hidden) | all pass | pass | ✅ |
| progress indicator max % before idle (large.md) | 1 % | ≈ 100 % monotone | ❌ |
| <html data-theme> at navigation commit with dark pref stored | dark (no flash; MutationObserver log shows no light stamp) | dark before first paint | ✅ |
| gutter drag: editor width change / --split persisted across reload | 577 → 377 px, --split=0.485fr, reload 377 px | −200 ± 12 px, persisted | ✅ |
| contrast light theme active TOC item | 3.97:1 | ≥ 4.5:1 | ❌ |
| contrast other surfaces (preview/editor text, gutter, status, code, link, toolbar) light + dark | 4.83 – 15.97:1 | ≥ 4.5:1 | ✅ |
| all SPEC §8 shortcuts (Mod-s/Shift-s/o, Mod-/, Mod-Shift-p/o/l, Mod-b/i/e/k, Mod-1..6/0, Mod-Shift-x, Mod-f/g/Shift-g/Alt-g, Enter/Tab/Shift-Tab in lists) | all trigger the right command (Mod-f only when the editor is focused) | per table | ✅ |
| search panel / goto-line / palette / dialog / toasts zh-CN text | no untranslated labels found | zh-CN | ✅ |
| console errors + page errors across all 10 scripts | 0 | 0 | ✅ |
| external link target/rel; relative link toast; Alt+click; checkbox write-back both ways; CJK percent-encoded #anchor resolves | all pass | pass | ✅ |
| legacy backend: Mod-o file chooser, Mod-s / Mod-Shift-s download names, 已下载 toast, export .html | pass (other.md, 未命名.md, exp.html) | pass | ✅ |
| 全部渲染 via palette mounts all blocks (medium.md) | 23 → 6002 of 6002 | all | ✅ |

## Lens (agent a10572b8bcfd25b9d)

Static review of every file under src/ plus targeted reproduction (Playwright on my own :5205 server, killed afterwards; vitest for unit-level evidence). tsc is clean and the 475-test suite (incl. the 300-seed fuzz of the render core) passes, so the worker's segmentation/identity/stats/outline/render logic is solid; the defects are in the editor configuration, the shell's mode/restart flows, the TOC, and export. Two HIGH: (1) typing anywhere except near the top of a 3 MB document costs 20–70 ms per keystroke persistently (P5 p95 86.5 ms vs 5 ms target, 10 long tasks in 120 keys) — isolated with a sampling profile and a standalone-view A/B/C to CodeMirror's Lezer markdown language parse (createEditor.ts:79); no language → 0 jank; fix = size-gated language Compartment. (2) applyMode hides a pane before syncing from it, and a display:none scroller reads scrollTop 0, so split→preview jumps the preview to line 1 and preview→edit lands the editor on line 1 (App.ts:345-361). MEDIUM: every Enter/Backspace/paste above the headings rebuilds all 6001 TOC anchors and forces layout via 6001 offsetTop reads (≈25 ms per keystroke, toc.ts:97-123); drafts silently stop after a worker restart because restart() never replays `draft enable` (workerClient.ts:125-142); exported HTML is unsanitised (script/onerror/iframe survive; core.ts exportHtml → App.buildExportDocument). LOW: AppHandle.dispose leaks the CM view + listeners; mid-document paste creates ~6k wrappers in one 54 ms task; html_block never gets data-l; ?perf=1 overlay's 100k-wrapper querySelectorAll janks huge.md; @codemirror/autocomplete and @lezer/common are undeclared deps; two colour literals in layout.css. Not reproduced (verified harmless, not reported): the identity-rule id-swap suspicion (resegmentation window rarely contains the twin), the never-pruned worker `dirty` set, exportHtml starving the silence watchdog (huge.md exports in 1.5 s, no restart). Other measurements: P1 large 160 ms pass, huge 409 ms marginal fail (2 %), P3/P4/P8/P9 pass, mount p95 0.5 ms, worker restart recovery pass. Evidence tests are marked it.fails so npm test stays green until the defects are fixed. No src/ files were edited; no background processes left.

### Findings (11)

- **[high] Typing anywhere but the top of a large document costs 20–70 ms per keystroke (P5 missed >6×) — CodeMirror markdown language parse**
  - file: /Users/zyx/LocalDocuments/MDReader/src/editor/createEditor.ts:79 (markdown({ base: markdownLanguage, codeLanguages: languages }) in staticExtensions, always on regardless of document size)
  - expected: SPEC §11 P5: main-thread work per keystroke p95 < 5 ms, max < 10 ms; no frames > 20 ms while typing in a paragraph of large.md
  - actual: review-typing: CDP TaskDuration per keystroke p95 86.5 ms (median 45, max 95), 136/1459 frames > 20 ms, 10 long tasks > 50 ms. review-typing-where: at line 3 ASCII 4/340 and CJK 1/329 frames > 20 ms (max ~21 ms), at line 51003 ASCII 36/373 (max 65.7 ms) and CJK 35/327 (max 38.8) — position-dependent, not character-dependent. Sampling profile of the middle burst: our code totals ~14 ms over 40 keys (createPreview 9.7 ms); the rest is Lezer parser/tree functions (nextChild 88 ms, balanceRange 45, addActions 43, hasNode 36, sibling 30, getActions 24, startInner 21, advanceStack 10 …). review-typing-parse: still 17/187 frames > 20 ms (max 68.8 ms) 90 s after the jump — persistent, not a transient catch-up. review-typing-cm (same 3 MB text, standalone view): A 22/193 frames > 20 ms p95 gap 34.5 max 71.3 ms; B 19/197 p95 30.1 max 37.2 ms; C (no language) 0/175, p95 17.5, max 19.3 ms. Mechanism: @codemirror/language LanguageState.apply runs up to 20 ms of synchronous parse work inside every transaction whenever the tree does not cover the viewport (+ ≤ 50 ms idle chunks, Work.MaxParseAhead 100 kB), and the Lezer markdown parse never gets cheap mid-document.
  - repro: cd /Users/zyx/LocalDocuments/MDReader && npx vite --port 5205 --strictPort & then: node bench/verify/review-typing.mjs (original P5 script, 120 keys at line 51003 of large.md); node bench/verify/review-typing-where.mjs (ASCII/CJK × line 3/middle + CDP sampling profile); node bench/verify/review-typing-parse.mjs (bursts at t=2/20/45/90 s after the jump); node bench/verify/review-typing-cm.mjs (standalone EditorView in the same page: A markdown+codeLanguages, B markdown only, C no language)
  - fix: Put the language extension in a Compartment and gate it on document size: above a threshold (~512 KB–1 MB; large.md is 3 MB) reconfigure to no markdown language (keep lineNumbers/history/search; optionally a StreamLanguage-style non-tree markdown mode for colours), and at minimum drop codeLanguages: languages (nested LR parsers made max gap 71 vs 37 ms). This is a SPEC §7 vs §11 conflict — the mandated extension list cannot meet P5 on the 10 MB target; document the size gate in the spec.
- **[high] Mode switch loses the scroll position: split→preview jumps the preview to the top, preview→edit puts the editor at line 1**
  - file: /Users/zyx/LocalDocuments/MDReader/src/app/App.ts:345-361 (applyMode: layout.setMode(m) runs BEFORE sync.syncNow(prev); the pane just hidden with display:none reports scrollTop 0, so editor.topVisible()/preview.topVisible() return line 1)
  - expected: SPEC §8: on mode change the shown pane lands on the same line as the pane that was visible (split→preview keeps ≈ line 8030; split→preview→split returns to ≈ 8000)
  - actual: split→preview: preview top line 8030 → 1 (scrollTop 253010 → 32). split→preview→split round trip: editor 1 / preview 1. Raw evidence: editor scrollDOM.scrollTop 132056 → 0 and topVisible() = line 1 while its pane is display:none. (edit→split works because the editor stays visible.)
  - repro: node bench/verify/review-mode-scroll.mjs (medium.md, scroll to line 8000 in split, then __mdr.mode('preview'), mode('edit'), mode('split'), plus a raw read of the hidden scroller)
  - fix: In applyMode capture the master position before hiding anything: const from = prev === 'preview' ? preview.topVisible() : editor.topVisible(); then layout.setMode(m) / setVisible / setEnabled, then position the newly shown pane explicitly (preview.scrollToLine(from.line, from.fraction) or editor.scrollToLine(...)) and only then call sync.syncNow for the settle passes. Alternatively extend ScrollSyncApi.syncNow(from, pos?) so App can pass the captured (line, fraction).
- **[medium] Every Enter/Backspace/paste that shifts lines above the headings rebuilds the whole TOC and forces layout with 6001 offsetTop reads (≈25 ms per keystroke)**
  - file: /Users/zyx/LocalDocuments/MDReader/src/preview/toc.ts:117-123 (setOutline key includes e.line → full rebuild on any line shift) and :97-103 + :79-85 (revealActive → refreshOffsets reads offsetTop/offsetHeight of every item synchronously after the rebuild)
  - expected: SPEC §0/§5.7/§8: no layout reads on per-keystroke paths; P5 main p95 < 5 ms; outline DOM should only be rebuilt when entries change (a pure line shift changes no entry text/level)
  - actual: 'x' ×30: 0/313 frames > 20 ms (max 18.7 ms). Enter ×30: 30/303 frames > 20 ms, p95 gap 35.5 ms, max 44.4 ms. Profile: 30 outline messages and 30 nav.replaceChildren rebuilds for 30 keystrokes; 6001 .mdr-toc__item offsetTop reads per keystroke; toc.ts self time 738.9 ms / 30 keys = 24.6 ms per Enter (revealActive 574 ms, rebuild 122 ms, refreshOffsets 30 ms, replaceChildren 91 ms, offsetTop 50 ms). Same cost for Backspace joining lines, paste, list continuation — any lineDelta ≠ 0 edit above the headings.
  - repro: node bench/verify/review-enter-toc.mjs (30 × 'x' vs 30 × Enter at line 3 of large.md, 6001 headings) and node bench/verify/review-enter-profile.mjs (CDP profile + instrumented offsetTop counter)
  - fix: toc.setOutline: compare a key of level+text only; when lengths and level/text sequence match, patch lines[i] and a.dataset.line in place (no DOM rebuild). Never read offsets synchronously in the keystroke path: after a real rebuild set offsetsDirty and refresh lazily from requestIdleCallback/rAF, or drop the cached-offset check and call items[active].scrollIntoView({block:'nearest'}) only when active changes (no layout read needed). Worker side (core.ts refreshOutline/touchesOutline): optionally post an outline message only when level/text changed and let the preview shift lines from the structure — but the TOC fix alone removes the forced layout.
- **[medium] Draft autosave silently stops after a render-worker restart**
  - file: /Users/zyx/LocalDocuments/MDReader/src/app/workerClient.ts:125-142 (restart(): kill → spawn → init → setDoc(onRestart()), never re-sends {type:'draft', action:'enable'}); /Users/zyx/LocalDocuments/MDReader/src/worker/draft.ts:22 (new worker starts with enabled=false); App.ts:402 only enables in openFile
  - expected: SPEC §9: restart + full-text resend keeps all features working; draft record version equals editor.version 1 s after the last edit and on flush; status shows 草稿已存
  - actual: Before restart: draft v17 == editor v17, status 草稿已存. After restart (workers 1→2, toast 渲染器已重启): editor v31, IDB draft still v17, status 未保存; visibilitychange flush also a no-op (still v17). Unsaved work after a restart has no crash protection until the file is reopened.
  - repro: node bench/verify/review-restart-draft.mjs (type, wait 2 s, dispatch an ErrorEvent on the Worker → restart, type again, wait 2.5 s, read IDB mdr.draft:text:small.md, then fire visibilitychange→hidden)
  - fix: Track the last draft action in workerClient (draftEnabled flag set in api.draft()) and after api.setDoc(...) in restart() post {type:'draft', action:'enable'} when it was enabled; or have App's onRestart/onError('渲染器已重启') path call w.draft('enable') itself. Add a unit test in test/app.workerClient.test.ts asserting the enable message is replayed after a restart.
- **[medium] Exported HTML is not sanitized: <script>, on* handlers and <iframe> from the markdown source land verbatim in the downloaded file**
  - file: /Users/zyx/LocalDocuments/MDReader/src/worker/md.ts:102-104 (renderDocument = raw md.render with html:true) → /Users/zyx/LocalDocuments/MDReader/src/worker/core.ts:267-277 (exportHtml) → /Users/zyx/LocalDocuments/MDReader/src/app/App.ts:100-113 (buildExportDocument injects html verbatim; only the title is escaped)
  - expected: The same DOMPurify policy as the live preview (sanitize.ts) — the preview strips these, so a user reasonably expects the exported document to be as safe as what they saw
  - actual: Exported article: <h1 …>t</h1>\n<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n<p>[click](javascript:alert(3))</p>\n<iframe src="https://example.com"></iframe> — script/onerror/iframe survive (markdown-it itself only neutralises the javascript: link). Opening an export of an untrusted .md runs its scripts.
  - repro: npx vitest run test/review-export-xss.test.ts (marked it.fails; the assertion output shows the exported <article> containing <script>alert(1)</script>, <img src=x onerror="alert(2)">, <iframe …>)
  - fix: Sanitize on the main thread before building the document: import the shared CONFIG from preview/sanitize.ts (App may import across modules) and run DOMPurify.sanitize(html, { ...CONFIG, RETURN_DOM_FRAGMENT: false }) (or sanitizeToFragment + a temporary <template> innerHTML serialisation) in App.exportHtml; keep the heading id= attributes via ADD_ATTR:['id'].
- **[low] AppHandle.dispose() never destroys the CodeMirror view or its listeners (editor keeps dispatching after dispose)**
  - file: /Users/zyx/LocalDocuments/MDReader/src/app/App.ts:572-592 (dispose omits the editor); /Users/zyx/LocalDocuments/MDReader/src/editor/createEditor.ts:97-98,168-175 (no dispose: view.destroy() never called, scrollDOM 'scroll' listener, cursorFrame/scrollFrame rAFs and registry.onChange(syncKeymap) never released); /Users/zyx/LocalDocuments/MDReader/src/app/theme.ts:42 (matchMedia 'change' listener never removed, no ThemeApi.dispose)
  - expected: After app.dispose(): .cm-editor removed, update listener and rAF cursor notifications stop, no window/mq listeners left
  - actual: .cm-editor still in DOM; a dispatch after dispose still runs the update listener and delivers onCursor callbacks (editor.version advanced 2→3, cursor handler fired). Preview/hooks are removed correctly.
  - repro: node bench/verify/review-dispose.mjs
  - fix: Add dispose() to createEditor (view.destroy(); cancelAnimationFrame(cursorFrame/scrollFrame); scrollDOM.removeEventListener('scroll', …); off registry.onChange) — EditorApi is frozen in shared/types, so expose it as an extra method on the returned object or via a WeakMap and call it from App.dispose; add ThemeApi-side cleanup of the mq listener. Also unsubscribe toolbar/palette registry.onChange handlers.
- **[low] A large mid-document paste creates every new wrapper synchronously (one 54 ms task), unlike the sliced initial creation**
  - file: /Users/zyx/LocalDocuments/MDReader/src/preview/createPreview.ts:127-154 (insertWrappers → chunksFor(from, to) builds all wrappers of the inserted range in one call inside applyStructure)
  - expected: SPEC §5.2: wrappers created in rAF slices of ≤ 8 ms (MOUNT_SLICE_MS); no task > 50 ms caused by an edit
  - actual: Longest main-thread task after the paste 54 ms (longtask API), longest animation frame 58.6 ms, 36004 blocks afterwards. Under the P4 120 ms bar but a visible hitch and it scales with paste size (a 100k-line paste would be ~250 ms).
  - repro: node bench/verify/review-paste.mjs (paste medium.md, 20k lines ≈ 6k blocks, into the middle of large.md)
  - fix: Insert synchronously only up to SYNC_CREATE_LIMIT wrappers; for larger middle ranges insert a placeholder chunk sized by the model (--chunk-h from the estimates) and fill it in rAF slices with a cursor, reusing runSlice's budget logic; the height model already knows all heights so the scrollbar is correct immediately.
- **[low] html_block never receives data-l (Alt+click / checkbox mapping inside HTML blocks falls back to the block's first line)**
  - file: /Users/zyx/LocalDocuments/MDReader/src/worker/md.ts:33,48-58 (line_attrs sets data-l on html_block tokens, but markdown-it's html_block renderer emits token.content verbatim, so the attribute is dropped)
  - expected: SPEC §4.4: data-l on paragraph_open, heading_open, list_item_open, blockquote_open, table_open, html_block
  - actual: renderBlock('<div class="x">\n<p>hi</p>\n</div>') → '<div class="x">\n<p>hi</p>\n</div>' with no data-l anywhere; only the wrapper's block start line is available to interactions.ts
  - repro: npx vitest run test/review-html-block-datal.test.ts (it.fails; control test shows paragraph_open gets data-l)
  - fix: Override md.renderer.rules.html_block to wrap the content: `<div data-l="${map[0]}">${content}</div>` (a plain div; DOMPurify keeps data-* attrs), or inject the attribute into the first opening tag of the content. Remove 'html_block' from LINE_TOKENS if the wrapper approach is used.
- **[low] ?perf=1 overlay refresh causes periodic jank on huge.md (querySelectorAll over 100k wrappers every 500 ms)**
  - file: /Users/zyx/LocalDocuments/MDReader/src/app/perfOverlay.ts:86 (rows.mounted = o.preview.el.querySelectorAll('.md-block:not(.is-pending)').length every REFRESH_MS)
  - expected: The diagnostics overlay must not perturb what it measures: 0 frames > 20 ms while idle
  - actual: With ?perf=1: 10/360 frames > 20 ms, max gap 35.5 ms (one querySelectorAll = 4.5 ms over 100002 wrappers + style/layout); without: 0/360, max 18.7 ms
  - repro: node bench/verify/review-overlay.mjs (huge.md idle 6 s with and without ?perf=1)
  - fix: Keep a mounted-block counter in createPreview (mounted.size) and expose it (e.g. via a perf:sample {name:'mounted'} or a non-frozen extra method) instead of querying the DOM; or throttle the DOM query to every 5 s.
- **[low] Undeclared runtime/type dependencies: @codemirror/autocomplete and @lezer/common imported but not in package.json**
  - file: /Users/zyx/LocalDocuments/MDReader/src/editor/createEditor.ts:8 (import { closeBrackets } from '@codemirror/autocomplete' — runtime) and /Users/zyx/LocalDocuments/MDReader/src/editor/keymap.ts:6 (import type { SyntaxNode } from '@lezer/common')
  - expected: CONTRACT §0 'Do NOT add packages' presumes every import is a declared, pinned dependency; SPEC §1 pins @codemirror/* explicitly
  - actual: Both packages are absent from package.json; a strict installer (pnpm/yarn PnP) or a codemirror major bump breaks the build silently
  - repro: grep -rhoE "from '(@[a-z0-9-]+/[a-z0-9.-]+|[a-z][a-z0-9.-]*)" src | sort -u vs package.json dependencies — both resolve only because npm hoists them from the `codemirror` meta-package
  - fix: Add "@codemirror/autocomplete": "^6.x" and "@lezer/common": "^1.x" to dependencies (they are already installed, so no new package is introduced), or drop closeBrackets (SPEC lists it, so declare it).
- **[low] Colour literals outside tokens.css (contract violation)**
  - file: /Users/zyx/LocalDocuments/MDReader/src/styles/layout.css:286 (background: rgba(0, 0, 0, 0.35) on .mdr-dialog-backdrop) and :330 (color: #fff on .mdr-dialog__btn--danger)
  - expected: CONTRACT §2/§3: 'Nobody else defines colours as literals — use tokens'; tokens.css is the only file with literals
  - actual: Two literals in layout.css; the dialog backdrop does not adapt to the dark theme and the danger button text ignores the palette
  - repro: grep -n '#[0-9a-fA-F]\{3,8\}\b\|rgba\?(' src/styles/layout.css src/styles/preview.css src/styles/editor.css src/styles/hljs.css
  - fix: Use color-mix(in srgb, var(--mdr-fg) 35%, transparent) for the backdrop (same technique editor.css uses for the palette) and var(--mdr-accent-fg) or a new --mdr-danger-fg token for the button.

### Measurements (26)

| name | value | target | pass |
|---|---|---|---|
| P5 typing mid-doc (large.md line 51003) main-thread task per keystroke p95 (CDP TaskDuration) | 86.5 ms (median 45.1, max 95.1) | < 5 ms p95 / < 10 ms max | ❌ |
| P5 typing mid-doc long tasks > 50 ms during 120 keystrokes | 10 [79,64,54,76,69,67,66,58,77,68] | 0 | ❌ |
| Typing 'x' ×30 at line 3 of large.md: frames > 20 ms | 0 / 313 (max gap 18.7 ms) | 0 | ✅ |
| Typing at middle, 40 keys: rAF gap p95 / max (ASCII, CJK) | 33.1 / 65.7 ms, 29.0 / 38.8 ms | < 5 ms main; no frames > 20 ms | ❌ |
| Mid-doc typing cost 90 s after the jump (20 × 'x') | 17/187 frames > 20 ms, p95 27.5 ms, max 68.8 ms | decays to 0 | ❌ |
| Standalone CodeMirror at middle: p95 gap A markdown+codeLanguages / B markdown / C no language | 34.5 (max 71.3) / 30.1 (max 37.2) / 17.5 (max 19.3) ms | no frames > 20 ms | ❌ |
| Enter ×30 at line 3 of large.md (6001 headings): frames > 20 ms | 30 / 303 (p95 gap 35.5 ms, max 44.4 ms) | 0 | ❌ |
| toc.ts self time per Enter keystroke / offsetTop reads per Enter | 24.6 ms / 6001 reads (30 rebuilds for 30 keys) | ≈ 0 / 0 | ❌ |
| Mode switch split→preview: preview top line | 8030 → 1 (hidden editor scrollTop 132056 → 0) | ≈ 8030 | ❌ |
| Mode round trip split→preview→split: editor/preview top line | 1 / 1 (started at 8000) | ≈ 8000 | ❌ |
| Draft version after worker restart + edit + 2.5 s (small.md) | IDB v17 vs editor v31 (status 未保存) | equal (草稿已存) | ❌ |
| Worker restart recovery (medium.md): stale/pending visible wrappers 5.5 s after restart, scrollTop | 0 stale, 0 pending, scrollTop unchanged 307376 | 0 / unchanged | ✅ |
| P1 large.md open → first-visible | 159.7 ms (open→structure 87.2 ms) | < 400 ms | ✅ |
| P1 huge.md open → first-visible | 408.7 ms (open→structure 237.1 ms) | < 400 ms | ❌ |
| P3 large.md open → idle | 427.4 ms | < 20 s | ✅ |
| P4 longest main task after open large.md / huge.md | 0 ms / 106 ms; long tasks after t=1 s: 0 / 0 | < 120 ms; 0 | ✅ |
| P8 preview wheel 20 screens large.md: frames > 20 ms, long tasks, editor follows | 0/316 (0%), 0, preview 591 vs editor 591 | < 3 %, 0, ≤ 1 block | ✅ |
| P9 editor PageDown ×100 large.md: frames > 20 ms, long tasks, preview follows | 0/252 (0%), 0, editor 2665 vs preview 2665 | < 3 %, 0, ≤ 1 block | ✅ |
| Mount sample (sanitize + replaceChildren) p95 over 200 mounts | 0.5 ms | < 2 ms | ✅ |
| Paste 20k lines into the middle of large.md: longest main-thread task | 54 ms (LoAF 58.6 ms; 36004 blocks; paste→idle 1550 ms) | < 120 ms (P4), ideally sliced ≤ 8 ms | ✅ |
| exportHtml huge.md (6.6 MB): worker blocked duration; restart triggered by typing during export | 1513.5 ms, 66.9M chars; no restart | < 10 s silence watchdog; no restart | ✅ |
| ?perf=1 overlay on huge.md idle 6 s: frames > 20 ms with / without overlay | 10/360 (max 35.5 ms) / 0/360 (max 18.7 ms) | 0 | ❌ |
| Export sanitisation (script/onerror/iframe stripped from exported HTML) | all three survive | stripped like the preview | ❌ |
| AppHandle.dispose(): .cm-editor removed / editor listeners stopped | false / still firing | true / stopped | ❌ |
| npx tsc --noEmit / npx vitest run | clean / 476 passed + 2 expected-fail (my evidence tests), 26 files | clean / green | ✅ |
| Cross-module imports outside App.ts | 0 | 0 | ✅ |

## Lens (agent abdb46bcb5d14ee8b)

Performance verification of MDReader against SPEC §11 on large.md (102k lines) and huge.md (340k lines), Playwright Chromium 1x CPU, own dev server on :5201 (stopped). PASS: P1 (large 147 ms; huge 380 ms best / 405 ms worst — borderline), P3 (idle 439 ms large, 1240 ms huge), P4 (no long task ≥50 ms during/after open on large; one 96–105 ms Worker.onmessage task on huge, under 120), P8/P9 scrolling (0.3 % / 0 % frames > 20 ms, follower within 0 frames — an earlier 27 % figure was an artifact of the MessageChannel monitor loop starving rendering, confirmed by re-running without it), P12 (mode 25–34 ms, theme 27 ms), P5 keystroke→mount p95 34 ms, and the DOM architecture assertion (200 keystrokes → exactly 200 childList mutations, every one a direct replaceChildren on the single edited .md-block; 0 .md-block wrappers inserted/removed; wrapper identity kept). FAIL: (1) main-thread work per keystroke is 3–9x over target — view.dispatch alone is 10–13 ms in large.md and 42–60 ms in huge.md (with 52–104 ms long tasks and 48–64 ms keydown event durations) because @codemirror/language + lezer re-parse/rebuild the markdown tree on every transaction (profiler: @codemirror_language 10.8 ms/key inclusive, balanceRange/nextChild/hasNode top self-time; small.md dispatch is 0.6 ms); the same cost makes P11 undo/redo 10–15 ms per step; (2) after closing a giant tilde fence, the deferred giant-guard payload (older version) is mounted over the already-correct render: block 1 (2 source lines, 10 chars) permanently shows 2,075,304 chars of the whole document — wrong output; (3) a 5k-line code block the user is looking at is evicted (empty) because runEvict compares only the block's top with scrollTop; typing inside it stays blank (4.1 s empty, final is-pending, typed text never shown) — violates SPEC §5.5 'old content stays visible'; (4) memory: evicted blocks are not freed — the content-visibility-locked pending wrapper's stale LayoutResult/PhysicalBoxFragment retains the removed subtree (heap-snapshot retainer path), ~180k Blink nodes and +260 MB after 100 preview jumps (280 → 544 MB footprint) while page heap stays 16 MB and worker heap 46–70 MB; the P13 flow ends at 472 MB (> 450); replacing wrappers with shallow clones frees it, toggling content-visibility does not; (5) the giant fence produces a ~1.1 s scriptless long task (layout of the 102k-line <pre>) after opening, after every typing burst inside it, and again on close (3 tasks > 100 ms vs ≤ 1), with keystroke event durations up to 32 ms; (6) typing in a 300-line highlighted fence costs ~20 ms per key (dispatch 7.7 ms p95 + an 11–13 ms sanitize+mount of the whole fence per keystroke) vs < 8 ms. Not measured: P2, P10, P14, P15, worker cache-hit rate for P11 (no hook), 4x CPU throttle. Earlier RSS numbers from p13-memory.mjs were invalid (its ps filter matched the Claude desktop app's Electron renderer) and are superseded by p13-attrib.mjs, which identifies renderers via CDP SystemInfo.getProcessInfo and macOS footprint.

### Findings (6)

- **[high] P5/P11: keystroke main-thread cost 3–9x over target — CodeMirror markdown parse runs per transaction and scales with document size**
  - file: src/editor/createEditor.ts (line 79: markdown({ base: markdownLanguage, codeLanguages: languages }))
  - expected: SPEC §11 P5: main-thread work per keystroke p95 < 5 ms, max < 10 ms; §10 budget: CM transaction + view update 1–3 ms; P11 undo/redo p95 < 5 ms per step.
  - actual: large.md: trace RunTask sum per keystroke p50 31 ms, p95 44 ms, max 64 ms; longest single task per key p50 18 ms, max 23 ms (MutationCallback→view.dispatch); view.dispatch alone p50 10.3–11.7 ms, p95 12.3–16.7 ms (n=200/60/40 across three runs). small.md control: dispatch p50 0.6 ms. huge.md: dispatch p50 42.4 ms, p95 54.1 ms, max 60.5 ms; 10 long tasks (52–104 ms) in 40 keystrokes; Event Timing keydown/input duration p50 48 ms, max 64 ms. Profile (60 keys): 18 ms/key JS, of which @codemirror/language 10.8 ms/key inclusive; top self-time: nextChild/balanceRange/hasNode/sibling (@lezer/common tree building) and addActions/readToken (@lezer/lr nested code languages); MDReader's own preview path is 0.4 ms/key (mount) and 0.6 ms/key createPreview.ts. P11: dispatch per undo step p50 9.7 ms, p95 15.3 ms, max 16.4 ms; per redo step p50 9.7 ms, p95 14.2 ms. Idle background parse (IdleRequestCallback) additionally runs 48–79 ms slices even with no input.
  - repro: Start `npx vite --port 5201 --strictPort`; then `node bench/verify/p5-typing.mjs large 200 100` (per-key busy + mutation audit), `node bench/verify/p5-trace.mjs large 60 100` (trace RunTask sums), `node bench/verify/p5-control.mjs 40 100` (small/large/huge view.dispatch + Event Timing), `node bench/verify/p5-profile.mjs large 60 100` (V8 profile attribution), `node bench/verify/p11-p12-undo-mode.mjs` (undo/redo). Cursor placed at large.md line 50011 via __mdr.app.editor.gotoLine, page.keyboard.type with 100 ms delay.
  - fix: Stop running the full lezer markdown parser over a 100k-line document on every transaction: for documents above a size threshold (e.g. > 1 MB or > 20k lines) replace `markdown({codeLanguages: languages})` with a viewport-only highlighter (a ViewPlugin building decorations from per-line regexes for the visible ranges, or a StreamLanguage-based markdown mode that has no tree to rebalance), and drop nested `codeLanguages` (the @lezer/lr parsers) for large docs. If keeping lezer, at least remove `codeLanguages` and verify with p5-control.mjs that dispatch returns to the 1–3 ms budget; also cap the background ParseWorker so idle slices stay ≤ 50 ms.
- **[high] P7: stale giant-guard payload is mounted over a newer render after the fence closes — block shows the entire document (wrong output)**
  - file: src/preview/createPreview.ts (applyHtml lines 363–378, restartGiant lines 381–390, applyStructure line 271–272)
  - expected: After closing, block 1 (source '~~~~\n~~~~\n', 10 chars, lineCount 2) renders only its own source; SPEC §5.5: a mount must not regress to an older version (is-stale cleared only when batch.version ≥ staleSince).
  - actual: Timeline after last key: at 100 ms 30003 blocks, 23 mounted, block 1 correct; at 500 ms the deferred giant payload (from the '~'/'~~'/'~~~' keystrokes, when the fence was still unclosed) is mounted into block 1: renderedChars 2,075,304 vs sourceChars 10 (doc 2,075,305); firstText '~~~~\n~~~~# 性能测试文档 Performance Test Document xyz\n\n本…'; mounted count drops to 1 because the giant <pre> fills the viewport and pushes the real blocks off-screen; state persists ≥ 5 s and until the next edit of that block. is-stale is not set (the check passes because staleSince was cleared by the correct mount).
  - repro: `node bench/verify/p7-giant.mjs` (large.md, split): gotoLine(1,0), type '~~~~\n' (150 ms/key) → one 102,005-line Code block; gotoLine(2,end) type ' xyz'; gotoLine(2,0) type '~~~~\n' to close; wait 5 s; compare block 1 textContent length with its 2-line source.
  - fix: In applyHtml, when a non-giant payload arrives for an id that has a pending giant timer, clearTimeout and delete the giant entry (the small payload supersedes it); in restartGiant/mountItem, drop any item whose version is lower than the latest version already mounted or queued for that id (track lastVersion per id); in applyStructure, do not re-arm the giant timer with the old item when the block is no longer giant (check the new block's size/kind).
- **[high] Tall block containing the viewport is evicted and never re-mounted; typing inside a 5k-line fence leaves the preview empty (SPEC §5.4/§5.5 violation)**
  - file: src/preview/createPreview.ts (runEvict lines 317–333: `Math.abs(tops[i] - rel) > EVICT_SCREENS * H`; updateWindow lines 282–306)
  - expected: A mounted block whose box intersects the viewport is never evicted (eviction is for blocks > 20H away); while a giant block re-renders, the old content stays visible (SPEC §5.5); the typed text appears ~500 ms after the last key (giant guard).
  - actual: Part 1 (no typing): block 202 (5003 lines, box height 223,988 px, top −57,466 px, scrollTop 68,381 → the viewport is inside it) is `is-pending` with 0 children for the entire 4 s; preview.isLineVisible(mid) returns false. Part 2 (typing): classes cycle is-pending/is-slow/is-stale, children stay 0 for ≈ 4,114 ms while on screen, final state `md-block is-pending`, 0 children, typed text never rendered. Mechanism: the block's top is 57–111 k px above scrollTop, so |tops[i] − rel| > 20H and runEvict empties it right after mount; nothing re-requests it until the next scroll, and each keystroke restarts the 500 ms giant timer.
  - repro: `node bench/verify/p6-eviction.mjs` (builds a 5,000-line ```ts fence via __mdr.loadText, split mode). Part 1: preview.scrollToLine(mid-fence) and watch the block for 4 s. Part 2: editor.gotoLine(mid-fence), type ' // abc def' at 100 ms/key. Also visible in `node bench/verify/p6-detail.mjs` (block goes is-pending 87 ms after the first keystroke).
  - fix: Evict by distance to the block's extent, not its top: skip when `tops[i] + heights[i] >= rel - limit && tops[i] <= rel + H + limit`; never evict indices inside [winFirst, winLast]; after an eviction pass call updateWindow() so a wrongly evicted in-window block is re-requested. Make isLineVisible use the block's extent as well.
- **[high] P13: evicted preview blocks are never freed — content-visibility-locked pending wrappers retain their removed subtree; memory grows without bound while scrolling**
  - file: src/preview/createPreview.ts (evict lines 336–344: `w.replaceChildren()` on a display-locked wrapper)
  - expected: SPEC §5.4/§13: memory bounded by evicting far-away mounted blocks (replaceChildren + pinned height); P13 renderer < 450 MB after load + 1 min typing + scroll to end.
  - actual: After 100 jumps + full GC: Blink node counter 223,542 vs 43,184 nodes in the document (36,741 elements, 17 mounted) → ~180k retained nodes outside the document with only 838–990 V8 wrappers; renderer physical footprint 280 MB → 544 MB (573 MB after 200 more keystrokes), page JS heap 16 MB, worker heap 46–70 MB (its 64 MB LRU) — so the growth is Blink-side. Heap-snapshot retainer path for the detached elements: `<section class="md-block is-pending" data-id=…>` → blink::LayoutBlockFlow → blink::LayoutResult → PhysicalBoxFragment → HeapVector<FragmentItem> → child LayoutBlockFlow → removed nodes: the off-screen wrapper is display-locked (content-visibility:auto), is not re-laid-out after replaceChildren(), and its stale layout result pins the evicted subtree. Replacing 1,844 evicted wrappers with shallow clones frees 88,561–88,798 nodes (≈48/wrapper); toggling content-visibility:visible + forced layout frees nothing; loadText() (removes all wrappers) frees everything. On-screen micro-test (p13-micro.mjs) with c-v:auto / ResizeObserver / chunk parent retains 0 nodes, confirming the lock is the trigger. P13 flow: footprint 377 MB after load (large split; edit 391, preview 357; huge.md 659 MB after load), 396 MB after 60 s typing, 472 MB after scroll to end (FAIL, target < 450).
  - repro: `node bench/verify/p13-leak.mjs large 100` (100 preview jumps through large.md, Memory.prepareForLeakDetection + 3× GC, heap snapshot with retainer paths); `node bench/verify/p13-nodes.mjs 100` (TreeWalker census: in-document vs Blink node counter); `node bench/verify/p13-release.mjs` and `node bench/verify/p13-fix.mjs` (release experiments); `node bench/verify/p13-worker.mjs large` (page heap / worker heap / footprint per stage); `node bench/verify/p13-attrib.mjs 60` (P13 flow: load + 60 s typing + scroll to end, renderer identified via CDP SystemInfo.getProcessInfo, macOS `footprint`).
  - fix: On eviction, replace the locked wrapper instead of emptying it: create a fresh `section.md-block` (copy data-id/--est-h/is-pending), `w.replaceWith(fresh)`, update els/byId and the ResizeObserver, so the stale LayoutResult dies with the old element (p13-fix.mjs part B proves this frees the nodes). Alternatively evict only while the wrapper is not display-locked (e.g. in the same idle pass, temporarily set `content-visibility: visible` on the wrapper, remove children, force one layout, then restore — note the naive toggle without an intermediate layout did not work). Re-verify with p13-nodes.mjs (node counter must stay ≈ in-document count) and p13-attrib.mjs.
- **[high] P7: giant fence mount freezes the main thread for ~1.1 s after opening, after every typing burst inside it, and on close (3 tasks > 100 ms, target ≤ 1)**
  - file: src/preview/createPreview.ts (mountItem PLAIN path + giant guard, lines 380–420)
  - expected: SPEC §11 P7: input latency p95 < 16 ms; tasks > 100 ms ≤ 1 (one deferred giant mount).
  - actual: Three long tasks of 1,110 / 1,088 / 1,114 ms (LoAF blocking 1,037–1,059 ms, no script attributed → style/layout of the 102,005-line `<pre class="md-code md-code--plain">`), one after opening (+1.2 s), one ~500 ms after the ' xyz' burst inside the fence (block re-mounted by the giant guard), one after closing (this one is the stale-payload mount from the previous finding). Keystroke cost during these phases: view.dispatch p50 8.3–9.3 ms, p95 19.2–23.9 ms; Event Timing keydown/input durations up to 32 ms (17 of 16 keys ≥ 16 ms).
  - repro: `node bench/verify/p7-giant.mjs` (large.md split; '~~~~' at line 1 col 0, ' xyz' at line 2 end, '~~~~' at line 2 col 0; PerformanceObserver longtask + long-animation-frame injected via addInitScript).
  - fix: Do not lay out a multi-MB plain block as one <pre>: render PLAIN payloads in line-sliced chunks (e.g. 2k-line <pre> segments appended across rAF slices, or only the lines around the viewport with pinned --est-h for the rest), and skip the re-mount while the block is being edited when the payload is unchanged apart from the edited lines (diff by line, patch the affected text node). Fixing the stale-payload bug removes the third task.
- **[high] P6: typing in a 300-line highlighted fence costs ~20 ms of main-thread work per keystroke (full fence re-sanitized and re-mounted on every key)**
  - file: src/preview/createPreview.ts (mountItem HTML path: DOMPurify.sanitize + replaceChildren of the whole block) / src/worker (re-render of the whole fence per edit)
  - expected: SPEC §11 P6: main-thread p95 per keystroke < 8 ms (300-line fence), < 16 ms (5k-line fence).
  - actual: 300-line fence: view.dispatch p95 7.7 ms plus one mount per keystroke of p50 11.4 ms / p95 12.9 ms (26 KB highlighted HTML sanitized and replaced each key) → ≈ 20.6 ms per key; block toggles is-stale → mounted every keystroke (18/18). 5k-line fence: dispatch p95 9.8 ms + 0.1 ms mount (PLAIN, giant guard) → 9.9 ms (passes the 16 ms budget) but the block is blank due to the eviction bug above.
  - repro: `node bench/verify/p6-detail.mjs` (300-line ```ts fence built with __mdr.loadText, cursor mid-fence via gotoLine, 18 chars at 100 ms; direct view.dispatch wrapper, perf:sample 'mount' from __mdr bus).
  - fix: For Code blocks being edited, patch instead of replace: have the worker send line-range diffs (or re-highlight only the edited line when hljs output is line-stable) and update the affected text/spans in place; or debounce the mount of the same block to once per ~150 ms while keystrokes keep arriving (keep the is-stale version visible), and move DOMPurify out of the per-keystroke path for worker-generated highlight markup (trusted, no raw HTML) so mount is a single replaceChildren of a pre-parsed template.

### Measurements (28)

| name | value | target | pass |
|---|---|---|---|
| P1 large.md open→mdr:first-visible (best of 2 / worst) | 147.5 ms / 156.3 ms (structure at 83–90 ms) | < 400 ms | ✅ |
| P1 huge.md open→mdr:first-visible (best of 2 / worst) | 380.5 ms / 405.1 ms | < 400 ms | ✅ |
| P3 open→mdr:idle large.md / huge.md | 439–508 ms / 1240–1267 ms | < 20 s (outline/idle) | ✅ |
| P4 large.md longest main task during open; long tasks > 50 ms after t=1 s | none ≥ 50 ms; 0 after 1 s (2 runs) | < 120 ms; 0 | ✅ |
| P4 huge.md longest main task during open; long tasks after t=1 s | 96–105 ms (Worker.onmessage, structure apply at +232 ms); 0 after 1 s | < 120 ms; 0 | ✅ |
| P5 large.md main-thread work per keystroke p95 (trace RunTask sum; monitor-based run gave 61 ms) | 44.1 ms (p50 31 ms) | < 5 ms | ❌ |
| P5 large.md main-thread work per keystroke max | 63.7 ms (longest single task per key p50 17.8, max 23.3 ms) | < 10 ms | ❌ |
| P5 view.dispatch per keystroke p50/p95: small.md / large.md / huge.md | 0.6/3.7 ms · 10.3/12.3 ms · 42.4/54.1 ms | 1–3 ms (SPEC §10) | ❌ |
| P5 huge.md long tasks during 40 keystrokes; Event Timing keydown duration p50/max | 10 (52–104 ms); 48 ms / 64 ms | 0; < 16 ms | ❌ |
| P5 large.md keystroke → block mounted p95 | 33.7 ms (p50 26.3, n=200/200) | < 40 ms | ✅ |
| ARCH typing (200 keys): childList mutations on preview body | 200, all direct replaceChildren on the single edited .md-block; 0 in other blocks; 0 outside blocks | exactly one block's children replaced per keystroke | ✅ |
| ARCH typing: .md-block wrappers inserted/removed; wrapper identity kept | 0 / true (attribute mutations: class on the edited block only) | 0 / true | ✅ |
| P6 300-line fence main work per keystroke (dispatch p95 + mount p95) | 7.7 + 12.9 = 20.6 ms | < 8 ms | ❌ |
| P6 5k-line fence main work per keystroke (dispatch p95 + mount) | 9.8 + 0.1 = 9.9 ms (block mounted PLAIN via giant guard) | < 16 ms | ✅ |
| P6 5k-line fence: block stays visible while typing inside it | empty (0 children) ≈ 4114 ms while on screen; final is-pending, typed text never shown | old content stays visible; text after ≈ 500 ms | ❌ |
| P7 giant tilde fence: blocks after open / after close | 1 (102,005-line Code block) / 30003 (30002 + 1) | 1 / 30003 | ✅ |
| P7 tasks > 100 ms across open/type-inside/close | 3 (1110, 1088, 1114 ms; scriptless LoAF = layout of the giant <pre>) | ≤ 1 | ❌ |
| P7 input: view.dispatch p95 / Event Timing keydown+input max | 23.9 ms / 32 ms (8 ms granularity) | p95 < 16 ms | ❌ |
| P7 after closing: block 1 rendered chars vs its source | 2,075,304 vs 10 (stale giant payload mounted at +500 ms, persists ≥ 5 s) | rendered ≈ source | ❌ |
| P8 preview wheel 20 screens: frames > 20 ms (monitor loop disabled) | 0.3 % (1/370, max 50 ms, p95 17.4 ms); no long tasks; largest Layout per frame 1.3 ms in trace | < 3 %; forced layouts > 2 ms = 0 | ✅ |
| P8 editor follows preview | 0 frames lag on all 20 screens; final delta 0 lines | ≤ 1 frame | ✅ |
| P9 editor PageDown ×100: frames > 20 ms; preview follows | 0 % (0/300, max 18.7 ms); 0 frames lag; final delta 0 lines | < 3 %; ≤ 1 frame | ✅ |
| P11 undo ×50 / redo ×50 view.dispatch per step p95 (monitor-based busy p95 68.6 ms) | 15.3 ms / 14.2 ms (p50 9.7 ms); all 50+50 steps applied, preview correct after redo | < 5 ms | ❌ |
| P12 mode switch ×20 / theme toggle ×20 longest task | 24.6–33.7 ms / 26.9–27.2 ms | < 50 ms | ✅ |
| P13 renderer physical footprint after load + 60 s typing + scroll to end (large.md) | 472 MB (load 377 → typing 396 → scroll 472; JS heap 54.5 MB) | < 450 MB | ❌ |
| P13 footprint after load only: small / medium / large / huge | 134 / 210 / 379 / 659 MB (about:blank baseline 97 MB; large edit 391, preview 357) | (attribution) | ✅ |
| Memory after 100 preview jumps through large.md | 280 → 544 MB footprint; Blink nodes 223,545 vs 43,184 in document; worker heap 46–70 MB; page heap 16 MB | bounded by eviction | ❌ |
| P13 sanity: JS heap after load large / huge (CDP Performance.getMetrics) | 16.7–16.9 MB / 32–40 MB | (informational) | ✅ |

