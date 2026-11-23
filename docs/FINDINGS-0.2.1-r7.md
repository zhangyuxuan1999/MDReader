# 0.2.1 release candidate — fix round 7 confirmation, r7 findings (2026-11-23)

Fix round 7 repaired exactly four things for version 0.2.1:
- R7 (switch off; N11 = OFFA-2 + OFFK-1 of FINDINGS-0.2.0-r4): replacing the document during its own save could lose the typed text. A replacement now waits for that save (at most 10 s; 4 s for 打开… and recent entries on the web). No draft is deleted while a save of its document is in flight.
- SAN (switch off; the processing-instruction block of FINDINGS-0.2.0-r5, identical in 0.1.1): a block that made the sanitizer throw left it and every later block empty. Such a block is now shown as the md-error box, and the others mount.
- P1 (switch on; VF-1 of FINDINGS-0.2.0-r6, medium): a Backspace merge into a block that rule T refuses wrote the join and then ended the session. The merge is now refused before anything is written, and the session stays.
- P2 (switch on; VF-2, low): bold or italic on part of a `font`-shorthand span wrote twelve longhands. The shorthand's own word is now edited.

fix-pre also moved every test that needs the old code onto the frozen copy test/fixtures/src-0.2.0, and made 导出 HTML of such a document succeed (exportBody). challenge-7 then attacked the repairs and found no high and no medium, only five lows (C7-1 to C7-5), all accepted at checkpoint J. The integrator built the candidate release/staging-0.2.1.noindex.

One regression runner for the switch-off configuration (regress-off) then ran the standing lists against 0.1.1 and against the released 0.2.0. It reported **no finding** and two older observations, both already accepted. The second verifier (verify-7) did not run in this round. That was a budget decision at checkpoint J; its attack on the candidate is deferred until the usage budget resets.

I am the confirm agent and I worked alone. I re-ran the four repairs. I ran the whole unit suite and the performance spec once each, plus P5 and the cold start against the released 0.2.0.

The machine was not fully idle. Processes of the user outside this project (an UnrealEditor and three Python processes, about one core each) kept running, with load about 4 at my start and 2.4 at the performance run. I did not touch them. Every timing comparison alternates the two builds, so both sides saw the same load.

Ports:
- Candidate 0.2.1: 5488, release/staging-0.2.1.noindex/dist. Served through bench/verify/r4-int-perfserve.mjs (adds ?perf=1) for the repairs, through bench/verify/v5-cfm-perfserve.mjs with `off` for P5, and under vite preview for the cold start.
- Released 0.2.0: 5498, release/baseline-0.2.0.noindex/dist, served the same way as the candidate in each comparison.
- 0.1.1: 5497, release/baseline-0.1.1.noindex/dist under vite preview.
- The tree's Vite dev server: 5489.

## Verdict by the release gate

**(1) The configuration that ships, 预览可编辑 off by default: MET.**
- There is no finding at all, so no high and no regression of medium or above against the released 0.2.0.
- R7 and SAN, the two switch-off repairs, hold on the candidate's build and on the candidate's desktop directory.
- regress-off found the candidate equal to 0.2.0 in the full gesture matrix (2126 cases), in 10 fresh fuzz seeds and in the real-user scripts.
- Against 0.1.1, its numbers equal the round-5 records or are better through R7 and SAN.
- The one accepted regression against 0.2.0 is C7-1 (low, desktop): an untitled 另存为 followed by closing the window and 不保存 leaves a draft offer for text that is already on disk. It is in the README.

**(2) The experimental feature, switch on: MET.**
- No high. P1 and P2 are repaired.
- C7-3 and C7-4 (low, the same in 0.2.0) stay as README limits.
- verify-7 did not run, so the built candidate got no switch-on attack beyond the defining scripts.

## The repairs (re-run by me)

| group | status | evidence |
|---|---|---|
| R7 | fixed | `MDR_PORT=5488 MDR_BASE_PORT=5497 MDR_TMP=<scratch> node bench/verify/v5-offa-r6.mjs fail-where-500 recent-same-500` (candidate dist vs 0.1.1): 2 same/ok, 0 differ. recent-same-500 asks no question; the reopened file shows `# S⏎typed` with the clean title `s.md`; the final disk is `# S⏎typedmore`. 0.1.1 asks, and its final disk is `# S⏎more`. fail-where-500: the draft holds `# S⏎typed`. The fixer's table on the tree, `MDR_PORT=5489 node bench/verify/r7-fs-table.mjs <prefix>`: 48 of 126 rows in 6 groups (open-500 5, recent-same 21, new-bound 6, drop-500 5, open-bound 6, recent-50 5), all same/ok. Desktop, `MDR_APP_DIR=release/staging-0.2.1.noindex node bench/electron/v5-offk-save.mjs`: 6 passed, 0 failed; reopen-same-during-save gives asked=false, tx1 `# R1⏎typed`, d2 `# R1⏎typedmore`. |
| SAN | fixed | `MDR_PORT=5488 MDR_BASE_PORT=5497 node bench/verify/v6-ro-pi.mjs`: RESULT PASS. The candidate shows `["before","渲染此段落时出错：Illegal invocation<p data-l=\"0\"><?form></p>","after"]` with 0 page errors. The same script with the released 0.2.0 on the candidate's port gives `["","","after"]`, 2 page errors, RESULT FAIL. `v6-ro-piwait`: candidate 0 / 0 / 0 empty blocks, 0 page errors; 0.1.1 10 / 1 / 1, 2 errors. `MDR_PORT=5489 node bench/verify/v4-tru-diff.mjs 20000 1` runs through all 20 000 documents (39 163 blocks): bypass 0, oldMiss 0, mismatch 0, threw 1 (the `<?form>` block, whose real HTML throws too), 0 page errors, RESULT PASS. |
| P1 | fixed | `MDR_PORT=5488 T_MS=400000 node bench/verify/v7-vf-rulet.mjs` (complete): RESULT bad=0 of 59. The 8 merge cases are kept=true and guard=0; 7 show toast=1, and form takes no merge, as before. `MDR_PORT=5488 node bench/verify/v7-vf-tmerge.mjs`: ruleT-iframe, onclick and script all give toast=1 liveAfter=true. The block above stays in the source byte for byte, and QR sits at the start of the lower paragraph, for example `视频 <iframe src="https://www.youtube.com/embed/abc"></iframe> 说明文字⏎⏎QR下面一段文字`. The script's joinWritten=true is its known artifact. control-plain and gate-trailing-emsp still merge. |
| P2 | fixed | `MDR_PORT=5488 T_MS=300000 node bench/verify/v7-vf-m3.mjs`: RESULT bad=0 of 19, guard 0. shorthand-unbold writes `font: 16px serif` for the un-bolded part. unitalic-toolbar-shorthand writes `font: 15px serif`. shorthand-bold-plain-part writes `**简写**` inside `font: 15px serif`. No longhands appear. |

## Machine and candidate (step 0)

- Nothing of this project was left running: no listener on 5461 to 5498 or 5199, no Electron of this project, no vitest, no headless Chromium. I ended nothing.
- `npx tsc --noEmit`: no output, exit 0. `node bench/verify/scan-invisible.mjs`: OK.
- `diff -rq` of electron/ and dist/ against release/staging-0.2.1.noindex: empty.
- /Applications/MDReader.app is version 0.2.0 (Info.plist read only, not launched).
- 11 Electron crash reports at my start and at my end; the newest is Electron-2026-11-20-145455.ips. My one desktop run (v5-offk-save on the candidate directory, through _electron.mjs) added none.

## Summary table

No group: the runners and the verifier reported no finding, and neither older observation is high.

## Older defects (not counted against the gate)

Both are accepted limits. I read them and did not re-run them.
- The copy race with the switch off: a copy from a preview range sometimes takes the editor's line (`# Gesture doc`). This happened on 10 of 72 copies with the candidate and 7 of 72 with 0.2.0, and 0.2.0 differs against itself too. Accepted in round 5. Repro: `node bench/verify/v6-vo-copyrace.mjs <candidate port> <0.2.0 port>`. Low: nothing is written into a document.
- A task tick clicked 0 to 20 ms after an edit can land on the LI or do nothing, without a toast, on both builds (0.1.1 gives WRONG there). This is the stated limit of the tick that does not wait. Repro: `MDR_PORT=<tree dev> node bench/verify/v5-ptk-ticks.mjs cand atk-enter-mid-small`. Low: the box simply does not flip.

## Whole unit suite

`npx vitest run --no-file-parallelism`, once:
- 159 files, 4846 tests: 4840 passed, 6 expected fail (the known K22 / K24 ones), 0 failed, 340.6 s.
- No test/v9-*.test.ts exists, so no repro case was expected to fail.
- Unexplained: 0. The jsdom timing case of v5-rev-serial and r6-fr-diff both passed in this run.

## Performance

`npx playwright test`, once (its own Vite on 5199): 1 passed in 57.7 s. Every budget is met:

| metric | value | budget |
|---|---|---|
| P1 open to first visible | 112.1 ms | < 400 |
| P4 longest task | 0 | < 120 |
| P4 tasks > 50 ms after 1 s | 0 | 0 |
| P5 main per keystroke p95 | 25.1 ms | < 30 |
| P5 max | 27.9 ms | < 60 |
| P5 key to mount p95 | 34.0 ms | < 40 |
| P8 frames > 20 ms | 0.4 % | < 3 |
| P11 undo step p95 | 0.0 ms | < 5 |

test-results/ was moved to my scratch directory and deleted with it.

P5 against the released 0.2.0: bench/verify/fix2-int-p5.mjs on the built dists, served by v5-cfm-perfserve with the switch stored off. 3 alternating runs, large.md split, 200 keys:

| build | raw p95 (ms) | key to mount p95 (ms) |
|---|---|---|
| 0.2.1 candidate | 23.9 / 24.3 / 25.5 | 33.8 / 34.0 / 34.1 |
| 0.2.0 | 24.3 / 23.4 / 23.9 | 34.0 / 34.2 / 34.0 |

keysWithoutMount was 0 in all 6 runs, and the two builds are level. The script's own strict "< 5 ms adjusted" target fails on both, as always.

Cold start: `MDR_PORT=5488 MDR_BASE_PORT=5498 node bench/verify/v5-offa-cold.mjs 3 --net 10`, both builds under vite preview, run twice:

| | set 1 candidate | set 1 0.2.0 | set 2 candidate | set 2 0.2.0 |
|---|---|---|---|---|
| editor shown (ms) | 320 / 324 / 322 | 304 / 303 / 322 | 321 / 303 / 302 | 320 / 321 / 322 |
| tIdle (median, ms) | 451 | 434 | 434 | 451 |
| small.md idle (median, ms) | 148 | 148 | 148 | 148 |

Every value falls on one of two levels, about 303 or about 321 ms, one frame apart. Set 1 favours 0.2.0 and set 2 favours the candidate. So the integrator's "4-5 % slower" was frame quantization, not a regression. Other numbers:
- large.md idle: 426 against 433 ms.
- JS received before the editor: 248 491 against 247 519 bytes (+972).
- Long tasks at start: 0 on both.

## What the runners and the verifier attacked without breaking it

**regress-off (switch off, the standing lists, against 0.1.1 and against the released 0.2.0).**
- The full gesture matrix against 0.2.0: v5-offd-matrix, 2126 cases in 4 shards. Each of the 22 differing cases was re-run 3 times, plus a 0.2.0-against-0.2.0 control. The differences moved between runs and appeared in the control: 0 cases differed on the candidate only.
- Random gesture sequences: v5-offd-fuzz with 10 fresh seeds (9301-9310, 60 ops) against 0.2.0: 10 of 10 same. Seeds 231-250 against 0.1.1: 18 same, plus the 2 recorded seeds and steps. v5-offp-fuzz, 10 seeds: 9 same, plus the recorded seed 11.
- R7 in the standing lists: v5-offa-r6, all 42 cases: 29 same / 13 differ (before R7: 25 / 17). The four N11 cases recovered, and the 13 left equal the fix-save and integrate records. v4-flow-drop drop-during-save, new-during-save and clean-save-drop pass. v5-offa-upgrade: 9 profiles the same apart from the switch button.
- SAN: v6-ro-pi PASS, v6-ro-piwait 0 / 0 / 0 empty blocks. v4-tru-diff seed 1 at 20 000 documents runs through (39 163 blocks, 0 bypass, 1 threw). v5-offc-rest dom small / readme / all identical to 0.1.1.
- The editing chunk is never requested by a switch-off script. Two request logs (98 requests) were attributed script by script, and every request falls in a script that turns the switch on. r5-pl-noload x4: editReqs 0. vo-daily: 0 chunk requests.
- Real users of the default configuration see what 0.2.0 shows: v6-vo-daily 34 of 34 steps identical; v6-vo-gest A-F identical apart from the accepted copy race (shown with self-compares); v6-vo-stand identical on 3 re-runs; v6-vo-tickscroll identical.
- The new key-editor-Meta+a difference of v5-offa-daily is noise. bench/verify/v9-ro-selall.mjs samples the preview's scrollTop for 2 s after Cmd+A. On one dev server the tree followed 1 of 4 times and the frozen 0.2.0 source 1 of 4. The production builds gave candidate 1/7, 0.2.0 5/6, 0.1.1 2/6.
- Ticks, the switch, the application flows and the trust checks match the round-5 records: v5-chc-ticks 548 cases, v5-ptk-ticks 186, v5-rvk-ticks, v5-rvt-trust, r4-t-stale 16/16, r4-t-u24 30/30, r4-if-holes, r4-if-miss, tickfuzz 10 seeds with 0 violations, r4-rel-default 44/44, v5-sw-default 193/193, v5-sw-off 7 known, v5-sw-user 25/29 known, sw-print, sw-narrow, v2-app x4, v2-flow-web 22/22, fixA/C/F, v4-flow x4, v4-tru x9, and 23 fx scenarios x 2 builds.

**challenge-7 (before the integration, on the tree).**
- R7 on the web: 28 cases of its own. v5-offa-r6 whole against 0.2.0. v5-offk-save 6/6 on the dev shell.
- SAN: 81 documents of its own, and the trust generator with seeds 4/5/6 at 20 000 documents (0 bypasses). A mount differential of 6 000 documents.
- Export: 260 generated documents, byte-identical to 0.2.0.
- P1 65/65. P2 14 of 16 forms.
- The start set: 1 081 blocks, 0 one-sided.
- Its five lows are accepted (checkpoint J).

**confirm (me).** The defining scripts of the four repairs, on the candidate's build, the candidate's desktop directory and the tree. The whole suite, the performance spec, and P5 and the cold start against the released 0.2.0.

## What nobody covered

- verify-7 did not run: no switch-on attack on the built candidate, and no real-user check of the four repairs beyond the defining scripts. Deferred until the budget resets (checkpoint J).
- Performance scripts other than mine: v5-offa-huge, v5-offa-scroll, v6-vo-cold.
- v6-ro-chunkprobe gave no result: on the real-user server it gets no test hooks, because its --perf flag is not passed into open(). Loading was covered by the two request logs and r5-pl-noload.
- v6-ro-reloaddraft was not run. v5-sw-user reproduced only the known reload artifact.
- v5-offc-rest and the v5-offp-* scripts ran against 0.1.1 only, as recorded.
- The tick scripts that need a dev server (chc, ptk, rvk, r4-t, r4-if, tickfuzz) compare the tree with 0.1.1, not with 0.2.0. Their numbers equal the round-5 records.
- Tools and helpers not run: v4-tru-fp, v4-tru-gen, v4-tru-h1cases, v4-tru-prof, v5-sw-fuzz, v5-offa-ux.
- Desktop:
  - There was no desktop gesture matrix in this round. regress-off ran no Electron; I ran v5-offk-save only; the integrator ran the desktop scripts on the candidate.
  - Not tested: a second window, and the shell's open-file at other moments of a save.
  - The web's 4-s gesture bound was not tested with a real permission prompt or file panel; headless stubs them.
- Of r7-fs-table, I re-ran 48 of 126 rows; fix-save recorded 126 of 126.
- Real macOS IME, the system emoji picker, spell-checker replacement, the real system clipboard, Firefox, Safari, touch, iPad and VoiceOver.
