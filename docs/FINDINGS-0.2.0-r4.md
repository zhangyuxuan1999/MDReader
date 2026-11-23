# 0.2.0 release candidate — fix round 4 confirmation, r4 findings (2026-11-22)

Seven verifiers attacked fix round 4 (verify-off-preview, verify-off-app, verify-off-desktop and verify-switch on the configuration that ships, verify-session-keys and verify-session-pointer on the experimental feature with the switch on, verify-review on the code) and reported 13 findings (OFFP-1, OFFA-1, OFFA-2, OFFK-1, SW-1, KEYS-1, KEYS-2, PTR-1 to PTR-4, REV-1, REV-2). I re-ran every repro myself, alone, on a quiet machine: the switch-off findings against the production build release/staging-0.2.0.noindex/dist and the 0.1.1 dist (vite preview on my ports 5488 and 5498, the candidate without ?perf=1 or with ?perf=1 and a stored "0"), the desktop finding on the candidate directory and the 0.1.1 baseline directory, the session findings on my own Vite dev server of the tree (5488). All 13 reproduced (REV-2 is flaky at natural timing: 6 of 9, 3 of 3 with a held re-render). They form 11 groups N1 to N11: 2 high, 5 medium, 4 low.

## Verdict by the release gate

**By the release gate (user, 2026-11-21) this candidate must not ship as it is.**

**(1) The configuration that ships, 预览可编辑 off by default.** No high. One regression against 0.1.1 of medium: N3. The web page loads the whole in-preview editing code at start even with the switch off. The main script grows from 137 KB to 233 KB gzip, and a cold (uncached) visit shows the editor about 27 % later: 400 against 315 ms at 10 Mbit/s, 820 against 629 ms at 4 Mbit/s. Locally the cost is about 12 ms; with a warm cache it is equal. The gate is strict, so N3 blocks unless the lead accepts it as a known cost. Its absolute size is small, and the fix is mechanical: a dynamic import() of the session module when the switch is turned on. Everything else that shows with the switch off is low. N10 is pre-existing, the keyboard form of J13, and identical in 0.1.1. N11 is a spec-gap: a replacement answered with 丢弃 during the same document's own save. Its desktop form is identical in 0.1.1, and the web form differs only through the decided R2. N9 is low and needs the switch to have been on once: a document-level execCommand setting is left behind, with no visible effect. Measured with the switch off: P5 equals 0.1.1, every playwright budget passes, the decoder is unchanged, and electron/ differs from pre-r4 only in the decided menu label.

**(2) The experimental feature, switch on.** Two high groups, so gate (2) fails:
- N1. When Chromium merges two line boxes inside a session block, the file is rewritten. This happens on Backspace at the start of a list item or quote paragraph, on Delete at the end of the line above, and on Enter then Backspace at a block start. Every inline formula on the moved line is respelled from its rendering ($x$ becomes $xx$; \frac{a}{b} becomes "abba" plus an invisible U+200B). An image becomes raw HTML with a style attribute. A joined list item takes the second item's checkbox state ("- [ ] task a" joined with "- [x] task b" is written "- [x] task a task b"; a plain item becomes a ticked task). This is older than round 4.
- N2. Editing anything in a block that holds a link with a percent-escaped invisible character writes that character raw into the file: U+200B, U+FEFF, U+202E (which reverses the display of the source line), NBSP, U+3000 or a private-use character. I raised the verifier's medium to high by the gate's own words ("written that the user did not type and cannot see"). The href and the rendering are unchanged, so the lead may accept medium.

Medium and low defects of the experimental feature, to become README limits once the two high groups are fixed: N4, N5, N6, N7 (medium) and N8, N9 (low). The plain sentences are in the section "Known limits for the README" below.

**(3) For the record, what would still block "on by default":** N1 and N2. Then N4 to N7. Then the medium limits already deferred or accepted by the lead: J7, J11, CHA-6 with CHB-5, CHA-7 beyond the toast, CHA-8, CHA-9, CHB-4 and K26 (J10). N3 would also stay as a cost.

Introduced by fix round 4: none of the 11 groups. Every one is older than the round; the verifiers measured release/pre-r4.noindex identical, and for N3 the round kept the static import. R6's new branch (fix-flows) behaves as decided in N11 but does not cover it. Round 4's own fixes held under the verifiers' variations: J1, J2, J3, J5, J8, J9, J12, J30, CHA-1, CHA-2 and CHA-5, U24 as amended, the tick that does not wait, U2 as amended, the capture element, the default rule and the marking. Broken r3 variations: J4, J6, J13 and J19, each covered by a reproduced group (N11, N4, N10, N2).

## Machine and candidate (step 0)

- No process left by the verifiers: nothing listened on 5461 to 5510 or 5199, and there was no Electron of this project, no vitest and no headless Chromium; I ended nothing. The load was low (the Claude app and its renderers only).
- npx tsc --noEmit printed nothing (exit 0). node bench/verify/scan-invisible.mjs: OK.
- diff -rq electron/ and dist/ against release/staging-0.2.0.noindex: empty. package.json identical. No file of src/ or electron/ is newer than dist/index.html.
- diff -r release/pre-r4.noindex/electron electron: exactly menu.mjs line 132 (预览可编辑 -> 预览可编辑（实验性）), as decided.
- /Applications/MDReader.app/Contents/Info.plist CFBundleShortVersionString = 0.1.1 (read only, not launched).
- Crash reports: still 11 Electron reports, the newest Electron-2026-11-20-145455.ips (and .000), at my start and at my end. My desktop runs (v5-offk-save on the candidate and baseline directories, 6 launches; v4-dec-diff on the candidate directory) caused none and left no Electron behind.

## Summary table

| group | severity | class | introduced by | needs a session | findings (verdict) | title |
|---|---|---|---|---|---|---|
| N1 | high | new-feature-defect | older than fix round 4 | yes (switch on) | PTR-1 (reproduced), KEYS-1 (reproduced) | Chromium's own merge of two line boxes inside a session block corrupts what it moves: every inline formula on the moved line is rewritten from its rendered text, an image gets a baked style attribute, and the joined list item takes the SECOND item's checkbox state |
| N2 | high | new-feature-defect | older | yes (switch on) | REV-1 (reproduced) | J19 class: when a session edits anything in a block, percent-escapes in a bare URL, an autolink, an inline link destination or an image source are written as the raw characters (U+200B, U+FEFF, U+202E, U+00A0, U+3000, private use) |
| N3 | medium | regression-vs-shipped | older than fix round 4 | no (shows with the switch off) | OFFA-1 (reproduced) | Switch OFF: the web page loads the whole editing code at start; a first (uncached) visit shows the editor about 27 % later than 0.1.1 |
| N4 | medium | new-feature-defect | older | yes (switch on) | KEYS-2 (reproduced) | J6 variation: after the first edit of a block normalised its spelling (K5), Cmd-Z / Shift-Cmd-Z in the session puts the caret at the end of the last normalised range, not where the user typed |
| N5 | medium | new-feature-defect | older than fix round 4 | yes (switch on) | PTR-2 (reproduced) | Right after a block is emptied (Cmd-A Backspace, the emptied element still on screen), a double or triple click lower down selects the word or paragraph one block below; the next typed text replaces text the user did not aim at |
| N6 | medium | new-feature-defect | older than fix round 4 | yes (switch on) | PTR-3 (reproduced) | After pasting several paragraphs into a paragraph, when the last pasted paragraph contains line breaks, the next typed text lands that many characters before the end of the paste |
| N7 | medium | new-feature-defect | older than fix round 4 | yes (switch on) | PTR-4 (reproduced) | A triple-click on a line holding an inline formula, then ArrowRight, puts the caret inside the formula's rendering; every typed key is swallowed (nothing shown, nothing written, no toast) |
| N8 | low | new-feature-defect | older | yes (switch on) | REV-2 (flaky) | A press on a task box inside a session that is released off the box leaves inlineEdit's toggle set; a click on that box right after the session ends is lost silently |
| N9 | low | new-feature-defect | older | yes (switch on) | SW-1 (reproduced) | After the switch was on once, the document-wide execCommand setting defaultParagraphSeparator stays "p" when it is off again (0.1.1: "div") |
| N10 | low | pre-existing | older | no (shows with the switch off) | OFFP-1 (reproduced) | J13 keyboard form: Tab onto a task box that a document hid inside an invisible label overlay, then Space, ticks the hidden task (same in 0.1.1) |
| N11 | low | spec-gap | older | no (shows with the switch off) | OFFA-2 (reproduced), OFFK-1 (reproduced) | J4 / R6 variation: a document replacement answered with 丢弃 while that same document's save is still in flight; the contract does not say whether the replacement waits for the save |

## Groups

### N1 [high, new-feature-defect] Chromium's own merge of two line boxes inside a session block corrupts what it moves: every inline formula on the moved line is rewritten from its rendered text, an image gets a baked style attribute, and the joined list item takes the SECOND item's checkbox state

- What goes wrong for the user: Needs the switch on. Backspace at the start of a list item or quote paragraph (or Delete at the end of the line above, or Enter then Backspace at a block start) silently changes the file: $x$ becomes $xx$, \frac{a}{b} becomes "abba" plus an invisible U+200B, an image becomes raw HTML with a style attribute, and joining "- [ ] task a" with "- [x] task b" writes "- [x] task a task b" (a plain item can become a ticked task).
- Findings: PTR-1, KEYS-1. Introduced by: older than fix round 4 (identical on release/pre-r4.noindex; the serializer task-marker loop is the same in pre-r3): the session lets Chromium run its own paragraph / list-item merge (MoveParagraph re-creates nodes from markup) inside the block; serialize.ts then takes a formula TeX it no longer recognises from the rendered text, keeps the style Chromium baked, and sets data-mdr-task for EVERY checkbox of the li, so the last one wins.
- Repro (from the project root): `MDR_PORT=5488 node bench/verify/v5-ptr-mergeatoms.mjs ; MDR_PORT=5488 node bench/verify/v5-ptr-u23atoms.mjs ; MDR_PORT=5488 node bench/verify/v5-keys-probe.mjs task- ; npx vitest run test/v5-keys-taskjoin.test.ts   (5488 = npx vite --port 5488 --strictPort, the tree)`
- Observed: v5-ptr-mergeatoms 3/11 passed: '- item first⏎- Lead $x$ item two⏎', click 'item two', Home, Backspace, Esc -> '- item firstLead $xx$ item two⏎' (the same for tight-items-del, loose items, an item's second paragraph, a nested item, ordered items, quote paragraphs by Backspace and by Delete). v5-ptr-u23atoms 5/13 passed: 'Lead $x$ and more words.' Home Enter Backspace -> 'Lead $xx$ and more words.'; Enter Q Backspace Backspace on 'Lead ![i](x.png) and more words.' -> 'Lead <img src="x.png" alt="i" style="background-color: rgb(250, 248, 244);"> and more words.'; in a heading the session DOM carries 'font-size: 16px' too. v5-keys-probe task-: 6 of 6 join cases wrong, e.g. '- [ ] task a⏎- [x] task b⏎⏎end⏎' End Delete Esc -> '- [x] task a task b⏎⏎end⏎' (the session shows '[ ] task a[x] task b' before Esc), '- plain a⏎- [x] task b' -> '- [x] plain a task b', '- [ ] one⏎- [x] two⏎- [ ] three' Backspace at 'two' -> '- [x] one two⏎- [ ] three'; item-nested-del '- one⏎  - [x] nested⏎- [ ] two' -> '- [x] onenested⏎- [ ] two'. No toast in any case. Unit test: 3 of 3 cases fail.
- Expected: Only the join itself changes (K8): '- item firstLead $x$ item two', U23 (Enter then Backspace) leaves the source byte-identical, no style attribute and no U+200B is written; the joined item keeps its own marker: '- [ ] task a task b', '- plain a task b', '- [ ] one two⏎- [ ] three'.
- Baseline: Not applicable (0.1.1 has no in-preview editing). The verifiers measured release/pre-r4.noindex served by its own Vite: identical failures (8/11, 8/13, 6/6). Cmd-Z in the editor restores the original bytes.
- My verdict: Reproduced, 1 run each on a quiet machine (deterministic): mergeatoms 8/11 fail, u23atoms 8/13 fail, keys-probe task- 6/6 + item-nested-del wrong, unit 3/3 fail. Grouped because one fix closes both: the join of two line boxes inside a session block must not be left to Chromium (move the existing nodes in code, or merge in the source as U3 does across blocks); the serializer must in any case never derive TeX from rendered text, never write a style attribute the block did not hold, and take an item's task state only from its own leading box (ownTaskBox). A fixer who repairs only one of the two symptoms has not fixed the group.
- PTR-1: reproduced, severity high. Decisive output: v5-ptr-mergeatoms: "3/11 passed", e.g. FAIL tight-items-bs src="- item firstLead $xx$ item two\n\nnext\n"; v5-ptr-u23atoms: "5/13 passed", image-typed src="Lead <img src=\"x.png\" alt=\"i\" style=\"background-color: rgb(250, 248, 244);\"> and more words." (1 of 1 run each, deterministic). Baseline run: not applicable (new feature; the verifier measured pre-r4 identical).
- KEYS-1: reproduced, severity high. Decisive output: v5-keys-probe task-: RESULT task-del-join {"ok":false,"after":"- [x] task a task b\n\nend\n"}, task-del-join-plain-first after "- [x] plain a task b" (6 of 6 join cases wrong; item-nested-del "- [x] onenested"); test/v5-keys-taskjoin.test.ts 3 of 3 failing. Baseline run: not applicable (new feature; pre-r4 identical per verifier, serializer loop identical in pre-r3 and pre-r4 by code).
- Suspected files: src/preview/inlineEdit.ts, src/preview/serialize.ts

### N2 [high, new-feature-defect] J19 class: when a session edits anything in a block, percent-escapes in a bare URL, an autolink, an inline link destination or an image source are written as the raw characters (U+200B, U+FEFF, U+202E, U+00A0, U+3000, private use)

- What goes wrong for the user: Needs the switch on. Typing one character anywhere in a paragraph that holds a link with "%E2%80%8B" (or %EF%BB%BF, %E2%80%AE, %C2%A0, %E3%80%80, %EE%80%81) writes that character raw into the file: invisible in both panes, and U+202E reverses the display of the rest of the source line; the link still opens the same target.
- Findings: REV-1. Introduced by: older: the U11 autolink / bare spelling is written from data-mdr-text (the shown text, which normalizeLinkText decoded) and linkDest decodes destinations (rounds 2/3); fix round 4's J19 rule (fix-serial decodedDest / PUA_RAW) keeps escapes only for marker-range characters and only on linkDest.
- Repro (from the project root): `npx vitest run test/v5-rev-autolink.test.ts ; MDR_PORT=5488 MDR_RUNS=2 node bench/verify/v5-rev-autolink.mjs   (5488 = Vite of the tree)`
- Observed: Chromium, click at the end of 'words', type X, Esc, 10 of 10 failing (5 shapes x 2 runs): 'See https://e.example/?q=a%E2%80%8Bb here⏎second line words⏎' -> 'See https://e.example/?q=a<U+200B>b here⏎second line wordsX⏎' (nonAscii=[200b]); '<https://e.example/?q=a%E2%80%8Bb>' -> '<https://e.example/?q=a<U+200B>b>'; %E2%80%AE -> raw U+202E (and the click lands inside 'words': 'wordXs'); 'https://www.example.com/search?q=%E4%B8%AD%E6%96%87%E3%80%80%E8%AF%8D' -> '<https://www.example.com/search?q=中文<U+3000>词>'; %C2%A0 -> raw NBSP. Control %20 keeps its escape. Unit: test/v5-rev-autolink.test.ts 22 failing cases ('REV-1 tree'), test/v5-rev-serial.test.ts 14 ('J19 class' 12, 'J19 variations' 2), e.g. expected [] got ['200b'] for 'See [x](https://e.example/a<U+200B>b) here⏎second line wordsX'.
- Expected: The URL's bytes are unchanged outside what the user typed: an escape stays an escape (fix-serial's own J19 sentence: 'same href, no invisible character written'). K5 does not list percent-escapes respelled as raw characters.
- Baseline: Not applicable (0.1.1 has no in-preview editing). pre-r4 and pre-r3 serializers write the same (the snapshots case of test/v5-rev-autolink.test.ts).
- My verdict: Reproduced: browser 10/10, unit 22/22 + 14/14 in the whole suite. SEVERITY RAISED from medium to high: the release decision defines a high defect of the experimental feature as "something written that the user did not type and cannot see", and a raw U+200B / U+FEFF / U+202E / private-use character the user never typed is exactly that (U+202E even scrambles how the editor pane shows the line). The verifier's argument for medium (the characters were the URL's own, the href and the rendering are identical) is fair; the lead may accept it, but by the letter of the gate this is high.
- REV-1: reproduced, severity high (Raised from medium: the release decision lists "written that the user did not type and cannot see" as high for the experimental feature, and raw U+200B / U+FEFF / U+202E / private-use characters are exactly that; the href and rendering are unchanged, so the lead may accept medium.). Decisive output: v5-rev-autolink: FAIL bare-zwsp run0 … escapeKept=false nonAscii=[200b] source="See https://e.example/?q=a<U+200B>b here\nsecond line wordsX\n"; "10 failing" (2 runs); control-ascii ok; suite: v5-rev-autolink 22 failed, v5-rev-serial 14 failed. Baseline run: not applicable (new feature).
- Suspected files: src/preview/serialize.ts

### N3 [medium, regression-vs-shipped] Switch OFF: the web page loads the whole editing code at start; a first (uncached) visit shows the editor about 27 % later than 0.1.1

- What goes wrong for the user: Shows with the switch off (every user). The main script grows from 380 KB to 643 KB (gzip 137 KB to 233 KB): a cold visit of the web page shows the editor 85 ms later at 10 Mbit/s and 190 ms later at 4 Mbit/s; with a warm cache there is no difference, locally (desktop-like) about 12 ms.
- Findings: OFFA-1. Introduced by: older than fix round 4: the in-preview editing feature (rounds 1-3); createPreview.ts imports inlineEdit.ts statically, which imports serialize.ts (markdown-it, turndown, turndown-plugin-gfm, the math plugin) and fidelity.ts. Round 4 (fix-release) made the switch off by default and kept the static import..
- Repro (from the project root): `npx vite preview --outDir release/staging-0.2.0.noindex/dist --port 5488 --strictPort & npx vite preview --outDir release/baseline-0.1.1.noindex/dist --port 5498 --strictPort & sleep 3; MDR_PORT=5488 MDR_BASE_PORT=5498 node bench/verify/v5-offa-cold.mjs 4 --net 10`
- Observed: release/staging-0.2.0.noindex/dist/assets/index-HSzQfuou.js 643 065 B (gzip 233 452 B) against 0.1.1's index-BP8hzxzG.js 380 008 B (gzip 136 603 B). JS received before the editor exists 334 791 B vs 237 865 B (x1.41). Time from navigation to .cm-content, no cache, alternating, 4 samples per build and run: at 10 Mbit/s candidate 401 / 400 / 405 ms vs 0.1.1 315 / 315 / 317 ms (x1.27, x1.27, x1.28; every candidate sample slower than every 0.1.1 sample); idle 539 / 537 / 539 vs 454 / 452 / 454 ms (x1.19). At 4 Mbit/s 820 vs 629 ms (x1.30), idle 1120 vs 920. Unthrottled local network, no cache: 65 vs 53 ms (x1.23). Warm HTTP cache: 52 vs 48 ms (noise). Opening small.md and large.md afterwards: the same.
- Expected: With the switch off the start costs what 0.1.1's did: the session code (createInlineEdit, serialize, fidelity and what they import) is loaded only when the switch is turned on or a session starts.
- Baseline: 0.1.1 dist, same script, alternating in the same runs (numbers above). Regression measured by me: 3 of 3 runs at 10 Mbit/s, 1 of 1 at 4 Mbit/s, 1 of 1 unthrottled.
- My verdict: Reproduced on the production build. Medium by the scale's sentence "ANY regression against the baseline in something people use every day" (opening the app); the absolute cost is small (85 ms on a cold 10 Mbit/s visit, about 12 ms of parse/compile locally) and the lead may accept it as a known cost, but by the strict switch-off gate it is the one item that blocks. The fix is mechanical (dynamic import() of the session module at setEditable(true)).
- OFFA-1: reproduced, severity medium (Agree by the letter (regression in something used every day); absolute cost small (about 85 ms cold at 10 Mbit/s, 12 ms locally), warm cache equal.). Decisive output: v5-offa-cold 4 --net 10, three runs: "tEditor cand 401 base 315 ratio 1.27", "cand 400 base 315 ratio 1.27", "cand 405 base 317 ratio 1.28"; --net 4: "cand 820 base 629 ratio 1.30"; unthrottled "cand 65 base 53"; --warm "cand 52 base 48". Baseline run: 0.1.1 dist in the same alternating runs: 315/315/317 ms at 10 Mbit/s, 629 ms at 4 Mbit/s; the baseline really is faster on every cold sample.
- Suspected files: src/preview/createPreview.ts, src/preview/inlineEdit.ts, src/preview/serialize.ts, src/preview/fidelity.ts

### N4 [medium, new-feature-defect] J6 variation: after the first edit of a block normalised its spelling (K5), Cmd-Z / Shift-Cmd-Z in the session puts the caret at the end of the last normalised range, not where the user typed

- What goes wrong for the user: Needs the switch on. In a "* one" list, a setext heading, a heading with closing hashes, or a block with reference links, autolinks, entities or a backslash break, typing a few letters and pressing Cmd-Z moves the caret elsewhere in the block, and the next keys land there (visible, nothing lost).
- Findings: KEYS-2. Introduced by: older (history() returns the end of the last changed range; a block's first write carries its K5 normalisation, so the undone range spans it); fix round 4's caretForSource maps that position correctly, the position itself is wrong. The same class fails on pre-r4..
- Repro (from the project root): `MDR_PORT=5488 node bench/verify/v5-keys-probe.mjs k5undo   (Vite of the tree)`
- Observed: Type QR, pause 900 ms, Cmd-Z, type W: '* one⏎* two⏎* three' (QR after 'one') -> '- one⏎- two⏎- Wthree'; 'Title words⏎===========' (QR after 'Title') -> '# Title wordsW'; '## Head words ##' (QR after 'Head') -> '## Head wordsW'. Controls right: 'plainW words here', refs with QR at the end.
- Expected: '- oneW⏎- two⏎- three', '# TitleW words', '## HeadW words' (the caret where the undone typing began; after a redo after the redone text).
- Baseline: Not applicable (new feature). Same class fails on pre-r4 (verifier).
- My verdict: Reproduced 3 of 3 normalising shapes, 1 run (deterministic); controls 2 of 2 right.
- KEYS-2: reproduced, severity medium. Decisive output: RESULT k5undo-star-list {"ok":false,"after":"top\n\n- one\n- two\n- Wthree\n\nend\n"}; k5undo-setext after "# Title wordsW"; k5undo-closing-hashes "## Head wordsW"; controls ok. Baseline run: not applicable (new feature).
- Suspected files: src/app/previewEdit.ts, src/preview/inlineEdit.ts

### N5 [medium, new-feature-defect] Right after a block is emptied (Cmd-A Backspace, the emptied element still on screen), a double or triple click lower down selects the word or paragraph one block below; the next typed text replaces text the user did not aim at

- What goes wrong for the user: Needs the switch on. Clear one paragraph, then double-click a word further down to replace it: the word (or with a triple click the whole paragraph) one block below is selected and replaced instead.
- Findings: PTR-2. Introduced by: older than fix round 4 (identical on pre-r4): the first press ends the session on the emptied element, which leaves the layout at once, so the content moves up under the pointer before the second press.
- Repro (from the project root): `RUNS=3 MDR_PORT=5488 node bench/verify/v5-ptr-shift.mjs emptied   (Vite of the tree)`
- Observed: 'Alpha line one. / Bravo para two. / Charlie line three. / Delta line four. / Echo line five. / Foxtrot six.': click 'Bravo', Cmd-A, Backspace, double-click 'four' (element under the pointer at the press: 'Delta line four.') -> selected 'five', X gives '…Delta line four.⏎⏎Echo line X.⏎⏎Foxtrot six.⏎'; triple-click -> 'Echo line five.' selected, X gives '…Delta line four.⏎⏎X⏎⏎Foxtrot six.⏎'. Controls: single click 'Delta line fXour.', Esc first then double-click 'Delta line X.'.
- Expected: The multi-click selects what was under the pointer at the first press: 'Delta line X.'.
- Baseline: Not applicable (new feature). Identical on pre-r4 (verifier).
- My verdict: Reproduced: double 3/3, triple 3/3; controls 6/6 right.
- PTR-2: reproduced, severity medium. Decisive output: FAIL emptied-dblclick-below#1..#3 underAtPress="Delta line four.\n" selected="five" src="…Echo line X.…"; FAIL emptied-tripleclick-below#1..#3 selected="Echo line five."; "6/12 passed" (the 6 controls). Baseline run: not applicable (new feature).
- Suspected files: src/preview/inlineEdit.ts, src/preview/createPreview.ts

### N6 [medium, new-feature-defect] After pasting several paragraphs into a paragraph, when the last pasted paragraph contains line breaks, the next typed text lands that many characters before the end of the paste

- What goes wrong for the user: Needs the switch on. Paste an address or a poem with paragraphs and line breaks into a paragraph and keep typing: the typed text goes inside the last pasted word (visible, Cmd-Z repairs).
- Findings: PTR-3. Introduced by: older than fix round 4 (splitTarget byte-identical to pre-r4): the split caret is a visible-text offset counted in the session DOM (a pasted <br> has no text after it) and applied to the re-render (markdown-it puts a "
" text node after every <br>).
- Repro (from the project root): `MDR_PORT=5488 node bench/verify/v5-ptr-splitbr.mjs   (Vite of the tree)`
- Observed: 4/9 passed. 'Alpha first words here.', caret at the end, paste 'Pone⏎⏎Ptwo⏎Ptri', type TYPED -> 'Alpha first words here.Pone⏎⏎Ptwo  ⏎PtrTYPEDi'; two breaks -> '…Ptri  ⏎PfoTYPEDur'; the same with CRLF, after a 1500 ms wait, and mid-paragraph. Controls pass (no break in the last paragraph, no split, a quote).
- Expected: '…Ptwo  ⏎PtriTYPED'.
- Baseline: Not applicable (new feature). Identical on pre-r4 (verifier).
- My verdict: Reproduced, 5 of 9 cases fail (deterministic).
- PTR-3: reproduced, severity medium. Decisive output: FAIL para-lf-1br want ...PtriTYPED src="Alpha first words here.Pone\n\nPtwo  \nPtrTYPEDi…"; "4/9 passed". Baseline run: not applicable (new feature).
- Suspected files: src/preview/inlineEdit.ts

### N7 [medium, new-feature-defect] A triple-click on a line holding an inline formula, then ArrowRight, puts the caret inside the formula's rendering; every typed key is swallowed (nothing shown, nothing written, no toast)

- What goes wrong for the user: Needs the switch on. Triple-click a line with a formula and press the right arrow: whatever is typed next disappears until the user clicks again.
- Findings: PTR-4. Introduced by: older than fix round 4 (identical on pre-r4): placeSafe / setCaretAtOffset snap the caret out of non-editable elements only for resumes and click restores, not when the browser collapses a selection.
- Repro (from the project root): `MDR_PORT=5488 node bench/verify/v5-ptr-arrowatom.mjs triple ; RUNS=3 MDR_PORT=5488 node bench/verify/v5-ptr-tripletype.mjs heading-formula   (Vite of the tree)`
- Observed: arrowatom triple 1/4 passed: 'Para Aaa with $x^2$ formula words.', triple-click, ArrowRight -> caret in a <mi> inside .md-math (inMath=true), TYPED not in the source after Esc; the same in a heading and on a line ending with a formula. tripletype heading-formula 0/6 passed (3 runs x 2 cases): sel='Head Aaa with ', caret in 'mi.', shownInPreview=false, inSourceLive=false.
- Expected: After the arrow the caret is directly after the selection and before the formula (through its U21 spacer); the typed text is written there.
- Baseline: Not applicable (new feature). Identical on pre-r4 (verifier).
- My verdict: Reproduced: 3/4 and 6/6.
- PTR-4: reproduced, severity medium. Decisive output: arrowatom: FAIL para-triple-right caret={"el":"mi","inMath":true} src unchanged, "1/4 passed"; tripletype: "0/6 passed" (heading-formula-right1/2 x 3 runs, inSourceLive=false). Baseline run: not applicable (new feature).
- Suspected files: src/preview/inlineEdit.ts

### N8 [low, new-feature-defect] A press on a task box inside a session that is released off the box leaves inlineEdit's toggle set; a click on that box right after the session ends is lost silently

- What goes wrong for the user: Needs the switch on. Press a task box in a session, drag off it, press Esc, click the same box at once: nothing is ticked and nothing is said (with a slow re-render the box even flashes ticked); clicking again works.
- Findings: REV-2. Introduced by: older (the toggle branch of onMouseDown / onClick, since round 2); it became silent with fix round 4's U16 answers (fix-session-f: interactions cancels a "wait" answer without a toast and relies on the session's wait, which onClick's earlier toggle branch skips).
- Repro (from the project root): `MDR_PORT=5488 node bench/verify/v5-rev-staletoggle.mjs 3 0 ; MDR_PORT=5488 node bench/verify/v5-rev-staletoggle.mjs 3 1500 ; MDR_CONTROL=1 MDR_PORT=5488 node bench/verify/v5-rev-staletoggle.mjs 3 0   (Vite of the tree)`
- Observed: Natural timing: 6 of 9 runs 'FAIL … ticked=false toast=false toasts=[] shown60ms=[false,false,false]' (3 invocations: 1/3, 2/3, 3/3 failing). Re-render held 1500 ms: 3 of 3 'ticked=false toast=false shown60ms=[true,false,false] shownAfter=[false,…]'. Control without the press on the box: 3 of 3 'ticked=true'.
- Expected: U16 as amended: the click ticks the task (as the control does), or nothing changes and the toast 没有勾选：该任务项刚被改动，请再点一次 is shown; never lost silently.
- Baseline: Not applicable (needs a session).
- My verdict: Flaky at natural timing (6 of 9 on a quiet machine), reproduced 3 of 3 with the held re-render. Low: rare gesture, the box visibly stays unticked, a second click works.
- REV-2: flaky, severity low. Decisive output: hold 0: 6 of 9 "FAIL runN … ticked=false toast=false toasts=[]"; hold 1500: 3 of 3 FAIL shown60ms=[true,false,false] shownAfter=[false,…]; MDR_CONTROL=1: 3 of 3 ok ticked=true. Baseline run: not applicable (needs a session).
- Suspected files: src/preview/inlineEdit.ts, src/preview/interactions.ts

### N9 [low, new-feature-defect] After the switch was on once, the document-wide execCommand setting defaultParagraphSeparator stays "p" when it is off again (0.1.1: "div")

- What goes wrong for the user: Needs the switch turned on once (one session); after it is off again nothing visible differs: CodeMirror handles Enter itself (the verifier typed Enter, Shift+Enter, Alt+Enter, Ctrl+O, Cmd+Enter in the editor after a session: same source as 0.1.1).
- Findings: SW-1. Introduced by: older (begin() calls exec("defaultParagraphSeparator", "p") since rounds 1-3; teardown() and setEditable(false) never restore it).
- Repro (from the project root): `MDR_PORT=5488 MDR_BASE_PORT=5498 node bench/verify/v5-cfm-dps.mjs   (5488 = vite preview of release/staging-0.2.0.noindex/dist, no ?perf=1; 5498 = the 0.1.1 dist) ; or the verifier's MDR_PORT=<Vite dev of the tree> MDR_BASE_PORT=<0.1.1 dist> node bench/verify/v5-sw-off.mjs dps-leftover`
- Observed: Production build, no hooks: {"cand":{"before":"div","pressed0":"false","pressed1":"true","session":1,"during":"p","pressed2":"false","after":"p"},"base":{"before":"div",…,"after":"div"}} -> 'DIFF cand.after=p base.after=div'. Dev server: cand {"before":"div","afterOff":"p"} base {"before":"div","afterOff":"div"}.
- Expected: Nothing a session sets on the document outlives it: "div" again after the switch is off.
- Baseline: 0.1.1 "div" throughout (measured by both scripts).
- My verdict: Reproduced on the production build without hooks (1 of 1) and on the dev server (1 of 1). Low: no user-visible effect found. Never shows on a page where the switch was never turned on.
- SW-1: reproduced, severity low. Decisive output: v5-cfm-dps (production build, no hooks): "DIFF cand.after=p base.after=div"; v5-sw-off dps-leftover (dev): cand {"before":"div","afterOff":"p"} base {"before":"div","afterOff":"div"}. Baseline run: 0.1.1 "div" before and after the same gestures (both scripts).
- Suspected files: src/preview/inlineEdit.ts

### N10 [low, pre-existing] J13 keyboard form: Tab onto a task box that a document hid inside an invisible label overlay, then Space, ticks the hidden task (same in 0.1.1)

- What goes wrong for the user: Shows with the switch off, identical in 0.1.1: a keyboard user who Tabs through a hostile document's preview and presses Space ticks a task line they cannot see (Cmd-Z restores it).
- Findings: OFFP-1. Introduced by: older (0.1.x checkbox write-back); fix round 4's U24 key rule (detail 0, keyOn === the box, focusGiven !== the box) accepts it because it does not look at visibility.
- Repro (from the project root): `MDR_PORT=5488 MDR_BASE_PORT=5498 MDR_CAND_PERF=1 node bench/verify/v5-offp-j13.mjs tab-hidden   (5488 = vite preview of release/staging-0.2.0.noindex/dist, 5498 = the 0.1.1 dist)`
- Observed: '- [ ] visible task one⏎⏎- <label style="position:absolute;left:-3000px;top:-3000px;width:9000px;height:9000px;z-index:50;opacity:0;display:block">x⏎  - [ ] hidden task⏎⏎last line⏎': focus on the visible box, Tab, Space -> cand {"focused":"hidden task","changed":["4:  - [x] hidden task"],"toasts":[]}.
- Expected: A key on a box the document made invisible leaves the source unchanged (as the click forms of J13 now do).
- Baseline: 0.1.1, same script, same page pair: {"focused":"hidden task","changed":["4:  - [x] hidden task"],"toasts":[]} 3 of 3. Pre-existing.
- My verdict: Reproduced 3 of 3 on the candidate's production build (switch off) and 3 of 3 on 0.1.1. Not a release blocker.
- OFFP-1: reproduced, severity low. Decisive output: tab-hidden {"cand":{"focused":"hidden task","changed":["4:  - [x] hidden task"],"toasts":[]},"base":{"focused":"hidden task","changed":["4:  - [x] hidden task"],"toasts":[]}} 3 of 3. Baseline run: 0.1.1 dist: the same tick 3 of 3, so pre-existing (the baseline does not behave better).
- Suspected files: src/preview/interactions.ts, src/preview/sanitize.ts

### N11 [low, spec-gap] J4 / R6 variation: a document replacement answered with 丢弃 while that same document's save is still in flight; the contract does not say whether the replacement waits for the save

- What goes wrong for the user: Shows with the switch off; needs a slow or failing disk. Web: after 丢弃 during the save, a late save failure leaves the typed text nowhere (0.1.1 kept it as a draft). Web and desktop: reopening the same file during its save shows the pre-save text as saved, and the next save silently overwrites the text that was just saved (the desktop form is identical in 0.1.1).
- Findings: OFFA-2, OFFK-1. Introduced by: older: a replacement never waits for the current document's own save (identical in 0.1.1); R2 (an earlier round: the discarded document's draft is deleted) removes the draft 0.1.1 kept; R6 (fix round 4, fix-flows) handles the binding correctly but does not cover these forms.
- Repro (from the project root): `Web: MDR_PORT=5488 MDR_BASE_PORT=5498 MDR_TMP=<scratch> node bench/verify/v5-offa-r6.mjs fail-where-500 recent-same-500   (both dists by vite preview). Desktop: MDR_OFFK_TMP=<scratch> MDR_TARGET=cand node bench/electron/v5-offk-save.mjs reopen-same-during-save (and MDR_TARGET=base)`
- Observed: fail-where-500, cand: drafts [] (only the recent list), disk s.md '# S⏎', toast '保存失败：s.md：disk full (test)'; the text 'typed' exists nowhere. recent-same-500, cand: the editor shows '# S⏎' titled 's.md' (clean) with '已保存：s.md' while the disk holds '# S⏎typed'; 'more' + Cmd-S writes '# S⏎more'. Desktop cand: t1 'r1.md', tx1 '# R1⏎', d1 '# R1⏎typed', then d2 '# R1⏎more' with no conflict prompt (dlg2 []), toasts ['已保存：r1.md×','已保存×'].
- Expected: A 丢弃 given while that document's own save is in flight does not lose what the save was writing: the replacement waits for the save's result, or the draft is kept until the save succeeded; a document read while its own save is still being written is not shown as saved (or its next save asks).
- Baseline: Web 0.1.1: fail-where-500 keeps the draft '# S⏎typed' (offered when s.md is opened again); recent-same-500 ends with the same disk '# S⏎more' but shows '● s.md' and a draft offer holding 'typed'. Desktop 0.1.1: same disk bytes '# R1⏎more', title '● r1.md'. The web difference comes from the decided R2; the desktop form is pre-existing.
- My verdict: Reproduced: web both cases 3 of 3 (candidate differs as described, 0.1.1 as described); desktop candidate directory 3 of 3, baseline directory 3 of 3. Grouped: one fix (a replacement waits for the current document's in-flight save, or keeps its draft until that save resolves and re-reads a same-path reopen). Low: needs a slow or failing write plus 丢弃 at that moment; the user did answer 丢弃.
- OFFA-2: reproduced, severity low. Decisive output: DIFF recent-same-500 — typed text lost: {"s.md":"# S\nmore"}; DIFF fail-where-500 cand drafts [["o.md","s.md"]] (no text) vs base drafts ["# S\ntyped",…]; "0 same/ok, 2 differ" 3 of 3. Baseline run: 0.1.1 keeps the draft "# S\ntyped" (fail-where) and shows "● s.md" with a draft offer (recent-same): better for the user, through the decided R2 difference.
- OFFK-1: reproduced, severity low. Decisive output: cand: OBS reopen-same-during-save {"t1":"r1.md","tx1":"# R1\n","d1":"# R1\ntyped","d2":"# R1\nmore","dlg2":[]} FAIL, 3 of 3. Baseline run: 0.1.1 baseline directory: the same disk bytes "# R1\nmore", title "● r1.md", 3 of 3: pre-existing.
- Suspected files: src/app/App.ts, electron/fileIO.mjs

## Known limits for the README (experimental feature, switch on), in plain words

- N4: In a block whose spelling the first edit tidies up (a "*" list, an underlined heading, closing #s, reference links, autolinks, entities, a backslash line break), Cmd-Z right after typing can put the cursor at another place in the block; click where you want to type next.
- N5: Right after you empty a paragraph, a double or triple click further down selects the word or paragraph one block lower; press Esc first, or check the selection before typing.
- N6: After pasting several paragraphs whose last one contains line breaks, the cursor lands a few characters too early; click at the end of the pasted text before you type on.
- N7: Triple-clicking a line that contains a formula and then pressing the right arrow puts the cursor inside the formula, and typing does nothing until you click again.
- N8: If you press a checkbox, drag off it, press Esc and click it again at once, the tick may not happen; click once more.
- N9 (no visible effect): after editing in the preview was on once, a browser editing setting stays changed until the page is reloaded.

## Whole unit suite (step 2)

- npx vitest run --no-file-parallelism, once, in the background on the quiet machine: 123 files, 2588 tests; 39 failed, 2543 passed, 6 marked as known failures (it.fails, K22 / K24) behaved as expected; 118.4 s.
- All 39 failures are the verifiers' repro cases and belong to reproduced findings. test/v5-keys-taskjoin.test.ts has 3 (KEYS-1, N1). test/v5-rev-autolink.test.ts has 22 ("REV-1 tree": bare URL, autolink and bare URL in a list item, each with ZWSP, BOM, NBSP, RLO, U+3000 and U+E001; inline link destination and image source, each with ZWSP and RLO; REV-1, N2). test/v5-rev-serial.test.ts has 14: "J19 class" autolink and linkify with %C2%A0, %E2%80%8B, %E2%80%AE, %E3%80%80, %EE%80%81 and %EF%BB%BF (12), and "J19 variations" autolink pct E001 and linkify pct E001 (2) (REV-1, N2).
- Unexplained failures: none. test/v5-chc-linethrough.test.ts and test/v5-rev-zwdoc.test.ts pass completely. The integration count was 119 files / 2462 tests with 0 failing; the 4 new files with 126 tests are the verifiers' v5 tests.

## Performance (step 3)

- (a) npx playwright test, once (its own Vite on 5199, 57.8 s, 1 passed): every budget passes. P1 open to first visible 94.2 ms (< 400). P4 longest task 0 ms, tasks > 50 ms after 1 s 0. P5 main per keystroke p95 26.5 ms (< 30), max 32.3 ms (< 60), raw p95 26.5 ms, idle baseline 0. P5 keystroke to mount p95 35.5 ms (< 40). P8 frames > 20 ms 0.4 % (< 3). P11 undo step p95 0.0 ms (< 5). This is the dev server with nothing stored, so test mode and the switch ON. test-results/ was moved to my scratch directory.
- (b) P5 against 0.1.1 (K17) with bench/verify/fix2-int-p5.mjs: 200 keys on large.md in split mode, three alternating rounds (candidate on, 0.1.1, candidate off), production builds served by bench/verify/v5-cfm-perfserve.mjs. The server redirects / to ?perf=1; with "off" it stores mdr.previewEdit = "0" before the app starts, checked: aria-pressed false.
-     · Candidate, switch on (test-mode default): raw busy per key p95 25.1 / 23.9 / 26.6 ms, p50 13.2 / 13.1 / 12.3 ms; keystroke to mount p95 34.8 / 34.6 / 34.6 ms.
-     · Candidate, switch OFF (the shipped configuration): p95 24.8 / 25.7 / 24.0 ms, p50 12.8 / 12.5 / 13.1 ms; keystroke to mount p95 34.1 / 34.4 / 34.1 ms.
-     · 0.1.1: p95 25.2 / 26.0 / 27.2 ms, p50 13.2 / 13.2 / 12.9 ms; keystroke to mount p95 34.4 / 34.6 / 34.1 ms.
-     · Judgement: equal to 0.1.1 in both configurations (the candidate means are 0.5 to 1.3 ms lower, inside the run-to-run spread). The script's own absolute "< 5 / < 10 ms" lines fail on all three builds alike, as in every earlier round.
- (c) MDR_PORT=5488, one at a time, dev server (switch on): inline-verify-perf 5/5 (large.md session start max 18.5 ms; preview work per key p95 0.8 ms; 300-line list start 43.8 ms (< 50), flush p95 3.1 ms; 20 tables start p95 5.9 ms, flush p95 2.4 ms); inline-verify-resume 13/13 (Enter to resumed session median 30 ms on small.md, 40 ms on large.md; CJK and IME input during the window never lost); fix2-i2-paste 9/9 (handlers 0.1 to 15.3 ms, longest frame after a paste 19 to 29 ms; the next key after a 55 000-character one-word paste takes 1197 ms in the browser, which is K16).
- Cold start, switch off, production builds: see N3 (v5-offa-cold.mjs, 5 invocations, 20 samples per build).

## r3 checks

Each r3 group the verifiers re-attacked, with the variations tried and the outcome. Every broken variation is covered by a group I reproduced.

| r3 group | verifier | variations tried | holds / broken |
|---|---|---|---|
| J13 | verify-off-preview | r3 overlay form, raw-checkbox overlay, label around two tasks, overlay over a visible box, fixed overlay; U24 grids at DSF 1.5, CSS zoom 0.5 and touch (about 290 presses); label then box then Space | holds (all of these) |
| J13 | verify-off-preview | keyboard: Tab onto the hidden box inside the invisible label, then Space | broken: OFFP-1 (N10, pre-existing, identical in 0.1.1) |
| J13 | verify-off-app | 10 tick cases with the switch off (own boxes at four nestings, raw cell box, label around a raw box, item text, double tick, Space, tick + editor Cmd-Z); tick, type, Cmd-Z x3 order | holds |
| J13 | verify-off-desktop | double click on an invisible overlay label, label then Space, press + Shift + release in a raw label, accessibility presses, overlays at zoom 0.8 / 1.5 / 2 (forward path not reached at zoom) | holds |
| J5 | verify-off-preview | selections starting outside every block (4), >130 random copies in 42 fuzz runs, the selected block re-rendered by the editor, Shift-extensions, right-click copy, keys / mode switch / wheel during a drag | holds (byte-identical, OFFD-2 aside) |
| J5 | verify-session-pointer | 31 gestures leaving a session, 8 after K5 writes, 4 after line-box changes (Enter, Tab) | holds (text/plain byte-identical to 0.1.1, 43/43) |
| J4 | verify-off-app | 打开… / a recent entry / 新建 / a CDP file drop at 0, 50, 500 ms into a slowed save that succeeds or fails (24); untitled save picker plus a drop (3); a draft restored during the save (2); a second Cmd-S (3) | holds |
| J4 | verify-off-app | 丢弃 during the document's own save: a late failure; the same file reopened | broken: OFFA-2 (N11, spec-gap) |
| J4 | verify-off-desktop | menu 新建 during a slow main-process write; two opens during one write; 另存为 during an open; a late EIO failure; the close question's 保存 with a document arriving during the write | holds |
| J4 | verify-off-desktop | the same file reopened (丢弃) while its own save is in flight | broken: OFFK-1 (N11; identical in 0.1.1) |
| J25 | verify-off-app | locked .md / .markdown / .txt, locked + readable pair, a file deleted between dragOver and drop, clean and dirty documents (9) | holds |
| J23 | verify-off-app | <!div>, <frameset>, <html>, <body>x, <head>, <!DOCTYPE html>, <frame>, <noframes>, CDATA, a processing instruction | holds |
| J3 | verify-session-keys | 11 neighbour shapes x Cmd-Z + Shift-Cmd-Z settled (44), machine speed and two cycles (22), every worker message delayed 400 ms (77), 24 history steps that re-interpret other blocks | holds |
| J12 | verify-session-keys | typing / Enter + typing into the emptied element between merging neighbours (44); editor insertions above or below while it lives (20) | holds |
| J30 | verify-session-keys | empty the first / last / only / middle block of 5 kinds then Cmd-Z, Q (20); Esc, click a neighbour, type (15) | holds |
| J6 | verify-session-keys | QR at 198 caret positions in 12 block kinds, Cmd-Z / Shift-Cmd-Z then W; U3 merge after 12 block endings | holds (144 positions right in blocks that do not normalise; no key swallowed) |
| J6 | verify-session-keys | the same in blocks whose first edit normalises (reference links, autolinks, escapes and entities, [^1], backslash break, * list, setext, closing hashes) | broken: KEYS-2 (N4), 25 of 37 positions |
| J8 | verify-session-keys | Esc / another block / a list item, then a click back and keys, worker delays 0 to 3000 ms (15); a giant 400-formula block (5); Cmd-Z or Enter then a click elsewhere (10) | holds |
| J9 | verify-session-keys | 13 duplicate shapes x 3 pauses (39), the same with a 400 ms worker delay (42), about 30 fuzz seeds on duplicate documents | holds |
| CHA-5 | verify-session-keys | an editor change inside the paragraph or two lines above it, then a click, delays 0 to 3000 ms (10); about 100 fuzz seeds with remote changes | holds |
| CHA-2 | verify-session-keys | a waiting click with keys queued, then the editor / status bar / another block (6), a queued Delete (4), Esc during the wait (10) | holds |
| CHA-1 | verify-session-keys | typing, Esc, another box at once; Enter / Backspace join then a box; a live session in the same or another block (15) | holds |
| J1 | verify-session-pointer | 165 pastes over 33 exact selections, the same 165 in blocks with KaTeX zero-width characters, 30 cross-line-box pastes, 195 Markdown-active pastes | holds |
| J2 | verify-session-pointer | 30 session states x copy / cut / Esc / paste into the editor; fuzz seeds 1 to 62; the wrapper scanned after Esc | holds (a U+200B reaches the source only through N1) |
| J2 | verify-review | every helper insertion and removal read; KaTeX \frac blocks with a moved spacer (v5-rev-zwmerge); copy / cut / dragstart without a session | holds |
| J19 | verify-review | the caret marker against marker code points reaching the output through 9 other shapes; document-held raw ZWSP / BOM / ZWJ / ZWNJ (8) | holds |
| J19 | verify-review | bare URL, autolink, inline destination and image source with %E2%80%8B, %EF%BB%BF, %C2%A0, %E2%80%AE, %E3%80%80, %EE%80%81 | broken: REV-1 (N2) |
| J20 | verify-review | runs of 16 other characters (jsdom, n and 4n), 11 element-building runs in Chromium at 15 000 / 58 000 characters, backslash-star and backtick-dollar runs | holds (linear) |
| J21 | verify-review | U+3000, em space, NBSP, thin space and a double U+3000 after $10$ at the end of a heading, item, quote, task, inside bold, before a soft break (30) | holds |
| J22 | verify-review | an opened TeX ending in NBSP, U+3000, em space, backslash + NBSP, NBSP + space, in three places (15) | holds |

## What the verifiers attacked without breaking it

- verify-off-preview: switch off, the tick that does not wait (rest 49, edit-then-click 66, IME 6, CHB-3 24, series 12, giant 8, huge.md 7): every tick on the clicked task, 0 wrong, 0 silent, shown at the first frame; CHB-3 gone (24/24); undo order with ticks; real double / triple clicks as in 0.1.1; U24 grids per point equal to 0.1.1; a differential fuzz of 42 runs (about 2 650 steps) and 27 probes equal to 0.1.1 apart from decided or noise differences; nothing of the switch outlives it; the shipped build has no hooks and the switch is not pressed.
- verify-off-app: an upgrade in place on 9 profiles (including corrupted storage and a full quota) keeps everything and writes nothing 0.1.1 cannot read; U2 as amended (16 cases); daily use (shortcuts, every command, toolbar, palette, TOC, status bar, narrow window, IME, multi-cursor, print, dark, quota) identical; v2/v3-app-regress identical; saves, drafts and drops unchanged apart from decided fixes; scroll and typing performance and huge.md equal; exported HTML byte-identical apart from 13 inert rules.
- verify-off-desktop: upgrade 0.1.1 -> 0.2.0 -> 0.1.1 on one profile loses nothing; 64 menu items identical apart from the decided one; menu undo / redo; preview gestures in the real window; copy byte-equal (8/8); checkbox presses at 7 zoom factors; 18 edit-then-click ticks without a wrong one; 30 task shapes; close / quit (13); open paths (14) and open-lifecycle 27/27; 50 files in 10 encodings and 242 920 decoder inputs with 0 differences; S3 navigation; renderer crash drafts; narrow windows and dark theme.
- verify-switch: the default for users (25 stored values), test mode, broken localStorage, the 实验性 marking, four toggle paths and restarts (desktop 14/14), turning the switch off at every moment of a session (nothing lost, nothing left behind apart from SW-1), the capture element (5/5), fast toggling, turning on mid-drag, 69 seeded fuzz runs with about 160 ticks, a reload during a session, narrow toolbars.
- verify-session-keys: about 100 fuzz seeds with 0 lost, duplicated or invisible characters apart from KEYS-1; P-B with merging neighbours (154 + 24); P-F (40); the place rule (81); P-D (198 positions, no key swallowed); P-C (95); CHA-1 / CHA-2 / CHA-5 (45).
- verify-session-pointer: P-A helpers never reach clipboard, DOM or source (30 states, 63 fuzz seeds, 165 scanned pastes); paste equals typing (360 pastes); U19 blank-line pastes (240, only PTR-3 failed); pasted Markdown is literal (195); P-E copies equal 0.1.1 (31); Cmd-E / Cmd-B without a session as 0.1.1; arrow keys over formulas (10/10 apart from PTR-4).
- verify-review: every listener / timer / element the editing code installs regardless of the switch is guarded (code read); the task answer at rest is exact (108 checks, about 2 700 boxes); 9 fresh tickfuzz seeds (257 clicks, 0 violations); each round-4 rule lives in one function (the one bypass is REV-2); U15 held on 125 354 generated blocks; electron/ and md.ts unchanged; J20 linear.
- Mine: the whole suite (no unexplained failure), the playwright budgets, P5 in both configurations against 0.1.1, inline-verify-perf / -resume and fix2-i2-paste, and an independent decoder differential in Electron on the candidate directory.

## What nobody covered

- Real IME, touch hardware, Firefox, Safari and iPad, VoiceOver or Voice Control sessions (the accessibility API was driven directly), the dark theme in the session lenses. Every verifier named these.
- Native drag of selected preview text into the editor or another field (headless Chromium starts no native text drag), a real image paste from the system clipboard, paste and match style in a session, and text/html of in-session copies compared byte for byte with a production build.
- Desktop: the first click into an inactive window, a native context menu while the switch is turned off, the menu 编辑 → 撤销 / 重做 inside a session (J3's desktop form), the menu 拷贝 / 剪切 / 粘贴 in a session, 打开最近 (the wrapper stubs it), J4 with a restored draft during an in-flight save, and the desktop cold start (N3 was measured on the web only; unthrottled local loading was +12 ms).
- Suspicions from reading the code, without a repro. interactions.ts focusGiven: on a platform where a label click focuses its control, a later direct click + Space could be refused. createPreview.ts stampFloor / desync: blocks mounted before a desync answer "unknown" once their version leaves the ring. inlineEdit.ts begin(): data-mdr-o / contenteditable=false stay on the wrapper until the re-render, so a text/html copy in that window would carry them. pasteText: an unregistered placeholder in an ownZw > 0 block. hitsBox: any untrusted click within 11 s of a re-rendered real tick counts as granted. App.ts exportHtml reads file.name after its awaits.
- verify-session-keys seed 92 (80 ops): once, a token typed after a replayed queue reached nowhere with no P-G toast, not isolated. Seed 36: a queued Delete was applied between editor-pane characters, not isolated. Table cells: Delete at a cell's end deletes the first character of the next cell (Chromium). The P-C first-block case with an editor insertion at the top (CHA-3 / CHA-4, deferred).
- verify-session-pointer: a possible K5-uncovered rendering change over a selection from an item into its nested item ('- top AXb⏎  - - deep Ccc', v5-ptr-pastecross nest-into); PTR-1 to PTR-4 not compared with pre-r3.
- Heap after many edits against 0.1.1 (the step ring) and per-keystroke cost of the ring with the switch off: read, not timed by the verifiers (my P5 with the switch off equals 0.1.1).

## Decoder verdict

Reads and saves are at least as good as 0.1.1 in the shipped runtime. My own run: MDR_APP_DIR=release/staging-0.2.0.noindex SEEDS=100 node bench/electron/v4-dec-diff.mjs inside the Electron 44.4.3 main process (ICU 78.2, 7.8 s): verdict OK; 6 307 inputs, readDiff 0, dormantReached 0; 45 138 saves, saveWorse 0, saveSameCountDiff 0, newRefusal 0 (696 saves change fewer bytes than 0.1.0: the K7 WHATWG Shift_JIS / Big5 table rule); 252 real files through readFileInfo / writeFileAtomic, 0 failures. verify-off-desktop: r3-d-parity 242 920 inputs with 0 read differences and 0 worse saves, 50 files in 10 encodings identical. electron/ is unchanged apart from the menu label.

## Notes on the verifiers' scripts

- v5-ptr-*.mjs default MDR_SCRATCH to a v5-ptr folder in the session scratch directory; I deleted it after my runs.
- v5-offa-r6.mjs needs MDR_TMP (it creates and removes its own temporary folder there); v5-offk-save.mjs needs MDR_OFFK_TMP.
- v5-sw-off.mjs needs a dev server for the candidate (the hooks); bench/verify/v5-cfm-dps.mjs checks SW-1 on a production build without hooks.
- fix2-int-p5.mjs needs a static server that redirects / to ?perf=1 (r4-int-perfserve.mjs or my v5-cfm-perfserve.mjs, which can also store the switch off).
- v5-rev-staletoggle.mjs at holdMs 0 is timing-dependent (6 of 9 failing here); holdMs 1500 is the deterministic form.
