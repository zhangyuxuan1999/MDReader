# 0.2.0 release candidate — stage 2a adversarial verification, r1 findings (2026-11-20)

Seven verifiers reported 45 findings. I re-ran every repro on the quiet machine: 44 reproduced, 1 is flaky (FLOW-8, 2 of 3), none failed to reproduce. They fall into 39 groups (one group = one fix): 12 high, 15 medium, 12 low.

**By the release gate this candidate must not ship.** 9 high groups are new in 0.2.0 or regressions (G1, G2, G3, G4, G5, G6, G7, G22, G23), and 6 regressions against 0.1.1 are medium or above (G22, G23, G15, G24, G25, G30). The pre-existing high groups (G28, G29, G37) do not block by the gate, but G37 shows that K1 is reachable with one click.

The worst problems, in plain terms:
- **Editing in the preview can write things into the file that the user did not type** (G1: a downloaded document can plant a hidden phishing link with one typed letter; G5: Shift+Enter next to bold writes raw HTML), or **remove things the user did not touch** (G2 autolinks, G3 formulas in tables, G4 private-use characters, G9 &nbsp; spacers).
- **⌘S after deleting a paragraph in the preview saves the deleted text** while the status says saved (G7).
- **The new decoder misreads or damages files 0.1.1 handled**: Latin-1 Portuguese / German files open as Chinese garbage and cannot be saved, and a damaged GBK file opens as U+FFFD and is wiped by one save (G22); saving a Big5 file rewrites every 十 (G23).
- **A large paste freezes the window** for tens of seconds or minutes (G6).
- **Drag-selecting text across paragraphs in the preview no longer works** with in-preview editing on, which is the default (G15, a regression).

## Machine and candidate (step 0)
- Quiet machine at the start: nothing listened on ports 5281-5298, no Electron, vitest or headless Chromium from this project was running; nothing had to be killed.
- npx tsc --noEmit printed nothing (exit 0).
- diff -rq electron release/staging-0.2.0.noindex/electron, diff -rq dist release/staging-0.2.0.noindex/dist and package.json: no differences.
- /Applications/MDReader.app/Contents/Info.plist: CFBundleShortVersionString 0.1.1, CFBundleVersion 0.1.1 (read only, not launched).

## Summary table

| group | severity | class | findings (verdict) | title |
|---|---|---|---|---|
| G1 | high | new-feature-defect | REV-1 (reproduced) | The serializer trusts attributes a document can carry (data-md, data-md-block, data-mdr-ui, data-lang, class md-math, newlines in href/title) |
| G2 | high | new-feature-defect | SES-2 (reproduced), FID-1 (reproduced), FID-2 (reproduced), FID-3 (reproduced) | The bare-URL / <url> decision for autolinks (mdrLink, bareAutolink, linkifyEndsAfter) is wrong on both sides of the URL |
| G3 | high | new-feature-defect | FID-10 (reproduced) | A formula with an escaped pipe in a table cell loses its escapes: the row splits and the formula disappears |
| G4 | high | new-feature-defect | FID-9 (reproduced) | Private-use characters U+E000..U+E003 in the document collide with the serializer's internal markers |
| G5 | high | new-feature-defect | SES-5 (reproduced) | A line break typed or pasted at the edge of bold / italic is written as raw <strong>/<em> HTML; in inline code it is dropped |
| G6 | high | new-feature-defect | SES-4 (reproduced) | A large paste into a session freezes the page; afterwards every keystroke costs seconds |
| G7 | high | new-feature-defect | APP-1 (reproduced) | An emptied block's deletion is written only when the session ends: ⌘S saves the deleted text, and the next click acts on stale positions |
| G22 | high | regression-vs-shipped | DEC-1 (reproduced), DEC-5 (reproduced) | Decoder rules 5 and 6 accept a lenient (U+FFFD) reading without evidence: clean windows-1252 Latin text becomes GBK garbage, NUL-padded GBK becomes all-U+FFFD "UTF-8" |
| G23 | high | regression-vs-shipped | DEC-2 (reproduced) | Saving a correctly detected Big5 / Shift_JIS file rewrites duplicate-mapped characters (十 A451 → A2CC, 卅 A4CA → A2CE, ⅰ FA40 → EEEF) |
| G28 | high | pre-existing | FLOW-1 (reproduced) | Hiding the tab while a crash-recovery offer is unanswered overwrites the stored draft with the clean document |
| G29 | high | pre-existing | FLOW-2 (reproduced) | 恢复 on a still-visible draft offer replaces text typed since then, without a question and without undo |
| G37 | high | pre-existing | SHELL-1 (reproduced) | A link inside an inline SVG navigates the app window (404 page: window cannot close, app cannot quit; index.html target: unsaved text dropped) |
| G8 | medium | new-feature-defect | SES-7 (reproduced) | Emptying the first item of a nested list writes a bare marker line: the parent becomes a setext <h2> or the nested list flattens |
| G9 | medium | new-feature-defect | FID-6 (reproduced) | A paragraph, line or cell that is only &nbsp; (a spacer) is deleted when another part of its block is edited |
| G10 | medium | new-feature-defect | SES-1 (reproduced) | ⌘/Ctrl keys pressed in the resume window (⌘←/⌘→/⌘⌫, Ctrl-E, ⌘A) are dropped, so following characters land in the wrong place |
| G11 | medium | new-feature-defect | SES-9 (reproduced) | A split written while the caret sits in an empty trailing paragraph resumes at the start of the previous paragraph |
| G12 | medium | new-feature-defect | SES-6 (reproduced) | ⌘Z whose history step lands in a block outside the viewport: unmounted → the resume never completes and typed keys are lost; mounted → the session continues off screen |
| G13 | medium | new-feature-defect | SES-8 (reproduced) | Enter at the end of a list item, then Tab or Shift+Tab, then typing: the text goes into the previous item |
| G14 | medium | new-feature-defect | APP-2 (reproduced) | A session-end write after a click into the editor moves the editor caret back to the edited block |
| G15 | medium | regression-vs-shipped | APP-3 (reproduced) | With 预览可编辑 on (default), text cannot be selected across blocks in the preview and ⌘A selects only the clicked block |
| G16 | medium | new-feature-defect | REV-2 (reproduced) | A resume pending after a Backspace merge or ⌘Z survives a document replacement: old keys replayed into the new document, focus taken from the discard question |
| G24 | medium | regression-vs-shipped | DEC-3 (reproduced) | Clean GBK made of GBK-extension characters is overturned by windows-1252 on 4 characters (and then by lenient UTF-8) |
| G25 | medium | regression-vs-shipped | DEC-6 (reproduced) | A file whose only clean reading is windows-1252 with one of 81/8D/8F/90/9D (Czech / Slovak CP1250) is now refused |
| G26 | medium | new-feature-defect | DEC-4 (reproduced) | For a lenient-GBK file the warnReplaced dialog names UTF-8 and promises a save the app then refuses; the GBK toast contradicts it |
| G30 | medium | regression-vs-shipped | FLOW-3 (reproduced) | Web: 丢弃 / 不保存 in one tab deletes the untitled draft another tab is still writing |
| G31 | medium | pre-existing | FLOW-4 (reproduced) | Desktop drag and drop ignores the shell's read refusal and opens File.text() instead |
| G32 | medium | pre-existing | FLOW-5 (reproduced), SHELL-2 (reproduced) | A request held by the renderer during the desktop close question (a dropped file, 新建 / 打开… from the menu) dies when the user answers 不保存 |
| G17 | low | new-feature-defect | SES-3 (reproduced), FID-11 (reproduced) | Backspace merge (U3) concatenates the two paragraphs' raw source: delimiters at the join form new markup |
| G18 | low | new-feature-defect | FID-4 (reproduced) | A typed dash line with inner spaces ("-- -", "--- ---") is not escaped and becomes a thematic break |
| G19 | low | new-feature-defect | FID-5 (reproduced) | A heading ending in " #" plus a trailing NBSP loses the "#" |
| G20 | low | new-feature-defect | FID-7 (reproduced) | An inline formula directly followed by a digit is written as $x$1 and no longer closes |
| G21 | low | new-feature-defect | FID-8 (reproduced) | Adjacent formatting of different kinds (**粗体**~~删除~~) is rewritten as raw HTML |
| G27 | low | pre-existing | DEC-7 (reproduced) | An unmodified save normalises mixed line endings to CRLF and CR-only endings to LF |
| G33 | low | regression-vs-shipped | FLOW-6 (reproduced) | A rejected 打开… picker is reported as 「需要重新授权访问该文件」 |
| G34 | low | new-feature-defect | FLOW-7 (reproduced) | Persistent open-error toasts pile up, outlive a successful open of the same file, and Escape does not dismiss them |
| G35 | low | new-feature-defect | FLOW-8 (flaky 2/3) | A renderer crash within milliseconds of 丢弃 leaves the discarded untitled draft and the next launch offers it |
| G36 | low | pre-existing | FLOW-9 (reproduced) | 新建 on a clean untitled document stacks duplicate draft offers |
| G38 | low | pre-existing | SHELL-3 (reproduced) | ⌘Q while the dirty-close question is up and the window is minimised or the app hidden does nothing visible |
| G39 | low | pre-existing | APP-4 (reproduced) | Desktop menu 编辑 → 撤销 undoes the document while a UI text field has the focus |

## Groups

### G1 [high, new-feature-defect] The serializer trusts attributes a document can carry (data-md, data-md-block, data-mdr-ui, data-lang, class md-math, newlines in href/title)

- **What goes wrong for the user:** One typed letter in a paragraph of a downloaded file writes hidden attacker-chosen Markdown (a phishing link, a link definition that retargets another paragraph) into the user's file, or deletes visible text.
- **Repro:** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v2-rev-forged-attrs.test.ts   (6 failed); MDR_PORT=5287 node bench/verify/v2-rev-browser.mjs rev1; MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex node bench/electron/v2-rev-desktop.mjs`
- **Observed:** Source line 'Fix the typo here <span data-md="[bank login](https://evil.example/phish)" style="display:none">.</span> please': click "typo", type "s", Esc, ⌘S. Line 3 on disk: "Fix the typos here [bank login](https://evil.example/phish) please". rev1c: a data-md-block payload writes "[bank]: https://evil.example/phish" ahead of the document's own definition, so the link in paragraph 2 changes from https://bank.example/ to https://evil.example/phish. "Keep <span data-mdr-ui>THIS TEXT</span> safe" loses its visible text.
- **Expected:** Only the typed letter changes; the carrier stays as raw HTML or the block is refused with 此块请在源码中编辑 (K4).
- **Baseline:** baseline-0.1.1 desktop, same script: no session starts and the file stays byte-identical (ALL PASS).
- **Suspected files:** src/preview/serialize.ts, src/preview/sanitize.ts, src/preview/inlineEdit.ts
- **Suggested fix:** Strip data-md / data-md-block / data-mdr-* and the internal md-* classes from raw HTML in sanitize.ts (or honour data-md only on placeholders prepare() created in the same run), refuse blocks whose raw HTML carries them, and neutralise newlines in href, title and data-lang.
- **Confirm verdicts:**
  - REV-1: **reproduced** — vitest 6/6 failed; browser rev1 1 run 0/3; desktop staging 1 run 2 FAIL, baseline 1 run ALL PASS. Decisive: line 3 on disk: "Fix the typos here [bank login](https://evil.example/phish) please" (baseline: file unchanged); rev1c: link in paragraph 2 https://bank.example/ -> https://evil.example/phish. My severity: high.

### G2 [high, new-feature-defect] The bare-URL / <url> decision for autolinks (mdrLink, bareAutolink, linkifyEndsAfter) is wrong on both sides of the URL

- **What goes wrong for the user:** Typing anywhere in a paragraph that holds an <url> or <e-mail> autolink removes the angle brackets: the link disappears, swallows the following text, changes its visible text, or exposes ** of an adjacent bold.
- **Repro:** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v2-ses-autolink.test.ts   (3 failed); perl -e 'alarm 110; exec @ARGV' npx vitest run test/v2-fid-repro.test.ts -t 'FID-[123][a-e]? '   (FID-1 5, FID-2 3, FID-3 3 failing); MDR_PORT=5281 node bench/verify/v2-fid-reach.mjs bare-`
- **Observed:** "word<https://e.com> tail" + typed x → "wordhttps://e.com tailx" (no <a>). "请联系<support@example.com> 获取帮助。" → "请联系support@example.com 获取帮助x" (no mailto). "**注意！**<https://example.com/x>" → "**注意！**https://example.com/x" (literal **). "文档 <https://example.com/docs>(英文)" → link to "https://example.com/docs(%E8%8B%B1%E6%96%87)". "[https://…/%E4%B8%AD%E6%96%87](same)" → visible text "…/中文".
- **Expected:** Write the bare form only when linkify would start AND end exactly there and would display the same text (normalizeLinkText(href) === text); otherwise write <url>.
- **Baseline:** Not applicable: 0.1.1 never writes Markdown from the preview.
- **Suspected files:** src/preview/serialize.ts
- **Suggested fix:** One conservative predicate in mdrLink: bare only after whitespace / line start / a known linkify boundary (no closing emphasis delimiter), only when linkifyEndsAfter is true with path-aware rules for ( { " ' after a path, and only when markdown-it's normalizeLinkText(href) equals the text; everything else <url>.
- **Confirm verdicts:**
  - SES-2: **reproduced** — vitest 3/3 failed (suite + single run); browser v2-ses-format autolink 1 run (info-only cases, output shows the loss). Decisive: md "wordhttps://e.com tail", rendered without <a>; browser: src="wordhttps://e.com tailx\n" html has no <a>. My severity: high.
  - FID-1: **reproduced** — vitest 5/5 failed (suite + -t run); v2-fid-reach 1 run: bare-before-mail-cjk-space, -http-letter, -mail-letter, -strong BROKEN. Decisive: "版本v2https://example.com/a 说明x" renders "<p>版本v2https://example.com/a 说明x</p>"; "**注意！**https://example.com/x" renders literal "**注意！**". My severity: high (verifier: medium). Raised from medium to high: same root cause and same user-visible damage as SES-2 (the link, or the bold next to it, silently disappears from a paragraph the user only typed into).
  - FID-2: **reproduced** — vitest 3/3 failed; v2-fid-reach bare-after-paren / bare-after-quote BROKEN (1 run). Decisive: md "文档 https://example.com/docs(英文) 可参考x" renders href="https://example.com/docs(%E8%8B%B1%E6%96%87)". My severity: medium.
  - FID-3: **reproduced** — vitest 3/3 failed; v2-fid-reach percent-link-text BROKEN (1 run). Decisive: link text "https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87" shown as ".../wiki/中文" after the edit. My severity: low.

### G3 [high, new-feature-defect] A formula with an escaped pipe in a table cell loses its escapes: the row splits and the formula disappears

- **What goes wrong for the user:** Editing any cell of a table that contains $\|x\|$ or $P(A\|B)$ rewrites the formula as $|x|$; the table gains columns and the formula vanishes.
- **Repro:** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v2-fid-repro.test.ts -t 'FID-10'   (2 failed); MDR_PORT=5281 node bench/verify/v2-fid-reach.mjs math-pipe`
- **Observed:** "| 绝对值 | $\|x\|$ |" with x typed → "| 绝对值 | x$|x|$ |"; the second cell renders "x$" only.
- **Expected:** The source keeps "$\|x\|$"; 2 cells and the formula.
- **Baseline:** Not applicable (new feature).
- **Suspected files:** src/preview/serialize.ts
- **Suggested fix:** In prepare(), escape "|" in the data-md of a .md-math placeholder inside TD/TH, as inlineCode(text, inCell) does for code.
- **Confirm verdicts:**
  - FID-10: **reproduced** — vitest 2/2 failed; v2-fid-reach math-pipe-in-cell BROKEN (1 run). Decisive: after "| 名称 | 公式 |\n|---|---|\n| 绝对值 | x$|x|$ |\n" (before "... | $\\|x\\|$ |"). My severity: high.

### G4 [high, new-feature-defect] Private-use characters U+E000..U+E003 in the document collide with the serializer's internal markers

- **What goes wrong for the user:** An edit anywhere in a block that contains such a character (icon fonts) deletes it (U+E000 becomes a line break) or splits a table cell (U+E002).
- **Repro:** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v2-fid-repro.test.ts -t 'FID-9'   (2 failed); MDR_PORT=5281 node bench/verify/v2-fid-reach.mjs pua`
- **Observed:** "图标\uE000文字与说明" + x → "图标\n文字与说明x"; "| 名 | 图\uE002标 |" → "| 名 | 图 | 标 |" with a third delimiter column.
- **Expected:** Document characters survive byte for byte.
- **Baseline:** Not applicable (new feature).
- **Suspected files:** src/preview/serialize.ts
- **Suggested fix:** Escape U+E000..U+E003 found in text nodes as numeric entities before marker processing, or use sentinels that cannot occur in DOM text.
- **Confirm verdicts:**
  - FID-9: **reproduced** — vitest 2/2 failed; v2-fid-reach pua-e000-paragraph, pua-e002-table BROKEN (1 run). Decisive: before "图标\uE000文字与说明\n" after "图标\n文字与说明x\n"; table row becomes "| 名 | 图 | 标 |". My severity: high. Rare input, but a character is deleted from the file: high by the scale.

### G5 [high, new-feature-defect] A line break typed or pasted at the edge of bold / italic is written as raw <strong>/<em> HTML; in inline code it is dropped

- **What goes wrong for the user:** Shift+Enter at the start of a paragraph that begins with bold text turns the whole paragraph into an HTML block whose *em*, `code` and links render literally; elsewhere the file fills with <strong>/<em> the user never typed; a break typed in code disappears.
- **Repro:** `MDR_PORT=5282 node bench/verify/v2-ses-format.mjs caret0   (also shift-enter, paste)`
- **Observed:** src-bold-caret0-shift-enter: src="<strong>  \nNote</strong> text with *em* and `code`\n"; b-shift-enter: "abc<strong>x  \n</strong>y def"; b-paste-2lines: "abc<strong>r  \n</strong>s def"; e-shift-enter: "abc`x`y def" (the break the session showed is gone).
- **Expected:** The break outside the delimiters ("**Note**  \n…" / "  \n**Note** …"), no raw HTML, the break kept.
- **Baseline:** Not applicable (new feature).
- **Suspected files:** src/preview/inlineEdit.ts, src/preview/serialize.ts
- **Suggested fix:** Hoist a leading / trailing <br> out of inline formatting (in the session after insertLineBreak and in the serializer) instead of falling back to raw HTML; split a code span around a <br> instead of dropping it.
- **Confirm verdicts:**
  - SES-5: **reproduced** — v2-ses-format caret0 0/2, shift-enter 4/12, paste 3/4 (1 run each, deterministic per the verifier's 2/2). Decisive: FAIL src-bold-caret0-shift-enter src="<strong>  \nNote</strong> text with *em* and `code`\n"; b-shift-enter src="abc<strong>x  \n</strong>y def\n"; code: e-shift-enter src="abc`x`y def\n" (break lost). My severity: high.

### G6 [high, new-feature-defect] A large paste into a session freezes the page; afterwards every keystroke costs seconds

- **What goes wrong for the user:** Pasting a long log or chapter into the preview hangs the window for tens of seconds to minutes; a user force-quits with whatever was unsaved.
- **Repro:** `MDR_PORT=5282 node bench/verify/v2-ses-bigpaste.mjs 200 prose ; MDR_PORT=5282 node bench/verify/v2-ses-bigpaste.mjs 100 prose1   (run in the background)`
- **Observed:** Quiet machine: "paste handler blocked 12658 ms for 200 KB (2561 lines)"; 100 KB single line: "one more key after: 4147 ms", "Esc: 8416 ms". (Verifier: 52 s at 400 KB, > 170 s at 1 MB.)
- **Expected:** One insertion of the pasted fragment (about a second), or a refusal with a message once the block would exceed MAX_EDIT_CHARS.
- **Baseline:** Not applicable (0.1.1 pastes into CodeMirror, which handles 1 MB at once).
- **Suspected files:** src/preview/inlineEdit.ts, src/preview/serialize.ts
- **Suggested fix:** Build the pasted fragment once and insert it with one Range operation; check MAX_EDIT_CHARS on paste and while the session runs; profile serializeBlock on a 100 KB text node (about 4 s: some pass is super-linear).
- **Confirm verdicts:**
  - SES-4: **reproduced** — 200 KB multi-line 1 run, 100 KB single-line 1 run (the 400 KB / 1 MB sizes were not re-run). Decisive: paste handler blocked 12658 ms for 200 KB (2561 lines); 100 KB one line: one more key after: 4147 ms, Esc: 8416 ms. My severity: high. Agree with high: growth is super-linear (the verifier measured 52 s at 400 KB and > 170 s at 1 MB); a user facing a minute-long beach ball force-quits with unsaved work.

### G7 [high, new-feature-defect] An emptied block's deletion is written only when the session ends: ⌘S saves the deleted text, and the next click acts on stale positions

- **What goes wrong for the user:** A user deletes a paragraph in the preview and saves: the status says saved, the file on disk still holds the deleted text; the next click starts no session (typing lost) or toggles the wrong task.
- **Repro:** `MDR_PORT=5283 node bench/verify/v2-app-replace.mjs C1 ; MDR_PORT=5283 node bench/verify/v2-app-stale.mjs 3 ; MDR_PORT=5283 node bench/verify/v2-app-stale-gap.mjs   (start npx vite --port 5283 --strictPort first: the scripts' own server keeps node alive after they finish)`
- **Observed:** Saved file "# 标题\n\n甲段落文字。\n\n乙段落文字。\n", title "r.md"; only after Esc "# 标题\n\n\n乙段落文字。\n" and "● r.md". Click on 乙 afterwards: session=no, X not in the source (6/6). Checkbox 任务二: 0 ms → "- [x] 任务三", 20 ms and more → click lost.
- **Expected:** The saved file matches the screen and the document stays dirty until it does; the next click behaves like any click.
- **Baseline:** Not applicable (new feature).
- **Suspected files:** src/preview/inlineEdit.ts, src/app/App.ts
- **Suggested fix:** Write an emptied block's deletion like any other edit (rAF flush), or at least in flush(), and count it as dirty; do not interpret the ending mousedown against a structure older than the write.
- **Confirm verdicts:**
  - APP-1: **reproduced** — C1 1/1; v2-app-stale 3 runs: S1 6/6 no session and X lost, S2 6/6, gap sweep 1 run. Decisive: saved file "# 标题\n\n甲段落文字。\n\n乙段落文字。\n"; title after save "r.md"; after Esc "# 标题\n\n\n乙段落文字。\n" title "● r.md"; S2 0 ms: "- [x] 任务三" (wrong task), 90 ms: click lost. My severity: high. v2-app-stale S1 prints PASS because its assertion accepts "no session"; the detail (session=no, X not in the source) is the APP-1 symptom.

### G22 [high, regression-vs-shipped] Decoder rules 5 and 6 accept a lenient (U+FFFD) reading without evidence: clean windows-1252 Latin text becomes GBK garbage, NUL-padded GBK becomes all-U+FFFD "UTF-8"

- **What goes wrong for the user:** Portuguese, German, Icelandic, Catalan and Spanish files that 0.1.1 opened correctly show Chinese garbage and cannot be saved; a damaged GBK file that 0.1.1 refused opens as U+FFFD and one ⌘S wipes its text.
- **Repro:** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v2-dec-decoder.test.ts -t 'DEC-1'   (5 failed) and -t 'DEC-5' (1 failed); PART=latin node bench/verify/v2-dec-thresholds.mjs ; CASES=pt,de,nulpad MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex node bench/electron/v2-dec-e2e.mjs`
- **Observed:** pt 1602/3000, de 799, is 408, ca 154, es 91 regressions. Staging pt-cp1252: "N鉶 h� solu玢o. ORIENTA钦ES GERAIS", dialog "不是完全有效的 UTF-8 文本", toast GBK, save "保存失败：文档包含 GBK 编码无法表示的字符「�」". gbk-nulpad: dialog "其中 41 处无效字节…", ⌘S "已保存", 88 → 166 bytes, every Chinese character replaced by EF BF BD.
- **Expected:** pt/de: windows-1252 with the true text, byte-exact save (0.1.0). nulpad: refused as in 0.1.0, or lenient UTF-8 only with UTF8_LENIENT_MIN_VALID valid characters.
- **Baseline:** Same e2e script on baseline-0.1.1: pt/de show the true text, toast WINDOWS-1252, save = original bytes + "x"; gbk-nulpad is refused.
- **Suspected files:** electron/fileIO.mjs, electron/main.mjs
- **Suggested fix:** Rules 5 and 6 must not override a clean windows-1252 reading, and rule 6 must not pick lenient UTF-8, without MIN_EVIDENCE_CHARS valid characters and the EVIDENCE_MARGIN score rule (as step 2 and rule 3 require).
- **Confirm verdicts:**
  - DEC-1: **reproduced** — vitest 5/5 failed; PART=latin 1 run; e2e staging 1 run, baseline 1 run. Decisive: pt: 1602/3000 regressions; staging pt-cp1252 editor "N鉶 h� solu玢o. ORIENTA钦ES GERAIS", toast GBK, save "保存失败：文档包含 GBK 编码无法表示的字符「�」". My severity: high.
  - DEC-5: **reproduced** — vitest 1/1 failed; e2e staging 1 run, baseline 1 run. Decisive: staging gbk-nulpad: dialog "其中 41 处无效字节…", after ⌘S "已保存" REWRITTEN byte 2: expected bbe1d2e9bccd got efbfbdefbfbd (len 88 → 166). My severity: medium. Class changed from new-feature-defect to regression-vs-shipped: measured on both shells, the baseline refuses the file (nothing at risk) and the candidate offers a save that destroys its text. Same rule (6) and same fix as DEC-1.

### G23 [high, regression-vs-shipped] Saving a correctly detected Big5 / Shift_JIS file rewrites duplicate-mapped characters (十 A451 → A2CC, 卅 A4CA → A2CE, ⅰ FA40 → EEEF)

- **What goes wrong for the user:** A Traditional Chinese user fixes one typo in a Big5 note and saves: every 十 and 卅 is silently rewritten; macOS text tools then refuse the file as Big5 or show 〸.
- **Repro:** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v2-dec-decoder.test.ts -t 'DEC-2'   (2 failed); node bench/verify/v2-dec-tables.mjs ; CASES=big5-ten MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex node bench/electron/v2-dec-e2e.mjs`
- **Observed:** Toast BIG5, ⌘S "已保存", "byte 8: expected a451a4eba451 got a2cca4eba2cc", 8 bytes changed outside the edit; tables: big5 non-roundtrip= 10, shift_jis non-roundtrip= 398.
- **Expected:** Only the edited bytes change (WHATWG / iconv / CP950 encoders write A451, A4CA, FA40).
- **Baseline:** baseline-0.1.1: the file opens as GBK mojibake and saves byte-exact (original bytes + "x"); the encoder tables are identical, but 0.1.0 never chose Big5 for this text.
- **Suspected files:** electron/fileIO.mjs
- **Suggested fix:** Build the encoder tables like the WHATWG encoders (Big5: skip lead < 0xA1 and take the last pointer for the six duplicates; Shift_JIS: skip pointers 8272-8835), or remember a duplicate character's original bytes per file.
- **Confirm verdicts:**
  - DEC-2: **reproduced** — vitest 2/2 failed; v2-dec-tables 1 run; e2e staging 1 run, baseline 1 run. Decisive: staging big5-ten: toast BIG5, save "已保存", REWRITTEN "byte 8: expected a451a4eba451 got a2cca4eba2cc", 8 bytes; tables: big5 non-roundtrip= 10, shift_jis non-roundtrip= 398. My severity: high.

### G28 [high, pre-existing] Hiding the tab while a crash-recovery offer is unanswered overwrites the stored draft with the clean document

- **What goes wrong for the user:** The unsaved text from a crash is lost for good if the user switches tabs once before answering the offer and then reloads.
- **Repro:** `node bench/verify/v2-flow-web.mjs W1   (baseline: MDR_DIST=release/baseline-0.1.1.noindex/dist node bench/verify/v2-flow-web.mjs W1)`
- **Observed:** FAIL W1a … stored ""; FAIL W1b … offer shown again — [].
- **Expected:** The draft survives until restored or dismissed; a flush writes only after an edit.
- **Baseline:** Identical FAIL lines on the 0.1.1 dist.
- **Suspected files:** src/app/App.ts, src/worker/draft.ts
- **Suggested fix:** Skip the flush when nothing was edited since setDoc / the last restore.
- **Confirm verdicts:**
  - FLOW-1: **reproduced** — candidate 1 run, baseline 1 run. Decisive: FAIL W1a … stored "" ; FAIL W1b after a reload the offer is shown again — [] (both builds). My severity: high.

### G29 [high, pre-existing] 恢复 on a still-visible draft offer replaces text typed since then, without a question and without undo

- **What goes wrong for the user:** Text typed after the offer appeared is lost by one click on a toast button.
- **Repro:** `node bench/verify/v2-flow-web.mjs W8   (baseline: MDR_DIST=release/baseline-0.1.1.noindex/dist node bench/verify/v2-flow-web.mjs W8)`
- **Observed:** FAIL W8 … {"t":"old crash text","u":"old crash text"}.
- **Expected:** Ask before replacing a dirty document, or apply the draft as an undoable transaction.
- **Baseline:** Identical on the 0.1.1 dist.
- **Suspected files:** src/app/App.ts
- **Suggested fix:** restoreDraft: docGuard.confirmDiscard() when dirty, or an undoable transaction instead of setDoc.
- **Confirm verdicts:**
  - FLOW-2: **reproduced** — candidate 1 run, baseline 1 run. Decisive: FAIL W8 … {"t":"old crash text","u":"old crash text"} (both builds). My severity: high.

### G37 [high, pre-existing] A link inside an inline SVG navigates the app window (404 page: window cannot close, app cannot quit; index.html target: unsaved text dropped)

- **What goes wrong for the user:** One click on a link inside an SVG of a received document blanks the window; with unsaved edits the app can only be force-quit; later documents are not shown. K1's premise "not reachable from the UI" is false.
- **Repro:** `node bench/electron/v2-shell-doclink.mjs svg404 ; MDR_DIRTY_WAIT=4000 node bench/electron/v2-shell-doclink.mjs svgApp   (baseline: prefix MDR_TARGET=baseline)`
- **Observed:** navigated=true url=app://mdreader/nonexistent.md … laterDocShown=false … quitExit=null; svgApp: editsStillShown=false title="未命名.md".
- **Expected:** No document link replaces the app page; close and quit keep working.
- **Baseline:** Identical output on baseline-0.1.1 (svg404 and svgApp).
- **Suspected files:** electron/main.mjs, src/preview/sanitize.ts, src/preview/interactions.ts
- **Suggested fix:** will-navigate: block every main-frame navigation the shell did not start, app:// included; sanitizer: treat SVG <a> (localName a, href / xlink:href) like HTML anchors; interactions.ts: preventDefault every unrouted link click.
- **Confirm verdicts:**
  - SHELL-1: **reproduced** — svg404 and svgApp: staging 1 run each, baseline 1 run each. Decisive: navigated=true url=app://mdreader/nonexistent.md … laterDocShown=false … quitExit=null (staging and baseline identical); svgApp editsStillShown=false title="未命名.md". My severity: high. K1 is worse than described: a document reaches the state with one click.

### G8 [medium, new-feature-defect] Emptying the first item of a nested list writes a bare marker line: the parent becomes a setext <h2> or the nested list flattens

- **What goes wrong for the user:** Deleting a sub-item's text turns the parent bullet into a heading (also in the TOC) or shows "1. 2." as text, visible only after Esc.
- **Repro:** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v2-ses-emptyitem.test.ts   (3 failed); MDR_PORT=5282 node bench/verify/v2-ses-lists.mjs nested-first-emptied`
- **Observed:** "- on\n  -\n  - o" renders UL[(H2{on}UL[(o)])]; "1. on\n   1.\n   2. o" renders OL[(on1.2.o)].
- **Expected:** The rendered structure equals the session's (an empty item that stays an item, or is dropped).
- **Baseline:** Not applicable (new feature).
- **Suspected files:** src/preview/serialize.ts
- **Suggested fix:** Never emit a bare "-" / "1." line directly under paragraph text: drop the empty item or emit a form that stays an empty item.
- **Confirm verdicts:**
  - SES-7: **reproduced** — vitest 3/3 failed; v2-ses-lists nested-first-emptied 0/3 (1 run). Decisive: src="- on\n  -\n  - o\n\nafter\n" renders "UL[(H2{on}UL[(o)])]"; ordered: "OL[(on1.2.o)]". My severity: medium.

### G9 [medium, new-feature-defect] A paragraph, line or cell that is only &nbsp; (a spacer) is deleted when another part of its block is edited

- **What goes wrong for the user:** Editing a word in a quote, list or tight heading block silently removes the user's &nbsp; spacer lines from the file.
- **Repro:** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v2-fid-repro.test.ts -t 'FID-6'   (2 failed); MDR_PORT=5281 node bench/verify/v2-fid-reach.mjs nbsp-`
- **Observed:** "> 第一段\n>\n> &nbsp;\n>\n> 第三段" → "> 第一段\n>\n> 第三段"; "## 标题\n&nbsp;" → "## 标题".
- **Expected:** A line whose only content is NBSP keeps "&nbsp;".
- **Baseline:** Not applicable (new feature).
- **Suspected files:** src/preview/serialize.ts
- **Suggested fix:** In fixNbsp, write "&nbsp;" when the segment is a whole line / cell / paragraph consisting only of NBSP.
- **Confirm verdicts:**
  - FID-6: **reproduced** — vitest 2/2 failed; v2-fid-reach nbsp-para-in-quote, nbsp-under-heading BROKEN (1 run); 3 of the 7 v2-fid-fuzz seed-7 failures. Decisive: before "> 第一段\n>\n> &nbsp;\n>\n> 第三段\n" after "> 第一段\n>\n> 第三段\n". My severity: medium.

### G10 [medium, new-feature-defect, timing-sensitive] ⌘/Ctrl keys pressed in the resume window (⌘←/⌘→/⌘⌫, Ctrl-E, ⌘A) are dropped, so following characters land in the wrong place

- **What goes wrong for the user:** A fast typist who presses Enter and then ⌘→ / ⌘⌫ within ~15-50 ms gets the next characters at the wrong position (U4 promises nothing is lost).
- **Repro:** `MDR_PORT=5282 node bench/verify/v2-ses-resume.mjs p-m ; MDR_PORT=5282 node bench/verify/v2-ses-resume.mjs ctrl`
- **Observed:** p-mid-cmdright src="abc\n\nQdef\n" (expected "abc\n\ndefQ\n"); p-mid-cmdleft-after-type "XYQdef" (expected "QXYdef"); p-meta-bs "XYQdef" (expected "Qdef"); p-ctrl-e "Qdef".
- **Expected:** Modified editing / caret keys are queued and replayed like plain arrows.
- **Baseline:** Not applicable (new feature; not K2, which is the menu path).
- **Suspected files:** src/preview/inlineEdit.ts
- **Suggested fix:** onResumeKey: preventDefault and queue every ⌘/Ctrl key that edits or moves the caret, replay with Selection.modify / execCommand; in onWindowKey, queue the key that triggered a synchronous resume.
- **Confirm verdicts:**
  - SES-1: **reproduced** — p-m 3 runs: 3/3 (3 cases each); ctrl 1 run: 1/1. Decisive: FAIL p-mid-cmdright src="abc\n\nQdef\n" expected="abc\n\ndefQ\n"; p-meta-bs src="abc\n\nXYQdef\n" expected="abc\n\nQdef\n"; p-ctrl-e src="abc\n\nQdef\n". My severity: medium. Deterministic on the quiet machine at script speed (no wait between Enter and the modified key).

### G11 [medium, new-feature-defect, timing-sensitive] A split written while the caret sits in an empty trailing paragraph resumes at the start of the previous paragraph

- **What goes wrong for the user:** With two paragraph boundaries in one frame (fast typing, long frames in large documents), the text typed next goes to the beginning of the previous paragraph.
- **Repro:** `MDR_PORT=5282 node bench/verify/v2-ses-resume.mjs empty-caret`
- **Observed:** src="abc\n\nghidef\n\nnext\n"
- **Expected:** "abc\n\ndef\n\nghi\n\nnext\n"
- **Baseline:** Not applicable (new feature).
- **Suspected files:** src/preview/inlineEdit.ts
- **Suggested fix:** In splitTarget, when the caret's top-level element serializes to nothing, resume after it (or recreate the empty paragraph) instead of offset 0 of the preceding segment.
- **Confirm verdicts:**
  - SES-9: **reproduced** — empty-caret 3 runs: 3/3 (both cases each run). Decisive: FAIL empty-caret-at-flush src="abc\n\nghidef\n\nnext\n" expected="abc\n\ndef\n\nghi\n\nnext\n". My severity: medium. Needs two paragraph boundaries in one frame; deterministic with the script's same-frame input.

### G12 [medium, new-feature-defect] ⌘Z whose history step lands in a block outside the viewport: unmounted → the resume never completes and typed keys are lost; mounted → the session continues off screen

- **What goes wrong for the user:** Pressing ⌘Z repeatedly after editing in two far-apart places kills the session: 2.5 s of typing is lost and the keyboard does nothing until a click; the undone change is not scrolled into view.
- **Repro:** `MDR_PORT=5282 node bench/verify/v2-ses-undo-far.mjs split ; MDR_PORT=5282 N=40 FAR=30 node bench/verify/v2-ses-undo-far.mjs split`
- **Observed:** 3 s after the far ⌘Z: {"editing":null,"active":""}, Q not in the source; N=40: {"editing":"para0 text here","visible":false,"top":-1110}.
- **Expected:** U1: the session continues on the block of the returned line, scrolled into view; queued keys replayed.
- **Baseline:** Not applicable (new feature).
- **Suspected files:** src/preview/inlineEdit.ts, src/preview/createPreview.ts
- **Suggested fix:** Scroll the target line into view (mounting it) before waiting in runHistory / tryResume; do not drop the queue on the timeout while the block is merely unmounted.
- **Confirm verdicts:**
  - SES-6: **reproduced** — split 1 run 4/8 (both sub-cases), N=40 FAR=30 1 run 6/8. Decisive: FAIL preview-session: 3 s after the far ⌘Z there is a live session — {"editing":null,"active":""}; mounted: {"visible":false,"top":-1110}. My severity: medium.

### G13 [medium, new-feature-defect] Enter at the end of a list item, then Tab or Shift+Tab, then typing: the text goes into the previous item

- **What goes wrong for the user:** The most common outline gesture (new bullet, indent, type) puts the text into the parent bullet and loses the new item.
- **Repro:** `MDR_PORT=5282 node bench/verify/v2-ses-lists.mjs enter-tab ; ... v2-ses-lists.mjs nested-enter-stab`
- **Observed:** "- onchild\n- two" (expected "- on\n  - child\n- two"); Shift+Tab: "- on\n  - inout\n-\n- two".
- **Expected:** The caret stays in the moved, still-empty item.
- **Baseline:** Not applicable (new feature).
- **Suspected files:** src/preview/inlineEdit.ts
- **Suggested fix:** In tabKey, keep the caret as a DOM position inside the moved li instead of a block-wide text offset.
- **Confirm verdicts:**
  - SES-8: **reproduced** — enter-tab 1 run 0/3, nested-enter-stab 1 run 0/1. Decisive: FAIL enter-tab-type src="- onchild\n- two\n\nafter\n" expected "- on\n  - child\n- two\n\nafter\n". My severity: medium.

### G14 [medium, new-feature-defect] A session-end write after a click into the editor moves the editor caret back to the edited block

- **What goes wrong for the user:** Text typed into the editor right after leaving a preview edit (Chinese IME users always have a composition open) lands in another paragraph.
- **Repro:** `MDR_PORT=5283 node bench/verify/v2-app-stale.mjs 3   (S3, S4)`
- **Observed:** S3: "Q\n乙段落文字。\n\n丙段落文字。…"; S4: "甲段落文字。niQ\n\n乙段落文字。…" (3/3 each).
- **Expected:** "丙段落文字。Q".
- **Baseline:** Not applicable (new feature).
- **Suspected files:** src/app/previewEdit.ts, src/preview/inlineEdit.ts
- **Suggested fix:** In createSourceAccess.replace, map the existing selection through the change when the editor has focus (or the write comes from a focus-out end()).
- **Confirm verdicts:**
  - APP-2: **reproduced** — S3 3/3, S4 3/3. Decisive: FAIL S3: Q not where clicked: "Q\n乙段落文字。\n\n丙段落文字。..."; FAIL S4: "甲段落文字。niQ\n\n乙段落文字。...". My severity: medium.

### G15 [medium, regression-vs-shipped] With 预览可编辑 on (default), text cannot be selected across blocks in the preview and ⌘A selects only the clicked block

- **What goes wrong for the user:** Selecting and copying several paragraphs from the preview, which works in 0.1.1, stops working after the upgrade.
- **Repro:** `npx vite --port 5283 --strictPort & ; MDR_BASE_URL=http://localhost:5283 node bench/verify/v2-app-regress.mjs ; baseline: npx vite preview --outDir release/baseline-0.1.1.noindex/dist --port 5293 --strictPort & ; MDR_PERF=1 MDR_BASE_URL=http://localhost:5293 node bench/verify/v2-app-regress.mjs`
- **Observed:** Candidate (3/3): drag-select = "第一段落文字 alpha。"; Cmd-A {"len":12,"hasFirst":false,"hasThird":false}.
- **Expected:** As 0.1.1: the drag selects across the three paragraphs; ⌘A selects the page.
- **Baseline:** Measured (2/2): "第一段落文字 alpha。 第二段落文字 beta。 第三段落文字 gamm", Cmd-A {"len":1475}. Candidate with MDR_EDIT=off: three paragraphs (1/1).
- **Suspected files:** src/preview/inlineEdit.ts
- **Suggested fix:** Start the session on mouseup / click with a collapsed selection inside one block (or drop contenteditable when a drag leaves the block); let ⌘A in an unchanged session fall back to the page. Or the lead accepts and documents it.
- **Confirm verdicts:**
  - APP-3: **reproduced** — candidate 3/3 confined; baseline 2/2 correct; candidate with MDR_EDIT=off 1/1 correct. Decisive: candidate: drag-select = "第一段落文字 alpha。", Cmd-A {"len":12}; baseline: "第一段落文字 alpha。 第二段落文字 beta。 第三段落文字 gamm", Cmd-A {"len":1475}. My severity: medium. Not covered by CONTRACT section 11: a release blocker by the gate unless the lead accepts it explicitly.

### G16 [medium, new-feature-defect, timing-sensitive] A resume pending after a Backspace merge or ⌘Z survives a document replacement: old keys replayed into the new document, focus taken from the discard question

- **What goes wrong for the user:** Characters typed right after a merge or ⌘Z can end up in the next document that opens, and a discard question loses its keyboard focus.
- **Repro:** `MDR_PORT=5287 node bench/verify/v2-rev-browser.mjs race   (uses a slow-worker hook to widen the ~30 ms window)`
- **Observed:** merge: "NEW DOC first paraQQ\n\nNEW DOC second para\n\nNEW DOC third\n" with a live session; undo: "NEW DOC second parQQa"; dialog: {"dialog":true,"active":"md-block is-editing"}, Escape no longer answers it.
- **Expected:** The new document untouched, no session in it, the question keeps the focus.
- **Baseline:** Not applicable (new feature).
- **Suspected files:** src/app/previewEdit.ts, src/preview/inlineEdit.ts, src/app/App.ts
- **Suggested fix:** Make previewEdit.commit() / flush() end a pending resume (call preview.endEditSession() unconditionally); cancel a resume when a full structure resets block ids; never w.focus() while a modal owns the focus.
- **Confirm verdicts:**
  - REV-2: **reproduced** — race 3 runs: 3/3 at 2/8 (merge, undo and dialog variants each time; split holds). Decisive: FAIL race/merge: source now "NEW DOC first paraQQ\n\nNEW DOC second para\n\nNEW DOC third\n"; FAIL race/dialog: {"dialog":true,"active":"md-block is-editing"}. My severity: medium. Reproduced only with the script's slow-worker hook (400 ms delayed deltas); natural timing (about 30 ms window) was not attempted.

### G24 [medium, regression-vs-shipped] Clean GBK made of GBK-extension characters is overturned by windows-1252 on 4 characters (and then by lenient UTF-8)

- **What goes wrong for the user:** A short note of name characters or a traditional phrase in GBK, which 0.1.1 read correctly, opens as Latin garbage or as U+FFFD with a dialog that invites a destructive save.
- **Repro:** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v2-dec-decoder.test.ts -t 'DEC-3'   (2 failed); CASES=gbk-rare MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex node bench/electron/v2-dec-e2e.mjs`
- **Observed:** Staging gbk-rare: editor "ˆÒ †´ •N", toast WINDOWS-1252; unit: "責維護舊" read as utf-8 "؟�S�o�f" (replaced 3).
- **Expected:** GBK "堃 喆 昇" / "責維護舊".
- **Baseline:** baseline-0.1.1, same e2e: "堃 喆 昇", toast GBK, byte-exact save.
- **Suspected files:** electron/fileIO.mjs
- **Suggested fix:** Require MIN_EVIDENCE_CHARS (20) for windows-1252 too when GBK is clean (or discount 1252 single high bytes followed by a GBK trail byte); rule 6 must not apply when GBK was clean.
- **Confirm verdicts:**
  - DEC-3: **reproduced** — vitest 2/2 failed; e2e staging 1 run, baseline 1 run. Decisive: staging gbk-rare: editor "ˆÒ †´ •N", toast WINDOWS-1252. My severity: medium.

### G25 [medium, regression-vs-shipped] A file whose only clean reading is windows-1252 with one of 81/8D/8F/90/9D (Czech / Slovak CP1250) is now refused

- **What goes wrong for the user:** A Czech or Slovak text file that 0.1.1 opened (mostly readable, saved losslessly) can no longer be opened.
- **Repro:** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v2-dec-decoder.test.ts -t 'DEC-6'   (1 failed); CASES=cs MDR_APP_DIR=<staging|baseline> node bench/electron/v2-dec-e2e.mjs`
- **Observed:** Staging: not shown, toast "无法打开「cs-cp1250.md」：无法识别它的文本编码，它可能不是文本文件".
- **Expected:** Opens as in 0.1.1 (windows-1252 reading, byte-exact save) or better.
- **Baseline:** baseline-0.1.1: opens, toast WINDOWS-1252, save = original bytes + "x".
- **Suspected files:** electron/fileIO.mjs
- **Suggested fix:** Accept U+0081/8D/8F/90/9D for the windows-1252 candidate when no other reading wins; keep the C1 rejection for the CJK labels.
- **Confirm verdicts:**
  - DEC-6: **reproduced** — vitest 1/1 failed; e2e staging 1 run, baseline 1 run. Decisive: staging cs-cp1250: not shown, toast "无法打开「cs-cp1250.md」：无法识别它的文本编码，它可能不是文本文件". My severity: medium.

### G26 [medium, new-feature-defect] For a lenient-GBK file the warnReplaced dialog names UTF-8 and promises a save the app then refuses; the GBK toast contradicts it

- **What goes wrong for the user:** The user is told the file is UTF-8 and that saving will replace bad bytes; every save then fails with a third message.
- **Repro:** `CASES=lenient-gbk MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex node bench/electron/v2-dec-e2e.mjs ; vitest -t "DEC-4" (1 failed)`
- **Observed:** Dialog "「lenient-gbk.md」不是完全有效的 UTF-8 文本" / "保存时这些位置会写成 �（U+FFFD）"; toast "该文件是 GBK 编码…保存时也写回 GBK"; save "保存失败：文档包含 GBK 编码无法表示的字符「�」"; file unchanged.
- **Expected:** A dialog that names GBK and says what will happen; no contradicting toast; or the save does what the dialog promises.
- **Baseline:** Not applicable (0.1.1 has no lenient decode; it opens the file as windows-1252 mojibake and saves byte-exact).
- **Suspected files:** electron/main.mjs, src/app/App.ts, electron/fileIO.mjs
- **Suggested fix:** Pass info.encoding to warnReplaced and word it per encoding; suppress the "保存时也写回 GBK" toast for such a file.
- **Confirm verdicts:**
  - DEC-4: **reproduced** — vitest 1/1 failed; e2e staging 1 run (lenient-gbk, also seen on pt/de). Decisive: dialog "「lenient-gbk.md」不是完全有效的 UTF-8 文本" + toast "该文件是 GBK 编码…保存时也写回 GBK" + save "保存失败：文档包含 GBK 编码无法表示的字符「�」"; saved "unchanged on disk". My severity: medium.

### G30 [medium, regression-vs-shipped] Web: 丢弃 / 不保存 in one tab deletes the untitled draft another tab is still writing

- **What goes wrong for the user:** If tab 1 then crashes before its next keystroke, its unsaved text has no draft to recover from.
- **Repro:** `node bench/verify/v2-flow-web.mjs W7   (baseline: MDR_DIST=release/baseline-0.1.1.noindex/dist node bench/verify/v2-flow-web.mjs W7)`
- **Observed:** Candidate: FAIL W7 … stored null.
- **Expected:** A tab deletes only a draft it wrote itself.
- **Baseline:** ok W7 … stored "tab one text" (the baseline never deletes drafts on discard).
- **Suspected files:** src/app/App.ts, src/files/drafts.ts, src/files/fileService.ts
- **Suggested fix:** Delete only when the stored record matches this tab's last draftSaved, or key untitled drafts per tab.
- **Confirm verdicts:**
  - FLOW-3: **reproduced** — candidate 1 run failed, baseline 1 run ok. Decisive: candidate: FAIL W7 … stored null; baseline: ok W7 … stored "tab one text". My severity: medium. A regression by measurement; the loss only materialises if tab 1 dies before its next keystroke.

### G31 [medium, pre-existing] Desktop drag and drop ignores the shell's read refusal and opens File.text() instead

- **What goes wrong for the user:** Dropping a binary, unreadable or FIFO file shows garbage, an English error or an empty document where R3 promises a truthful message.
- **Repro:** `MDR_TARGET=staging node bench/electron/v2-flow-desk.mjs D5 D9   (baseline: MDR_TARGET=baseline)`
- **Observed:** Binary drop: control-character garbage titled d5-binary.md, no toast; locked: "无法打开「d5-locked.md」：The requested file could not be read…"; FIFO: empty document "d9-pipe.md".
- **Expected:** The same zh-CN reason as open-file; the current document left alone.
- **Baseline:** Binary: same garbage; locked: English message; FIFO: nothing happens (title 未命名.md).
- **Suspected files:** src/files/nativeBackend.ts, src/app/App.ts
- **Suggested fix:** In fromDrop, rethrow toOpenError(err) when a path exists and the shell refused it.
- **Confirm verdicts:**
  - FLOW-4: **reproduced** — staging 1 run, baseline 1 run. Decisive: staging binary drop: control-character garbage titled d5-binary.md, toasts []; locked drop: English "The requested file could not be read…"; FIFO drop: empty document "d9-pipe.md". My severity: medium. The FIFO sub-case is slightly worse on the candidate (it replaces the document with an empty one); the rest is equal.

### G32 [medium, pre-existing] A request held by the renderer during the desktop close question (a dropped file, 新建 / 打开… from the menu) dies when the user answers 不保存

- **What goes wrong for the user:** After 不保存 the window closes and the dropped document or the chosen command is gone; the user has to repeat it.
- **Repro:** `MDR_TARGET=staging node bench/electron/v2-flow-desk.mjs D7 ; MDR_E4_STATES=closeQuestion node bench/electron/v2-shell-life.mjs e4   (baselines: MDR_TARGET=baseline)`
- **Observed:** D7: "不保存: the dropped document is shown somewhere — windows 0"; e4: windows=0 panelCalls=0 cmdSends=1 for file.open and file.new.
- **Expected:** As for OS documents (E4): one window reopens and shows / runs it.
- **Baseline:** Both fail identically on baseline-0.1.1 (the baseline additionally stacks two questions in D7).
- **Suspected files:** src/app/App.ts, src/app/native.ts, electron/main.mjs
- **Suggested fix:** Buffer WINDOWLESS_COMMANDS in main while closeAsked, hand dropped paths to the shell, and reopen a window on 不保存 when anything is pending.
- **Confirm verdicts:**
  - FLOW-5: **reproduced** — staging 1 run, baseline 1 run. Decisive: FAIL D7 不保存: the dropped document is shown somewhere — windows 0 (both); baseline also asks 2 questions. My severity: medium.
  - SHELL-2: **reproduced** — staging 1 run, baseline 1 run. Decisive: FAIL [e4] file.open in state closeQuestion … windows=0 panelCalls=0 cmdSends=1 (both). My severity: low. Same root cause as FLOW-5: requests the renderer holds at the question gate die with the page when 不保存 closes the window.

### G17 [low, new-feature-defect] Backspace merge (U3) concatenates the two paragraphs' raw source: delimiters at the join form new markup

- **What goes wrong for the user:** After a Backspace merge, characters the user saw disappear into italic, code, strikethrough, a formula or a list marker; ⌘Z restores it.
- **Repro:** `MDR_PORT=5282 node bench/verify/v2-ses-merge.mjs ; MDR_PORT=5281 node bench/verify/v2-fid-reach.mjs merge-`
- **Observed:** "a *b" + "c* d" → "a *bc* d" (italic); "1" + ". x" → "1. x" (a list); "abc  " + "def" → "abc  def"; "价格 $x" + "y$ 之后" → "价格 $xy$ 之后" (a formula).
- **Expected:** The merged block shows the two visible texts joined.
- **Baseline:** Not applicable (new feature).
- **Suspected files:** src/preview/inlineEdit.ts, src/preview/serialize.ts
- **Suggested fix:** Serialize the merged DOM (escaping recomputed for the joined context) instead of joining raw source; or the lead documents U3 as raw.
- **Confirm verdicts:**
  - SES-3: **reproduced** — v2-ses-merge 1 run: 8 FAIL. Decisive: FAIL star-forms-em visible "a b|c d" expected "a *bc* d"; digit-then-dot visible "x|" (kinds=4); trailing-spaces visible "abc |def". My severity: low.
  - FID-11: **reproduced** — v2-fid-reach merge-dollar, merge-tilde BROKEN (1 run). Decisive: before "价格 $x\n\ny$ 之后\n" after "价格 $xy$ 之后\n" (renders a formula). My severity: low. Same root cause as SES-3 (U3 joins raw source).

### G18 [low, new-feature-defect] A typed dash line with inner spaces ("-- -", "--- ---") is not escaped and becomes a thematic break

- **What goes wrong for the user:** Rare input: the typed text becomes a horizontal rule; in a list the item disappears.
- **Repro:** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v2-fid-repro.test.ts -t 'FID-4'   (4 failed)`
- **Observed:** "- 第一项\n- --- ---" renders <ul><li>第一项</li></ul><hr>.
- **Expected:** "\-- -" (literal text).
- **Baseline:** Not applicable.
- **Suspected files:** src/preview/serialize.ts
- **Suggested fix:** Line-start escape for the thematic-break shape with "-".
- **Confirm verdicts:**
  - FID-4: **reproduced** — vitest 4/4 failed; v2-fid-reach thematic-typed, thematic-list-item BROKEN. Decisive: md "- 第一项\n- --- ---" renders "<ul><li>第一项</li></ul><hr>". My severity: low.

### G19 [low, new-feature-defect] A heading ending in " #" plus a trailing NBSP loses the "#"

- **What goes wrong for the user:** Rare: a "#" typed at the end of a heading vanishes from the rendering.
- **Repro:** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v2-fid-repro.test.ts -t 'FID-5'   (2 failed)`
- **Observed:** "## Learn C #" renders <h2>Learn C</h2>.
- **Expected:** "## Learn C \#".
- **Baseline:** Not applicable.
- **Suspected files:** src/preview/serialize.ts
- **Suggested fix:** Treat NBSP as space in the headingEnd escape (or run it after fixNbsp).
- **Confirm verdicts:**
  - FID-5: **reproduced** — vitest 2/2 failed; v2-fid-reach heading-hash-trailing-space BROKEN. Decisive: md "## Learn C #" renders "<h2>Learn C</h2>". My severity: low.

### G20 [low, new-feature-defect] An inline formula directly followed by a digit is written as $x$1 and no longer closes

- **What goes wrong for the user:** Rare: two formulas turn into a red KaTeX error after an edit next to them.
- **Repro:** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v2-fid-repro.test.ts -t 'FID-7'   (1 failed)`
- **Observed:** "公式 $x$1 个与 $y$ 结尾" renders [MATH ERROR].
- **Expected:** Formula x, "1 个与", formula y (e.g. "$x$&#49;").
- **Baseline:** Not applicable.
- **Suspected files:** src/preview/serialize.ts, src/worker/math.ts
- **Suggested fix:** Write a digit that follows a math placeholder as a numeric entity.
- **Confirm verdicts:**
  - FID-7: **reproduced** — vitest 1/1 failed; v2-fid-reach math-then-digit BROKEN. Decisive: md "公式 $x$1 个与 $y$ 结尾" renders "[MATH ERROR]". My severity: low.

### G21 [low, new-feature-defect] Adjacent formatting of different kinds (**粗体**~~删除~~) is rewritten as raw HTML

- **What goes wrong for the user:** Source noise: <del> / <strong> appear in a file the user wrote without HTML; the rendering is equivalent.
- **Repro:** `perl -e 'alarm 110; exec @ARGV' npx vitest run test/v2-fid-repro.test.ts -t 'FID-8'   (2 failed)`
- **Observed:** "**粗体**~~删除~~ 文本" → "**粗体**<del>删除</del> 文本".
- **Expected:** Delimiters kept.
- **Baseline:** Not applicable.
- **Suspected files:** src/preview/serialize.ts
- **Suggested fix:** gluedToFormatting answers true only when the neighbour uses the same delimiter character.
- **Confirm verdicts:**
  - FID-8: **reproduced** — vitest 2/2 failed; v2-fid-reach glued-formatting-html BROKEN. Decisive: after "**粗体**<del>删除</del> 文本\n". My severity: low.

### G27 [low, pre-existing] An unmodified save normalises mixed line endings to CRLF and CR-only endings to LF

- **What goes wrong for the user:** Whole-file diffs in version control for files with mixed endings.
- **Repro:** `node bench/verify/v2-dec-roundtrip.mjs`
- **Observed:** "a\r\nb\nc\r\n" saved as "a\r\nb\r\nc\r\n"; "a\rb\rc\r" as "a\nb\nc\n".
- **Expected:** Untouched lines keep their bytes, or the user is told.
- **Baseline:** Frozen 0.1.0 fileIO: identical.
- **Suspected files:** electron/fileIO.mjs
- **Suggested fix:** Not a blocker: document it or note mixed endings on the first save.
- **Confirm verdicts:**
  - DEC-7: **reproduced** — v2-dec-roundtrip 1 run. Decisive: "utf-8 mixed LF/CRLF | 0.1.0: DIFFER at byte 4: 0a630d0a → 0d0a630d0a | 0.2.0: same". My severity: low.

### G33 [low, regression-vs-shipped] A rejected 打开… picker is reported as 「需要重新授权访问该文件」

- **What goes wrong for the user:** A false instruction in a rare situation (a second picker request, a lost activation).
- **Repro:** `node bench/verify/v2-flow-web.mjs W5   (baseline: MDR_DIST=release/baseline-0.1.1.noindex/dist node bench/verify/v2-flow-web.mjs W5)`
- **Observed:** ["无法打开该文件：需要重新授权访问该文件"] for NotAllowedError and SecurityError.
- **Expected:** The real reason or a neutral message.
- **Baseline:** "打开失败：File picker already active." (true, English).
- **Suspected files:** src/app/native.ts, src/app/App.ts
- **Suggested fix:** Do not classify picker rejections as permission problems.
- **Confirm verdicts:**
  - FLOW-6: **reproduced** — candidate 1 run, baseline 1 run. Decisive: candidate: NotAllowedError → ["无法打开该文件：需要重新授权访问该文件"]; baseline: ["打开失败：File picker already active."]. My severity: low.

### G34 [low, new-feature-defect] Persistent open-error toasts pile up, outlive a successful open of the same file, and Escape does not dismiss them

- **What goes wrong for the user:** Clutter after a batch of failures and a stale error next to the document that did open.
- **Repro:** `MDR_TARGET=staging node bench/electron/v2-flow-desk.mjs D4`
- **Observed:** 10 toasts, box {"top":371,"h":457,"w":527}, still 10 after 9 s and after Escape; stale error for missing-0.md after it opened.
- **Expected:** Clear a path's error when it opens; cap the stack; Escape dismisses.
- **Baseline:** One coalesced toast "…×10" (39 px), gone after 8 s.
- **Suspected files:** src/app/native.ts, src/app/toast.ts, src/app/App.ts
- **Suggested fix:** Register open-failure toasts by path; cap the error stack.
- **Confirm verdicts:**
  - FLOW-7: **reproduced** — staging 1 run, baseline 1 run. Decisive: toasts after 10 failures: 10, stack box {"top":371,"h":457,"w":527}; after Escape: 10; stale error after a successful open of missing-0.md. My severity: low.

### G35 [low, new-feature-defect, timing-sensitive] A renderer crash within milliseconds of 丢弃 leaves the discarded untitled draft and the next launch offers it

- **What goes wrong for the user:** A rare spurious restore offer; nothing is lost.
- **Repro:** `MDR_TARGET=staging node bench/electron/v2-flow-desk.mjs D3`
- **Observed:** FAIL D3 crash: … "thrown away crash" (2 of 3 runs on the quiet machine).
- **Expected:** The discarded text is not offered again.
- **Baseline:** The baseline never deletes the draft.
- **Suspected files:** src/app/App.ts
- **Suggested fix:** Await the draft deletion before the 丢弃 answer resolves, or accept as a known limit.
- **Confirm verdicts:**
  - FLOW-8: **flaky** — 3 runs: 2 of 3 failed. Decisive: FAIL D3 crash: the discarded untitled draft is not in IndexedDB — "thrown away crash"; next page offers 1. My severity: low.

### G36 [low, pre-existing] 新建 on a clean untitled document stacks duplicate draft offers

- **What goes wrong for the user:** Cosmetic: three identical restore toasts.
- **Repro:** `node bench/verify/v2-flow-web.mjs W3`
- **Observed:** offers 3 (candidate and baseline).
- **Expected:** One offer.
- **Baseline:** Identical.
- **Suspected files:** src/app/App.ts
- **Suggested fix:** Skip offerDraft when an offer for that docId is on screen.
- **Confirm verdicts:**
  - FLOW-9: **reproduced** — candidate 1 run, baseline 1 run. Decisive: FAIL W3 … offers 3 (both). My severity: low.

### G38 [low, pre-existing] ⌘Q while the dirty-close question is up and the window is minimised or the app hidden does nothing visible

- **What goes wrong for the user:** Quitting appears to do nothing; the question stays hidden.
- **Repro:** `node bench/electron/v2-shell-life.mjs e2quit   (baseline: MDR_TARGET=baseline)`
- **Observed:** exit=null post={"windows":1,"min":true…} / {"hidden":true} (both builds).
- **Expected:** The question comes to the front.
- **Baseline:** Identical.
- **Suspected files:** electron/main.mjs
- **Suggested fix:** before-quit: focusWindow() when closeAsked is already true.
- **Confirm verdicts:**
  - SHELL-3: **reproduced** — staging 1 run, baseline 1 run. Decisive: FAIL [e2quit] close question + minimize + ⌘Q … exit=null post={"windows":1,"min":true} (both). My severity: low.

### G39 [low, pre-existing] Desktop menu 编辑 → 撤销 undoes the document while a UI text field has the focus

- **What goes wrong for the user:** Rare: a menu click undoes the document instead of the focused field; redo restores it.
- **Repro:** `npx vite --port 5283 --strictPort & ; MDR_SHELL_DIR=. MDR_DEV_URL=http://localhost:5283 node bench/electron/v2-app-menu-undo.mjs   (baseline: MDR_SHELL_DIR=release/baseline-0.1.1.noindex MDR_DEV_URL='http://localhost:5293/?perf=1' with the 0.1.1 dist served on 5293)`
- **Observed:** focus in palette input: {"doc":"第一行文字。","active":"DIV.cm-content"}; find field the same.
- **Expected:** The menu item undoes in the focused field.
- **Baseline:** Identical RESULT lines.
- **Suspected files:** src/app/App.ts
- **Suggested fix:** runHistory: leave the step to a focused input / textarea outside CodeMirror.
- **Confirm verdicts:**
  - APP-4: **reproduced** — candidate 1 run, baseline 1 run. Decisive: RESULT menu-undo, focus in palette input (typed "mode") = {"doc":"第一行文字。","active":"DIV.cm-content"} (both). My severity: low.

## Whole unit suite (step 2)
- npx vitest run --no-file-parallelism, once: 71 files / 1270 tests, 6 files and 51 tests failed, 85.2 s.
- The 64 pre-existing files (1209 tests) all pass. Every failure is in a v2 file and belongs to a finding: v2-fid-repro 26 (FID-1 5, FID-2 3, FID-3 3, FID-4 4, FID-5 2, FID-6 2, FID-7 1, FID-8 2, FID-9 2, FID-10 2), v2-dec-decoder 12 (DEC-1 5, DEC-2 2, DEC-3 2, DEC-4 1, DEC-5 1, DEC-6 1), v2-rev-forged-attrs 6 (REV-1), v2-ses-autolink 3 (SES-2), v2-ses-emptyitem 3 (SES-7), v2-fid-fuzz 1.
- v2-fid-fuzz 'I3/I4 over 500 documents (seed 7)' fails with 7 render diffs; re-run with MDR_FID_VERBOSE=1: 2 are FID-1 (bare URL after a closing ** / a letter), 3 are FID-6 (NBSP-only paragraph or line dropped), 1 is FID-4 (typed '-- -'), 1 is a harness artefact (an <a> left empty after deleting its whole text, which Chromium does not produce). No unexplained failure. v2-fid-listcache passes.

## Performance (step 3)
- npx playwright test (bench/perf.spec.ts, large.md, own Vite on 5199), once, 57.6 s: FAILED on one budget, P5 main/keystroke p95 = 30.7 ms (target < 30). All others pass: P1 open→first-visible 205.2 ms (< 400), P4 longest open task 0 ms (< 120), P4 late long tasks 0, P5 max 38.4 ms (< 60), P5 keystroke→mount p95 34.6 ms (< 40), P8 slow frames 0 % (< 3), P11 undo step p95 0 ms (< 5). Single run on a quiet machine, 0.7 ms over; K6 accepts CodeMirror's per-keystroke parser cost in very large files, so this is reported, not filed. Playwright's test-results/ folder was moved out of the tree.
- bench/verify/inline-verify-perf.mjs (MDR_PORT=5288): 5/5. large.md session start max 5.3 ms; per-keystroke preview work p50/p95/max 0.3 / 0.6 / 1.8 ms; CodeMirror dispatch p95 1.3 ms; 0 long tasks; 300-line list session start 16.4 ms, flush p95 2.9 ms; medium.md 20 tables start p95 1.5 ms, flush p95 1.4 ms.
- bench/verify/inline-verify-resume.mjs: 13/13. Enter → resumed session median 32 ms (small.md, 26-41) and 35 ms (large.md, 29-40).
- bench/verify/inline-verify-render.mjs: 12/13, 4 runs, always the same step: 'split · large.md: Enter in a block scrolled far down → session resumes' — 'no paragraph on screen'. Not a product failure: the harness precondition fails (after the 300 000 px wheel no '性能测试的段落' paragraph lies fully inside the viewport: candidates at 710-838 px with the limit at 825 px; traced with bench/verify/v2-cfm-render-diag.mjs). The other 12 checks (no re-render during typing, structure tiles, scroll sync within 1 block, eviction survival, 0 px drift in split small / large and preview mode) pass. None of the three scripts writes into bench/verify/out (checked).

## What the verifiers attacked without breaking it

**verify-fidelity**
- I1: click into a block and Esc writes nothing: v2-fid-walk.mjs in Chromium over README, CONTRACT, SPEC, WIP-inline-edit, FINDINGS-inline-r1, small.md, medium.md lines 1-700 and an adversarial document: 705 blocks, 0 writes, 0 version changes
- I2: an edit never touches bytes outside the edited block's lines: the same 705 blocks with 14 risky strings typed at the start or end: 0 changed lines outside the block
- I4: cached list serialization equals uncached: v2-fid-listcache.test.ts, seeds 11/12/13, about 430 comparisons and 9900 cache hits each under structural edit sequences, plus a 1000-item list: 0 mismatches
- Reduced escaping of $ ~ [ ] is safe: v2-fid-fuzz.test.ts seeds 7-10 (1300-1900 serializations each): every failure maps to FID-1/4/6/7 or a harness artefact; no $ / ~ / [ / ] context-count failure
- linkifyEndsAfter's following side for punctuation, CJK, whitespace: jsdom and Chromium cases ('...', '，', '（', quotes after a path-less host, links in strong / em / cells, www., IPv6, ports, queries, fragments): all render the same except FID-1 / FID-2
- tableDelim / tightHeadings hints, common heading-end escapes, NBSP while typing: tight headings before fence / $$ / table / paragraph, a table in a list item, ' #' after <em>, NBSP-only task item: byte-identical or held 3/3

**verify-session**
- Plain typing across splits and merges loses or reorders nothing (apart from SES-1 / SES-9): oracle fuzz v2-ses-fuzz.mjs: seeds 1-28 small document at machine speed (about 140 ops each) 28/28, large.md seeds 1-6 5/6 (the failure is SES-9), human speed 6/6
- Undo all the way restores the original byte for byte; redo restores the final text; held ⌘Z works: v2-ses-undo.mjs 8 mixed sequences stepwise 8/8, held ⌘Z / ⇧⌘Z x25 8/8, every fuzz seed ends with undo / redo to the ends (34 seeds)
- The resume window handles every block kind for plain keys: v2-ses-resume.mjs 53 cases (paragraph, heading, list, task, quote, code, table cell, last block, line-start syntax in the second half, Shift/Alt arrows, CJK insertText, IME commit, emoji): all held except SES-1 / SES-9
- IME inside sessions and across the resume window: v2-ses-ime.mjs 10 CDP compositions (commit with Enter, Backspace in a composition, Esc, 3 s open compositions, across the resume window): 10/10
- Paste is plain text and follows U6 / the contract: v2-ses-paste.mjs 28 cases (code, CRLF, tabs, fences inside, prose paragraphs, Markdown syntax pasted literally, text/html ignored, cells, headings, quotes, ⌘X, paste in the resume window): all held
- ⌘E / ⌘B / ⌘I / ⌘K never leave zero-width spaces or style / <a> markup: v2-ses-format.mjs 50 cases: 0 ZWSP, 0 style=, 0 <a in the source; failures only SES-5 / SES-2
- What the session shows equals what the source renders to: v2-ses-wysiwyg.mjs seeds 1-22 on a mixed document: 13 clean, all 9 mismatches trace to SES-5 or SES-7

**verify-app**
- A session survives UI actions that keep the focus: toolbar heading button, window resize, wheel to the end of a 400-paragraph document, theme / TOC / palette keys mid-typing: all pass
- Export during a session has no session artefacts; ⌘S writes text typed 0 ms before: file.exportHtml after collapsed ⌘E: no contenteditable / is-editing / U+200B; legacy download contains a character typed 0 ms before (except APP-1)
- Replacing the document while a session holds unwritten text asks once and never leaks old text: v2-app-replace C2-C5: drop 0 ms after typing and with a pending deletion, Shift-Cmd-E and Cmd-/ with a pending deletion
- Long use does not leak: 2000 keystrokes in one session with 9 splits exact; 200 sessions in a row: 1 capture textarea, 0 leftovers, DOM 290 -> 303 nodes, heap 17.5 -> 18.3 MB
- Shortcut routing: v2-app-shortcuts.mjs 18/18 (editor-only shortcuts show the hint, session keys and global shortcuts work); v2-app-undo.mjs keyboard ⌘Z routing on candidate and baseline
- No regression in old UX scenarios, large.md behaviour, and the preview with 预览可编辑 off: 18 bench/verify/fx scripts on candidate and 0.1.1 dist: no item worse; v2-app-large.mjs identical values; v2-app-regress with MDR_EDIT=off equals the baseline

**verify-flows**
- R1: one question at a time; a document arriving during the desktop close question is shown afterwards: D2 on staging with 不保存 / 取消 / cancelled save, 2 runs each plus the baseline; D8 with a slow 10 MB load; D7 取消
- R2: drafts are deleted on 新建→丢弃, 不保存 and 丢弃+close, and kept on 取消 and failed opens: W2, D2, D3 close (gaps 0 and 300 ms), W4
- Crash drafts survive reloads, minimise / hide, close and reopen: W1r 3 reloads; D1 / D6 on staging and baseline
- R3 messages from open-file and recent entries are true and name the file: D4, D5 open-file (undecodable, no permission), D8 moved recent entry, W4 revoked permission and deleted OPFS file
- The document guard does not stick after odd drops; beforeunload with a dirty document: D9 FIFO drop then open-file works; W6 one prompt

**verify-shell**
- E3: navigation handlers never leave the queue ready without a page, nor buffering for ever with one: v2-shell-nav.mjs 19 scenarios (reloads, aborted navigations, crashes, stops, during the close question): staging 22/22, baseline 17/22 (all 5 in the fixed class)
- E1: the last request is shown and nothing opens twice: 17 burst cases (ABA, AAB, ABCAB, BAA, during the close question, across a crash): staging all pass, baseline fails 15
- E2 / E4 / E5 / menu: E2 9 state x trigger cases + 1 (10/10); E4 14/14 except SHELL-2; E5 17 argv classes cold and second-instance; all 30 custom menu items send their own id once
- Regression sweep of the existing lifecycle scripts on staging; startup reliability: open-lifecycle 27/27, verify-hotfix-behaviour 122/125 (K7 and an expectation change), interleave 6/6, hunt-startup 13/13, gestures 4/4; 10 cold starts 0.64-1.04 s

**verify-decoder**
- Strict UTF-8, UTF-8 BOM and UTF-16 BOM at least as good as 0.1.0: differential, 2 seeds x 10 000 inputs per family (zh, mixed scripts, fr/de/pl/ru/el/tr, four line-ending variants, 25 % BOM, 1 byte to 150 KB): 0 regressions, 0 new refusals
- Simplified Chinese GBK / GB18030 keeps 0.1.0's answer: 20 000 inputs per family over 2 seeds, GB2312 pools at 1-40 characters: 0 regressions (failures only with GBK-extension characters: DEC-3)
- Big5 / Shift_JIS / EUC-KR detection improves without refusals: big5 8395/10000 improved, sjis 7257, euckr 6167, 0 regressions
- 96 KB sampling, 40 % NUL rule, 50 % control rule, lenient UTF-8 dialog and save, cut files, encoder table equality: v2-dec-large.mjs sizes and cut points; 300 inputs per threshold point; staging e2e of a stray 0xFF (exact EF BF BD); 4000 cuts per family (candidate clearly better); v2-dec-tables 0 table differences

**verify-review**
- Sanitizer configuration, CSP and preload unchanged from 0.1.1: bundled DOMPurify config strings identical; protocol.mjs and preload.cjs byte-identical
- ⌘K javascript: URLs and text/html pastes cannot inject live markup: browser, 3 runs each: 0 live javascript: links, onerror never ran
- An Enter-split resume never lands in a newly opened document: slow-worker hook, 3/3 untouched (confirmed again by the confirm agent, 3/3)
- Question gate, document guard and resolveClose release on every path; toasts / dialogs use textContent; E5 and navigation do not widen what a link can open; replace() never splits a surrogate pair: code review of dialogs.ts, native.ts, toast.ts, paths.mjs, main.mjs, peerLine.ts, previewEdit.ts commonEnds / validRange

## What nobody covered

**confirm**
- inline-verify-render.mjs's last step ('split · large.md: Enter in a block scrolled far down → session resumes') never reached its assertion on this machine (4 of 4 runs: no needle paragraph fully inside the viewport where the 300 000 px wheel lands; traced with bench/verify/v2-cfm-render-diag.mjs). An Enter resume far down large.md in split mode after a wheel scroll is therefore not verified by that script this round (verify-session's large.md fuzz covered resumes at line ~54 400 without a wheel scroll).
- SES-4 was re-run only at 200 KB (multi-line) and 100 KB (single line); the 400 KB and 1 MB numbers are the verifier's.
- REV-2 was reproduced only with the slow-worker hook; natural timing was not attempted by anyone.
- The P5 budget miss (30.7 ms vs < 30) was not compared with 0.1.1: the spec runs against the dev server, the baseline exists only as a production dist.

**verify-fidelity**
- What the serializer receives during an IME composition and from pasted text/html
- Sessions inside the desktop shell (only the web renderer was driven)
- test-data/medium.md beyond line 700 and the 200 KB plain fallback (K6)
- jsdom-only suspicions not reproduced in Chromium: '*a * b*' with 'a' deleted → '** b*' (serialize.ts:180); nested strong inside strong (mergeAdjacentFormatting / flankOk); an emptied task item writes '- [x]' rendering literal '[x]'
- Escaping inside raw inline HTML beyond <kbd>

**verify-session**
- Desktop shell: native menu 撤销 / 重做 and format commands inside a session (K2 area; native.ts / App.ts runShellCommand)
- Real macOS input methods (compositions emulated through CDP)
- Drag and drop of text inside a session and a file dropped onto a live session (inlineEdit.ts onDrop ~1388, App.ts onDrop ~1138)
- A split resume that hits the natural 2.5 s timeout (tryResume, inlineEdit.ts ~606-643)
- Right-click context-menu actions in a session
- Not filed: the capture textarea stays in the preview after the first resume (inert); deleting a whole block leaves an extra blank line; a paste starting with blank lines glues its first paragraph to the current one (spec question)

**verify-app**
- Web File System Access save path and the desktop native save with APP-1 (same save() → previewEdit.flush(), very likely affected)
- Recent entries and a restored draft while a session holds pending text; a crash draft written while an emptied block is pending
- Real OS drag-and-drop gestures and OS documents arriving during a session
- Printing during a session (no print CSS at all, pre-existing)
- Desktop native menu format commands routed into a live session
- Focus line / TOC right after a resumed session in very large documents; scroll sync while a session grows a block at the bottom

**verify-flows**
- Desktop counterpart of FLOW-1: under Playwright minimise / hide never make visibilityState hidden, so whether the installed app overwrites a crash draft that way is unverified (App.ts onVisibility)
- Real Finder drags (a folder named *.md, several mixed files)
- ⌘Q with the 打开… panel up; menu 新建 / 打开… while the panel or the close question is up
- Closing while an IME composition is open in a preview session, and a close within one frame of typing in a session
- A save during which the user keeps typing (save() clears the draft after the await; pre-existing by reading)
- Web legacy backend: two files with the same name share docId legacy:<name> and their drafts
- argv and 重新载入 failure messages; paths with unusual characters in toasts

**verify-shell**
- The packaged .app (LaunchServices / AppKit argv-to-open-event duplication, app.isPackaged differences)
- Real OS gestures (Dock clicks, real ⌘H / ⌘Q, Spaces); logout with a pending close question
- An extensionless binary passed in argv opens as lenient UTF-8 garbage instead of being refused (decoder question)
- Other document-triggered navigations: SVG xlink:href, <set> / <animate> on href, keyboard activation of an SVG link (SHELL-1 area)
- The Shift-Cmd-E key binding in the renderer

**verify-decoder**
- Encodings outside both label sets (ISO-2022-JP, EUC-JP, UTF-32, long GB18030 four-byte texts)
- Mixed-encoding files (UTF-8 majority with one GBK paragraph reads as lenient GBK in 27 % of 3-paragraph cases; not filed)
- Open paths other than open-file (打开… panel, drag and drop, recent list, 重新载入)
- Draft / crash restore of a lenient-decoded document
- DEC-2 for further duplicate-mapped characters in EUC-KR / GBK beyond the table audit

**verify-review**
- inlineEdit.ts end() (~511-530): if commit() / serializeBlock throws, the session is not torn down (no DOM found that throws)
- inlineEdit.ts onResumeKey (~658-683): during a resume Tab is preventDefaulted and Escape stopPropagated for dialog buttons / toolbar (seen only inside REV-2)
- Mode switch and the desktop close question during a resume (REV-2 root cause, not measured separately)
- offsetForSource (~239-295) counts raw inline HTML tags as shown text (caret after undo could land inside a surrogate pair; not reproduced)
- interactions.ts:126: in the web build ⌘-click on a user-typed javascript: link opens a popup (EXTERNAL_RE accepts any scheme)
- refusedAt grows per refused block id across documents (tiny leak)
- electron/fileIO.mjs and the equality of dist/ with src/ were not reviewed (the confirm agent checked dist/ = staging dist/ only)

## Notes on the verifiers' scripts
- bench/verify/v2-app-replace.mjs, v2-app-stale.mjs (v2-app-lib ensureServer): when no server answers they spawn their own Vite without unref, so node never exits after printing its result. Start npx vite --port 5283 --strictPort first (the repro commands above say so).
- bench/verify/v2-ses-*.mjs leave a detached Vite on 5282 by design (v2-ses-lib); stop it with lsof -ti tcp:5282 | xargs kill.
- v2-app-stale.mjs S1 counts 'no session after the click' as PASS; its detail line (session=no, X absent) is the APP-1 symptom.
- v2-ses-format.mjs autolink and e-shift-enter cases are info-only (expectation null): they print PASS while their src shows SES-2 / the SES-5 code-break loss.
- v2-rev-browser.mjs race needs its slow-worker hook; the split variant passes 3/3.
