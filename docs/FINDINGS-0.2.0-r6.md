# 0.2.0 release candidate — fix round 6 confirmation, r6 findings (2026-11-23)

Fix round 6 (stage 2g) repaired the three groups that the round-5 verification left open. It changed only the editing chunk: src/preview/serialize.ts, inlineEdit.ts and fidelity.ts.
- M1 (high): a session wrote raw invisible characters that the source spelled as a character reference, or as a percent-escape in a bare URL or autolink. The repair is rule S and the guard, then B1 to B4 after the challenge (rule T among them).
- M2 (medium): U+FFFC passed the URL predicate although it is drawn blank.
- M3 (medium, introduced by round 5): a bold or italic command on part of a document's own styled span was undone when the session ended.

Two regression runners (regress-a, regress-b) and one targeted verifier (verify-refs) then worked on the final tree and the new candidate at the same time, on a loaded machine. They reported 2 findings (VF-1, VF-2) and 10 older observations.

I am the confirm agent. I worked alone on the quiet machine. I re-ran every repro and the three repairs, redid the build comparison, and ran the whole unit suite and the performance spec once each.

Ports:
- Round-6 candidate: 5488, release/staging-0.2.0-r6.noindex/dist served by bench/verify/v5-cfm-perfserve.mjs (which adds ?perf=1).
- 0.1.1: 5498, release/baseline-0.1.1.noindex/dist on the same server.
- The tree's dev server: 5489. For the P5 comparison only, 5489 first served the round-5 candidate (release/staging-0.2.0.noindex/dist).

For "introduced by round 6" I used a self-contained copy of the tree:
- src/ from release/pre-r6.noindex, with its own bench/, test/, test-data/ and public/;
- a link to node_modules, and its own Vite configuration (fs.allow and cacheDir in the copy only);
- served on 5489 while the tree's server was stopped, with the scripts run from inside the copy.

I checked that it served the pre-round-6 serializer: the served serialize.ts has no `spelledHidden`, and the tree's has it.

## Verdict by the release gate

**(1) The configuration that ships, 预览可编辑 off by default: MET.**
- SCOPE holds. The candidate is the round-5 candidate file for file, except the editing chunk and the hashed names that follow from it. So the switch-off configuration is the one round 5 verified and passed.
- No finding shows with the switch off.

**(2) The experimental feature, switch on: MET.**
- No high. M1, M2 and M3 are repaired, and their defining tests pass on the quiet machine.
- Two defects introduced by round 6 remain. Both need the switch on and become README limits:
  - P1 (VF-1, medium): Backspace at the start of a paragraph below a block that rule T refuses writes the join. Then the session ends with the toast, and what the user types next is lost.
  - P2 (VF-2, low): a bold or italic command on part of a span styled with the CSS `font` shorthand writes that span's style as twelve longhand declarations.

None of the older observations is high.

## The repairs (re-run by me on the quiet machine)

| group | status | evidence |
|---|---|---|
| M1 | fixed | Unit: test/v6-von-linktext.test.ts 57/57 (round 5: 48 of 57 failed) and test/v6-vr-entity.test.ts 70/70 (66 of 70 failed). Browser: `MDR_PORT=5489 MDR_BASE_PORT=5498 node bench/verify/v6-von-linktext.mjs` gives 20/20 on the tree, and 20/20 on the candidate with `MDR_PERFQ=1 MDR_PORT=5488` (round 5: 10/20). `MDR_PORT=5488 MDR_RUNS=3 node bench/verify/v6-vr-entity.mjs`: RESULT PASS bad=0 (round 5: 21/21 FAIL); the tree gives RESULT PASS bad=0 too. Example: in `Lead a&#x2060;b here` the reference stays and only the typed X is added. |
| M2 | fixed | test/v6-vr-predicate.test.ts 4/4, including 'U+FFFC, drawn blank'. `MDR_PORT=5488 MDR_RUNS=3 node bench/verify/v6-vr-fffc.mjs`: RESULT PASS bad=0; the destination stays `a%EF%BF%BCb` in all 3 runs (round 5: 3/3 FAIL). |
| M3 | fixed | test/v6-vr-presentation.test.ts 2/2. `MDR_PORT=5488 node bench/verify/v6-vr-bold.mjs`, 3 runs: RESULT PASS bad=0 each. unbold-span: before=700, in-session=400, after-Esc=400, source `Para <span>heavy</span> <span style="font-weight:bold">words</span> end text`. unitalic-span: after-Esc=normal. unbold-b-styled is n/a: that block starts no session, as before. |
| SCOPE | holds | `node bench/verify/v7-cfm-cmpbuild.mjs release/staging-0.2.0.noindex/dist dist`: 183 against 183 files. 170 are byte-identical. 12 are identical once hashed names are masked: index.html, the main script index-CHpgOa3C.js → index-D5utrUGr.js, and 10 dist-*.js chunks that import it by name. One differs in content: inlineEdit-DgxRjbYH.js → inlineEdit-Bdo_pBmz.js (246177 → 253610 bytes). No file is on one side only. I also built the tree into my scratch directory: `diff -rq` against dist/ is empty, so dist/ is the tree's build. dist/, electron/ and package.json equal release/staging-0.2.0-r6.noindex. |

## Machine and candidate (step 0)

- Nothing was left running by the runners and the verifier: no listener on 5461 to 5498 or 5199, no Electron of this project, no vitest, no headless Chromium. I ended nothing.
- npx tsc --noEmit: no output, exit 0. node bench/verify/scan-invisible.mjs: OK.
- diff -rq of electron/ and dist/ against release/staging-0.2.0-r6.noindex: empty. package.json identical.
- release/staging-0.2.0.noindex is untouched: shasum -c against the lead's staging-r5.sha gives 192/192 OK, and the directory holds 192 files.
- /Applications/MDReader.app is version 0.1.1 (Info.plist read only, not launched).
- 11 Electron crash reports at my start and at my end; the newest is Electron-2026-11-20-145455.ips. I launched no Electron.

## Summary table

| group | severity | class | introduced by | switch | findings | title |
|---|---|---|---|---|---|---|
| P1 | medium | new-feature-defect | fix round 6, rule T (B4) | on | VF-1 (reproduced) | Backspace merge into a rule-T block ends the session; the keys typed next are lost |
| P2 | low | new-feature-defect | fix round 6, M3 (afterFormat) | on | VF-2 (reproduced) | Bold or italic on part of a `font`-shorthand span writes twelve longhand declarations |

## Groups

### P1 [medium] Backspace merge into a block that rule T refuses ends the session; the keys typed next are lost

**What goes wrong for the user.** The switch must be on. The setup is a paragraph with raw HTML that the sanitizer changes (an embedded iframe, a script, a link with an onclick or a javascript: href), and a paragraph below it. The user edits the lower paragraph, presses Backspace at its start to join it to the one above, and goes on typing.
- The join is written into the source, and the raw HTML is kept verbatim.
- Then the toast 此块请在源码中编辑 appears and the session ends.
- Every key typed after that is lost until the user clicks again.

Nothing already in the document is lost.

**Root cause.** tryMergeBackward (src/preview/inlineEdit.ts) checks the previous block only with onlyParagraph and unsupportedReason, not with rule T. It writes the merged text through replaceSource and resumes a session on the merged block. That session's begin() runs startAllowed, and its sanitizerKept test refuses the merged block, so the session ends after the write.

**Repro.**
- `MDR_PORT=5489 node bench/verify/v7-vf-tmerge.mjs` (a Vite dev server of the tree on 5489). The candidate build on 5488, through v5-cfm-perfserve, gives the same.
- `MDR_PORT=5489 node bench/verify/v7-vf-rulet.mjs merge` shows the same for more kinds of raw HTML.

**Observed.**
- Tree, 3 of 3 runs, and candidate, 1 of 1, for each of the three rule-T cases: `ruleT-iframe: session=true joinWritten=true toast=1 liveAfter=false typedWritten=false guard=0 source="视频 <iframe src=\"https://www.youtube.com/embed/abc\"></iframe> 说明文字下面一段文字\n"`. ruleT-onclick and ruleT-script are the same.
- The two controls write the typed text: control-plain gives `普通的上一段文字QR下面一段文字`, and gate-trailing-emsp gives `段落中间&emsp;引用，结尾&emsp;QR下面一段文字`.
- v7-vf-rulet merge: RESULT bad=6 of 8. The 6 are iframe, script, onclick, jslink, a custom element and style. The form block takes no join, and the iframe block with a caption is ok.
- A full v7-vf-rulet run reached 44 cases before its 110 s cut-off, and only the merge-from-below cases are BAD. Click, double click, paste, tick, Delete from above and the arrow keys all keep the source and the session.

**Expected.** Rule T keeps the source untouched whatever the user tries. So the join into a refused block should itself be refused: nothing written, the toast, and the session kept in the lower paragraph so the typing lands there. At the least, keys typed after the join must not be dropped silently.

**Baseline.** 0.1.1 has no in-preview editing, so it does not apply. My pre-round-6 copy gives `ruleT-iframe: … joinWritten=true toast=0 liveAfter=true typedWritten=true source="视频 说明文字下QR面一段文字\n"`. The session goes on and QR is written, but the iframe, the onclick and the script are deleted from the source. That is the class rule T closes, and the lead rates it high. Round 6 replaced a silent deletion with a visible refusal that comes one step too late.

**Verdict.** Reproduced, deterministic (4 of 4 per case). Medium, as rated: a core gesture visibly misbehaves and typed keys are lost. But the document loses nothing, the toast is visible, and the trigger is a paragraph right after embed-like raw HTML. Introduced by round 6, rule T (B4).

**Suspected file.** src/preview/inlineEdit.ts (tryMergeBackward). Suggested fix: before writing, apply startAllowed's rule-T test to the previous block (sanitizerKept on its content, plus the test for a link or image without a URL). When it fails, refuse the join (nothing written, the toast) and keep the current session with the caret at its start.

### P2 [low] Bold or italic on part of a `font`-shorthand span writes twelve longhand declarations

**What goes wrong for the user.** The switch must be on. The source holds a raw span styled with the CSS `font` shorthand, for example `<span style="font: bold 16px serif">简写粗体 here</span>`. The user selects 简写 and presses ⌘B to un-bold it. The session writes the selected half with a long run of CSS the user never wrote.

The same happens in two more cases:
- the toolbar 斜体 un-italicizes part of `font: italic 15px serif`;
- ⌘B bolds part of a plain `font: 15px serif` span.

In every case the screen after Esc equals the session, and nothing is lost.

**Root cause.** afterFormat (src/preview/serialize.ts, M3) takes the recorded font-weight or font-style off the recorded style with CSSOM removeProperty. When the record uses the `font` shorthand, removing one longhand expands the shorthand into all its longhands. In the bold-a-plain-part case the command did not change that property on the element at all, yet the record is still edited.

**Repro.** `VERBOSE=1 MDR_PORT=5489 node bench/verify/v7-vf-m3.mjs 'shorthand'` (a dev server of the tree on 5489; `MDR_PORT=5488` for the candidate).

**Observed.** RESULT bad=3 of 3, in 3 of 3 runs on the tree and 1 of 1 on the candidate. shorthand-unbold writes:

`前文 <span style="font-style: normal; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 16px; line-height: normal; font-family: serif;">简写</span><span style="font: bold 16px serif">粗体 here</span> 后面 words`

shorthand-bold-plain-part writes the same twelve longhands around `**简写**`. unitalic-toolbar-shorthand writes twelve longhands with `font-weight: normal` in place of `font-style`. look=true in all three.

**Expected.** The user's command written in the source's own terms. For the un-bold, for example `<span style="font: 16px serif">简写</span>`. For bolding a plain part, `<span style="font: 15px serif">**简写**</span>`.

**Baseline.** 0.1.1: not applicable (new feature). My pre-round-6 copy gives bad=2 of 3.
- Un-bold and un-italic are the M3 defect itself: the shorthand is written back on both halves and the command is undone (look=false).
- Bolding part of `font: 15px serif` writes `<span style="font: 15px serif">**简写**</span>` cleanly (ok).

So round 6 repaired the first two cases with a verbose spelling, and made the third worse.

**Verdict.** Reproduced, deterministic. Low: the source gets visible text the user did not write, but it renders the same, nothing is lost, and the `font` shorthand is rare in Markdown inline styles. Introduced by round 6, M3 (afterFormat).

**Suspected file.** src/preview/serialize.ts (afterFormat). Suggested fix: when the recorded weight or style comes from the `font` shorthand, edit the shorthand's value (drop `bold` or `italic`) instead of calling removeProperty on a longhand. Leave the record unchanged when the command did not change that property on the element.

## Older defects (not counted against the gate; for the work after 0.2.0)

I read every older line for a hidden high and found none.

Re-run by me:
- **v6-von-life 15/18** (regress-b). The tree and the pre-round-6 copy both fail the same three cases:
  - img-bs leaves `Pic after` with one space where the script wants two;
  - merge-into-list does not join, which is a no-op;
  - held-esc is the accepted case where a click right after Esc, while a re-render is held, starts no session.

  Low, all older. Repro: `MDR_PORT=5489 MDR_BASE_PORT=5498 node bench/verify/v6-von-life.mjs`.
- **Copy or cut in a session, then paste into another block, writes the decoded invisible character raw** (verify-refs): U+00AD from `&shy;`, U+200C, and U+202E from a bare URL's %E2%80%AE. 4 of 4, identical on the tree and the pre-round-6 copy. The guard counts the paste as the user's input. The user did paste it, and what the browser copies is the rendered text, so I keep it low. I did not measure a 0.1.1 equivalent (copy from the preview, paste into the editor). Repro: `MDR_PORT=5489 node bench/verify/v7-vf-sneak.mjs '^(copy-paste-other-block|cut-paste-other-block|copy-paste-persian|copy-url-text-paste)$'`.

Taken from the agents as reported, without a re-run by me. All low or harness timing:
- v2-ses-fuzz seed 1 --large: 'caret not in editing block' at op 0 under load, the same on pre-round-6. This is timing.
- v6-von-taskbs 0/4 on both trees: the accepted Backspace at a task text start.
- Blocks refused at the start with the toast, the same on pre-round-6 (S4 keeps them refused):
  - table cells ending with a space-like reference;
  - an `&emsp;` next to a raw em space at a paragraph end;
  - a heading starting with a raw U+3000 next to a reference;
  - a heading with `&zwj;` and a formula.
- Raw space-like characters at a table cell's edge are dropped on edit. markdown-it trims them, so the rendering is the same.
- A raw relative `<a target="_blank">` is rewritten as a Markdown link and loses its target.
- A paragraph beginning with an inline raw HTML tag cannot be edited; the README's HTML-block line covers it.
- Raw HTML used in prose stays refused, the same on pre-round-6 (so not rule T): `<del>`/`<ins>`, `<b>` and `<i>` side by side, nested styled spans, a one-line `<details>`, `<center>`, `<p align>`.

## Whole unit suite

`npx vitest run --no-file-parallelism`, once, on the quiet machine:
- 152 files, 4742 tests: 4736 passed, 6 expected fail (the known ones), 0 failed, 228.8 s.
- The runners and the verifier added no test/v7-*.test.ts, so no repro case is expected to fail.
- Unexplained: 0. The jsdom timing case of v5-rev-serial passed in this run.
- The run wrote no file into the tree.

## Performance

`npx playwright test`, once (its own Vite on 5199): 1 failed in 57.2 s. One soft budget was missed by 1 ms:

| metric | value | budget |
|---|---|---|
| P1 | 135.2 ms | < 400 |
| P4 longest task | 0 | < 120 |
| P4 tasks > 50 ms | 0 | 0 |
| **P5 main per keystroke p95** | **31.0 ms** | **< 30 (missed)** |
| P5 max | 36.2 ms | < 60 |
| P5 key to mount p95 | 34.7 ms | < 40 |
| P8 | 0.0 % | < 3 |
| P11 | 0.0 ms | < 5 |

test-results/ was moved to my scratch directory.

P5 against 0.1.1 and the round-5 candidate: bench/verify/fix2-int-p5.mjs on the built dists, served by v5-cfm-perfserve, 3 alternating rounds, with the switch on by test mode:

| build | raw p95 (ms) | key to mount p95 (ms) |
|---|---|---|
| Round-6 candidate | 31.1 / 30.6 / 29.9 | 34.0 / 33.8 / 34.4 |
| 0.1.1 | 29.2 / 35.1 / 29.3 | 33.8 / 33.8 / 34.0 |
| Round-5 candidate | 28.5 / 31.9 / 29.6 | 34.0 / 34.1 / 33.8 |

The three builds are level. Today the machine is about 3 ms slower than at the integration, when 0.1.1 measured 26.2 to 27.6 ms with the same script. So the P5 miss comes from the machine, not from round 6: typing in the editor does not use the editing chunk, and the main script is round 5's apart from chunk names.

## What the runners and the verifier attacked without breaking it

**regress-a (switch on, first half of the standing lists).**
- 56 unit files (2951 tests) and about 80 Chromium scripts on the final tree with the guard hook: 153 runs counting reruns.
- Every number equals the pre-round-6 record. 17 v4-app scripts and 18 v4-sesa-probe probes were diffed line for line against a pre-round-6 copy. The only differences were noise: a v4-app-focus timing line, and CodeMirror console warnings that also appear on the copy.
- Long scripts ran to completion with a longer T_MS: r3-ia-empty 288/288, v4-sesa-atom 98/129, v4-sesa-gone 119/147, v4-sesb-pastesel 53/66.
- The guard fired 0 times in all 153 runs.

**regress-b (second half).**
- 246 runs on the tree (dev server) and on the new candidate's build, with 0.1.1 as the baseline, compared with the pre-round-6 table. Where a script was cut off, it was compared case by case against a pre-round-6 copy. No case got worse.
- In 245 counted runs the guard gave fired=0 starts=0.
- The shipped configuration never loads the chunk: r5-pl-noload editReqs 0, v6-vr-stamps' switch-off cases pass, and v5-sw-default passes 193/193.
- The round-6 repairs and the N1/N2 fixes hold: r6-cr-swap 0/8, mergeatoms 11/11, u23atoms 13/13, r5-fa-recreate 28/28.
- Fidelity walks are unchanged: gate 8, wrote 0.
- 99 fuzz runs: 98 OK. The one failure is the older v2-ses-fuzz 1 --large timing.

**verify-refs (targeted).**
- Rule S on documents as people write them (v7-vf-docs): 48 sessions over 6 documents, on the dev server, on the production build and as a real user. No raw invisible character was added.
- B1, the swap class (v7-vf-start swap and b1 sets): 0 reveals, against 25 on the pre-round-6 copy.
- Rule T over 70 kinds of raw HTML. All 32 that the sanitizer changes were refused with the source untouched; before round 6, 20 of them were silently changed. None of the 38 ordinary kinds is newly refused.
- A long life (v7-vf-long, 150 rounds per run): guard 0, toast 0, and every invisible character put in is kept.
- No write-path bypass in 29 gestures (v7-vf-sneak).
- S5 and N2 (v7-vf-links): 56 of 56 on both builds.
- M2: the U+FFFC row of v7-vf-links.
- M3: 16 of 19 styled-HTML cases are clean; the other 3 are P2.
- Differential: 320 of 320 sessions are byte-identical to pre-round-6. 150 more sessions on documents with hidden characters added 0 raw characters.
- 25 fresh fuzz seeds exit 0.
- Desktop round trip (bench/electron/v7-vf-desk.mjs on the r6 candidate): 8 of 8; the file on disk is the original plus the typed characters.

**confirm (me).**
- The four defining unit files and the four defining browser scripts, with 3 runs where the script allows it.
- The build comparison and a scratch rebuild of the tree.
- The whole suite, the performance spec, and P5 against two baselines.
- Both findings on the tree, the candidate and the pre-round-6 copy.
- v6-von-life and the cross-block paste on both trees.

## What nobody covered

- Real macOS IME, the system emoji picker and spell-checker replacement. Only CDP composition and insertText were used.
- The real system clipboard: only synthetic copy and paste events.
- Desktop: one round trip with the switch on; no desktop gesture matrix.
- P1 was measured with typing at 60 ms per key right after the Backspace. Other timings were not varied.
- Rule T for blocks whose reference definitions sit in another block (the integrator's open issue).
- A table cell `&emsp;苹果` that gave neither a session nor a toast on a click, on both trees (not investigated).
- Parts of the standing lists cut off by time: the r5-fa-joins and r5-ca-joins containers and atom sets not run, most header fuzzer seeds, and the tails of v5-ptr-pastesel and the v5-keys scripts.
- A pre-round-6 production build: the pre-round-6 comparisons ran on dev servers of a copy.
- Firefox, Safari, touch, iPad and VoiceOver.
