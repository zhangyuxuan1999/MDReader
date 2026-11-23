# 0.2.0 release candidate — fix round 5 confirmation, r5 findings (2026-11-23)

Fix round 5 (stage 2f) repaired the three groups that blocked the release after round 4:
- N1: Chromium's own joins corrupted atoms.
- N2: percent-escaped invisible characters were written raw.
- N3: the editing code was loaded at start with the switch off.

Five agents then attacked the integrated candidate at the same time, on a loaded machine:
- two regression runners: regress-session (switch on) and regress-off (switch off);
- three targeted verifiers: verify-off, verify-on and verify-review.

They reported 4 findings (VON-1, VR-1, VR-2, VR-3) and 14 older defects.

I am the confirm agent. I worked alone on the quiet machine. I re-ran every repro myself, re-ran the three repairs, and ran the whole unit suite and the performance spec once each.

Ports:
- Candidate: 5488, a vite preview of release/staging-0.2.0.noindex/dist.
- 0.1.1: 5498, a vite preview of release/baseline-0.1.1.noindex/dist.
- The tree's dev server: 5489.

For "older than round 5" I used a self-contained copy of the tree with src/ from release/pre-r5.noindex. It had its own bench/ and test/, a link to node_modules, and fs.allow set only in the copy. It was served on 5489 while the tree's server was stopped.

## Verdict by the release gate

**(1) The configuration that ships, 预览可编辑 off by default: MET.**
- No high.
- No regression of medium or above against 0.1.1 that round 5 introduced or that is a failure of a repair.
- N3 is repaired by the lead's restated criterion. The editing chunk is never requested with the switch off. On the quiet machine the time to the editor is 1.05 of 0.1.1's at 10 Mbit/s, 1.07 at 4 Mbit/s, and level without throttling (56 against 58 ms).
- All four findings need a session (switch on).

The older switch-off items are under "Older defects". I checked each for a hidden high and found none. Two of them need the lead's attention:
- The `<?form>` sanitizer throw: the same in 0.1.1; I rate it medium.
- The editor scroll after a tick: older than round 5, next to the decided OFFD-4.

**(2) The experimental feature, switch on: NOT MET.** There is one high group.

**M1 (high; VON-1 + VR-1).** A session still writes raw invisible characters into the file that the user did not type and cannot see. Round 5 repaired the URL writers; these paths are outside them:
- the TEXT of a bare URL or autolink that the user edits, whose percent-escapes the worker decoded for display;
- every character reference of an invisible character (`&#x202e;`, `&shy;`, `&#x2060;`, `&zwnj;` …) in text, an image alt, a link title or a raw HTML attribute, on ANY edit of the block.

The effect is exactly N2's; only the paths differ. Both are older than round 5: the pre-r5 serializer does the same or worse. But a high counts against the gate whatever its age (lead, late notes of 2026-11-22).

Two medium defects of the experimental feature become README limits once M1 is fixed, or are fixed together with it:
- M2 (VR-2): U+FFFC is let through raw in a URL. Older than round 5.
- M3 (VR-3): ⌘B or ⌘I on part of a document's own styled `<span>` is undone when the session ends. Introduced by round 5 (fix-atoms N1, rule P-G (c)).

Introduced by fix round 5: M3 only (medium, switch on). The three repairs held on the quiet machine. No unit test failed outside a finding.

## The three repairs (re-run by me on the quiet machine)

| group | status | evidence |
|---|---|---|
| N1 | fixed | Tree dev server 5489. v5-ptr-mergeatoms 11/11 (round 4: 3/11). v5-ptr-u23atoms 13/13 (round 4: 5/13). v5-keys-probe task- 7/7 ok, with the screen equal before and after: task-del-join `- [ ] task a task b`; task-del-join-plain-first `- plain a task b`; task-bs-join-three `- [ ] one two⏎- [ ] three`. test/v5-keys-taskjoin.test.ts 3/3. |
| N2 | fixed (for what N2 described) | test/v5-rev-autolink.test.ts 31/31. J19 cases of test/v5-rev-serial.test.ts 23/23. v5-rev-autolink.mjs MDR_RUNS=2 on 5489: 12 ok, 0 failing (auto-nbsp keeps %C2%A0). The class is not closed: M1 and M2 are further paths of the same effect. |
| N3 | fixed | See the sizes and cold start below. r5-pl-noload as a real user (nothing stored) and with ?perf=1 and '0' stored: editReqs 0, no editing element, exit 0. |

Sizes, raw / gzip -9:

| script | candidate | 0.1.1 |
|---|---|---|
| Main script | index-CHpgOa3C.js 404673 / 146106 | index-BP8hzxzG.js 380008 / 136474 |
| Lazy chunk | inlineEdit-DgxRjbYH.js 246177 / 90636 | – |
| render.worker | 303761 / 114256 | 303900 / 113655 |
| All scripts | 121 files, 2566653 / 922104 | 120 files, 2294102 / 820901 |

The round-4 candidate's main script was 643065 / 233230. index.html names only theme-boot.js, the main script, the modulepreload dist-CmsYx2-I.js and the CSS.

Cold start, bench/verify/v5-offa-cold.mjs, switch off, candidate against 0.1.1, alternating runs:

| network | runs | candidate tEditor | 0.1.1 tEditor | ratio |
|---|---|---|---|---|
| 10 Mbit/s | 3 | 313 [313, 310, 333] | 299 [299, 299, 314] | 1.05 |
| 4 Mbit/s | 3 | 649 [635, 652, 649] | 604 [595, 606, 604] | 1.07 |
| unthrottled | 5 | 56 | 58 | 0.97 |

0.1.1 against itself at 4 Mbit/s gave 620 / 628 (0.99). JS received before the editor: 247510 against 237865 bytes.

## Machine and candidate (step 0)

- Nothing left running by the runners and verifiers. No listener on 5461 to 5498 or 5199, no Electron of this project, no vitest, no headless Chromium. I ended nothing.
- npx tsc --noEmit: exit 0. scan-invisible: OK.
- diff -rq of electron/ and dist/ against release/staging-0.2.0.noindex: empty. package.json identical. No file of src/ is newer than dist/index.html.
- /Applications/MDReader.app is version 0.1.1 (Info.plist read only, not launched).
- 11 Electron crash reports at my start and at my end; the newest is Electron-2026-11-20-145455.ips. I launched no Electron.

## Summary table

| group | severity | class | introduced by | switch | findings | title |
|---|---|---|---|---|---|---|
| M1 | high | new-feature-defect | older than round 5 | on | VON-1 (reproduced), VR-1 (reproduced) | Text and attribute writers write invisible characters raw, whatever the source wrote |
| M2 | medium | new-feature-defect | older | on | VR-2 (reproduced) | rawInUrl lets U+FFFC (drawn with no ink) stand raw in a URL without a source spelling |
| M3 | medium | new-feature-defect | fix round 5 (fix-atoms N1, P-G (c)) | on | VR-3 (reproduced) | Un-bold or un-italic on part of a styled raw span is undone at Esc |

## Groups

### M1 [high] Text and attribute writers write invisible characters raw

**What goes wrong for the user.** The switch must be on. There are two paths.
- **VON-1.** The user fixes a character inside a bare URL or autolink whose source holds a percent-escaped invisible or blank character. The worker shows that character decoded in the link text. After the edit the session writes `[text](dest)`, and the text holds the raw character.
- **VR-1.** A block holds an invisible character written as a character reference. The user types one letter anywhere else in the block, and the reference becomes the raw character.

The file then holds a character the user did not type and cannot see; the editor has no highlightSpecialChars. U+202E reverses the text that follows it in other renderers. The href and the rendering do not change.

**Root cause.** Rule J19 extended (rawInUrl, sourceUrls, urlText) covers only the URL texts. These writers still write the DOM's characters as they are:
- escapeSegment, and therefore the `[text](dest)` fallback of mdrLink;
- mdrImage's alt and title;
- openTag's attribute values.

**Repro.**
- Unit: `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v6-von-linktext.test.ts` and `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v6-vr-entity.test.ts`.
- Browser, VON-1, tree: `MDR_PORT=5489 MDR_BASE_PORT=5498 node bench/verify/v6-von-linktext.mjs` (dev server of the tree on 5489).
- Browser, VON-1, candidate: the same command with `MDR_PERFQ=1 MDR_PORT=5488`.
- Browser, VR-1, candidate: `MDR_PORT=5488 MDR_RUNS=3 node bench/verify/v6-vr-entity.mjs`.

**Observed.**
- v6-von-linktext unit: 48 of 57 fail. Example: `See [https://e.example/Za<U+202E>b](https://e.example/a%E2%80%AEb) here`. The 9 passing cases are U+200B and U+FEFF (dropped from the text) and U+00A0 (written `&nbsp;`).
- v6-von-linktext browser: tree 10/20 and candidate 10/20. Every 'middle' case fails (U+202E, U+200E, U+200C, U+00AD, U+3000, bare and autolink); every 'end' case passes.
- v6-vr-entity unit: 66 of 70 fail.
- v6-vr-entity browser, candidate, 3 runs: 21/21 FAIL. Example: `- Lead a&#x3164;b here` became `- Lead a<U+3164>b here` with the typed X.

**Expected.** No stay-escaped character appears raw unless the source held it raw. The reference stays, or the character is written as `&#x…;`, which renders the same.

**Baseline.** Not applicable (0.1.1 has no in-preview editing). Before round 5, measured: the pre-r5 serializer writes the same (VR-1) or worse (VON-1: raw in the text and in the destination). On my pre-r5 copy, v6-von-linktext passes 0/20 and v6-vr-entity fails 7/7.

**Verdict.** Both reproduced, deterministic, both high: "written into the source, not typed, not visible". This is the same effect as N2 and CA-1.

**Suspected file.** src/preview/serialize.ts. Suggested fix: record at begin() which stay-escaped characters the source holds raw, and write every other one as `&#xHHHH;`, reusing rawInUrl's category test. Alternatively, refuse such blocks at the start.

### M2 [medium] U+FFFC stands raw in a URL without a source spelling

**What goes wrong.** The switch must be on. A link whose href holds %EF%BF%BC and has no source spelling in the block is written with a raw U+FFFC on the block's first edit. Such links are a reference link defined in another block, a link made or split in the session, a destination with an entity or a backslash escape, and an href spelled two ways. Chromium draws U+FFFC with no ink, about 0.3 px wide.

**Root cause.** BLANK_GLYPHS lacks 0xFFFC.

**Repro.**
- Unit: `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v6-vr-predicate.test.ts -t "FFFC, drawn"`. The verifier's filter `-t "U+FFFC"` matches nothing, because `-t` is a regular expression and `+` is special in it.
- Browser: `MDR_PORT=5488 MDR_RUNS=3 node bench/verify/v6-vr-fffc.mjs`.

**Observed.** Unit: tree and pre both write `See [r](https://e.example/a<fffc>b) words`. Browser: 3/3 FAIL, with ink width 0.3125.

**Baseline.** Not applicable. Pre-r5 writes the same raw character (1/1 on my copy).

**Verdict.** Reproduced; medium, as rated. The trigger is very narrow, as with CA-2. It is one number to add, best fixed with M1.

### M3 [medium] Un-bold or un-italic on part of a styled raw span is undone at Esc

**What goes wrong.** The switch must be on. The user presses ⌘B on "heavy" inside `<span style="font-weight:bold">heavy words</span>`. The session shows "heavy" at weight 400. Esc writes `Para <span style="font-weight:bold">heavy</span> <span style="font-weight:bold">words</span> end text`, so "heavy" is bold again. Italic behaves the same. Nothing is lost, but the command is silently discarded.

**Root cause.** Chromium splits the span, copies the data-mdr-ps stamp to both parts, and sets `style=""` on the selected part. presentationAsPrepared then writes the recorded style over it.

**Repro.**
- Unit: `perl -e 'alarm 60; exec @ARGV' npx vitest run test/v6-vr-presentation.test.ts`.
- Browser: `MDR_PORT=5488 node bench/verify/v6-vr-bold.mjs`.

**Observed.** Candidate, 3 of 3 runs: unbold-span 'before=700 in-session=400 after-Esc=700'; unitalic-span 'after-Esc=italic'. Unit test: 2/2 fail.

**Baseline.** Not applicable. The pre-r5 copy passed both cases in 3 of 3 runs ('after-Esc=400', source `Para <span style>heavy</span> …`). So this is introduced by round 5.

**Verdict.** Reproduced, deterministic, medium.

**Suspected files.** serialize.ts (presentationAsPrepared) and inlineEdit.ts (restamp after a session format command).

## Older defects (not counted against the gate; for the work after 0.2.0)

**`<?form>` in raw HTML (regress-off; re-run by me).** A raw-HTML block holding a processing-instruction-like `<?form>` makes DOMPurify throw 'Illegal invocation'. That block, the first paragraph and the blocks after it in the same chunk show empty until an edit.
- Measured with `MDR_PORT=5488 MDR_BASE_PORT=5498 node bench/verify/v6-ro-pi.mjs`: blocks ["","","after"] with two page errors on BOTH builds.
- v6-ro-piwait: 10 empty after 4 s, 1 after an edit, on both builds.
- Pre-existing. I rate it medium, not high: the document opens, the editor shows it whole, nothing is lost, an edit restores the preview, and the trigger is a malformed processing instruction outside a code block.

**Editor scroll after a tick (verify-off; re-run by me).** Commands:
- `node bench/verify/v6-vo-gest.mjs 5488 <c.json> C`
- `node bench/verify/v6-vo-gest.mjs 5498 <b.json> C`
- `node bench/verify/v6-vo-gest.mjs cmp <c.json> <b.json>`

Observed: 12 of 13 gestures differ only in the editor's scrollTop (candidate 12 or 38; 0.1.1 1506, 321, 295 or 234). Source and box states are the same. It was already in the round-4 candidate, so it is older than round 5. It is the editor side of the decided OFFD-4 (the preview no longer jumps after a tick). It is low or medium depending on whether the lead counts it as part of OFFD-4; it is not high.

**Copy focus race (verify-off).** Candidate 8/48, 0.1.1 7/48. It explains the integrator's one v5-offk-copy difference.

**v2-ses-resume p-shift-arrow (verify-on).** A resume-window race older than round 5: pre-r5 build 2/50, candidate 0/50. My 30 runs on the quiet machine (10 first runs after a fresh vite preview start, 20 warm): 30/30 pass.

**regress-session.**
- v2-ses-fuzz seed 736 caret check: tree 4/4, pre-r5 3/3.
- v5-keys-fuzz seed 1 C5: tree 8/10, pre-r5 5/10 (timing).
- v5-keys-fuzz seed 4: flaky.
- r5-ca-joins set 6 bs-enter leaves a stray `-` item: also on pre-r5.
- The v5-keys scripts stop at their 110 s timeout on both trees.

**verify-on.** All low and the same on pre-r5:
- U23 after a join in an item holding a quote, or under three levels of nesting.
- Backspace at a task text start first removes only the space.
- An emptied styled span, typed into, writes `&nbsp;`.
- With every re-render held 1.5 s, a click right after Esc starts no session.

**verify-review.** A `<b>` from ⌘B is written `**` (K5, same on pre-r5).

## Whole unit suite

`npx vitest run --no-file-parallelism`, once, on the quiet machine:
- 139 files, 4051 tests: 3928 passed, 6 expected fail (K22, K24), 117 failed, 154.4 s.
- Every failure belongs to a finding:
  - v6-von-linktext: 48 (VON-1)
  - v6-vr-entity: 66 (VR-1)
  - v6-vr-predicate: 1 (VR-2)
  - v6-vr-presentation: 2 (VR-3)
- Unexplained: 0. The jsdom timing case of v5-rev-serial passed in this run.

## Performance

`npx playwright test`, once: 1 passed in 58.1 s. Every budget met:

| metric | value | budget |
|---|---|---|
| P1 | 109.8 ms | < 400 |
| P4 longest task | 0 | |
| P4 tasks > 50 ms | 0 | |
| P5 p95 | 27.1 ms | < 30 |
| P5 max | 30.6 ms | < 60 |
| P5 key to mount p95 | 35.0 ms | < 40 |
| P8 | 0.4 % | < 3 |
| P11 | 0.0 ms | < 5 |

P5 against 0.1.1 (fix2-int-p5, v5-cfm-perfserve, 3 alternating rounds), per run:

| build | raw p95 (ms) | adjusted p95 (ms) |
|---|---|---|
| Candidate, switch on | 24.6 / 24.0 / 23.4 | 22.1 / 21.8 / 21.0 |
| 0.1.1 | 25.8 / 25.8 / 26.5 | 25.8 / 23.3 / 24.1 |
| Candidate, switch stored off | 24.8 / 26.9 / 27.3 | 24.8 / 26.9 / 25.2 |

Key to mount p95 was 33.8 to 34.9 ms on all three. Level with 0.1.1.

## What the runners and verifiers attacked without breaking it

**regress-session.**
- About 120 standing switch-on scripts, each compared with the pre-r5 number or a pre-r5 copy: none got worse. v5-ptr-enterbs is 96/133 against 77/133 before.
- N1 and N2 in the standing lists.
- The lazy chunk on the production build (r5-pl-*, r5-fl-loading, r5-rl-races 148 checks, v5-sw-default).
- 242 fuzzer runs: 240 OK; the 2 failures are older.
- The fidelity gate: 2105 blocks, 8 refused, 0 written.

**regress-off.**
- The complete switch-off standing comparison against 0.1.1 (offc-probes 160, offd-matrix 2126, offd-fuzz 30, offp, offa, upgrade 9 profiles, fx 23, atp 50): no new difference.
- No unclicked tick.
- The chunk was requested only by cases that toggle the switch (about 70 minutes of request logging).

**verify-off.**
- A real user's day with the switch off: 0 chunk requests.
- 61 gestures and 15 byte-exact copies equal 0.1.1.
- The stand-in, the chunk held and arriving (120/120), and the failures with RL-1.
- Desktop: r4-rel-desk, r5-pl-desk, r5-rl-desk, v5-sw-desk and v6-vo-desk.
- v5-sw-off on the production build.

**verify-on.**
- N1 as a class: 324 new cases, plus 11/11 x 3 as a real user.
- Stamps are kept off the clipboard; refusal mid-session behaves.
- Raw document checkboxes are kept.
- 482 real-document URL cases.
- 25 fresh fuzz seeds.
- p-shift-arrow characterized.

**verify-review.**
- Every switch-off line of the diff read.
- The stand-in, member by member.
- The loader: one instance, no unhandled rejection.
- Stamps (15/15).
- rawInUrl over all code points and 210 444 destinations.
- A 19 478-case differential against pre-r5.
- No test expectation weakened.

## What nobody covered

- Real IME, touch, Firefox, Safari, iPad and VoiceOver.
- The real Cloudflare deployment: routes were simulated.
- Desktop sessions with the switch on.
- bench/electron/v5-offk-copy.mjs: not run, because of the risk to the user's real system clipboard; the headless race explains the difference.
- M1's other gestures through the same fallback (Backspace in a URL text, bold or cut on part of it, e-mail autolinks, www links), and the entity case in cells, headings and named references in the browser: unit tests only, or not measured.
- r5-ca-joins atom sets other than 0 and 6; offd-matrix on dev; v5-atp-desk; the tails of the v5-keys scripts.
- The ink scan covers this machine's fonts only.
