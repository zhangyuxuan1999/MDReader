# 0.2.0 release candidate — stage 2d targeted re-verification, r3 findings (2026-11-21)

Six verifiers attacked fix round 3 and reported 35 findings (verify-session-a 9, verify-session-b 8, verify-trust 7, verify-flows 3, verify-app 8, verify-decoder 0). I re-ran every repro myself, alone, on a quiet machine (my ports 5438 for the tree's Vite / the built dist and 5448 for the 0.1.1 dist; the only change to each command is the port). All 35 reproduced. The timing-sensitive ones (SESA-5, SESB-4, SESB-6, TRU-2, TRU-3, FLOW-1) were run three times and reproduced each time (SESB-6's paste variants 1 of 3). They form 30 groups J1-J30: 4 high, 9 medium, 17 low.

**By the release gate this candidate must not ship.**
- 3 high groups are new in 0.2.0: J1 (paste over a whole link writes an invisible empty link), J2 (the session's zero-width spaces reach the source through copy and paste) and J3 (undo + redo after emptying a block between two lists deletes the list below on the next key). J1 and J2 were introduced by fix round 3.
- 1 regression against 0.1.1 of medium or above: J5 (U20, round 3): after clicking into a list, quote or table, a drag or Shift-click copies a different text from 0.1.1.
- J4 is high but pre-existing (identical in 0.1.1): a save in flight re-binds a replaced document to the old file.
- 7 medium new-feature groups (J6-J12) need a fix or an explicit acceptance; J13 is medium and pre-existing.

The worst problems, in plain terms:
- Double-click a link's word in the preview and paste: the link disappears from the screen, "[](url)" stays hidden in the file and the pasted word is plain text (J1).
- Copy a paragraph, list item, heading or cell that starts with a formula after clicking into it, paste it into the source: a zero-width space nobody can see is now in the file (J2).
- Empty a paragraph between two lists, press ⌘Z and ⇧⌘Z (or the menu items), type one letter: the second list is gone from the document (J3).
- ⌘Z at the end of a line that ends with a formula: the caret goes inside the formula and nothing typed appears until a click (J6). Clicking back into a formula-heavy block right after Esc drops what is typed (J8).
- With 预览可编辑 on, a drag that starts at the start of a list item, quote paragraph or cell copies an extra line break or tab (J5, regression).

What fix round 3 repaired and held: U15 (H1: no bypass in 1.2 million generated documents), U17 (H2), R5 (H5), S4 (f) (H7, H23, H28: reads and saves identical to 0.1.1 in the shipped runtime), H20, H22, P1, U16, and U18 (a) at human speed. Broken variations (each is a reproduced finding): H3, H4, H8, H10, H11, H12, H13, H14, H15, H17, H29.

## Machine and candidate (step 0)

- At my start two orphaned dev-shell Electron instances of this project were running (pids 16692 and 17289, app path = project root, isolated profiles under /var/folders/.../mdr-iso-*, parent launchd, about 45 minutes old, left by a verifier). I ended both with SIGKILL (no crash dialog). No Vite on 5401-5448, no vitest, no headless Chromium. The user's own /Applications/MDReader.app (pid 97469, started yesterday 21:03) was left alone.
- Load at the start: load average about 3 on 10 cores; WindowServer about 40 % of one core, Claude and Gemini a few % each; nothing heavy from other projects during my runs (load 2-3 throughout).
- npx tsc --noEmit printed nothing (exit 0). node bench/verify/scan-invisible.mjs: OK.
- diff -rq electron/ and dist/ against release/staging-0.2.0.noindex, and diff of package.json: no differences.
- /Applications/MDReader.app/Contents/Info.plist CFBundleShortVersionString is 0.1.1 (read only, not launched).
- Crash reports: still 11 Electron reports, the newest Electron-2026-11-20-145455.ips (and .000, 14:54 local). The verifiers caused no new main-process crash, and neither did my own Electron runs (v4-sesa-desk on staging, v4-app-desk on the dev shell, v4-dec-diff on staging): the list was unchanged at my end.
- One of my own runs left an orphan: bench/electron/v4-app-desk.mjs G2 ran into my 110 s alarm after printing its results and left its Electron (pid 28368); I ended it with SIGKILL, no crash report. The two orphans found at the start were most likely left the same way (a script killed by its alarm before its finally block closed the app).

## Summary table

| group | severity | class | introduced by | findings (verdict) | title |
|---|---|---|---|---|---|
| J1 | high | new-feature-defect | fix round 3 (fix-session-b H14: pasteText types U+200B over the selection and keeps it when it is all its text node holds; avoidLinkEdge then moves the insertion after a link that holds only the placeholder) | SESB-1 (reproduced) | H14 variation: pasting over a selection that is a link's whole text writes an empty, invisible link [](url) and puts the pasted text after it |
| J2 | high | new-feature-defect | fix round 3 (fix-session-b U21 spacerBefore / Session.spacers; fix-session-b H14 paste placeholder kept when it is all its text node holds) | SESB-2 (reproduced), APP-3 (reproduced) | U21 / H14 leftovers: the zero-width spaces a session puts into its block are copied by ⌘C; pasting the copy into the editor writes an invisible U+200B into the source |
| J3 | high | new-feature-defect | an earlier round (U1 history resume onto a block whose range the step changed); fix round 3's U19 lost-until-re-render rule covers only released blocks | APP-1 (reproduced) | H4/U19 class: ⌘Z + ⇧⌘Z of an emptied block between two blocks that merge (two same-type lists, two indented code blocks) resumes on a stale wrapper; the next keystroke deletes the block below from the source |
| J4 | high | pre-existing | older (identical in 0.1.1): save() is not run through docGuard and assigns file = r.file; savedVersion = version after its await | FLOW-1 (reproduced) | A document replaced while a save is still in flight gets the saved file's identity back: the next ⌘S writes the new document's text into the old file |
| J5 | medium | regression-vs-shipped | fix round 3 (fix-session-a H8/U20: hostRelease / restoreKept / pointAtOffset) | SESB-3 (reproduced), SESB-8 (reproduced) | H8 variation (U20): the kept selection is restored by visible-text offset, which lands on the wrong side of a line boundary (multi-line blocks) or on the wrong characters when the re-rendered text differs from the session DOM |
| J6 | medium | new-feature-defect | older (offsetForSource / shownText since U1/U3); fix round 3's U22 'after' branch turned H13's misplaced new-paragraph undo after a formula into swallowed typing | SESA-1 (reproduced), SESA-2 (reproduced) | H13/U22 class: the resume caret after ⌘Z / ⇧⌘Z or a U3 merge is computed from shownText, which does not model inline formulas, images, reference links or an empty list item; at the end of a formula the caret lands INSIDE it and every key is swallowed |
| J7 | medium | new-feature-defect | older (Chromium's placeholder <br>); fix round 3's caretBeforeAtom / caretBeforeAtomsAt handle only direct siblings, and enterKey's heading branch resets the caret after them | SESA-3 (reproduced), SESA-4 (reproduced) | H10/H11 variation (U21 gaps): Enter before an atom inside bold, italic or a link writes a break nobody typed; Enter before an image in a heading, a linked image, or an image followed by a formula puts the typed text after the image |
| J8 | medium | new-feature-defect | fix round 3 (fix-session-a U19/H4: release() marks the block lost until the re-render mounts; the click resume expires after 300 ms and cancelResume() drops the queued keys) | SESB-4 (reproduced) | U19 regression: clicking back into a block whose session just ended, while its re-render is pending for more than CLICK_WAIT_MS (a giant > 256 KB re-render, or any worker answer slower than 300 ms), loses every key typed: no session, no toast |
| J9 | medium | new-feature-defect | fix round 2 or older (tryResume: if (r.expected !== null) ok = shownNow() === r.expected, unchanged since pre-r3) | SESB-6 (reproduced) | H4 variation (U19): after a split (Enter or a paste of paragraphs) whose remaining part has the same text as the block below, the resume accepts that neighbour by expected text: the caret jumps one paragraph down and typed text lands there |
| J10 | medium | new-feature-defect | older (Chromium wraps the moved paragraph in a style span because the focus-line tint differs, and respells the space) | SESB-7 (reproduced) | H14 variation (U19): typing or pasting over a selection that spans two paragraphs of a quote or a loose list item writes &nbsp; |
| J11 | medium | new-feature-defect | fix round 2 (U8 pasteText rewrite: leading and trailing empty paragraphs are filtered out) | SESB-5 (reproduced) | U8/U19: a pasted text that starts or ends with a blank line loses that paragraph break: the pasted paragraph is glued into the caret's paragraph |
| J12 | medium | new-feature-defect | an earlier round (U9; retrack() derives the place from the previous block's end, which absorbs the following list once the block is gone); not covered by round 3's U18 keep rule | APP-2 (reproduced) | H12/U18 (c) variation: text typed into an emptied block between two blocks that merge once it is gone (same-type lists, indented code) is written after the second one, not at the block's place |
| J13 | medium | pre-existing | older (0.1.x checkbox write-back; DOMPurify keeps label and style) | TRU-6 (reproduced) | A document's invisible <label> overlay turns a click anywhere on the preview into a tick of a hidden task (no reserved name, U16 satisfied) |
| J14 | low | new-feature-defect | older (U9 writes the deletion in the next frame; round 3's goneKey applies only once cur.gone is set) | SESA-5 (reproduced) | A second Backspace in the same frame as the emptying keystroke is an ordinary Backspace in a not-yet-gone block: with a non-paragraph block above it does nothing and the next text goes into the emptied place |
| J15 | low | new-feature-defect | fix round 2 (U9 deleteBlock); round 3's keep rule handles the document end only when the line above is non-blank | SESA-6 (reproduced) | Deleting the last block of a document without a final newline adds one (also in the saved file) |
| J16 | low | new-feature-defect | older | SESA-7 (reproduced) | ⌘A ⌫ in a loose list leaves an empty item; typing then writes '- N⏎⏎-' |
| J17 | low | new-feature-defect | older (U7) | SESA-8 (reproduced) | After ⌘A ⌘A (whole preview selected) the first click on a block starts no session; text typed after it goes nowhere |
| J18 | low | new-feature-defect | older (atomAfter treats a <br> as a stop) | SESA-9 (reproduced) | Enter right before a hard line break: the typed text goes after the break and the new paragraph starts with a backslash break |
| J19 | low | new-feature-defect | fix round 2 (G4 pickMarkers checks innerHTML, where href/src are percent-encoded, while linkDest() decodes them) | TRU-1 (reproduced) | H15 variation: a U+E001 in a link or image destination collides with the caret marker; after Enter the next typed character lands at the start of the block |
| J20 | low | new-feature-defect | older (both lines are unchanged in release/pre-r3.noindex; round 3's H29 fix covered only the whitespace regexes) | TRU-2 (reproduced), TRU-3 (reproduced) | H29 variation: a run of backslashes (prepare()'s /\\+$/) or of backticks (stripCode's code-span regex) makes what a click runs before a session quadratic: about 1.0-1.3 s at 58 000 characters |
| J21 | low | new-feature-defect | fix round 3 (fix-serial H17: afterFormula counts only ASCII whitespace, the final trim removes Unicode whitespace) | TRU-4 (reproduced) | H17 variation: an ideographic space (U+3000) or em space typed after a digit…digit formula at a paragraph or cell end turns the formula into literal text |
| J22 | low | new-feature-defect | older | TRU-5 (reproduced) | Editing an inline formula's TeX in the preview: a trailing space or trailing backslash turns the formula into literal text |
| J23 | low | pre-existing | older (0.1.x) | TRU-7 (reproduced) | A block whose HTML DOMPurify cannot turn into a fragment (<!div>, <frameset>) shows the word null |
| J24 | low | pre-existing | older (isMarkdownDrop checks dt.files[0] only) | FLOW-2 (reproduced) | Several files dropped with a non-Markdown file first: nothing opens, although CONTRACT says the first Markdown file opens |
| J25 | low | pre-existing | older | FLOW-3 (reproduced) | Web: a dropped .md the browser cannot read shows the raw English NotReadableError text in the zh-CN toast |
| J26 | low | spec-gap | fix round 3 (fix-session-b U21: Home/End move by line in a live session) | APP-4 (reproduced) | H16/K19 scope: in a session Home / End / Shift+Space no longer scroll the preview (also in preview-only mode); README and K19 name only Space |
| J27 | low | new-feature-defect | an earlier round (runEditorCommand) | APP-5 (reproduced) | Editor commands that end a session (toolbar 标题, palette 切换任务项) act on the block's first or last line, not the caret's line; after an emptied block on a neighbouring block |
| J28 | low | new-feature-defect | older than round 3 (not measured on pre-r3) | APP-6 (reproduced) | After 取消 on the discard question raised while typing in a session, the focus is on body and the next key is lost |
| J29 | low | spec-gap | an earlier round (U13 drops the whitespace after the caret on Enter; U3 joins the raw texts) | APP-7 (reproduced) | Enter then Backspace in the middle of a paragraph before a space loses the space |
| J30 | low | new-feature-defect | an earlier round (the U9 range of a first block includes its trailing blank line) | APP-8 (reproduced) | H13/U22 class: after emptying the FIRST block, ⌘Z restores it but the session continues at the start of the next block |

## Groups

### J1 [high, new-feature-defect] H14 variation: pasting over a selection that is a link's whole text writes an empty, invisible link [](url) and puts the pasted text after it

- What goes wrong for the user: Pasting over a whole link's text makes the link vanish on screen, leaves "[](url)" hidden in the file and writes the pasted word as plain text.
- Findings: SESB-1. Introduced by: fix round 3 (fix-session-b H14: pasteText types U+200B over the selection and keeps it when it is all its text node holds; avoidLinkEdge then moves the insertion after a link that holds only the placeholder).
- Repro (from the project root): `MDR_PORT=5438 node bench/verify/v4-sesb-pastesel.mjs link   (Vite of the tree on MDR_PORT)`
- Observed: 'Lead **bold words** tail and [link](https://e.x/y) end.': double-click 'link' in a session, ⌘V 'X' -> '… tail and [](https://e.x/y)X end.' ('X Y' -> '[](https://e.x/y)X Y'; the same for [one](https://e.x/z) and an exact JS selection). 9 of 12 cases; the 3 passing ones cross the link edge.
- Expected: What typing over the same selection writes: '… tail and [X](https://e.x/y) end.' (U19). Never a link with no text.
- Baseline: Not applicable (new feature). The verifier measured pre-r3: '… tail andX&nbsp;end.' (the old H14), so the empty link is new in round 3.
- My verdict: Reproduced, 9/12 cases.
- SESB-1: reproduced. Decisive output: v4-sesb-pastesel.mjs link: 9/12 FAIL, e.g. dbl-link-word-x typed="… tail and [X](https://e.x/y) end." pasted="… tail and [](https://e.x/y)X end." (the 3 passing cases cross the link edge); 1 of 1 runs (verifier 2 of 2). Baseline run: not applicable (new feature); the verifier measured pre-r3 (H14 smart delete, no empty link), which I did not re-run.
- Suspected files: src/preview/inlineEdit.ts

### J2 [high, new-feature-defect] U21 / H14 leftovers: the zero-width spaces a session puts into its block are copied by ⌘C; pasting the copy into the editor writes an invisible U+200B into the source

- What goes wrong for the user: Copying from a session whose block starts a line with an inline formula (or after a paste over a selection) puts U+200B on the clipboard, and pasting it into the source writes a character nobody can see.
- Findings: SESB-2, APP-3. Introduced by: fix round 3 (fix-session-b U21 spacerBefore / Session.spacers; fix-session-b H14 paste placeholder kept when it is all its text node holds).
- Repro (from the project root): `MDR_PORT=5438 MDR_BASE_PORT=5448 node bench/verify/v4-sesb-zwcopy.mjs   ;   MDR_PORT=5438 node bench/verify/v4-app-zw.mjs`
- Observed: '$x^2$ starts here': click 'starts', ⌘A, ⌘C -> clipboard '<U+200B>\nx\n2\nx \n2\n  starts here'; Esc, ⌘V into the editor -> the source holds U+200B. Also after a hard break, in a list item, a heading, a table cell (also by a drag in the cell), with Home + Shift+End. Paste 'X' over a double-clicked **bold**, then ⌘A ⌘C -> 'Lead <U+200B>X tail'. v4-app-zw: 11 of 20 gestures (all ⌘A and Shift+End ones, the cell drag).
- Expected: ⌘C copies what the user sees: no U+200B; nothing invisible reaches the source through copy and paste.
- Baseline: 0.1.1 dist, same scripts: no U+200B in any copy (e.g. 'x \n2\n  starts here').
- My verdict: Reproduced (4/5 and 11/20). APP-3 raised from medium to high: same root cause as SESB-2, and the scale rates an invisible character written into the source as high.
- SESB-2: reproduced. Decisive output: v4-sesb-zwcopy.mjs: 4/5 FAIL, formula-start-selall cand="<ZWSP>\nx\n2\nx \n2\n  starts here" base="x \n2\n  starts here" zwInSourceAfterEditorPaste=true; paste-over-bold-then-copy copy="Lead <ZWSP>X tail". Baseline run: measured in the same script on the 0.1.1 dist (5448): no U+200B in any copy.
- APP-3: reproduced. Decisive output: v4-app-zw.mjs: 11/20 gestures zwPlain 1 / zwHtml 1 / zwSource 1, e.g. para-start cmdA plainHead="<ZWSP>\nc\n+\nd\nc+d 开头". Baseline run: the verifier measured 0.1.1 (0 in 20); SESB-2's run of the same class on 0.1.1 gave 0 in my run. Note: Verifier rated medium. Same root cause as SESB-2: an invisible character the user cannot see ends up in the source through an ordinary copy and paste, which the scale rates high.
- Suspected files: src/preview/inlineEdit.ts

### J3 [high, new-feature-defect] H4/U19 class: ⌘Z + ⇧⌘Z of an emptied block between two blocks that merge (two same-type lists, two indented code blocks) resumes on a stale wrapper; the next keystroke deletes the block below from the source

- What goes wrong for the user: Empty a paragraph between two lists, press ⌘Z and ⇧⌘Z, type one character: the whole list below vanishes from the document.
- Findings: APP-1. Introduced by: an earlier round (U1 history resume onto a block whose range the step changed); fix round 3's U19 lost-until-re-render rule covers only released blocks.
- Repro (from the project root): `MDR_RUNS=3 MDR_PORT=5438 node bench/verify/v4-app-redo.mjs lists   ;   desktop: MDR_DEV_URL=http://localhost:5438/ node bench/electron/v4-app-desk.mjs G2`
- Observed: '- aaa\n\n乙段落文字。\n\n- zzz\n': empty 乙 (source '- aaa\n\n- zzz\n'), ⌘Z, ⇧⌘Z (source again '- aaa\n\n- zzz\n'), the session shows only 'aaa', type Q -> '- aaaQ\n'. Also with a quote between the lists, ordered lists ('1. aaaQ\n'), tight lists ('- aaa\n- bbbQ\n'), indented code ('    aaa codeQ\n'), and through the desktop menu 编辑→撤销 / 重做.
- Expected: After the redo the session shows the merged block (aaa and zzz) or waits for its re-render; Q gives '- aaaQ\n\n- zzz\n', never deleting '- zzz'.
- Baseline: Not applicable (new feature). pre-r3 (verifier): the same loss.
- My verdict: Reproduced: lists 3/3 + 1, lists-quote 3/3, ordered, tight, indented code 1/1 each, desktop menu 1/1; the paragraph control keeps zzz.
- APP-1: reproduced. Decisive output: v4-app-redo.mjs lists (MDR_RUNS=3): undo-redo #1-#3 afterQ="- aaaQ\n" lostBelow=true; lists-quote 3/3; ordered "1. aaaQ\n", tight-lists "- aaa\n- bbbQ\n", indented-code "    aaa codeQ\n"; control-paras keeps zzz; desktop dev shell menu 撤销/重做 (v4-app-desk G2): afterQ "- aaaQ\n". Baseline run: not applicable (new feature); pre-r3 as measured by the verifier (5/5 same loss), not re-run.
- Suspected files: src/preview/inlineEdit.ts, src/preview/createPreview.ts

### J4 [high, pre-existing] A document replaced while a save is still in flight gets the saved file's identity back: the next ⌘S writes the new document's text into the old file

- What goes wrong for the user: A ⌘S that is still writing when the user drops, opens or creates another document re-binds that document to the old file, and the next save overwrites the old file with the other text.
- Findings: FLOW-1. Introduced by: older (identical in 0.1.1): save() is not run through docGuard and assigns file = r.file; savedVersion = version after its await.
- Repro (from the project root): `MDR_TMP=<scratch> MDR_URL=http://localhost:5438/ MDR_BASE_URL='http://localhost:5448/?perf=1' node bench/verify/v4-flow-drop.mjs drop-during-save new-during-save clean-save-drop   (Vite of the tree on 5438, vite preview of release/baseline-0.1.1.noindex/dist on 5448)`
- Observed: The FSA writable's close is slowed to 2.5 s. drop-during-save: s1.md '# S1\n', type 'typed', ⌘S, drop drop-a.md 150 ms later, 丢弃: after the save the title is '● s1.md' while the editor shows '# DROPPED A\n'; typing 'more' and ⌘S writes '# DROPPED A\nmore' into s1.md. new-during-save: s2.md becomes 'NEW DOC TEXT'. clean-save-drop: s3.md becomes '# DROPPED A\nmore'.
- Expected: A save that completes after another document replaced the open one does not change which file is open; s1/s2/s3.md keep '# S1typed\n', '# S2typed\n', '# S3\n'.
- Baseline: 0.1.1 dist, same script: identical strings on disk and identical titles in all three cases.
- My verdict: Reproduced, drop-during-save 3/3, the other two 1/1, on both builds. High, pre-existing (not a release blocker by the gate's regression rule, but data loss).
- FLOW-1: reproduced. Decisive output: v4-flow-drop.mjs drop-during-save 3/3: afterSaveTitle "● s1.md", afterSaveText "# DROPPED A\n", disk2 "# DROPPED A\nmore"; new-during-save disk "NEW DOC TEXT"; clean-save-drop disk "# DROPPED A\nmore". Baseline run: 0.1.1 dist (5448), same script, same runs: byte-identical results in all three cases (pre-existing).
- Suspected files: src/app/App.ts

### J5 [medium, regression-vs-shipped] H8 variation (U20): the kept selection is restored by visible-text offset, which lands on the wrong side of a line boundary (multi-line blocks) or on the wrong characters when the re-rendered text differs from the session DOM

- What goes wrong for the user: After clicking into a list, quote or table, a drag or Shift-click that starts or ends at a line start copies an extra \n or \t (or loses the last \n); after an opened formula or collapsed spaces it copies a few characters too many or too few.
- Findings: SESB-3, SESB-8. Introduced by: fix round 3 (fix-session-a H8/U20: hostRelease / restoreKept / pointAtOffset).
- Repro (from the project root): `MDR_PORT=5438 MDR_BASE_PORT=5448 node bench/verify/v4-sesb-drag.mjs 'fwd-from-2nd-quote|item-two-start|nested-start|cell2-start|drag-into-session-item|drag-into-session-cell|esc-then-shift'   ;   … v4-sesb-drag.mjs 'formula-opened|dblspace'`
- Observed: Click into the list, drag from the start of 'item two text' to 'cell one': '\nitem two text\nnested three\ncol a\tcol b\nce' (anchor restored at the end of 'item one text'); backward drag ends '…item one text' without its \n; cell start '\tcell four…'; Esc then Shift-click from an item start: the same. Opened formula then drag from 'and more': ' more words.…'; two typed spaces collapsed by the write, then drag: '…Last para ome'.
- Expected: Byte-identical to 0.1.1 for the same gesture: 'item two text\nnested three\ncol a\tcol b\nce', '…item one text\n', 'cell four…', 'nd more words.…', '…Last para o'.
- Baseline: 0.1.1 dist, same script and run: all 12 copies are the expected ones.
- My verdict: Reproduced: 9/9 boundary cases and 3/3 changed-text cases fail on the candidate, all pass on 0.1.1. A regression of an everyday copy flow (预览可编辑 is on by default): release blocker by the gate.
- SESB-3: reproduced. Decisive output: v4-sesb-drag.mjs (7 filters, 9 cases): 0/9 pass, e.g. fwd-from-item-two-start cand="\nitem two text\nnested three\ncol a\tcol b\nce" base="item two text\nnested three\ncol a\tcol b\nce"; bwd-from-item-two-start cand ends "item one text", base "item one text\n". Baseline run: measured in the same script on the 0.1.1 dist (5448): every copy is the expected one, so the regression is real.
- SESB-8: reproduced. Decisive output: v4-sesb-drag.mjs formula-opened|dblspace: 0/3, formula-opened-then-drag cand=" more words.…" base="nd more words.…"; typed-dblspace-then-drag cand "…Last para ome" base "…Last para o". Baseline run: measured in the same script on the 0.1.1 dist: correct copies (regression).
- Suspected files: src/preview/inlineEdit.ts

### J6 [medium, new-feature-defect] H13/U22 class: the resume caret after ⌘Z / ⇧⌘Z or a U3 merge is computed from shownText, which does not model inline formulas, images, reference links or an empty list item; at the end of a formula the caret lands INSIDE it and every key is swallowed

- What goes wrong for the user: After undo at the end of a line ending in a formula nothing the user types appears until a click; after a merge or undo near a formula, image or reference link the text lands a few characters away or in the wrong list item.
- Findings: SESA-1, SESA-2. Introduced by: older (offsetForSource / shownText since U1/U3); fix round 3's U22 'after' branch turned H13's misplaced new-paragraph undo after a formula into swallowed typing.
- Repro (from the project root): `MDR_PORT=5438 node bench/verify/v4-sesa-repro.mjs SESA-1 SESA-2   ;   candidate directory: MDR_APP_DIR=release/staging-0.2.0.noindex node bench/electron/v4-sesa-desk.mjs`
- Observed: 'a1 b1 $x^2$⏎⏎zz⏎': ⌘→, type QR, ⌘Z, type W -> W lost (also list item, table cell, the new-paragraph undo; the caret sits in KaTeX text, isContentEditable false). Merge: 'a1 $x^2$⏎⏎b1 yy' ⌘← in b1, ⌫, Q -> 'a1 $x^2$b1 Qyy'; 'see ![i](…)⏎⏎b1 yy' -> 'see Q![i](…)b1 yy'; history: 'a1 $x^2$ b1 yyQ'; 'see[^1](note) b1 yQy'; '- one⏎- twoQ⏎-⏎'.
- Expected: 'a1 b1 $x^2$W', 'a1 $x^2$Qb1 yy', 'see ![i](…)Qb1 yy', 'a1 $x^2$ b1Q yy', '- one⏎- two⏎- Q'.
- Baseline: Not applicable (new feature). pre-r3 (verifier): identical for the in-line cases; the new-paragraph undo was misplaced, not swallowed.
- My verdict: Reproduced: SESA-1 4/5 (the redo case passes), SESA-2 8/8; identical in the candidate directory. SESA-5's fast-prev-math-end (Q lost) is the same mechanism.
- SESA-1: reproduced. Decisive output: v4-sesa-repro.mjs SESA-1: 4/5 FAIL, undo-math-at-end observed "a1 b1 $x^2$\n\nzz\n" expected "a1 b1 $x^2$W\n\nzz\n" (also item, cell, new-paragraph undo; redo case passes); candidate directory (v4-sesa-desk.mjs on staging): undo-math-at-end and undo-newpara-after-math swallowed. Baseline run: not applicable (new feature).
- SESA-2: reproduced. Decisive output: v4-sesa-repro.mjs SESA-2: 8/8 FAIL, e.g. merge-math-end "a1 $x^2$b1 Qyy", merge-image-end "see Q![i](…)b1 yy", undo-after-math "a1 $x^2$ b1 yyQ", undo-to-empty-item "- one\n- twoQ\n-\n\nz\n"; staging: merge-math-end and undo-after-math identical. Baseline run: not applicable (new feature).
- Suspected files: src/preview/inlineEdit.ts

### J7 [medium, new-feature-defect] H10/H11 variation (U21 gaps): Enter before an atom inside bold, italic or a link writes a break nobody typed; Enter before an image in a heading, a linked image, or an image followed by a formula puts the typed text after the image

- What goes wrong for the user: Splitting a paragraph or item in front of a bold, italic or linked formula inserts an empty hard-break line; splitting a heading in front of an image puts the next text after the image.
- Findings: SESA-3, SESA-4. Introduced by: older (Chromium's placeholder <br>); fix round 3's caretBeforeAtom / caretBeforeAtomsAt handle only direct siblings, and enterKey's heading branch resets the caret after them.
- Repro (from the project root): `MDR_PORT=5438 node bench/verify/v4-sesa-repro.mjs SESA-3 SESA-4`
- Observed: 'abc **$x$ b** y', caret after abc, Enter, Z -> 'abc⏎⏎\⏎**Z$x$ b** y'; *…* and a link the same; Shift+Enter 'abc  ⏎\⏎**Z$x$ b** y'; list item '- abc⏎- \⏎  **Z$x$ b** y'. '## abc ![i](…) y' -> '## abc⏎⏎![i](…)Z y'; 'abc [![i](…)](…) y' -> '…)Z y'; 'abc ![i](…)$x$ d' -> '![i](…)Z$x$ d'.
- Expected: 'abc⏎⏎Z**$x$ b** y', 'abc  ⏎Z**$x$ b** y', '- abc⏎- Z**$x$ b** y', '## abc⏎⏎Z![i](…) y', 'abc⏎⏎Z[![i](…)](…) y', 'abc⏎⏎Z![i](…)$x$ d'.
- Baseline: Not applicable (new feature).
- My verdict: Reproduced: SESA-3 5/5, SESA-4 4/4; math-in-bold and image-in-h2 identical in the candidate directory.
- SESA-3: reproduced. Decisive output: v4-sesa-repro.mjs SESA-3: 5/5 FAIL, math-in-bold "abc\n\n\\\n**Z$x$ b** y\n\nz\n", math-in-bold-shift "abc  \n\\\n**Z$x$ b** y", math-in-bold-item "- abc\n- \\\n  **Z$x$ b** y\n- e\n"; staging math-in-bold identical. Baseline run: not applicable (new feature).
- SESA-4: reproduced. Decisive output: v4-sesa-repro.mjs SESA-4: 4/4 FAIL, image-in-h2 "## abc\n\n![i](https://e.example/i.png)Z y", linked-image "abc\n\n[![i](…)](https://e.example/)Z y", image-then-math "abc\n\n![i](…)Z$x$ d"; staging image-in-h2 identical. Baseline run: not applicable (new feature).
- Suspected files: src/preview/inlineEdit.ts

### J8 [medium, new-feature-defect] U19 regression: clicking back into a block whose session just ended, while its re-render is pending for more than CLICK_WAIT_MS (a giant > 256 KB re-render, or any worker answer slower than 300 ms), loses every key typed: no session, no toast

- What goes wrong for the user: In formula-heavy notes (or on a slow worker), Esc and an immediate click back to keep typing silently drop the typed text.
- Findings: SESB-4. Introduced by: fix round 3 (fix-session-a U19/H4: release() marks the block lost until the re-render mounts; the click resume expires after 300 ms and cancelResume() drops the queued keys).
- Repro (from the project root): `MDR_PORT=5438 node bench/verify/v4-sesb-giantclick.mjs 'gap0|gap150'   ;   MDR_DELAY=400 MDR_PORT=5438 node bench/verify/v4-sesb-clickwait.mjs`
- Observed: A paragraph with 400 inline formulas (5.5 kB source, 412 106 bytes of HTML): click into it, Esc (or click another paragraph), within 0 or 150 ms click 'MARKER' and type 'QRS' -> after 2 s session=false, written=false, toast='', source unchanged. The same for a 100-item list. With every worker answer delayed 400 ms in a small document, 4 of 5 cases lose 'QRS'.
- Expected: The click starts a session at the clicked character (at once or once the re-render mounts) and 'QRS' is written there.
- Baseline: Not applicable (new feature). pre-r3 (verifier): 6/6 written.
- My verdict: Reproduced: 8/8 in each of 3 runs (24/24), the delay variant 4/5. Keys lost without any message.
- SESB-4: reproduced. Decisive output: v4-sesb-giantclick.mjs 'gap0|gap150' (8 cases): 0/8 in each of 3 runs (24/24 lose QRS): htmlBytes=412106 session=false written=false toast=""; v4-sesb-clickwait.mjs MDR_DELAY=400: 4/5 lose QRS. Baseline run: not applicable (new feature); pre-r3 measured by the verifier (6/6 written), not re-run. Note: timingSensitive: deterministic on the quiet machine (24/24).
- Suspected files: src/preview/createPreview.ts, src/preview/inlineEdit.ts

### J9 [medium, new-feature-defect] H4 variation (U19): after a split (Enter or a paste of paragraphs) whose remaining part has the same text as the block below, the resume accepts that neighbour by expected text: the caret jumps one paragraph down and typed text lands there

- What goes wrong for the user: In documents with repeated paragraphs, Enter or a paste moves the caret into the next identical paragraph and what is typed next goes there.
- Findings: SESB-6. Introduced by: fix round 2 or older (tryResume: if (r.expected !== null) ok = shownNow() === r.expected, unchanged since pre-r3).
- Repro (from the project root): `RUNS=4 MDR_PORT=5438 node bench/verify/v4-sesb-dupresume.mjs enter-mid-before-dup-wait   ;   RUNS=3 MDR_PORT=5438 node bench/verify/v4-sesb-dupresume.mjs   (the finding's filter 'a|b' matches nothing: the script uses includes())`
- Observed: 'a⏎⏎xdup⏎⏎dup⏎⏎z', caret after x, Enter, wait 500 ms, type QR -> 'a⏎⏎x⏎⏎dup⏎⏎QRdup⏎⏎z⏎'. Paste 'x⏎⏎ ' before the first of two dup paragraphs: the same, 1 of 3.
- Expected: 'a⏎⏎x⏎⏎QRdup⏎⏎dup⏎⏎z⏎'.
- Baseline: Not applicable (new feature). pre-r3 (verifier): fails too.
- My verdict: Reproduced: the Enter-and-pause case 7/7, the paste cases 1 of 3, enter-mid-word-dup 1 of 3 (timingSensitive for the paste variants).
- SESB-6: reproduced. Decisive output: The command as given filters with 'enter-mid-before-dup-wait|paste-', but the script matches by includes(), so it prints 0/0. Run by name: enter-mid-before-dup-wait 4/4 (RUNS=4) and 3/3 (RUNS=3) give "a\n\nx\n\ndup\n\nQRdup\n\nz\n"; paste-x-ws-before-dup 1/3; enter-mid-word-dup 1/3 (two more fail only on the script's trailing-space expectation). Baseline run: not applicable (new feature). Note: timingSensitive: the Enter-then-pause case is deterministic (7/7), the paste cases are flaky (1 of 3).
- Suspected files: src/preview/inlineEdit.ts

### J10 [medium, new-feature-defect] H14 variation (U19): typing or pasting over a selection that spans two paragraphs of a quote or a loose list item writes &nbsp;

- What goes wrong for the user: Replacing text across paragraphs of a quote or list item leaves an &nbsp; entity the user never typed in the file.
- Findings: SESB-7. Introduced by: older (Chromium wraps the moved paragraph in a style span because the focus-line tint differs, and respells the space).
- Repro (from the project root): `MDR_PORT=5438 node bench/verify/v4-sesb-nbsp.mjs`
- Observed: '> quote one here⏎>⏎> quote two here': select 'one here⏎⏎quote two', type or paste X -> '> quote X&nbsp;here'; session DOM '<p class="is-focus">quote X<span style="background-color: …">&nbsp;here</span></p>'. Also '> alpha X&nbsp;epsilon zeta', '- item X&nbsp;here', three paragraphs.
- Expected: '> quote X here' (U19: no &nbsp;).
- Baseline: Not applicable (new feature). pre-r3 (verifier): typing the same; the paste wrote two &nbsp;.
- My verdict: Reproduced 8/8. Not covered by K18 (that is an NBSP of the document next to typed text). fix-session-b reported it as the remaining case; no K entry accepts it.
- SESB-7: reproduced. Decisive output: v4-sesb-nbsp.mjs: 0/8, quote-two-paras-paste src="> quote X&nbsp;here\n\nLast.\n" exp="> quote X here\n\nLast.\n"; the same for typing, the loose item and three paragraphs. Baseline run: not applicable (new feature).
- Suspected files: src/preview/inlineEdit.ts, src/preview/serialize.ts

### J11 [medium, new-feature-defect] U8/U19: a pasted text that starts or ends with a blank line loses that paragraph break: the pasted paragraph is glued into the caret's paragraph

- What goes wrong for the user: Paragraphs copied with their surrounding blank line are merged into the paragraph where they are pasted.
- Findings: SESB-5. Introduced by: fix round 2 (U8 pasteText rewrite: leading and trailing empty paragraphs are filtered out).
- Repro (from the project root): `MDR_PORT=5438 node bench/verify/v4-sesb-pasteresume.mjs 'trailing-blank|leading-blank|both-blank'`
- Observed: 'before⏎⏎abcdef⏎⏎after', caret before abcdef, paste 'vao⏎⏎', type QR -> 'before⏎⏎vaoQRabcdef⏎⏎after⏎'; in abc|def paste '⏎⏎vao' -> 'abcvaoQRdef'; at the end paste '⏎⏎vao' -> 'abcdefvaoQR'.
- Expected: 'vao⏎⏎QRabcdef', 'abc⏎⏎vaoQRdef', 'abcdef⏎⏎vaoQR' (what the editor pane does).
- Baseline: Not applicable (new feature).
- My verdict: Reproduced 10/10.
- SESB-5: reproduced. Decisive output: v4-sesb-pasteresume.mjs trailing-blank|leading-blank|both-blank: 0/10, trailing-blank-0 src="before\n\nvaoQRabcdef\n\nafter\n" exp="before\n\nvao\n\nQRabcdef\n\nafter\n"; leading-blank-mid "abcvaoQRdef". Baseline run: not applicable (new feature).
- Suspected files: src/preview/inlineEdit.ts

### J12 [medium, new-feature-defect] H12/U18 (c) variation: text typed into an emptied block between two blocks that merge once it is gone (same-type lists, indented code) is written after the second one, not at the block's place

- What goes wrong for the user: Rewriting a paragraph that sits between two lists (select all, Backspace, type) moves the new text below the next list.
- Findings: APP-2. Introduced by: an earlier round (U9; retrack() derives the place from the previous block's end, which absorbs the following list once the block is gone); not covered by round 3's U18 keep rule.
- Repro (from the project root): `MDR_PORT=5438 node bench/verify/v4-app-merge.mjs`
- Observed: '- aaa⏎⏎乙段落⏎⏎- zzz⏎', empty 乙, type Q -> '- aaa⏎⏎- zzz⏎⏎Q⏎' (the emptied element is also shown below zzz during the session). The same for a quote, a heading ('## Q' after the list), ordered, tight, task lists, indented code, different bullet markers; Enter+Q likewise.
- Expected: U18 (c): '- aaa⏎⏎Q⏎⏎- zzz⏎'.
- Baseline: Not applicable (new feature). pre-r3 (verifier): the same.
- My verdict: Reproduced 14/14; the paragraph controls are placed between. Same class as the integrator's open low item (empty-then-edit-prev-in-editor), but reachable without touching the editor.
- APP-2: reproduced. Decisive output: v4-app-merge.mjs: 14/14 placed after-below, e.g. lists-around-para typeQ src "- aaa\n\n- zzz\n\nQ\n"; heading "…- zzz\n\n## Q\n"; control-paras "aaa\n\nQ\n\nzzz\n" between. Baseline run: not applicable (new feature). Note: Same class as the integrator's open low item "empty-then-edit-prev-in-editor" (the place follows the block that keeps prevId), but this trigger needs no editor edit, so it is not the low leftover.
- Suspected files: src/preview/inlineEdit.ts

### J13 [medium, pre-existing] A document's invisible <label> overlay turns a click anywhere on the preview into a tick of a hidden task (no reserved name, U16 satisfied)

- What goes wrong for the user: A downloaded document can make every click in the preview toggle one of its own task lines.
- Findings: TRU-6. Introduced by: older (0.1.x checkbox write-back; DOMPurify keeps label and style).
- Repro (from the project root): `MDR_URL='http://localhost:5438/?mode=split' node bench/verify/v4-tru-u16.mjs label   ;   baseline: MDR_URL='http://localhost:5448/?mode=split&perf=1' node bench/verify/v4-tru-u16.mjs label`
- Observed: 'Intro paragraph you click to read.⏎⏎- <label style="position:absolute;…;opacity:0;display:block">x⏎  - [ ] wire the money⏎⏎last line⏎': a click on the intro paragraph hits the LABEL and line 4 becomes '  - [x] wire the money' (editing on and off; also a visible label).
- Expected: A click that is not on a checkbox changes no source.
- Baseline: 0.1.1: identical, 3/3.
- My verdict: Reproduced on both builds. Pre-existing.
- TRU-6: reproduced. Decisive output: v4-tru-u16.mjs label on the candidate: label-other, label-other-noedit, label-visible all "hit LABEL; … line 4: \"  - [ ] wire the money\" -> \"  - [x] wire the money\"". Baseline run: 0.1.1 dist (5448, ?perf=1), same script: identical, 3/3 ticked (pre-existing). Note: The verifier notes the letter of the scale could read high (a write the user did not make and, with the overlay, does not see). I keep medium: the change is [ ] to [x] of the document's own task line, the title shows ● and ⌘Z restores. Pre-existing, so not a release blocker either way.
- Suspected files: src/preview/interactions.ts, src/preview/sanitize.ts

### J14 [low, new-feature-defect] A second Backspace in the same frame as the emptying keystroke is an ordinary Backspace in a not-yet-gone block: with a non-paragraph block above it does nothing and the next text goes into the emptied place

- What goes wrong for the user: Only when two keys arrive within one frame: one Backspace has no effect.
- Findings: SESA-5. Introduced by: older (U9 writes the deletion in the next frame; round 3's goneKey applies only once cur.gone is set).
- Repro (from the project root): `MDR_PORT=5438 node bench/verify/v4-sesa-repro.mjs SESA-5`
- Observed: ⌘A ⌫ ⌫ Q at machine speed: '# Hd1⏎⏎Q⏎⏎zz⏎', '- a1⏎- b1⏎⏎Q⏎⏎zz⏎', fence the same; with 'a1 $x^2$' above Q is lost (J6).
- Expected: '# Hd1Q⏎⏎zz⏎', '- a1⏎- b1Q⏎⏎zz⏎'.
- Baseline: Not applicable (new feature).
- My verdict: Reproduced in 3 of 3 runs (per case 2-3 of 3); timing sensitive (same-frame keys only).
- SESA-5: reproduced. Decisive output: v4-sesa-repro.mjs SESA-5, 3 runs: every run fails; per case fast-prev-heading 3/3 "# Hd1\n\nQ\n\nzz\n", fast-prev-math-end 3/3 "a1 $x^2$\n\nzz\n" (Q lost), fast-prev-list 2/3, fast-prev-fence 2/3. Baseline run: not applicable (new feature). Note: timingSensitive (same-frame keys). The math-end variant loses Q because the resume lands in the formula: that part is J6.
- Suspected files: src/preview/inlineEdit.ts

### J15 [low, new-feature-defect] Deleting the last block of a document without a final newline adds one (also in the saved file)

- What goes wrong for the user: A file without a trailing newline gains one after its last block is deleted in the preview.
- Findings: SESA-6. Introduced by: fix round 2 (U9 deleteBlock); round 3's keep rule handles the document end only when the line above is non-blank.
- Repro (from the project root): `MDR_PORT=5438 node bench/verify/v4-sesa-repro.mjs SESA-6   ;   MDR_APP_DIR=release/staging-0.2.0.noindex node bench/electron/v4-sesa-desk.mjs`
- Observed: 'aaa⏎⏎xx para', ⌘A ⌫ Esc -> 'aaa⏎'; ⌘S in the candidate directory writes 'aaa\n'.
- Expected: 'aaa'.
- Baseline: Not applicable (new feature).
- My verdict: Reproduced 3/3 and on disk in the candidate directory.
- SESA-6: reproduced. Decisive output: v4-sesa-repro.mjs SESA-6: 3/3, "aaa\n\nxx para" gives "aaa\n"; staging (v4-sesa-desk.mjs) saved bytes "aaa\n". Baseline run: not applicable (new feature). Note: By the letter (a byte written that the user did not type and cannot see) this could be high; the byte is a final newline, which changes neither the rendering nor any text, so I agree with low. The lead should confirm.
- Suspected files: src/preview/inlineEdit.ts

### J16 [low, new-feature-defect] ⌘A ⌫ in a loose list leaves an empty item; typing then writes '- N⏎⏎-'

- What goes wrong for the user: An empty bullet is left behind after clearing a loose list.
- Findings: SESA-7. Introduced by: older.
- Repro (from the project root): `MDR_PORT=5438 node bench/verify/v4-sesa-repro.mjs SESA-7`
- Observed: 'aaa⏎⏎- a1⏎⏎- b1⏎⏎- c1⏎⏎zz⏎', ⌘A ⌫ N -> 'aaa⏎⏎- N⏎⏎-⏎⏎zz⏎'.
- Expected: 'aaa⏎⏎- N⏎⏎zz⏎'.
- Baseline: Not applicable.
- My verdict: Reproduced 2/2.
- SESA-7: reproduced. Decisive output: v4-sesa-repro.mjs SESA-7: 2/2, loose-list-empty-type "aaa\n\n- N\n\n-\n\nzz\n". Baseline run: not applicable (new feature).
- Suspected files: src/preview/inlineEdit.ts, src/preview/serialize.ts

### J17 [low, new-feature-defect] After ⌘A ⌘A (whole preview selected) the first click on a block starts no session; text typed after it goes nowhere

- What goes wrong for the user: One extra click is needed after a select-all.
- Findings: SESA-8. Introduced by: older (U7).
- Repro (from the project root): `MDR_PORT=5438 node bench/verify/v4-sesa-repro.mjs SESA-8`
- Observed: session in 'xx para', ⌘A ⌘A, click 'zz', type Y -> source unchanged, focus on BODY.
- Expected: '…zYz…'.
- Baseline: Not applicable.
- My verdict: Reproduced 1/1 (deterministic).
- SESA-8: reproduced. Decisive output: v4-sesa-repro.mjs SESA-8: click-after-select-all observed "aaa\n\nxx para\n\nzz\n" expected "…zYz…". Baseline run: not applicable (new feature).
- Suspected files: src/preview/inlineEdit.ts

### J18 [low, new-feature-defect] Enter right before a hard line break: the typed text goes after the break and the new paragraph starts with a backslash break

- What goes wrong for the user: After Enter at the end of a line followed by a hard break, the text appears one line lower.
- Findings: SESA-9. Introduced by: older (atomAfter treats a <br> as a stop).
- Repro (from the project root): `MDR_PORT=5438 node bench/verify/v4-sesa-repro.mjs SESA-9`
- Observed: 'abc  ⏎def⏎⏎z⏎', Enter after abc, Z -> 'abc⏎⏎\⏎Zdef⏎⏎z⏎'.
- Expected: 'abc⏎⏎Z  ⏎def⏎⏎z⏎'.
- Baseline: Not applicable.
- My verdict: Reproduced (the Shift+Enter and list cases pass, as reported).
- SESA-9: reproduced. Decisive output: v4-sesa-repro.mjs SESA-9: enter-before-hardbreak "abc\n\n\\\nZdef\n\nz\n" (Shift+Enter and the list-item case pass). Baseline run: not applicable (new feature).
- Suspected files: src/preview/inlineEdit.ts

### J19 [low, new-feature-defect] H15 variation: a U+E001 in a link or image destination collides with the caret marker; after Enter the next typed character lands at the start of the block

- What goes wrong for the user: In a block whose URL holds U+E001 (raw or %EE%80%81), Enter then typing puts the text at the block start.
- Findings: TRU-1. Introduced by: fix round 2 (G4 pickMarkers checks innerHTML, where href/src are percent-encoded, while linkDest() decodes them).
- Repro (from the project root): `npx vitest run test/v4-tru-serial.test.ts -t "TRU caret marker"   ;   MDR_URL='http://localhost:5438/?mode=split' node bench/verify/v4-tru-caretmark.mjs 3`
- Observed: 'NSee [x](https://e.com/?q=<U+E001>) first line⏎second line⏎⏎words⏎' (3/3 for each of 3 variants); the %EE%80%81 spelling is rewritten to the raw character.
- Expected: 'See [x](…) first line⏎second line⏎⏎Nwords⏎'.
- Baseline: Not applicable.
- My verdict: Reproduced (unit 2/2, Chromium 3 x 3/3).
- TRU-1: reproduced. Decisive output: unit: 2 failing cases in the whole suite; v4-tru-caretmark.mjs 3: raw-E001-in-link, pct-E001-in-link, pct-E001-in-image 0/3 each, "NSee [x](https://e.com/?q=<U+E001>) first line\nsecond line\n\nwords\n"; list item and control 3/3 pass. Baseline run: not applicable (new feature).
- Suspected files: src/preview/serialize.ts, src/preview/inlineEdit.ts

### J20 [low, new-feature-defect] H29 variation: a run of backslashes (prepare()'s /\\+$/) or of backticks (stripCode's code-span regex) makes what a click runs before a session quadratic: about 1.0-1.3 s at 58 000 characters

- What goes wrong for the user: A click into (or every write of) a block with a long backslash or backtick run freezes the window for about a second.
- Findings: TRU-2, TRU-3. Introduced by: older (both lines are unchanged in release/pre-r3.noindex; round 3's H29 fix covered only the whitespace regexes).
- Repro (from the project root): `npx vitest run test/v4-tru-serial.test.ts -t "backslashes|backticks"   ;   MDR_PORT=5438 node bench/verify/v4-tru-h29.mjs backslashes / backticks`
- Observed: serialize 1001 / 1070 / 1071 ms at n=58004 (growth x13.6-13.9); guard 1201 / 1257 / 1242 ms (x13.2-13.8).
- Expected: Linear, under 100 ms.
- Baseline: Not applicable.
- My verdict: Reproduced 3/3 each in Chromium and in the unit suite.
- TRU-2: reproduced. Decisive output: unit 1024 ms in the suite; v4-tru-h29.mjs backslashes in Chromium, 3 runs: serialize 1001.2 / 1069.8 / 1070.6 ms at n=58004, growth x13.6-13.9. Baseline run: not applicable (new feature). Note: timingSensitive: 3/3, growth factor is the evidence.
- TRU-3: reproduced. Decisive output: unit 997 ms in the suite; v4-tru-h29.mjs backticks, 3 runs: guard 1200.8 / 1256.5 / 1241.7 ms at n=58004, growth x13.2-13.8. Baseline run: not applicable (new feature). Note: timingSensitive: 3/3.
- Suspected files: src/preview/serialize.ts

### J21 [low, new-feature-defect] H17 variation: an ideographic space (U+3000) or em space typed after a digit…digit formula at a paragraph or cell end turns the formula into literal text

- What goes wrong for the user: A full-width space typed after "$10$" at a line end makes the formula show as "$10$" text.
- Findings: TRU-4. Introduced by: fix round 3 (fix-serial H17: afterFormula counts only ASCII whitespace, the final trim removes Unicode whitespace).
- Repro (from the project root): `npx vitest run test/v4-tru-serial.test.ts -t "H17 variations"   ;   MDR_URL='http://localhost:5438/?mode=split' node bench/verify/v4-tru-h17.mjs 3`
- Observed: '等于 $10$。' ⌫ + U+3000 -> '等于 $10$⏎', formulas 1 -> 0; em space and table-cell variants the same.
- Expected: The formula stays a formula (e.g. '等于 $10$&#32;').
- Baseline: Not applicable.
- My verdict: Reproduced (unit 2/2, Chromium 3 x 3/3; controls hold).
- TRU-4: reproduced. Decisive output: unit 2 failing cases in the suite; v4-tru-h17.mjs 3: delete-stop-type-ideographic-space, replace-word-by-em-space, table-cell-ideographic-space 0/3 each, formulas 1 -> 0, source "等于 $10$\n"; controls 3/3 pass. Baseline run: not applicable (new feature).
- Suspected files: src/preview/serialize.ts

### J22 [low, new-feature-defect] Editing an inline formula's TeX in the preview: a trailing space or trailing backslash turns the formula into literal text

- What goes wrong for the user: A stray space at the end of the TeX shows "$x+1 $" as text.
- Findings: TRU-5. Introduced by: older.
- Repro (from the project root): `MDR_URL='http://localhost:5438/?mode=split' node bench/verify/v4-tru-tex.mjs 2`
- Observed: 'Area $x+1 $ here.⏎' and 'Area $x+1\$ here.⏎', 0 formulas.
- Expected: The formula stays a formula.
- Baseline: Not applicable.
- My verdict: Reproduced 2/2 each.
- TRU-5: reproduced. Decisive output: v4-tru-tex.mjs 2: type-trailing-space 0/2 source "Area $x+1 $ here.\n" formulas 0; type-trailing-backslash 0/2 "Area $x+1\\$ here.\n". (The script also has a digit-ends case that fails because Home in a session now goes to the paragraph's line start, so Shift+End selects the whole paragraph; that is not this finding.). Baseline run: not applicable (new feature).
- Suspected files: src/preview/serialize.ts

### J23 [low, pre-existing] A block whose HTML DOMPurify cannot turn into a fragment (<!div>, <frameset>) shows the word null

- What goes wrong for the user: A stray word "null" in the preview.
- Findings: TRU-7. Introduced by: older (0.1.x).
- Repro (from the project root): `MDR_URL='http://localhost:5438/?mode=split' node bench/verify/v4-tru-null.mjs   ;   baseline MDR_URL='http://localhost:5448/?mode=split&perf=1'`
- Observed: blocks ["first paragraph\n","null","last paragraph\n"].
- Expected: An empty block.
- Baseline: 0.1.1: identical.
- My verdict: Reproduced on both builds.
- TRU-7: reproduced. Decisive output: v4-tru-null.mjs candidate: blocks shown ["first paragraph\n","null","last paragraph\n"] for <!div> and <frameset>. Baseline run: 0.1.1 dist, same script: identical (pre-existing).
- Suspected files: src/preview/createPreview.ts, src/preview/sanitize.ts

### J24 [low, pre-existing] Several files dropped with a non-Markdown file first: nothing opens, although CONTRACT says the first Markdown file opens

- What goes wrong for the user: A multi-selection that starts with an image opens nothing.
- Findings: FLOW-2. Introduced by: older (isMarkdownDrop checks dt.files[0] only).
- Repro (from the project root): `MDR_TMP=<scratch> MDR_URL=http://localhost:5438/ MDR_BASE_URL='http://localhost:5448/?perf=1' node bench/verify/v4-flow-drop.mjs multi-png-first`
- Observed: toast 仅支持打开 Markdown 文本文件（.md / .markdown / .txt）, drop-a.md not opened.
- Expected: drop-a.md opens.
- Baseline: 0.1.1: identical.
- My verdict: Reproduced on both builds.
- FLOW-2: reproduced. Decisive output: v4-flow-drop.mjs multi-png-first: toast 仅支持打开 Markdown 文本文件（.md / .markdown / .txt）, document unchanged, drop-a.md not opened. Baseline run: 0.1.1 dist: identical (pre-existing).
- Suspected files: src/files/fileService.ts, src/app/App.ts

### J25 [low, pre-existing] Web: a dropped .md the browser cannot read shows the raw English NotReadableError text in the zh-CN toast

- What goes wrong for the user: An untranslated message.
- Findings: FLOW-3. Introduced by: older.
- Repro (from the project root): `MDR_TMP=<scratch> MDR_URL=http://localhost:5438/ MDR_BASE_URL='http://localhost:5448/?perf=1' node bench/verify/v4-flow-drop.mjs web-locked`
- Observed: 无法打开「locked.md」：The requested file could not be read, typically due to permission problems …
- Expected: A zh-CN reason.
- Baseline: 0.1.1: the same English text after a needless question.
- My verdict: Reproduced (the script prints ok because it checks other conditions; the toast text is the finding).
- FLOW-3: reproduced. Decisive output: v4-flow-drop.mjs web-locked: candidate toast 无法打开「locked.md」：The requested file could not be read, typically due to permission problems … (the script itself prints "ok", it checks only that nothing is asked and the document is kept). Baseline run: 0.1.1: 打开失败：The requested file could not be read… after a needless discard question (pre-existing).
- Suspected files: src/app/native.ts

### J26 [low, spec-gap] H16/K19 scope: in a session Home / End / Shift+Space no longer scroll the preview (also in preview-only mode); README and K19 name only Space

- What goes wrong for the user: A reader who clicks a paragraph and presses End or Home to jump no longer moves.
- Findings: APP-4. Introduced by: fix round 3 (fix-session-b U21: Home/End move by line in a live session).
- Repro (from the project root): `MDR_MODE=preview MDR_PORT=5438 node bench/verify/v4-app-sel.mjs 'K '   ;   MDR_MODE=preview MDR_PERF=1 MDR_PORT=5448 node bench/verify/v4-app-sel.mjs 'K '`
- Observed: End / Home {"scrolled":"no"}, Shift+Space types.
- Expected: Either documented with K19 or scrolling as in 0.1.1.
- Baseline: 0.1.1: End down, Home up, Shift+Space up.
- My verdict: Reproduced. Needs a lead decision; without one it is a regression against 0.1.1 (medium).
- APP-4: reproduced. Decisive output: v4-app-sel.mjs 'K ' MDR_MODE=preview on 5438: End {"scrolled":"no"}, Home {"scrolled":"no"}, Shift+Space types (srcSame false), PageDown down. Baseline run: 0.1.1 dist (5448, MDR_PERF=1): End down, Home up, Space down, Shift+Space up. Note: Spec-gap: if the lead does not extend K19 / the README to Home, End and Shift+Space, it is a regression against 0.1.1 in preview-only reading and would be medium.
- Suspected files: src/preview/inlineEdit.ts, README.md

### J27 [low, new-feature-defect] Editor commands that end a session (toolbar 标题, palette 切换任务项) act on the block's first or last line, not the caret's line; after an emptied block on a neighbouring block

- What goes wrong for the user: A heading or task toggle lands on another item of the list, or on the paragraph below an emptied block.
- Findings: APP-5. Introduced by: an earlier round (runEditorCommand).
- Repro (from the project root): `MDR_PORT=5438 node bench/verify/v4-app-line.mjs task   ;   MDR_PORT=5438 node bench/verify/v4-app-under.mjs U7`
- Observed: session in 乙 + toolbar H2 -> '- [ ] ## 任务甲 aaa'; after typing -> '- [ ] ## 任务丙 ccc'; emptied block + H2 -> '甲段落文字。⏎## ⏎丙段落文字。⏎', first emptied -> '## 丙段落文字。'.
- Expected: The command acts on the caret's line.
- Baseline: 0.1.1 acts on line 1 (worse); not a regression.
- My verdict: Reproduced.
- APP-5: reproduced. Decisive output: v4-app-line.mjs task: 甲 type-toolbarH2 changed line 5 "- [ ] ## 任务丙 ccc", click-toolbarH2 line 3 "- [ ] ## 任务甲 aaa" for a session in 乙; v4-app-under.mjs U7: para emptied + H2 "甲段落文字。\n## \n丙段落文字。\n", first emptied "## 丙段落文字。". Baseline run: 0.1.1 (verifier's measurement): acts on line 1 in every case, which is not better.
- Suspected files: src/app/App.ts

### J28 [low, new-feature-defect] After 取消 on the discard question raised while typing in a session, the focus is on body and the next key is lost

- What goes wrong for the user: The user cancels to keep working, types, and nothing appears until a click.
- Findings: APP-6. Introduced by: older than round 3 (not measured on pre-r3).
- Repro (from the project root): `MDR_PORT=5438 node bench/verify/v4-app-cancel.mjs   ;   MDR_PERF=1 MDR_PORT=5448 node bench/verify/v4-app-cancel.mjs`
- Observed: activeAfterCancel "BODY.", Z lost (4/4 session cases).
- Expected: Focus back in the session or block.
- Baseline: 0.1.1: the editor cases identical (focus returns).
- My verdict: Reproduced.
- APP-6: reproduced. Decisive output: v4-app-cancel.mjs on 5438: session new / drop / session-click: activeAfterCancel "BODY.", z "lost"; editor cases "DIV.cm-content", z "after XY". Baseline run: 0.1.1 dist (5448): the editor cases are identical (focus returns); no session exists there.
- Suspected files: src/app/App.ts, src/preview/inlineEdit.ts

### J29 [low, spec-gap] Enter then Backspace in the middle of a paragraph before a space loses the space

- What goes wrong for the user: Taking back a mistaken Enter glues two words together.
- Findings: APP-7. Introduced by: an earlier round (U13 drops the whitespace after the caret on Enter; U3 joins the raw texts).
- Repro (from the project root): `MDR_PORT=5438 node bench/verify/v4-app-r5.mjs enterBackspace`
- Observed: 'para two words' -> 'para twowords'.
- Expected: 'para two words'.
- Baseline: Not applicable.
- My verdict: Reproduced.
- APP-7: reproduced. Decisive output: v4-app-r5.mjs enterBackspace: stored "para one\n\npara twowords\n", backToLoaded false. Baseline run: not applicable (new feature).
- Suspected files: src/preview/inlineEdit.ts

### J30 [low, new-feature-defect] H13/U22 class: after emptying the FIRST block, ⌘Z restores it but the session continues at the start of the next block

- What goes wrong for the user: After undoing the deletion of the first block, the next characters go into the block below.
- Findings: APP-8. Introduced by: an earlier round (the U9 range of a first block includes its trailing blank line).
- Repro (from the project root): `MDR_PORT=5438 node bench/verify/v4-app-under.mjs "U3 first"`
- Observed: '乙段落文字。⏎⏎Q丙段落文字。⏎' (paragraph, list and heading).
- Expected: '乙段落文字。Q⏎⏎丙段落文字。⏎'.
- Baseline: Not applicable.
- My verdict: Reproduced 3/3 shapes.
- APP-8: reproduced. Decisive output: v4-app-under.mjs "U3 first": paragraph "乙段落文字。\n\nQ丙段落文字。\n", list "- 乙段落文字。\n- 乙二\n\nQ丙段落文字。\n", heading "## 乙段落文字。\n\nQ丙段落文字。\n" (3/3 shapes). Baseline run: not applicable (new feature).
- Suspected files: src/preview/inlineEdit.ts

## Whole unit suite (step 2)

- npx vitest run --no-file-parallelism, once, in the background: 105 files / 2087 tests; 1 file and 6 tests failed; 6 tests marked known (it.fails with their K number: DEC-3 = K24 and five K22 cases) behaved as expected; 2075 passed; 96.8 s.
- All 6 failures are in test/v4-tru-serial.test.ts and each belongs to a reproduced finding: TRU-4 2 ("面积 $10$元" with 元 replaced by U+3000 and by U+2003), TRU-1 2 (TRU caret marker "%EE%80%81" and "mple/?q="), TRU-2 1 (serializeBlock on a run of backslashes, 1024 ms), TRU-3 1 (unsupportedReason on a run of backticks, 997 ms).
- test/v4-dec-off.test.ts (verify-decoder) passes completely.
- No failing test belongs to no finding (unexplained: none). The integration count was 103 files / 2060 tests; the two new files are the verifiers' v4 tests.

## Performance (step 3)

- (a) npx playwright test, once (57.8 s, 1 passed): every budget passes. P1 open to first visible 106.1 ms (< 400); P4 longest task 0 ms, tasks > 50 ms after 1 s 0; P5 main per keystroke p95 24.7 ms (< 30), max 27.5 ms (< 60), raw p95 27.0 ms, idle baseline 2.3 ms; P5 keystroke to mount p95 33.9 ms (< 40); P8 frames > 20 ms 0.4 % (< 3); P11 undo step p95 0.0 ms (< 5). Playwright created test-results/.last-run.json in the tree; I moved the directory to my scratch.
- (b) P5 against 0.1.1 (K17) with bench/verify/fix2-int-p5.mjs, my own static server for both builds (it redirects / to ?perf=1, which warmUp needs), alternating candidate / 0.1.1, 3 runs each, 200 keys on large.md:
- - Candidate raw busy per key p95 28.2 / 27.1 / 27.9 ms, p50 13.0 / 12.9 / 12.9 ms; keystroke to mount p95 34.1 / 34.3 / 35.1 ms.
- - 0.1.1 raw busy per key p95 26.4 / 26.7 / 27.1 ms, p50 13.1 / 13.1 / 14.2 ms; keystroke to mount p95 34.0 / 34.4 / 35.1 ms.
- - The candidate's p95 is about 1 ms (4 %) higher on average, p50 is equal and keystroke to mount is equal. The two ranges touch (27.1 ms on both); I judge it equal to 0.1.1 within the run-to-run spread, not a regression. (The script's own absolute "< 5 ms / < 10 ms" lines fail on both builds alike; K17 replaces them.)
- (c) With MDR_PORT=5438, one at a time: inline-verify-perf 5/5 (large.md session start max 10.5 ms; preview work per key p95 0.7 ms; 300-line list start 37.1 ms, flush p95 3.8 ms; 20 tables start p95 5.2 ms, flush p95 2.4 ms); inline-verify-resume 13/13 (resume window median 32 ms on small.md, 39 ms on large.md); fix2-i2-paste 9/9 (longest task after a 55 000-character one-line paste 19 ms, after 1 000 lines 32 ms; next-key flush 18-25 ms; refusals correct; in one unbroken 55 000-character word the next insertText takes 1198 ms = K16).

## r2 checks

Each r2 group the verifiers re-attacked, with the variations tried and the outcome. Every broken variation is a finding I reproduced.

| r2 group | verifier | variations tried | holds / broken |
|---|---|---|---|
| H3 | verify-session-a | 20 kinds of previous block at human speed; ⌥⌫ / ⌘⌫ / Ctrl-H / Shift-⌫ and 5 forward-delete keys; typed-then-cleared, IME; 5 ways of emptying; uneditable or absent previous block; same-frame ⌘A ⌫ ⌫ | broken (same-frame only: SESA-5, J14); 5 variations hold |
| H12 | verify-session-a | emptied heading tight under list / quote / heading / fence, between tight headings, tight on both sides; typing, Enter, Shift+Enter, re-empty, machine speed, 4-step undo chain; emptied list / task / quote / fence / table with Tab, Shift-Tab, Enter; last block without final newline | broken (final newline: SESA-6, J15); 3 variations hold |
| H10 | verify-session-a | formula after the caret in paragraph, items, tasks, heading, quote, cell, after a soft break, two formulas, image then formula; replayed Enter; U13 + U21 together; formula inside bold / italic / link | broken (formula inside an inline wrapper: SESA-3, J7); 3 variations hold |
| H11 | verify-session-a | bare image in paragraph, item, quote, Shift+Enter, two images, replayed Enter; image in a heading; linked image; image then formula; image at the end of a U3 merge or new-paragraph undo | broken (heading, linked image, image + formula: SESA-4, J7; merge / undo: SESA-2, J6); 1 variation holds |
| H13 | verify-session-a | new paragraph / item then undo in heading, quote, last block, no final newline, leading blank line, two blank lines, redo; new list item then undo; formula or reference link before the position; formula at the line end | broken (SESA-1, SESA-2, J6); 1 variation (13 cases) holds |
| P1 | verify-session-a | empty the only block then ⌘Z⌘Z fast (heading, no final newline, leading blank); ⌘Z ⌘Z ⇧⌘Z ⇧⌘Z chain; two blocks emptied; slow ⌘Z then ⇧⌘Z then type | holds (4 of 4) |
| H8 | verify-session-b | 13 drag / Shift-click / double- and triple-click gestures; typing then drag; kind change; double mount; 84 Esc-then-click cases; line-start end points in multi-line blocks; changed re-render text | broken (SESB-3, SESB-8, J5); 4 variations hold |
| H4 | verify-session-b | 26 paste shapes x 2 timings; second paste in the resume window, two pastes in a row, paste into an emptied element; duplicate neighbour | broken (duplicate neighbour: SESB-6, J9); 2 variations hold |
| H14 | verify-session-b | 22 selection shapes x 3 texts against typing; whole link text; across paragraphs of a quote or loose item | broken (SESB-1 J1, SESB-7 J10); 1 variation holds (38 of 44 one-line cases, undo 66/66) |
| H20 | verify-session-b | structures / HTML delayed 80-700 ms with a per-frame sampler, 9 shapes; editor rewrites in the same frame, replace-all, two deletions within 50 ms | holds (2 of 2) |
| H22 | verify-session-b, verify-app | ⌘A once and twice in 17-18 block kinds; ⌘A ⌘A from 14 kinds at 3 positions (42) with ⌘C | holds (5 of 5) |
| H1 | verify-trust | 1,220,000 generated documents in 7 seeds (66,783 blocks with document-supplied names, all flagged, 0 bypasses), 343 hand-made shapes, 9 end-to-end forged-formula variants, 3 checkbox steering variants, U16 with the flag removed | holds (5 of 5) |
| H15 | verify-trust | block full of markers at session start; 4-free / 5-free boundary; exhaustion through a cell paste, 10-item list, heading same-frame paste, TeX or href holding half the pool; U+E001 only in a decoded link destination | broken (TRU-1, J19); 3 variations hold |
| H17 | verify-trust | 11 contexts in jsdom and an emptied bold in Chromium; sources already in the general spelling; U+3000 / U+2003 after the formula at a line or cell end | broken (TRU-4, J21); 2 variations hold |
| H29 | verify-trust | whitespace runs of every kind in 11 inline / block contexts at 58,000 and 15,000 characters; a backslash run; a backtick run | broken (TRU-2, TRU-3, J20); 1 variation holds |
| H2 | verify-flows, verify-app | web: file + text/plain / uri-list / html on editor lines, session, find bar, palette, splitter, scrollbars, dialog button, two drops 20 ms apart; desktop staging trusted CDP drags with real paths (10/10), refused files, drop + open-file in one instant; drops on idle / typing / emptied sessions, TOC, status bar, toolbar, gutter, png + md | holds (11 of 11) |
| H5 | verify-flows, verify-app | 12 web take-back variations (Backspace, cut/paste, undo/redo chain, CRLF, session edits, hide right after, restore question 取消, × closed, ⌘S, 另存为), desktop SIGKILL relaunch cycles on staging and dev shell (6/6), 5 preview-session take-backs | holds (6 of 6) |
| H7 | verify-decoder | the GBK timesheet through 7 open paths and a draft restore on staging and 0.1.1; CRLF, cut, NUL-padded, 240 KB copies; a generated H7 family of 1,200 seeds x 6 in Electron; the same in Node | holds (4 of 4) |
| H23 | verify-decoder | NEC Shift_JIS with mixed and CR-only endings; CP932 files the WHATWG table gives back with typed duplicate-mapped characters; 536,117 saves in Electron; in-preview edits of 6 legacy files | holds (3 of 3) |
| H28 | verify-decoder | encoder tables built in the real Electron main process; the same corpus in Electron and Node; real readFileInfo / writeFileAtomic on 3,072 + 1,549 files; the installed app's Electron version | holds (4 of 4) |
| H16 | verify-app | switch off: Space, Shift+Space, End, Home, PageDown, ArrowDown and 42 ⌘A ⌘A cases; preview-only mode off and on; click on padding then Space | holds (3 of 3); End / Home no longer scroll with the switch on: APP-4, J26 (spec gap) |

Broken r2 groups and the J group that covers them:

- H3: SESA-5 -> J14
- H4: SESB-6 -> J9
- H8: SESB-3, SESB-8 -> J5
- H10: SESA-3 -> J7
- H11: SESA-4; SESA-2 (merge / undo next to an image) -> J7, J6
- H12: SESA-6 -> J15
- H13: SESA-1, SESA-2 -> J6
- H14: SESB-1, SESB-7 -> J1, J10
- H15: TRU-1 -> J19
- H17: TRU-4 -> J21
- H29: TRU-2, TRU-3 -> J20

## What the verifiers attacked without breaking it

- verify-session-a: U18 (a) in 147 cases (20 previous-block kinds, 28 keys at two speeds, 5 ways of emptying); U18 (b)(c) in 30+ neighbour combinations, 9 emptied kinds with list keys, 10 pastes, 39 tight-mode fuzz seeds; U21 for direct-sibling atoms (40+ cases) and U13/U14 with round 3 (24); U22 / P1 (47); H15 refusals (6); joinsAbove (5); structure keys in tables, quotes, lists, code (19); queued keys under a 300 ms slow structure and in large.md (30 runs); a model-checked keyboard fuzz of 119 seeds; the findings and controls in the candidate directory.
- verify-session-b: U20 for 22 of 47 gestures byte-identical to 0.1.1 (the rest are J5); a double mount (4); 84 Esc-then-click cases; 26 paste-resume and 11 paste-corner cases; 38 of 44 paste-over-selection cases equal typing, undo 66/66; H20 identity under delays (14); H22 in 18 kinds; a pointer / clipboard fuzz of about 1,150 operations; click back into ordinary blocks under natural timing (23).
- verify-trust: U15 against 1.22 million generated documents, 343 hand-made shapes and 12 end-to-end variants: 0 bypasses among 66,783 blocks with document-supplied names; 0 false positives on ordinary Markdown (21,384 blocks of the project's own documents); U16 with the flag removed; H15 in every serializer entry point (8); KaTeX emits no reserved names; no DOM clobbering of app globals; the serializer's raw-HTML re-emission.
- verify-flows: U17 in 31 web drop cases and 15 desktop checks on staging, baseline and the dev shell; text drags byte-identical to 0.1.1 (7); R5 in 12 web variations and 4 desktop kill / relaunch cycles; never more than one question on screen; failed drops leave the document alone.
- verify-decoder: no dormant override code is reached by default (114,146 inputs through a throwing copy); reads identical to 0.1.1 in the shipped runtime (76,114 inputs); no save worse than 0.1.1 (536,117 + 270,190 saves); every open path identical to 0.1.1 (51 rows; 9 differ only by decided R3 / G31 behaviour); in-preview edits of legacy files (42); the decoder tests catch 13 of 14 mutants (the 14th looks equivalent).
- verify-app: U16 in 27 list shapes identical to 0.1.1; 14 older feature scripts and 17 x 3 regression probes; U20 does not steal focus (21); save at 0 ms after U18 deletions (16 web, 3 desktop); the emptied-block session against 8 actions x 7 documents and the desktop menu; R5 against sessions (5); export during a session; no false dirty flag (13); joinsAbove cost under a 40,000-line fence not visible; triple-click copy around formulas not worse than 0.1.1.
- confirm: an independent decoder differential in the candidate directory's Electron main process (6,307 inputs, 45,138 saves, 252 files, 0 differences); the whole suite, the performance spec and P5 against 0.1.1 (see above).

## What nobody covered

- Real macOS keybindings (NSResponder ⌥⌫, ⌘⌫, Ctrl-K, ⌘← in a live session) and real IME input: CDP events only (verify-session-a).
- Desktop clipboard: the Edit-menu 粘贴 / 拷贝 path and Electron's native clipboard; the copied text/html flavour; ⌘X across formatting (verify-session-b). SESB-1 / SESB-2 copy parts were not measured on pre-r3 (argued from the round-3 diff).
- Dragging text OUT of a live session (deleteByDrag is not prevented in src/preview/inlineEdit.ts onBeforeInput) and dragging a preview image: headless Chromium starts no native drag in either build (verify-flows, verify-app). A text drag that advertises the type Files with an empty list is refused by the candidate where 0.1.1 inserted the text (synthetic only, bench/verify/v4-flow-probe-filestype.mjs).
- FLOW-1 (J4) on the desktop: native saves are too fast to open the window without stubbing the main-process IPC; the same App.save code runs there.
- interactions.ts taskLineOf combines startLineOf (preview model) with sourceLine (current editor text): a click right after an editor edit could tick an adjacent task line (verify-trust; not tested). lineOfElement (focus tint, Alt+click) still uses closest('.md-block').
- The export path (sanitizeHtmlString re-parse in the exported file) and desktop-only trust paths (window.mdrNative, will-navigate) were not attacked this round.
- readFileInfo's O_NONBLOCK open on iCloud dataless files, SMB / AFP / FUSE volumes; files above 3 MiB in the Electron differential; the web build's File.text() reading against the deployed 0.1.0 page; argv now taking non-Markdown regular files (verify-decoder).
- APP-1 / APP-2 in the packaged candidate directory (no test hooks; measured on the tree's renderer and the dev shell); IME, multi-cursor, find / replace-all and the context menu during a session; print of a live session; large.md typing at top / middle / end in a session (verify-app).
- turndown's own edgeWhitespace regex (the H29 shape, per inline element) was not measured by anyone.
- joinsAbove's per-keystroke segmenter cost was measured only indicatively (verify-app, 1010 vs 979 ms for 30 keys under a 40,000-line fence).

## Decoder verdict for S4 (f)

Yes. 0.2.0 reads and saves every file at least as well as 0.1.1 in the shipped runtime; no decoder finding was reported or found. verify-decoder: 76,114 inputs in the Electron 44 main process (ICU 78.2) and 38,032 in Node with 0 read differences, 536,117 saves with 0 worse / 0 same-count-different / 0 new refusals, 3,072 real file round trips with 0 failures, 42 end-to-end open-path rows identical to 0.1.1, 42 in-preview edits of legacy files saved cleanly, 14 mutants of the decoder caught by the tests. My own check: MDR_APP_DIR=release/staging-0.2.0.noindex SEEDS=100 node bench/electron/v4-dec-diff.mjs in the candidate directory's Electron main process: 6,307 inputs, readDiff 0, dormantReached 0, 45,138 saves with saveWorse 0, saveSameCountDiff 0, newRefusal 0 (696 saves changed fewer bytes than 0.1.0, all Shift_JIS files using the WHATWG table as K7 lists), 252 real readFileInfo / writeFileAtomic files with 0 failures; test/v4-dec-off.test.ts passes in the whole suite. Remaining differences from 0.1.1 are exactly K7's list (non-regular files refused; the WHATWG table where only it gives the bytes back).

## Notes on the verifiers' scripts

- bench/verify/v4-sesb-dupresume.mjs filters with includes(), so SESB-6's published command (filter 'enter-mid-before-dup-wait|paste-') matches nothing and prints 0/0; run it with one name or without a filter. Its enter-mid-word-dup expectation keeps a trailing space that K5 drops.
- bench/verify/v4-tru-tex.mjs digit-ends uses Home + Shift+End inside an opened TeX source; since round 3 Home in a session goes to the paragraph's line start, so the case replaces the whole paragraph. Not a product finding (J26 covers the Home change).
- bench/verify/v4-flow-drop.mjs web-locked prints ok; FLOW-3's finding is the toast text, which the script does not check.
- bench/electron/v4-app-desk.mjs: when the 110 s alarm ends it after its results, its Electron stays behind (orphan). The two orphans at my start were most likely of this kind.
- bench/verify/fix2-int-p5.mjs on a production build still needs a server that adds ?perf=1 (scratch static.mjs, as in r2).
