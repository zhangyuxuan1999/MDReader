# 0.2.0 release candidate — stage 2c adversarial verification, r2 findings (2026-11-20)

Seven verifiers reported 33 findings on the stage-2c candidate. I re-ran every repro myself, alone, on the quiet machine (my ports 5388 / 5398; scripts that default to another verifier's port were given MDR_PORT=5388, nothing else changed). All 33 reproduced. FID-3's fast variant failed 2 of 3 runs, its slow variant 3 of 3. None was flaky beyond that and none failed to reproduce. They fall into 29 groups H1-H29 (one group = one fix): 6 high, 10 medium, 13 low.

**By the release gate this candidate must not ship.**
- 4 high groups are new in 0.2.0 or regressions: H1 (U10 bypass), H2 (file dropped onto the editor, a regression), H3 (Backspace in an emptied paragraph) and H4 (paste written twice).
- 3 groups are regressions against 0.1.1 at medium or above: H2, H7 (GBK read as damaged UTF-8) and H8 (selection lost after a session).
- H5 and H6 are high but pre-existing. H5 is the G28 class, a crash draft overwritten. H6 is page script blanking the window.
- 8 medium groups are new-feature defects or a spec gap (H9-H16) and need a fix or an explicit acceptance.

The worst problems, in plain terms:
- A downloaded document can still steer in-preview editing (H1). One typed letter turns hidden raw HTML into a visible formula on disk, and a checkbox click can tick another task.
- Dragging a .md file from Finder onto the editor pane splices that file's text into the open document (H2). A clean document is then asked 放弃更改, and 取消 keeps the mixed text. 0.1.1 simply opened the file.
- One Backspace after emptying a paragraph glues the next block's raw Markdown onto the paragraph above (H3). A heading becomes '## …' text and a fence breaks.
- Pasting paragraphs that end in a whitespace-only line at a paragraph start writes the pasted text twice (H4).
- GBK data files whose Chinese happens to look like UTF-8 byte pairs (小时, 千元) now open as garbage with a 'damaged UTF-8' dialog (H7). 0.1.1 read them correctly.
- After clicking into a paragraph, a drag-selection across paragraphs copies from the paragraph start (H8, regression).

What the stage-2c step itself changed held up. U13 held 24 + 15 Chromium cases and U14 held 9 + 3 cases. The fixer's claim about unkeepReusedId / held was checked by three verifiers. The only defect there is a one- or two-frame flash when an older structure arrives after the deletion (H20, low).

## Machine and candidate (step 0)

- Nothing of this project was running at the start: no listener on 5380-5398, no project Electron, vitest or headless Chromium. Nothing had to be killed.
- npx tsc --noEmit printed nothing (exit 0). node bench/verify/scan-invisible.mjs: OK.
- diff -rq for electron/ and dist/ against release/staging-0.2.0.noindex, and cmp of package.json: no differences.
- /Applications/MDReader.app/Contents/Info.plist CFBundleShortVersionString is 0.1.1. I read it only and did not launch the app.
- Crash reports: still 11 Electron reports. The newest is Electron-2026-11-20-145455.ips (plus .000 from the same second, 14:54 local), so the verifiers caused no new main-process crash. My own Electron runs (about 20 launches of the staging and baseline directories) added none: the list was unchanged at my end.

## Summary table

| group | severity | class | introduced by | findings (verdict) | title |
|---|---|---|---|---|---|
| H1 | high | new-feature-defect | fix round 2 (U10 rawHtmlReserved / decodeNumericRefs); the checkbox steering itself exists since 0.1.x | REV-1 (reproduced), REV-2 (reproduced) | U10 bypass: rawHtmlReserved scans raw HTML text differently from the browser's HTML parser (RAWTEXT/RCDATA elements, named character references in class values) |
| H2 | high | regression-vs-shipped | fix round 2 (G31: onDrop awaits the shell's / File read before confirmDiscard) | FLOW-4 (reproduced), SHELL-3 (reproduced) | A Markdown file dropped onto the editor pane is first inserted into the current document by CodeMirror, then a discard question is asked |
| H3 | high | new-feature-defect | fix round 2 (U9 Session.gone + U3 tryMergeBackward) | SES-2 (reproduced) | Backspace in an emptied paragraph (deletion already written) glues the next block's raw Markdown onto the paragraph above |
| H4 | high | new-feature-defect | fix round 2 (U8 paste rewrite: pasteSplit resume by minVersion) | SES-8 (reproduced) | A paste of paragraphs whose last one is whitespace-only at a paragraph start resumes on the stale wrapper; the next keystroke writes the pasted paragraphs a second time |
| H5 | high | pre-existing | older (identical on 0.1.1) | FLOW-1 (reproduced) | G28 class: with a crash-recovery offer unanswered, typing and taking it back makes the worker overwrite the crash draft with the loaded text |
| H6 | high | pre-existing | older (identical on 0.1.1) | SHELL-1 (reproduced) | Page script can navigate the app window to about:blank / about:srcdoc: will-navigate never fires, later documents vanish, a dirty window cannot close or quit |
| H7 | medium | regression-vs-shipped | fix round 2 (S4 override 3, lenient UTF-8) | DEC-1 (reproduced) | G22 variation: clean GBK whose characters happen to be valid UTF-8 byte pairs (小时, 千元, …) is read as lenient UTF-8 |
| H8 | medium | regression-vs-shipped | fix round 2 (U7: deferred release re-render of the ended session's block) | SES-4 (reproduced), SES-9 (reproduced) | The re-render of an ended session's block leaves the document selection at (preview, 0): a drag or Shift-click out of the session loses its start; a click at the same paragraph's start after Esc keeps that stale caret |
| H9 | medium | new-feature-defect | in-preview editing (Chromium whitespace rebalancing; not U13/U14) | FID-1 (reproduced) | Typing or Backspace next to a soft line break makes Chromium turn the line feed into a space; the session writes the two source lines joined |
| H10 | medium | new-feature-defect | in-preview editing (Chromium placeholder <br> before a contenteditable=false atom; not U13) | FID-2 (reproduced), SES-7 (reproduced) | Enter or Shift+Enter right before an inline formula: Chromium's placeholder <br> is written as a hard break and the typed text ends up on its own line above the formula |
| H11 | medium | new-feature-defect | unknown (resume caret mapping) | FID-3 (reproduced) | Enter right before an image: after the resume the caret sits after the image |
| H12 | medium | new-feature-defect | fix round 2 (U9 deleteBlock / reinsert) | SES-1 (reproduced) | Deleting (U9) a block that sits directly under a paragraph with no blank line merges the paragraph above with the text below; text typed there lands elsewhere or is dropped |
| H13 | medium | new-feature-defect | unknown (offsetForSource) | SES-3 (reproduced) | After ⌘Z / ⇧⌘Z whose position falls in a block's trailing blank line, the caret lands at the start of the block's last line |
| H14 | medium | new-feature-defect | fix round 2 (U8 pasteText rewrite) | SES-5 (reproduced) | Paste over a selection uses Chromium's smart delete: the space before a double-clicked word is removed, or a remaining double space is written &nbsp; |
| H15 | medium | new-feature-defect | fix round 2 (G4 pickMarkers) | REV-4 (reproduced) | serializeBlock ignores a failed pickMarkers(): a block with no four free marker code points is serialized with stale markers |
| H16 | medium | spec-gap | stage 2b (U7 click-to-edit on by default) | APP-3 (reproduced) | A click in the preview followed by Space types a space into the document instead of paging the preview (also in preview-only mode) |
| H17 | low | new-feature-defect | fix round 2 (G20 covers only a digit after the formula) | FID-4 (reproduced) | G20 variation: an inline formula whose TeX starts and ends with a digit becomes literal text when an edit leaves it before whitespace or at the paragraph end (currency rule) |
| H18 | low | new-feature-defect | unknown (serializer list marker choice) | FID-5 (reproduced) | A List block with three or more adjacent lists of the same type is refused by the U12 gate |
| H19 | low | new-feature-defect | fix round 2 (U12 gate renders without the document's references) | FID-6 (reproduced) | A task list is refused when the document defines a reference named x ([x]: url) |
| H20 | low | new-feature-defect | the stage-2c fix step (unkeepReusedId) | SES-6 (reproduced) | unkeepReusedId also acts on an older structure arriving after the deletion write: the deleted block reappears for a frame or two |
| H21 | low | new-feature-defect | fix round 2 (G14 replace with userEvent input.type.previewEdit) | APP-1 (reproduced) | G14 variation: a session-end write while the user drags a selection in the editor cancels CodeMirror's drag |
| H22 | low | regression-vs-shipped | fix round 2 (U7 ⌘A two-step rule) | APP-2 (reproduced) | G15 variation: in a code-block session, ⌘A again never selects the whole preview |
| H23 | low | regression-vs-shipped | fix round 2 (S4 (e) WHATWG tables + saveTableOf) | DEC-2 (reproduced) | G23 variation: a Shift_JIS reading that neither encoder table gives back is saved with the WHATWG table and rewrites more bytes than 0.1.1 (22 vs 2), also with the overrides off |
| H24 | low | new-feature-defect | fix round 2 (G34 keyed failures) | FLOW-2 (reproduced) | G34 variation: a failure toast keyed by one spelling of a path is not cleared when the same file opens under another spelling (/tmp vs /private/tmp) |
| H25 | low | pre-existing | older (identical on 0.1.1) | FLOW-3 (reproduced) | G30 class: save() deletes the stored draft of the new docId unconditionally; on the legacy web backend one tab's save deletes another tab's draft |
| H26 | low | pre-existing | older (identical on 0.1.1) | SHELL-2 (reproduced) | mailto: and tel: links do nothing on the desktop although S3 says they open externally |
| H27 | low | pre-existing | older (identical in the 0.1.0 decoder) | DEC-3 (reproduced) | A GB18030 file with any four-byte sequence cannot be saved back in its encoding |
| H28 | low | spec-gap | older (test methodology) | DEC-4 (reproduced) | The decoder tests and differentials run on Node's ICU, not on the Electron 44 main process the app ships |
| H29 | low | new-feature-defect | fix round 2 (U12 fidelity.ts) | REV-3 (reproduced) | The fidelity gate is quadratic in a whitespace run inside emphasis or a formula |

## Groups

### H1 [high, new-feature-defect] U10 bypass: rawHtmlReserved scans raw HTML text differently from the browser's HTML parser (RAWTEXT/RCDATA elements, named character references in class values)

- **What goes wrong for the user:** A downloaded file can make one typed letter turn hidden raw HTML into a visible formula in the saved file, and can make a task checkbox tick another task elsewhere.
- **Repro (from the project root):** `MDR_PORT=5388 node bench/verify/v3-rev-browser.mjs tog mathRaw math blk ; perl -e 'alarm 110; exec @ARGV' npx vitest run test/v3-rev-reserved-bypass.test.ts ; MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex node bench/electron/v3-rev-desktop.mjs`
- **Observed:** tog: the wrapper of "<style><!--</style><ul><li data-l=\"-4\"><input type=\"checkbox\">…" has no data-mdr-x; a click on that checkbox changes line 1 to "- [x] pay the rent". math (class="&Tab;md-math" on a hidden span): one typed "s" writes line 3 "Please read $\text{Call +1 555 0100 now}$the tesrms". mathRaw (<style><![CDATA[…): line 3 "Please read $\text{Call +1 555 0100 now}$\"]]>the tesrms". blk (class="&Tab;md-block" data-id): the click on line 7 ticks line 3 "- [x] sign the lease". Desktop staging: line 3 rewritten on disk after Esc and ⌘S.
- **Expected:** Any block whose rendered DOM carries a reserved name is flagged: no session (refusal toast) or only the typed letter is added; a checkbox toggles its own line.
- **Baseline:** The formula rewrite is new: 0.1.1 starts no session and leaves the file unchanged (browser and desktop, same scripts). The checkbox steering (tog, blk) fails identically on 0.1.1.
- **Introduced by:** fix round 2 (U10 rawHtmlReserved / decodeNumericRefs); the checkbox steering itself exists since 0.1.x
- **Suspected files:** src/worker/md.ts, src/preview/interactions.ts, src/preview/serialize.ts
- **Suggested fix:** Decide on the parsed DOM instead of the token text (flag at mount when any element of the sanitized fragment carries a reserved attribute or class the worker did not emit), or make the scan model RAWTEXT/RCDATA elements and decode named references; interactions.ts should take the block from the outer wrapper, not from [data-l] / .md-block inside raw HTML.
- **Confirm verdicts:**
  - REV-1: **reproduced** — v3-rev-browser tog + mathRaw 0/2 (tog: wrapper data-mdr-x false, line 1 = "- [x] pay the rent"; mathRaw line 3 = "Please read $\text{Call +1 555 0100 now}$\"]]>the tesrms"); vitest reserved-bypass: the 12 REV-1 cases fail (2 runs: suite + single); desktop staging v3-rev-desktop rev1 2 FAIL. Baseline: baseline 0.1.1 dist (v3-rev-browser MDR_DIST): mathRaw PASS (no session, source unchanged), tog FAIL the same way (checkbox steering is pre-existing); desktop baseline ALL PASS (file unchanged). My severity: high.
  - REV-2: **reproduced** — v3-rev-browser math + blk 0/3 (math line 3 = "Please read $\text{Call +1 555 0100 now}$the tesrms"; blk lines 1-3 = ["- [ ] pay the rent","- [ ] call the bank","- [x] sign the lease"]); vitest: the 6 REV-2 cases fail; desktop staging rev2 2 FAIL. Baseline: baseline dist: math PASS (no session), blk FAIL identically (redirect pre-existing); desktop baseline ALL PASS. My severity: high.

### H2 [high, regression-vs-shipped] A Markdown file dropped onto the editor pane is first inserted into the current document by CodeMirror, then a discard question is asked

- **What goes wrong for the user:** Dragging a .md file from Finder onto the editor splices its text into the open document, asks a clean document 放弃更改, and 取消 keeps the mixed text (a save writes it).
- **Repro (from the project root):** `MDR_TARGET=staging node bench/electron/v3-flow-desk.mjs K7 ; MDR_TARGET=staging node bench/electron/v3-shell-dropeditor.mjs other ; web: MDR_URL=http://localhost:5388/ node bench/verify/v3-flow-web.mjs DR and MDR_BASE_URL=http://localhost:5388/ node bench/verify/v3-shell-webdrop.mjs (with npx vite --port 5388 --strictPort running)`
- **Observed:** Clean k7-a.md "alpha line\n\nsecond line\n" + drop of k7-b.md on the first .cm-line: editor "al# DROPPED\npha line\n\nsecond line\n", title "● k7-a.md", question 当前文档尚未保存，是否放弃更改？; 取消 keeps the mixed text; 丢弃 opens k7-b.md. Web: same on 未命名.md (buttons ["取消","丢弃"]).
- **Expected:** As 0.1.1: the dropped file opens, the current document is never changed, a clean document is not asked.
- **Baseline:** Measured: desktop baseline K7 6/6 pass and dropeditor 1/1 PASS (title "v2-dropeditor-dropped.md"); web baseline DR 4/4 and webdrop PASS. The dirty-document variant (DR2) fails in both builds (older).
- **Introduced by:** fix round 2 (G31: onDrop awaits the shell's / File read before confirmDiscard)
- **Suspected files:** src/app/App.ts, src/editor/createEditor.ts
- **Suggested fix:** Stop CodeMirror's own file-drop insertion (EditorView.domEventHandlers drop returning true for Files, or a capture-phase root listener with preventDefault) and keep G31's order.
- **Confirm verdicts:**
  - FLOW-4: **reproduced** — v3-flow-desk K7 staging 3/3 runs: FAIL "K7 editor: a clean document is not asked about — [当前文档尚未保存，是否放弃更改？]" and "K7 editor/取消 … \"al# DROPPED\\npha line\\n\\nsecond line\\n\""; web v3-flow-web DR 1/1 same FAILs. Baseline: measured: v3-flow-desk K7 baseline 6 passed 0 failed (editor "# DROPPED\n", no question); web baseline (0.1.1 dist with ?perf=1) DR 4 passed. My severity: high. Merged with SHELL-3 (same root cause). I keep high: a clean document gains another file's text and the natural answer 取消 keeps it; a save writes it to disk.
  - SHELL-3: **reproduced** — v3-shell-dropeditor other staging 3/3 FAIL title="● v2-dropeditor-base.md"; v3-shell-webdrop candidate FAIL after={"title":"● 未命名.md",…,"buttons":["取消","丢弃"]}. Baseline: measured: baseline shell 1/1 PASS title="v2-dropeditor-dropped.md"; web baseline PASS title "v3-webdrop.md", buttons []. My severity: high. Raised from medium to high: same bug as FLOW-4, which shows the 取消 path keeping the foreign text.

### H3 [high, new-feature-defect] Backspace in an emptied paragraph (deletion already written) glues the next block's raw Markdown onto the paragraph above

- **What goes wrong for the user:** One ordinary Backspace rewrites a block the user never touched: a heading, list, table or quote below becomes literal Markdown inside the previous paragraph, a fence breaks.
- **Repro (from the project root):** `MDR_PORT=5388 node bench/verify/v3-ses-probe.mjs ghost-bs ; perl -e 'alarm 110; exec @ARGV' npx vitest run test/v3-ses-repro.test.ts -t SES-2`
- **Observed:** "before words\n\nmiddle\n\n## Next heading\n\nend\n": click middle, ⌘A, Backspace → "before words\n\n## Next heading\n\nend\n" (right); one more Backspace → "before words## Next heading\n\nend\n". Fence: "before words```\ncode line\n\n```\n\nend\n"; list: session lost, 8 ⌘Z to restore.
- **Expected:** The emptied element goes away (or nothing happens), the caret ends after "before words", the source stays "before words\n\n## Next heading\n\nend\n".
- **Baseline:** Not applicable (new feature).
- **Introduced by:** fix round 2 (U9 Session.gone + U3 tryMergeBackward)
- **Suspected files:** src/preview/inlineEdit.ts
- **Suggested fix:** tryMergeBackward must not read src at cur.startLine / cur.lineCount when cur.gone (it reads the next block's lines and replaces them); end the gone session at the end of the previous paragraph instead.
- **Confirm verdicts:**
  - SES-2: **reproduced** — v3-ses-probe ghost-bs 0/6, e.g. afterBs="before words## Next heading\n\nend\n", fence "before words```\ncode line\n\n```\n\nend\n", list case editing=null undo=8; v3-ses-repro SES-2 2/2 fail. Baseline: not applicable. My severity: high.

### H4 [high, new-feature-defect] A paste of paragraphs whose last one is whitespace-only at a paragraph start resumes on the stale wrapper; the next keystroke writes the pasted paragraphs a second time

- **What goes wrong for the user:** Pasting copied paragraphs at the start of a paragraph (copied text often ends with a blank line and indentation) duplicates the pasted text in the file, with the next typed letter inside the copy.
- **Repro (from the project root):** `MDR_PORT=5388 node bench/verify/v3-ses-probe.mjs paste-split-identical ; perl -e 'alarm 110; exec @ARGV' npx vitest run test/v3-ses-repro.test.ts -t SES-8`
- **Observed:** "before\n\nabcdef\n\nafter\n", caret before abc, paste "vao\n\n " → split written correctly, but the wrapper still shows "<p>vao</p><p> abcdef</p>"; typing Q writes "before\n\nvao\n\nvQao\n\nabcdef\n\nafter\n". With "vao\n\nwuu\n\n " both pasted paragraphs are duplicated.
- **Expected:** "before\n\nvao\n\nQabcdef\n\nafter\n".
- **Baseline:** Not applicable (new feature).
- **Introduced by:** fix round 2 (U8 paste rewrite: pasteSplit resume by minVersion)
- **Suspected files:** src/preview/inlineEdit.ts, src/preview/createPreview.ts
- **Suggested fix:** In tryResume, do not accept by minVersion a wrapper that still shows the ended session's DOM (require matchSource or a re-mount after the release), or mark the released block not fresh until its re-render mounts.
- **Confirm verdicts:**
  - SES-8: **reproduced** — v3-ses-probe paste-split-identical 0/4, e.g. afterQ="before\n\nvao\n\nvQao\n\nabcdef\n\nafter\n" (html0 still "<p>vao</p><p> abcdef</p>"); v3-ses-repro SES-8 fails (expected 2 to be 1). Baseline: not applicable. My severity: high.

### H5 [high, pre-existing] G28 class: with a crash-recovery offer unanswered, typing and taking it back makes the worker overwrite the crash draft with the loaded text

- **What goes wrong for the user:** Text recovered from a crash is silently lost if the user types, deletes it again and the tab or app then dies before the offer is answered.
- **Repro (from the project root):** `npx vite --port 5388 --strictPort & then MDR_URL=http://localhost:5388/ node bench/verify/v3-flow-drafts.mjs D1a D1b`
- **Observed:** Draft {docId:untitled, text:"crash text"} offered; type x, Backspace (or abc, ⌘Z); 1.8 s later the stored draft is "", a new tab offers nothing.
- **Expected:** An unanswered offer's draft is never overwritten by text equal to the loaded text; the next launch still offers "crash text".
- **Baseline:** Measured: 0.1.1 dist identical (stored "", no offer).
- **Introduced by:** older (identical on 0.1.1)
- **Suspected files:** src/worker/draft.ts, src/app/App.ts
- **Suggested fix:** Pause the worker's debounced draft writes for the offered docId until the offer is answered, or skip a write whose text equals the loaded text.
- **Confirm verdicts:**
  - FLOW-1: **reproduced** — v3-flow-drafts D1a D1b candidate: 4 FAIL "the crash draft is still stored … stored \"\"", "the next tab offers the crash text — toasts []". Baseline: measured: 0.1.1 dist (?perf=1) identical 4 FAIL → pre-existing. My severity: high. Raised from medium to high: the scale lists "a draft that should have been kept" as high, and r1 rated the same class (G28) high. Pre-existing, so not a release blocker.

### H6 [high, pre-existing] Page script can navigate the app window to about:blank / about:srcdoc: will-navigate never fires, later documents vanish, a dirty window cannot close or quit

- **What goes wrong for the user:** Not reachable from a document today; any future script injection or app bug that sets location to about:blank would blank the window, swallow later documents and trap unsaved work.
- **Repro (from the project root):** `MDR_TARGET=staging node bench/electron/v3-shell-stuck.mjs aboutBlank aboutSrcdoc dirtyBlank`
- **Observed:** url=about:blank, ev=["start about:blank","did-navigate about:blank","did-stop-loading"], a later open-file is sent but not shown (editorLen=0); dirty: close leaves the window, app.quit() does not exit.
- **Expected:** The window stays on the app page, or the shell restores it and re-arms the queue (S3: no page script may navigate the window).
- **Baseline:** Measured: baseline shell 0/3, output identical.
- **Introduced by:** older (identical on 0.1.1)
- **Suspected files:** electron/main.mjs
- **Suggested fix:** In did-navigate (main frame) treat any committed URL other than the app page as a lost page: reset queue and close state as in render-process-gone and reload the renderer.
- **Confirm verdicts:**
  - SHELL-1: **reproduced** — v3-shell-stuck aboutBlank aboutSrcdoc dirtyBlank staging 0/3: url=about:blank ev=["start about:blank","did-navigate about:blank","did-stop-loading"] sends=1 editorLen=0; dirtyBlank windowsAfterClose=[{…"url":"about:blank"}] exitAfterQuit=null. Baseline: measured: baseline shell 0/3, output identical → pre-existing. My severity: high. Agree with high by the S3 rule (page-script navigation), but no document vector reaches it (verify-shell: 372 activations + 37 page-script vectors).

### H7 [medium, regression-vs-shipped] G22 variation: clean GBK whose characters happen to be valid UTF-8 byte pairs (小时, 千元, …) is read as lenient UTF-8

- **What goes wrong for the user:** A GBK timesheet or budget that 0.1.1 showed correctly opens as garbage with a dialog calling it damaged UTF-8; a save after the dialog destroys the Chinese text.
- **Repro (from the project root):** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v3-dec-decoder.test.ts -t DEC-1 ; MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex PHASE=paths node bench/electron/v3-dec-e2e.mjs (and the same with MDR_APP_DIR=…/baseline-0.1.1.noindex)`
- **Observed:** dec1-gbk-sheet: "# ��ʱ\n\n| ���� | ʱ�� |…", dialog 「dec1-gbk-sheet-open-file.md」不是完全有效的 UTF-8 文本 on open-file, the panel and a drop; save after appending x: "REWRITTEN (378 bytes differ from original+x; len 401->417)".
- **Expected:** As 0.1.1: GBK, the GBK toast, no dialog, save = original bytes + x.
- **Baseline:** Measured: baseline exact+x on every path, no dialog.
- **Introduced by:** fix round 2 (S4 override 3, lenient UTF-8)
- **Suspected files:** electron/fileIO.mjs
- **Suggested fix:** In overrideOf, do not let override 3 replace a clean CJK reading that scores as real text (scoreLegacy threshold around 0.6 per the verifier's measurements), or count damage per replaced character; otherwise S4 (f): ship with DECODER_OVERRIDES off.
- **Confirm verdicts:**
  - DEC-1: **reproduced** — vitest v3-dec-decoder -t DEC-1 4/4 fail (got {encoding:"utf-8",replaced:8,head:"# ��ʱ…"}); v3-dec-e2e staging dec1-gbk-sheet: dialog 「…不是完全有效的 UTF-8 文本」 on open-file, panel and drop, saved "REWRITTEN (378 bytes differ from original+x; len 401->417)". Baseline: measured: v3-dec-e2e baseline dec1-gbk-sheet "exact+x" on every path, no dialog → regression. My severity: medium.

### H8 [medium, regression-vs-shipped] The re-render of an ended session's block leaves the document selection at (preview, 0): a drag or Shift-click out of the session loses its start; a click at the same paragraph's start after Esc keeps that stale caret

- **What goes wrong for the user:** After clicking into a paragraph, selecting across paragraphs and ⌘C copies from the paragraph start (0.1.1 copies what was selected); a paste at a paragraph start after Esc becomes its own paragraph.
- **Repro (from the project root):** `MDR_PORT=5388 node bench/verify/v3-ses-pointer.mjs out-of-session ; MDR_PORT=5388 node bench/verify/v3-ses-probe.mjs esc-then-click-start-paste ; baseline: npx vite preview --outDir release/baseline-0.1.1.noindex/dist --port 5398 --strictPort, then MDR_PORT=5398 MDR_PERF=1 node bench/verify/v3-ses-pointer.mjs out-of-session-drag-clean`
- **Observed:** copied="First para alpha words here.\n\nSecond para beta words here.\n\nThird para gam" (drag from "words" to "gamma"); SES-9: caret={"node":"SECTION","off":0}, ⌘V "bqf" → "aaa\n\nbqf\n\nxyz wordsQ\n\nzzz\n".
- **Expected:** "words here.\n\nSecond para beta words here.\n\nThird para gam"; "aaa\n\nbqfxyz words\n\nzzz\n".
- **Baseline:** Measured: 0.1.1 dist 2/2 PASS for the drag (and the candidate with editing off is correct per the verifier).
- **Introduced by:** fix round 2 (U7: deferred release re-render of the ended session's block)
- **Suspected files:** src/preview/inlineEdit.ts, src/preview/createPreview.ts
- **Suggested fix:** Save the selection endpoints that lie in the released block as text offsets before host.release re-renders it and restore them after the mount (or skip the re-render when nothing was written); normalise a caret that sits directly in the wrapper at session start.
- **Confirm verdicts:**
  - SES-4: **reproduced** — v3-ses-pointer out-of-session candidate 0/4 + 1 repeat of drag-clean: copied="First para alpha words here.\n\nSecond para beta words here.\n\nThird para gam". Baseline: measured: 0.1.1 dist on 5398 (MDR_PERF=1) out-of-session-drag-clean 2/2 PASS copied="words here.\n\n…" → regression. My severity: medium.
  - SES-9: **reproduced** — v3-ses-probe esc-then-click-start-paste 1/3 (control passes): caret={"node":"SECTION","off":0} after="aaa\n\nbqf\n\nxyz wordsQ\n\nzzz\n". Baseline: not applicable. My severity: low. Grouped with SES-4: both are the selection left at (wrapper, 0) when the ended session's block is re-rendered.

### H9 [medium, new-feature-defect] Typing or Backspace next to a soft line break makes Chromium turn the line feed into a space; the session writes the two source lines joined

- **What goes wrong for the user:** In hard-wrapped Markdown every edit at a line end or line start joins two source lines; the rendering is the same, so the change shows only in the editor pane and in diffs.
- **Repro (from the project root):** `MDR_PORT=5388 node bench/verify/v3-fid-reach.mjs soft- ; MDR_PORT=5388 node bench/verify/v3-fid-softprobe.mjs`
- **Observed:** "abc\ndef" + Q after abc → "abcQ def"; Q before def → "abc Qdef"; "第一行\n第二行" → "第一行Q 第二行"; "abcd\nefg" + Backspace → "abc efg". softprobe: the DOM text node itself changes from "abc\ndef" to "ab def".
- **Expected:** "abcQ\ndef", "abc\nQdef", "第一行Q\n第二行", "abc\nefg".
- **Baseline:** Not applicable (new feature).
- **Introduced by:** in-preview editing (Chromium whitespace rebalancing; not U13/U14)
- **Suspected files:** src/preview/inlineEdit.ts, src/preview/serialize.ts
- **Suggested fix:** Keep the text node's line feeds next to the edit point out of Chromium's rebalancing (restore them in the same DOM change, or mount each soft break as its own inert node).
- **Confirm verdicts:**
  - FID-1: **reproduced** — v3-fid-reach soft- 5/5 FAIL, e.g. src "abc\ndef\n\nnext\n" → "abcQ def\n\nnext\n"; v3-fid-softprobe "abc\ndef\n" Backspace: DOM "abc\ndef" -> "ab def". Baseline: not applicable. My severity: medium.

### H10 [medium, new-feature-defect] Enter or Shift+Enter right before an inline formula: Chromium's placeholder <br> is written as a hard break and the typed text ends up on its own line above the formula

- **What goes wrong for the user:** Splitting a paragraph or list item in front of a formula adds a line break nobody typed, in the preview and in the file.
- **Repro (from the project root):** `MDR_PORT=5388 node bench/verify/v3-fid-reach.mjs atom-enter-formula atom-shift ; MDR_PORT=5388 node bench/verify/v3-ses-probe.mjs atom- ; MDR_PORT=5388 node bench/verify/v3-fid-mathprobe.mjs`
- **Observed:** "abc $x$ y" + Enter after abc + Z → "abc\n\nZ  \n$x$ y\n"; Shift+Enter → "abc  \nZ  \n$x$ y\n"; list → "- abc\n- Z  \n  $x$ y\n"; at a paragraph start "$x$ d" + ⌘← + Q → "$x$Q d".
- **Expected:** "abc\n\nZ$x$ y\n", "abc  \nZ$x$ y\n", "- abc\n- Z$x$ y\n", "Q$x$ d".
- **Baseline:** Not applicable (new feature).
- **Introduced by:** in-preview editing (Chromium placeholder <br> before a contenteditable=false atom; not U13)
- **Suspected files:** src/preview/inlineEdit.ts, src/preview/serialize.ts
- **Suggested fix:** In enterKey (same DOM change) remove a <br> Chromium leaves as first child before a [contenteditable=false] atom and place the caret before the atom; give the caret a text position before a leading formula.
- **Confirm verdicts:**
  - FID-2: **reproduced** — v3-fid-reach atom-enter-formula(-fast), atom-shift-enter-formula, atom-enter-formula-li 4/4 FAIL, e.g. "abc $x$ y\n" → "abc\n\nZ  \n$x$ y\n"; mathprobe: new <p> starts "<br><span class=\"md-math\" … contenteditable=\"false\">" at once. Baseline: not applicable. My severity: medium.
  - SES-7: **reproduced** — v3-ses-probe atom- 1/5 (image passes): atom-nows-math src="abc\n\nQ  \n$x$ d\n"; atom-start-math-type src="$x$Q d\n\nz\n". Baseline: not applicable. My severity: medium. Raised from low to medium to match FID-2: same bug.

### H11 [medium, new-feature-defect] Enter right before an image: after the resume the caret sits after the image

- **What goes wrong for the user:** After splitting a paragraph in front of an image, the text typed next goes after the image.
- **Repro (from the project root):** `MDR_PORT=5388 node bench/verify/v3-fid-reach.mjs atom-enter-image`
- **Observed:** "abc ![i](https://e.example/i.png) y" + Enter after abc + Z → "abc\n\n![i](https://e.example/i.png)Z y\n".
- **Expected:** "abc\n\nZ![i](https://e.example/i.png) y\n".
- **Baseline:** Not applicable (new feature).
- **Introduced by:** unknown (resume caret mapping)
- **Suspected files:** src/preview/inlineEdit.ts
- **Suggested fix:** Count non-text atoms as positions in the resume offset (textOffsetOf / offsetForSource).
- **Confirm verdicts:**
  - FID-3: **reproduced** — v3-fid-reach atom-enter-image: slow variant 3/3 FAIL, fast variant 2/3 FAIL: "abc ![i](https://e.example/i.png) y\n" → "abc\n\n![i](https://e.example/i.png)Z y\n". Baseline: not applicable. My severity: medium. timingSensitive: fast variant 2 of 3.

### H12 [medium, new-feature-defect] Deleting (U9) a block that sits directly under a paragraph with no blank line merges the paragraph above with the text below; text typed there lands elsewhere or is dropped

- **What goes wrong for the user:** Removing a list or heading written in the common tight style merges the user's paragraphs; typed text lands after them or, in one case, about 2.5 s of typing is lost.
- **Repro (from the project root):** `MDR_PORT=5388 node bench/verify/v3-ses-probe.mjs tight- ; perl -e 'alarm 110; exec @ARGV' npx vitest run test/v3-ses-repro.test.ts -t SES-1`
- **Observed:** "Intro text:\n- item one\n- item two\n\nNext paragraph.\n" → "Intro text:\nNext paragraph.\n" shown as one paragraph; typing N → "Intro text:\nNext paragraph.\n\n- N\n". "para one\n# Head\npara two\n": session lost, Q dropped, focus on BODY. "para one\n# Head\n" emptied → "para one" (final newline gone).
- **Expected:** "Intro text:\n\nNext paragraph.\n" (paragraphs stay apart), N typed between them, the session continues.
- **Baseline:** Not applicable (new feature).
- **Introduced by:** fix round 2 (U9 deleteBlock / reinsert)
- **Suspected files:** src/preview/inlineEdit.ts
- **Suggested fix:** deleteBlock: keep a separating blank line when the line before is not blank; reinsert at the deleted block's own position; keep a final newline.
- **Confirm verdicts:**
  - SES-1: **reproduced** — v3-ses-probe tight- 1/8: tight-list-del-merges afterEmpty="Intro text:\nNext paragraph.\n" shown=["Intro text: Next paragraph."], typed="Intro text:\nNext paragraph.\n\n- N\n"; tight-heading-only-para-type after3s active=BODY, Q not written; tight-last-block-final-newline afterEmpty="para one"; v3-ses-repro SES-1 2/2 fail. Baseline: not applicable. My severity: medium. tight-quote-del also fails in the same run ("para one\n> quoted\n\npara two\n" → "para two\n") but the verifier did not claim it; it may be Cmd-A covering both lines of one block (not judged).

### H13 [medium, new-feature-defect] After ⌘Z / ⇧⌘Z whose position falls in a block's trailing blank line, the caret lands at the start of the block's last line

- **What goes wrong for the user:** Type a new paragraph or item, undo it, keep typing: the text goes to the start of the paragraph above.
- **Repro (from the project root):** `MDR_PORT=5388 node bench/verify/v3-ses-probe.mjs caret-undo ; perl -e 'alarm 110; exec @ARGV' npx vitest run test/v3-ses-repro.test.ts -t SES-3`
- **Observed:** "abc\n\nzzz\n" + Enter + def + ⌘Z + Q → "Qabc\n\nzzz\n"; list → "- oneQ\n- two\n\nz\n"; two-line paragraph → "abc Qdef".
- **Expected:** "abcQ\n\nzzz\n", "- one\n- twoQ\n\nz\n", "abc\ndefQ".
- **Baseline:** Not applicable (new feature).
- **Introduced by:** unknown (offsetForSource)
- **Suspected files:** src/preview/inlineEdit.ts
- **Suggested fix:** offsetForSource: a position after the last content line maps to the end of the content, not column 0 of the last line.
- **Confirm verdicts:**
  - SES-3: **reproduced** — v3-ses-probe caret-undo 1/5: afterQ="Qabc\n\nzzz\n" exp="abcQ\n\nzzz\n"; list afterQ="- oneQ\n- two\n\nz\n"; v3-ses-repro SES-3 fails (expected +0 to be 3). Baseline: not applicable. My severity: medium.

### H14 [medium, new-feature-defect] Paste over a selection uses Chromium's smart delete: the space before a double-clicked word is removed, or a remaining double space is written &nbsp;

- **What goes wrong for the user:** Replacing a word by pasting glues two words together or puts an &nbsp; the user never typed into the file.
- **Repro (from the project root):** `MDR_PORT=5388 node bench/verify/v3-ses-paste.mjs dblclick-word-paste ; MDR_PORT=5388 node bench/verify/v3-ses-paste.mjs sel-replace`
- **Observed:** Double-click "here", ⌘V "there" → "Some wordsthere to replace now."; select "def" in "abc def ghi", paste X → "abc&nbsp;X ghi"; "X\n\nY" → "abc&nbsp;X\n\nY ghi".
- **Expected:** "Some words there to replace now.", "abc X ghi" (what typing over the selection writes).
- **Baseline:** Not applicable (new feature).
- **Introduced by:** fix round 2 (U8 pasteText rewrite)
- **Suspected files:** src/preview/inlineEdit.ts
- **Suggested fix:** Delete the selection with range.deleteContents() (no smart delete) before the insertion, or use insertText for single-line text.
- **Confirm verdicts:**
  - SES-5: **reproduced** — v3-ses-paste dblclick-word-paste FAIL src="Some wordsthere to replace now.\n\nz\n"; sel-replace FAIL src="abc&nbsp;X ghi\n\nz\n"; sel-replace-lines FAIL src="abc&nbsp;X\n\nY ghi\n\nz\n". Baseline: not applicable. My severity: medium.

### H15 [medium, new-feature-defect] serializeBlock ignores a failed pickMarkers(): a block with no four free marker code points is serialized with stale markers

- **What goes wrong for the user:** Pasting a full private-use glyph table into a paragraph silently turns one glyph into a line break in the file.
- **Repro (from the project root):** `MDR_PORT=5388 node bench/verify/v3-rev-browser.mjs pua ; perl -e 'alarm 110; exec @ARGV' npx vitest run test/v3-rev-markers.test.ts`
- **Observed:** After pasting U+E000–U+F8FF plus U+FDD0–U+FDEF into "Glyphs: end": paragraph lines 2, length 6450 (expected 6451), U+E000 gone.
- **Expected:** Every pasted character reaches the source, or nothing is written and the block is refused.
- **Baseline:** Not applicable (new feature).
- **Introduced by:** fix round 2 (G4 pickMarkers)
- **Suspected files:** src/preview/serialize.ts
- **Suggested fix:** Honour pickMarkers()'s return value in serializeBlock / serializeBlockWithCaret (no serialization, refuse with the toast).
- **Confirm verdicts:**
  - REV-4: **reproduced** — v3-rev-browser pua FAIL "paragraph lines: 2, length 6450 (expected 6451)", U+E000 present=false; vitest v3-rev-markers 1/1 fail. Baseline: not applicable. My severity: medium.

### H16 [medium, spec-gap] A click in the preview followed by Space types a space into the document instead of paging the preview (also in preview-only mode)

- **What goes wrong for the user:** A reader who clicks into the preview and presses Space to page down inserts spaces into the file; the document turns dirty.
- **Repro (from the project root):** `MDR_PORT=5388 node bench/verify/v3-app-regress.mjs K3 ; MDR_EDIT=off MDR_PORT=5388 node bench/verify/v3-app-regress.mjs K3 ; MDR_PERF=1 MDR_PORT=5398 node bench/verify/v3-app-regress.mjs K3 (0.1.1 dist on 5398)`
- **Observed:** {"scrolled":false,"changedLine":"第一 段落文字 alpha。","session":true}.
- **Expected:** Lead decision: either accept and document it, or keep 0.1.1's reading habit (Space pages until the user types something else).
- **Baseline:** Measured: 0.1.1 {"scrolled":true,"changedLine":null,"session":false}; the candidate with 预览可编辑 off is identical.
- **Introduced by:** stage 2b (U7 click-to-edit on by default)
- **Suspected files:** src/preview/inlineEdit.ts, src/app/previewEdit.ts
- **Suggested fix:** Decision for the lead (see the verifier's options).
- **Confirm verdicts:**
  - APP-3: **reproduced** — v3-app-regress K3 candidate: {"scrolled":false,"changedLine":"第一 段落文字 alpha。","session":true}. Baseline: measured: 0.1.1 dist (MDR_PERF=1, 5398) {"scrolled":true,"changedLine":null,"session":false}; candidate with MDR_EDIT=off identical to the baseline. My severity: medium. Kept as spec-gap: the behaviour follows from click-to-edit by default; the lead has to decide.

### H17 [low, new-feature-defect] G20 variation: an inline formula whose TeX starts and ends with a digit becomes literal text when an edit leaves it before whitespace or at the paragraph end (currency rule)

- **What goes wrong for the user:** After deleting the punctuation behind $3\times4$ or typing a space after $1+2$, the formula shows as raw $…$ text.
- **Repro (from the project root):** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v3-fid-r1.test.ts -t G20 ; MDR_PORT=5388 node bench/verify/v3-fid-reach.mjs g20-`
- **Observed:** "面积 $3\times4$." + Backspace → "面积 $3\times4$" (0 formulas rendered); "和 $1+2$x" + space → "和 $1+2$ x"; "等于 $10$。" → "等于 $10$".
- **Expected:** The formula stays a formula.
- **Baseline:** Not applicable (new feature).
- **Introduced by:** fix round 2 (G20 covers only a digit after the formula)
- **Suspected files:** src/preview/serialize.ts, src/worker/math.ts
- **Suggested fix:** Apply the proof-or-general rule to math.ts's currency closer (refuse or write a closing spelling).
- **Confirm verdicts:**
  - FID-4: **reproduced** — vitest v3-fid-r1 -t G20 2 failed; v3-fid-reach g20- 3/3 FAIL "formulas rendered after the edit: 0 (expected 1)", e.g. "面积 $3\\times4$.\n" → "面积 $3\\times4$\n". Baseline: not applicable. My severity: low.

### H18 [low, new-feature-defect] A List block with three or more adjacent lists of the same type is refused by the U12 gate

- **What goes wrong for the user:** An ordinary list block ("- a", "* b", "+ c" separated by blank lines) cannot be edited in the preview.
- **Repro (from the project root):** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v3-fid-r1.test.ts -t "three adjacent" ; MDR_PORT=5388 node bench/verify/v3-fid-reach.mjs adjacent-lists`
- **Observed:** Baseline "- a\n\n* b\n\n* c" (lists 2 and 3 merge); session false, toast 此块请在源码中编辑.
- **Expected:** The block is editable; markers alternate for each adjacent list.
- **Baseline:** Not applicable (new feature).
- **Introduced by:** unknown (serializer list marker choice)
- **Suspected files:** src/preview/serialize.ts
- **Suggested fix:** Alternate the bullet / ordered delimiter relative to the previous adjacent list.
- **Confirm verdicts:**
  - FID-5: **reproduced** — vitest -t "three adjacent" 4 failed (baseline "- a\n\n* b\n\n* c": expected false to be true); v3-fid-reach adjacent-lists-refused FAIL session false, toast 此块请在源码中编辑. Baseline: not applicable. My severity: low.

### H19 [low, new-feature-defect] A task list is refused when the document defines a reference named x ([x]: url)

- **What goes wrong for the user:** In a document that defines [x] (or [X]), every task list with a checked item is uneditable in the preview.
- **Repro (from the project root):** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v3-fid-r1.test.ts -t "is editable: the gate" ; MDR_PORT=5388 node bench/verify/v3-fid-reach.mjs task-ref`
- **Observed:** Baseline "- [x] [x](https://ref.example/x) done\n- [ ] open" refused; no session, toast 此块请在源码中编辑.
- **Expected:** The task list is editable.
- **Baseline:** Not applicable (new feature).
- **Introduced by:** fix round 2 (U12 gate renders without the document's references)
- **Suspected files:** src/preview/fidelity.ts, src/preview/serialize.ts
- **Suggested fix:** Give the gate the document's references, or write a checked marker that cannot read as a reference link.
- **Confirm verdicts:**
  - FID-6: **reproduced** — vitest -t "is editable: the gate" 1 failed; v3-fid-reach task-ref-x / task-ref-X-upper FAIL "no session started; toast 此块请在源码中编辑", gate refusals 1 / 2. Baseline: not applicable. My severity: low.

### H20 [low, new-feature-defect] unkeepReusedId also acts on an older structure arriving after the deletion write: the deleted block reappears for a frame or two

- **What goes wrong for the user:** A one- or two-frame flash of just-deleted text (and of a missing neighbour) when typing and select-all-delete come within one worker round trip.
- **Repro (from the project root):** `MDR_PORT=5388 node bench/verify/v3-ses-preview.mjs old-delta`
- **Observed:** ["aaa","zzz"] → ["aaa","midX","zzz"] at ~305 ms → ["aaa","zzz"]; first block with a leading line: ["midX","zzz"], ["~midX"] (zzz not shown).
- **Expected:** The deleted block never shows again; neighbours never vanish.
- **Baseline:** Not applicable (new feature).
- **Introduced by:** the stage-2c fix step (unkeepReusedId)
- **Suspected files:** src/preview/createPreview.ts, src/preview/inlineEdit.ts
- **Suggested fix:** Apply unkeepReusedId only to structures whose version is at least the deletion write's version.
- **Confirm verdicts:**
  - SES-6: **reproduced** — v3-ses-preview old-delta 3 runs, 0/3 each (9/9 cases): framesShowingDeleted=1 ["305ms [\"aaa\",\"midX\",\"zzz\"]"]; first-lead ["285ms [\"midX\",\"zzz\"]","318ms [\"~midX\"]"]. Baseline: not applicable. My severity: low. timingSensitive (slow-worker hook): 3 of 3 runs on the quiet machine.

### H21 [low, new-feature-defect] G14 variation: a session-end write while the user drags a selection in the editor cancels CodeMirror's drag

- **What goes wrong for the user:** With an open IME composition in the preview, a drag-selection in the editor does not appear; the next typed text goes in at the press point.
- **Repro (from the project root):** `MDR_PORT=5388 node bench/verify/v3-app-g.mjs G14a 3`
- **Observed:** 丙 line "Q丙段落文字一二三。" / "Q段落文字一二三。".
- **Expected:** "Q文字一二三。".
- **Baseline:** Not applicable (new feature).
- **Introduced by:** fix round 2 (G14 replace with userEvent input.type.previewEdit)
- **Suspected files:** src/app/previewEdit.ts, src/preview/inlineEdit.ts
- **Suggested fix:** Do not tag the focus-keeping session-end write as input.type, or end the session from a capture-phase mousedown on the editor.
- **Confirm verdicts:**
  - APP-1: **reproduced** — v3-app-g G14a 3: 0/3, 丙 line "Q丙段落文字一二三。" (run 1) and "Q段落文字一二三。" (runs 2, 3) instead of "Q文字一二三。". Baseline: not applicable. My severity: low.

### H22 [low, regression-vs-shipped] G15 variation: in a code-block session, ⌘A again never selects the whole preview

- **What goes wrong for the user:** After clicking into a code block, ⌘A ⌘A only selects the code; the page cannot be selected without Esc first.
- **Repro (from the project root):** `MDR_PORT=5388 node bench/verify/v3-app-g.mjs G15k ; MDR_PORT=5388 node bench/verify/v3-app-regress.mjs A1 ; MDR_PERF=1 MDR_PORT=5398 node bench/verify/v3-app-regress.mjs A1`
- **Observed:** second ⌘A {"whole":false,"len":10,"session":true}; A1 {"whole":false,"len":12,"session":true}.
- **Expected:** As for other blocks (and 0.1.1): the second ⌘A ends the session and selects the whole preview.
- **Baseline:** Measured: 0.1.1 A1 {"len":">500","session":false}.
- **Introduced by:** fix round 2 (U7 ⌘A two-step rule)
- **Suspected files:** src/preview/inlineEdit.ts
- **Suggested fix:** In blockFullySelected compare against the editable content (skip [data-mdr-ui] and the code-block chrome).
- **Confirm verdicts:**
  - APP-2: **reproduced** — v3-app-g G15k 3/6 (the three code-block cases fail: second ⌘A {"whole":false,"len":10,"session":true}); v3-app-regress A1 candidate {"whole":false,"len":12,"session":true}. Baseline: measured: 0.1.1 dist A1 {"whole":false,"len":">500","session":false} (the page is selected) → regression. My severity: low.

### H23 [low, regression-vs-shipped] G23 variation: a Shift_JIS reading that neither encoder table gives back is saved with the WHATWG table and rewrites more bytes than 0.1.1 (22 vs 2), also with the overrides off

- **What goes wrong for the user:** Silent byte respelling on save in rare NEC-style Shift_JIS files; the characters read the same.
- **Repro (from the project root):** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v3-dec-decoder.test.ts -t DEC-2 ; MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex PHASE=paths node bench/electron/v3-dec-e2e.mjs`
- **Observed:** dec2-sjis-nec: "REWRITTEN (22 bytes differ from original+x; len 110->110)".
- **Expected:** No more bytes changed than 0.1.1 changed.
- **Baseline:** Measured: baseline "REWRITTEN (2 bytes differ …)".
- **Introduced by:** fix round 2 (S4 (e) WHATWG tables + saveTableOf)
- **Suspected files:** electron/fileIO.mjs
- **Suggested fix:** Choose the save table per character (keep the bytes the file used), or at least the table that changes fewer bytes.
- **Confirm verdicts:**
  - DEC-2: **reproduced** — vitest -t DEC-2 2 failed "expected 22 to be less than or equal to 2"; v3-dec-e2e staging dec2-sjis-nec "REWRITTEN (22 bytes differ from original+x; len 110->110)". Baseline: measured: v3-dec-e2e baseline dec2-sjis-nec "REWRITTEN (2 bytes differ …)" → regression. My severity: low. Low because the file must combine three rare conditions (0 of 95 830 generated inputs) and every rewritten byte pair decodes to the same character; by r1 G23 standards it would be high if it hit ordinary files.

### H24 [low, new-feature-defect] G34 variation: a failure toast keyed by one spelling of a path is not cleared when the same file opens under another spelling (/tmp vs /private/tmp)

- **What goes wrong for the user:** A false "cannot open" message stays next to the open document until dismissed.
- **Repro (from the project root):** `MDR_TARGET=staging node bench/electron/v3-flow-desk.mjs K2`
- **Observed:** 「无法打开「k2-later.md」：找不到这个文件…」 still shown while /tmp/…/k2-later.md is open.
- **Expected:** A successful open clears the file's failure whatever path spelling each entry point used.
- **Baseline:** Not comparable: 0.1.1 shows one generic toast 文件已不存在，已从最近列表移除 (×N).
- **Introduced by:** fix round 2 (G34 keyed failures)
- **Suspected files:** src/app/App.ts, electron/fileIO.mjs
- **Suggested fix:** Key failures by the resolved (realpath) path.
- **Confirm verdicts:**
  - FLOW-2: **reproduced** — v3-flow-desk K2 staging 5 passed, 1 failed: "K2 no stale 「无法打开 k2-later.md」 while it is open (other spelling of the path)". Baseline: baseline K2: the old generic toast 文件已不存在，已从最近列表移除 ×N (keyed toasts do not exist there: not comparable). My severity: low.

### H25 [low, pre-existing] G30 class: save() deletes the stored draft of the new docId unconditionally; on the legacy web backend one tab's save deletes another tab's draft

- **What goes wrong for the user:** Firefox/Safari users: tab A's unsaved text loses its draft when tab B saves another untitled document.
- **Repro (from the project root):** `npx vite --port 5388 --strictPort & then MDR_URL=http://localhost:5388/ node bench/verify/v3-flow-web.mjs L1`
- **Observed:** stored null after tab B's save.
- **Expected:** A save deletes only a draft this tab wrote.
- **Baseline:** Measured: 0.1.1 dist identical FAIL.
- **Introduced by:** older (identical on 0.1.1)
- **Suspected files:** src/app/App.ts, src/files/legacyBackend.ts, src/files/fileService.ts
- **Suggested fix:** Use delDraftIfMine in save(), give legacy untitled downloads a unique docId.
- **Confirm verdicts:**
  - FLOW-3: **reproduced** — v3-flow-web L1 candidate FAIL "tab B saving its own document leaves tab A’s unsaved draft alone — stored null". Baseline: measured: 0.1.1 dist L1 identical FAIL → pre-existing. My severity: low.

### H26 [low, pre-existing] mailto: and tel: links do nothing on the desktop although S3 says they open externally

- **What goes wrong for the user:** Clicking an e-mail or phone link gives no reaction.
- **Repro (from the project root):** `MDR_TARGET=staging node bench/electron/v3-shell-mailto.mjs`
- **Observed:** shell.openExternal never called for mailto / tel; https works.
- **Expected:** mailto / tel open the system handler.
- **Baseline:** Measured: baseline identical.
- **Introduced by:** older (identical on 0.1.1)
- **Suspected files:** electron/main.mjs
- **Suggested fix:** Forward mailto: / tel: from setWindowOpenHandler to shell.openExternal.
- **Confirm verdicts:**
  - SHELL-2: **reproduced** — v3-shell-mailto staging 0/1 FAIL "(⌘-)clicked mailto / tel links reach the system". Baseline: measured: baseline shell 0/1 identical → pre-existing. My severity: low.

### H27 [low, pre-existing] A GB18030 file with any four-byte sequence cannot be saved back in its encoding

- **What goes wrong for the user:** Such a file can only be saved as UTF-8 (the save is refused with a clear message).
- **Repro (from the project root):** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v3-dec-decoder.test.ts -t DEC-3`
- **Observed:** Error: 文档包含 GBK 编码无法表示的字符「𠀀」，请用「另存为」保存为 UTF-8.
- **Expected:** Byte-exact save including four-byte sequences.
- **Baseline:** Same refusal in the frozen 0.1.0 decoder.
- **Introduced by:** older (identical in the 0.1.0 decoder)
- **Suspected files:** electron/fileIO.mjs
- **Suggested fix:** Encode characters missing from the two-byte table with the GB18030 four-byte algorithm.
- **Confirm verdicts:**
  - DEC-3: **reproduced** — vitest -t DEC-3 fails: Error: 文档包含 GBK 编码无法表示的字符「𠀀」，请用「另存为」保存为 UTF-8. Baseline: the test itself checks the frozen 0.1.0 fixture: same refusal → pre-existing. My severity: low.

### H28 [low, spec-gap] The decoder tests and differentials run on Node's ICU, not on the Electron 44 main process the app ships

- **What goes wrong for the user:** No user impact found directly; future decoder changes validated only in vitest may behave differently in the app.
- **Repro (from the project root):** `MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex node bench/electron/v3-dec-icu.mjs`
- **Observed:** Encoder table sizes differ (big5 14816 vs 14490, shift_jis 9397 vs 9210, euc-kr 8570 vs 17176, gbk same size different content); 88 of 1072 inputs decode differently, the frozen 0.1.0 fixture included.
- **Expected:** Thresholds and differentials evaluated with the shipped runtime's decoders.
- **Baseline:** Not applicable.
- **Introduced by:** older (test methodology)
- **Suspected files:** test/electron.fileIO.differential.test.ts, electron/fileIO.mjs
- **Suggested fix:** Run the decoder differential under Electron's Node (ELECTRON_RUN_AS_NODE) or a main-process harness.
- **Confirm verdicts:**
  - DEC-4: **reproduced** — v3-dec-icu (Electron main of the staging directory): tableDiff for gbk, big5 (14816 vs 14490), shift_jis (9397 vs 9210), euc-kr (8570 vs 17176); resDiffCount 88; even the frozen 0.1.0 fixture answers differently (euc-kr in Node, windows-1252 in Electron) for Latin noise. Baseline: not applicable (test methodology; both apps run the same Electron). My severity: low.

### H29 [low, new-feature-defect] The fidelity gate is quadratic in a whitespace run inside emphasis or a formula

- **What goes wrong for the user:** A block with tens of thousands of spaces inside emphasis or a formula freezes the window 1-3 s per click.
- **Repro (from the project root):** `MDR_PORT=5388 node bench/verify/v3-rev-browser.mjs stallEm stallMath ; perl -e 'alarm 110; exec @ARGV' npx vitest run test/v3-rev-fidelity-stall.test.ts`
- **Observed:** click → next frame 1202 ms (em) and 2225 ms (math) at N=50000; gate 941 / 1535 ms in jsdom, serialize 2-8 ms.
- **Expected:** Linear, well under 100 ms.
- **Baseline:** Not applicable (0.1.1 starts no session).
- **Introduced by:** fix round 2 (U12 fidelity.ts)
- **Suspected files:** src/preview/fidelity.ts
- **Suggested fix:** Replace the two trailing-whitespace regexes (hoist, mathAtom) by backward loops.
- **Confirm verdicts:**
  - REV-3: **reproduced** — v3-rev-browser stallEm 1202 ms, stallMath 2225 ms (click → next frame, N=50000); vitest v3-rev-fidelity-stall 2/2 fail (gate 941 ms / 1535 ms, serialize 8 / 2 ms). Baseline: not applicable. My severity: low. timingSensitive by nature; 1 browser run + 2 vitest runs all far above the bound.

## Whole unit suite (step 2)

- npx vitest run --no-file-parallelism, run once in the background: 92 files / 1818 tests, 7 files and 42 tests failed, 157.4 s.
- 41 of the failures are in v3 repro files, and each belongs to a reproduced finding:
- - v3-rev-reserved-bypass: 18 (REV-1 12, REV-2 6).
- - v3-dec-decoder: 7 (DEC-1 4, DEC-2 2, DEC-3 1).
- - v3-fid-r1: 7 (FID-4 2, FID-5 4, FID-6 1).
- - v3-ses-repro: 6 (SES-1 2, SES-2 2, SES-3 1, SES-8 1).
- - v3-rev-fidelity-stall: 2 (REV-3).
- - v3-rev-markers: 1 (REV-4).
- 1 failure belongs to no finding: the existing test/final-delta-fuzz.test.ts 'incremental preview state equals a full structure of the same state' (seed 9004 step 1: lineToScrollTop 859 against 862 at entry 72).
- - Run alone it passed 2 of 2 times, and 6 concurrent single runs all passed, so it failed 1 of 9 runs.
- - Likely cause: a timing-dependent test. createPreview's eviction schedule uses real performance.now(), while the test only fakes timers. Reported as unexplained.

## Performance (step 3)

- (a) npx playwright test, run once (58.1 s): every budget passes.
- - P1 open to first visible: 117.7 ms (< 400).
- - P4: 0 ms / 0 tasks.
- - P5 main per keystroke: p95 26.8 ms (< 30), max 35.1 ms (< 60), raw p95 28.0 ms.
- - P5 keystroke to mount: p95 34.3 ms (< 40).
- - P8: 0 %. P11: 0 ms.
- - Playwright created test-results/.last-run.json in the tree; I moved it to my scratch directory.
- (b) P5 against 0.1.1 with bench/verify/fix2-int-p5.mjs, the same static server for both builds (adds ?perf=1), alternating, 3 runs each:
- - Candidate raw p95 38.0 / 28.9 / 29.7 ms, p50 15.5 / 13.8 / 14.2 ms.
- - 0.1.1 raw p95 34.0 / 31.3 / 27.3 ms, p50 16.0 / 13.4 / 14.3 ms.
- - Keystroke to mount p95: 34.2-34.7 ms in both builds.
- - The candidate is not slower than 0.1.1. The first run of each build is the high one.
- (c) With MDR_PORT=5388, one at a time:
- - inline-verify-perf: 5/5. large.md session start max 13.2 ms; preview work per key p95 0.7 ms; 300-line list start 30.6 ms and flush p95 2.3 ms; 20 tables flush p95 2.3 ms.
- - inline-verify-resume: 13/13. Resume window median 28 ms (small.md and large.md).
- - fix2-i2-paste: 9/9. Longest task after a 55 000-character one-line paste 22 ms, after 1 000 lines 25 ms; next-key flush 19-28 ms; refusals correct. In one unbroken 55 000-character word the next insertText takes 1616 ms (K16).

## r1 checks

| r1 group | variations tried | result | covered by |
|---|---|---|---|
| G1 | 7 (RAWTEXT style/xmp/title/textarea/noembed/noframes/iframe/script, CDATA token, &Tab; md-math, &Tab; md-block section, direct data-l control) | broken | H1 (REV-1, REV-2); the direct data-l control holds |
| G2 | 27 jsdom + 7 Chromium link variations | holds |  |
| G3 | 5 jsdom cell / formula variations + property fuzz 6 seeds | holds |  |
| G4 | 7 jsdom PUA variations + list-cache fuzz ~1800 sequences | holds | see also H15 (REV-4, marker exhaustion) |
| G5 | 10 jsdom + 11 Chromium edge cases + fuzz | holds |  |
| G6 | large pastes into list / quote / cell / heading, limit both sides | holds |  |
| G7 | flush, saves, close, drafts, export, menu save (verify-app, verify-session); tight neighbour; Backspace in the emptied element | broken | H12 (SES-1), H3 (SES-2) |
| G8 | 9 jsdom + 2 Chromium two-session cases | holds |  |
| G9 | 5 jsdom + fuzz | holds |  |
| G10 | 43 keys in the resume window vs a live session | holds |  |
| G11 | 4 multi-boundary splits (quote, list, heading, three) | holds |  |
| G12 | far undo / redo / undo of an emptied block in a 600-paragraph document | holds |  |
| G13 | 13 list Tab / Shift-Tab cases | holds |  |
| G14 | 4 (click in the rewritten line, double-click, after an emptied block, drag on another line) | broken | H21 (APP-1, drag) |
| G15 | drags without a session, drag out of a session, ⌘A ⌘A in 6 block kinds and 3 code kinds | broken | H8 (SES-4), H22 (APP-2) |
| G16 | 5 slow-worker replacements (verify-session) + 3 (verify-review) | holds |  |
| G18 | 36 jsdom + 2 Chromium | holds |  |
| G19 | 8 jsdom + 1 Chromium | holds |  |
| G20 | 3 digit-after variations hold; currency-rule variations | broken | H17 (FID-4) |
| G21 | 8 jsdom + fuzz | holds |  |
| G22 | Latin CP1252 in 5 languages, NUL padding, UTF-8-shaped GBK | broken | H7 (DEC-1) |
| G23 | Big5 override saves, Shift_JIS CP932 saves, NEC-style EEEF + 8790 | broken | H23 (DEC-2) |
| G24 | GBK-extension names (3400 strings), 6000 random GBK/3+4, hant-gbk 7637 | holds |  |
| G25 | CP1250 sentences with 8D/9D/8F, large files | holds |  |
| G26 | lenient UTF-8 with a genuine U+FFFD, reload, draft restore | holds |  |
| G28 | offer unanswered + Escape session; offer unanswered + typing taken back | broken | H5 (FLOW-1, pre-existing) |
| G29 | preview-session change + 恢复 in the same frame; re-shown offer | holds |  |
| G30 | three tabs 丢弃 at 0/5/50 ms; legacy backend two untitled downloads | broken | H25 (FLOW-3, pre-existing) |
| G31 | refused files onto a dirty document (4 kinds); normal .md onto the editor pane | broken | H2 (FLOW-4, SHELL-3) |
| G33 | AbortError / NotAllowedError / SecurityError; getFile NotFoundError | holds |  |
| G34 | repeat failure, 10 failures, ×; web lost permission then picker; /private/tmp vs /tmp | broken | H24 (FLOW-2) |
| G36 | 新建 ×3 queued; same document reloaded | holds |  |
| G37 | 31 vector forms × 6 activations × editing off/on, original repro, SVG / area variations | holds | page script about:blank is H6 (SHELL-1, pre-existing, not a document vector) |
| G38 | 6 hidden / minimised quit variations | holds |  |
| G39 | palette, find field, go-to-line, ⌘K link field | holds |  |

Every broken r1 variation is covered by a reproduced finding: G1, G7, G14, G15, G20, G22, G23, G28, G30, G31, G34.

## What the verifiers attacked without breaking it

- **verify-fidelity:** No false U12 refusal of an ordinary block: direct walks of medium.md (6002 blocks), large.md (30002), small.md, README and docs found 17 refusals, all raw HTML (K4); 500 real clicks found 0. No false pass in 292 written sessions over adversarial documents (0 rendering differences, 0 bytes outside the block). Click + Esc writes nothing (530 blocks). The list cache matches uncached serialization with per-call markers (6 seeds x 150 sequences). Typed Markdown characters stay literal. U13 meets the serializer (15 Chromium cases). U14 keeps leading lines.
- **verify-session:** U13: 24 cases plus undo/redo byte for byte. U14 holds for every first-block kind. unkeepReusedId / held: 10 per-frame sampled cases, only the SES-6 flash. The P1 class: 8 history cases, no lost keys. U7 pointer gestures: 30 cases, only SES-4 fails. Paste: about 45 cases, only SES-5, SES-8 and SES-9 fail. An oracle fuzz (about 33 seeds, small / human speed / large.md) found SES-8 and SES-9. IME, drag and drop and the editing toggle around sessions also held.
- **verify-app:** Saving with pending session text or an emptied block, on every web save path, writes exactly the screen. Replacing the document during a session never leaks its text. Draft offers against a live session work. Block identity with duplicates and leading lines: 23/24 (the one mismatch was a wrong expectation). The ghost survives far scrolling. UI operations right after typing work (11/11). Desktop dev shell 14/14 and staging 5/5. With editing off the preview behaves like 0.1.1 (18 probes). large.md sessions at top, middle and end are exact. The dirty flag is right.
- **verify-flows:** Typing during a slow save keeps a newer draft. Session text counts as dirty for every replacing request and for quit. The window closes only when confirmed. OS document bursts give one question. Drafts around save / 不保存 work. argv failures are named. An IME composition at close is saved. ⌘Q with the 打开… panel up asks. A folder or FIFO open-file never loses the document. No crash dialogs.
- **verify-shell:** No document content navigates the window, opens a window or downloads (372 activations + 11 static carriers). 37 page-script vectors other than about:blank / about:srcdoc are cancelled. The open queue is right after every cancelled navigation (196/196 + 6/6). The dev-URL rule holds (10/10). Closing or quitting around full-screen transitions caused 0 crashes in 33 cases. G38 holds for the whole class. Drops never navigate. The lifecycle scripts reproduce the integrator's numbers. A line-by-line read of the main.mjs diff found no stuck flag.
- **verify-decoder:** Over 95 830 inputs in Node and in the Electron main process, no refusal other than the binary rule, no label that fails to round-trip and no U+FFFD in a non-UTF-8 reading. With the switch off the results equal the fixture (0 differences). Unmodified and +1 saves keep every byte. meta.table survives conflict, retry and reload. The K11 dialog appears exactly for lenient UTF-8. Large-file sampling agrees with the whole-file decision. The thresholds sit where documented.
- **verify-review:** The unkeepReusedId / held claim holds: every caller was read, and 4 slow-worker cases passed 8/8. No listener or element leaks over 120 sessions and 40 loads. The sanitizer config and CSP are unchanged apart from the new hook. The gate's main-thread render cannot run script. The regexes are linear except REV-3. Nothing on the session path inserts HTML from document text. A directly forged data-l is flagged.

## What nobody covered

- Real macOS input: OS-level key equivalents reaching the native menu during a session (double ⌘B / ⌘Z), real IME (only CDP), a real Finder drag, and real open / save sheets.
- A really hidden tab: a session edit within one frame before hide, and the draft on hide with an open composition. Headless Chromium cannot hide a page.
- The desktop menu 撤销 in the resume window beyond K2. native.ts isUiTextField treats the capture textarea as a UI field.
- Natural timing of SES-6 (only the slow-worker hook was used). The full structure path of unkeepReusedId under a worker restart was only read, not run.
- main.mjs render-process-gone: the third crash within 60 s calls win.destroy(), possibly during a full-screen transition. Not run, so that no crash dialog appears on the user's screen.
- The decoder of the web build (File.text()). Real-world GBK / Big5 / Shift_JIS files, Big5-HKSCS, EUC-JP, and Shift_JIS user-defined characters.
- serialize.ts startsLine: '#' after a <br> and a whitespace-only <strong> (jsdom only). '**__d__**' (not reachable by ⌘B). A pasted U+200B is dropped from the source (not judged).
- Exceptions thrown inside serializeBlock during flush or begin. replayToggle when the block re-rendered meanwhile.
- Two tabs on the same document while one holds a session. The native 另存为 dialog while a session holds text. Recent-entry open and 重新载入 during a session (code-reviewed only).
- Drafts: a crash draft older than the file's mtime is never offered. The same file under two path spellings gets two docIds. delOwnDraft's text fallback can delete another tab's draft holding identical text.
- In SES-1's script, the case tight-quote-del ('para one⏎> quoted⏎⏎para two' emptied → 'para two') also fails. The verifier did not claim it. It may be ⌘A selecting both lines of one block; I did not judge it.

## Decoder verdict for S4 (f)

Yes, there is a reproduced decoder regression of medium or above against 0.1.1: DEC-1 (group H7, medium, regression-vs-shipped). It reproduced in the unit test (4/4) and end to end in the staging shell on open-file, the 打开… panel and a drop: dialog 「…不是完全有效的 UTF-8 文本」, and a save rewrites 378 bytes. The baseline shell reads the same file as GBK and saves exact+x. By S4 (f), override 3 (lenient UTF-8) must not replace a clean CJK reading that scores as real text; otherwise the release ships with DECODER_OVERRIDES off. Switching the overrides off removes DEC-1 (it is override 3). It does not remove DEC-2 (H23, a low regression: 22 bytes respelled instead of 2 in a constructed NEC-style Shift_JIS file), because the save-table rule is not behind the switch. DEC-3 (H27) is pre-existing and DEC-4 (H28) is test methodology. Its effect also applies to the frozen 0.1.0 fixture, which decodes 88 of 1072 inputs differently in Node and in Electron, so decoder differentials must run in Electron.

## Notes on the verifiers' scripts

- bench/verify/v3-ses-paste.mjs limit-prose-sel-replaced fails, but only because its option pre:'sel500' is not implemented: no selection is made, so 59 004 + 1 100 characters is rightly refused. This is a script artifact, not a product failure.
- bench/verify/fix2-int-p5.mjs on a production build needs a server that adds ?perf=1: its warmUp opens a URL without it and times out after 90 s on vite preview. I used a 25-line static server in my scratch directory, as the integrator did.
- bench/verify/v3-app-g.mjs and v3-app-regress.mjs printed nothing when started from a nohup'd sh batch with perl alarm and a pipe, and one v3-app-regress process outlived the batch. Run directly, they work. I ran them directly.
- v3-app-regress.mjs takes only one case filter (argv[2]).
- npx playwright test writes test-results/ into the tree.
