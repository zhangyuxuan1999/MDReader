# 预览内编辑 — 验证 r1 发现（2026-09-30）

I found 3 high and 5 medium problems with editing inside the preview, so a fixer should run before wrap-up. Much of the feature works well, but the most common real-world case is broken: typing in the preview after scrolling down in split mode.

**High**
1. **Split mode: the first keystroke jumps the preview to the top.** Scroll the preview down with the wheel, click a paragraph, type one character: the preview jumps to the editor's caret line, which is line 1 right after opening a file. The drift is -28,579 px on small.md and -300,071 px on large.md, and the packaged app does the same. The user keeps typing into a block that is off screen. On large.md, pressing Enter then never resumes editing, and everything typed afterwards is lost. The cause: each preview write makes CodeMirror emit a cursor event, and scroll sync follows it (`src/preview/scrollSync.ts:159`, emitted at `src/app/App.ts:590`). The integrator's `previewWriteGate` filters only the focus-line tint. The status bar and TOC also show line 1 for the same reason. Preview-only mode is not affected.
2. **Pasting several lines into a code block loses every newline.** The lines are merged into one (`onPaste` uses `insertText`; Enter was already fixed to use `insertLineBreak`).
3. **⌘K with no selection writes raw HTML into the file.** The source gets `<a … style="background-color: rgb(250,248,244)">…</a>`, which shows as a beige box in dark mode.

**Medium**
4. Keys typed in the ~30 ms between an Enter split and the resumed session are dropped: Backspace, Delete, and Chinese text committed without a keydown. The first edit of a heading directly followed by a paragraph or table goes through the same path. In the fidelity sweep, docs/SPEC.md:392 was left with a stray "x".
5. There is no way to undo an accidental Enter in the preview. Backspace at the start of a block does not merge it back, and ⌘Z after the split does nothing.
6. ⌘Z inside a session undoes one character per press. Other parts of the page update on every keystroke, which stops Chrome from grouping the typing. In the web version's preview-only mode, ⌘Z after the session ends does nothing.
7. ⌘E with no selection does not start inline code, although the hint bar advertises it.
8. A 300-item list costs 48 ms per keystroke (target under 10 ms) and 64 ms to start editing; a 1000-item list costs about 385 ms per keystroke.

**Low**
- Changing one character rewrote the source of 54 of 218 blocks: table separator rows become `| --- |`, `[1]` and `$5` get backslashes, setext headings become `#`, a blank line is inserted after a heading, reference links become inline, `&nbsp;` becomes a plain space. Only the `&nbsp;` change alters what is displayed; the integrator's table-row note is part of this.
- ⌘1–⌘6, ⌘⇧X and ⌘F silently do nothing during a session.
- A block is refused for editing when inline code contains `<!--`.
- An emphasis containing only spaces is written as raw HTML.

**What passed**
- Clicking into a block and pressing Esc wrote nothing and left all 218 blocks byte-identical.
- 40 characters at 40 ms kept the caret in place in all 11 positions (inside bold, block start and end, inline code, list, nested list, table cell, code block, quote, heading, last block).
- Every Markdown character typed literally (`*`, `_`, backtick, `$`, `<b>`, `[`, `#` or `1.` at line start, and so on) came back as the same literal text.
- IME composition wrote nothing until it was committed.
- While typing, no other block changed and the edited block was never re-rendered. The block structure stayed exact and scroll sync was 0 blocks off.
- The edited block survived scrolling 30 screens away and back.
- The interaction checks passed 21 of 21: ⌘S web download, mode switches, theme, palette, TOC toggle and click, Alt+click, checkboxes, links, toggle off, drafts, new file and open file mid-typing.
- Speed is fine for normal blocks: on large.md, starting an edit takes under 5 ms, the preview's own work per keystroke is 0.6 ms (95th percentile), and there were no long tasks. On medium.md, 20 tables each took 2.8 ms to start and 1.7 ms per write, and all stayed valid.
- In the packaged app: the menu toggle and ⌘⇧E work, the unsaved dot appears on the first preview keystroke (266 ms), and ⌘S writes the exact bytes, including after an Enter split.
- No console or page errors anywhere.

I did not change `src/` or `electron/`. My scripts are `bench/verify/inline-verify-{lib,fidelity,editing,render,interplay,resume,perf,fuzz,desktop}.mjs`; each starts and stops its own Vite on :5263. The desktop run used an isolated profile and did not touch your installed MDReader. No processes are left running. The fidelity details are in `bench/verify/out/inline-verify-fidelity.json` and the three screenshots in `bench/verify/out/inline-verify-shots/`. The third screenshot shows the lost-typing bug: after Enter, only "新" of "新段落从这里开始" survived. I appended my start, progress and done lines to `docs/AGENT-LOG.md` under 当前运行.

Next: a fixer for the high and medium items. Then I (or another verifier) re-run these scripts; the currently failing steps in the render and editing scripts serve as the regression checks. Then the lead's wrap-up.

## Findings

- **[high] Split mode: the first preview keystroke in a block below the first screen scrolls the preview back to the editor's caret line (line 1 after opening a file). On large.md, Enter then fails to resume the session and everything typed afterwards is lost.**
  - file: src/preview/scrollSync.ts
  - expected: The preview stays where it is and the edited block stays on screen. Enter resumes the session on the new paragraph, and typing lands there.
  - actual: Preview scrollTop jumps:
- small.md: 28598 → 0 px (top line 1000 → 1)
- large.md: -300071 px
- packaged app: 28598 → 0
The edited block is off screen while the user keeps typing blind.

On large.md after Enter:
- the new block is never mounted, so the resume never starts (no session after 3 s);
- 'abc' is lost;
- the split write leaves '&nbsp;over the lazy dog.' in the source.

The status bar and TOC also show the editor caret line (行 1) instead of the edited line. Preview-only mode is not affected (0 px drift).
  - repro: Web or packaged app, split mode:
1. Open test-data/small.md or large.md.
2. Scroll the PREVIEW down with the mouse wheel (10+ screens) and click into a paragraph.
3. Type 'xyz'.
bench/verify/inline-verify-render.mjs, 'typing in a block scrolled far down' steps; desktop: bench/verify/inline-verify-desktop.mjs.
For the lost typing: on large.md, click the paragraph at line 50017, press Enter, then type 'abc'.
  - fix: Root cause: every preview write dispatches a CodeMirror transaction tagged userEvent 'input.type.previewEdit'.
- CodeMirror's onCursor then emits doc:cursor with typing=true for the editor's unfocused caret (App.ts:590).
- scrollSync's offCursor (scrollSync.ts ~159) calls preview.scrollToLine(thatLine), because that line is not visible.
- previewWriteGate only filters the focus-line consumer.

Fix options:
- Gate the doc:cursor emission, or scrollSync's offCursor, while a preview write or session is active (e.g. skip when previewEdit.sessionActive() || previewWrites.noted), or emit typing=false for 'input.type.previewEdit' transactions.
- Better: in createSourceAccess.replace, move CodeMirror's selection to the end of the replaced range (the edited block). The editor caret, TOC and status bar then follow the preview edit, and the follow target is the visible block.

Add the render-script steps as regression tests.
- **[high] Pasting multi-line text inside a code fence loses every newline**
  - file: src/preview/inlineEdit.ts
  - expected: ```js
const a = 1;
const c = 3;
const d = 4;
const b = 2;
```
  - actual: Source line: 'const a = 1;const c = 3;const d = 4;'. The lines are merged, so the pasted code is corrupted.
  - repro: 1. Open a doc with the fence ```js / const a = 1; / const b = 2; / ```.
2. Click into the code and put the caret after 'const a = 1;'.
3. Paste text/plain '\nconst c = 3;\nconst d = 4;'.
bench/verify/inline-verify-editing.mjs, 'paste multi-line text inside a code fence'.
  - fix: In onPaste, the code branch calls exec('insertText', text) with '\n' inside <pre>. Chrome's insertText('\n') splits or drops newlines, the same bug the integrator fixed for Enter. Split the text on '\n' and call exec('insertLineBreak') between the lines (or insertText per line), as the prose branch does. Add a unit or e2e test.
- **[high] ⌘K with a collapsed caret writes raw HTML with an inline style into the Markdown source**
  - file: src/preview/inlineEdit.ts
  - expected: '…合并。[https://c.example/](https://c.example/)后', or a bare autolink.
  - actual: '…合并。<a href="https://c.example/" style="background-color: rgb(250, 248, 244);">https://c.example/</a>后' is written to the file. The light-theme background is baked in, so it shows as a beige box in dark mode.
  - repro: 1. Click into a paragraph and place the caret at its end (no selection).
2. Press ⌘K, type https://c.example/ and press Enter.
3. Type '后'.
bench/verify/inline-verify-editing.mjs, '⌘K with a collapsed caret'.
  - fix: closeLinkUi's collapsed branch uses exec('insertHTML', '<a href>…</a>'), and Chrome copies the computed style onto the inserted element. Insert the <a> through the DOM (range.insertNode plus caret placement, then schedule()), or run insertText followed by createLink on the selected URL.

As a safety net, the editing-mode serializer should strip style attributes from Markdown-mappable inline elements (A/STRONG/EM/CODE) instead of falling back to raw HTML. The same concern applies to toggleInlineCode's insertHTML.
- **[medium] Keys typed between a split write and the resumed session are dropped: Backspace/Delete, and CJK text committed without a keydown**
  - file: src/preview/inlineEdit.ts
  - expected: The Backspace deletes the character, or the Enter. The IME-committed text lands in the new paragraph.
  - actual: - The Backspace is silently dropped and 'x' stays.
- CJK insertText in the ~30 ms window is lost; the screenshot run typed '新段落从这里开始' and only '新' survived.
- The resume window is 27–42 ms on small.md.
  - repro: Three cases:
(a) Doc '## 标题\n紧跟的段落文字。'. Click after '段落', type 'x', and within ~20 ms press Backspace. The first edit of a heading+paragraph block inserts a blank line, so it is a split.
(b) Enter mid-paragraph, then Backspace within 30 ms.
(c) Enter, then CDP Input.insertText('新段落') within 0–30 ms.
Scripts: bench/verify/inline-verify-editing.mjs and bench/verify/inline-verify-resume.mjs. The fidelity sweep hit (a) on docs/SPEC.md:392 (heading directly followed by a table): 'next editx |'.
  - fix: onResumeKey only buffers printable keys, and Backspace only when the replay buffer is non-empty. Buffer every editing key in the window (Backspace, Delete, arrows, Enter) plus beforeinput/insertText and composition data, and replay them on the new session.

Alternatively, keep the old element contenteditable until the new session begins and map the extra text across. Also consider not treating the first keystroke's blank-line normalisation of heading+content blocks as a split that ends the session.
- **[medium] No way to undo an accidental Enter in the preview: Backspace at block start does not merge, and ⌘Z after the split does nothing**
  - file: src/preview/inlineEdit.ts
  - expected: Typora-like behaviour: Backspace at the start of a block merges it into the previous block, and ⌘Z undoes the split.
  - actual: The source stays split ('第二段落用于测试回车' / '' / '拆分和退格合并。'). Backspace at a block start writes nothing, and the resumed session's native undo history is empty. The only remedy is to leave the preview and undo in CodeMirror.
  - repro: 1. Click mid-paragraph ('回车|拆分') and press Enter. The session resumes on '拆分和退格合并。'.
2. Press Backspace at offset 0, or press ⌘Z.
bench/verify/inline-verify-editing.mjs, 'accidental Enter…' and '⌘Z inside the session after an Enter split'.
  - fix: Handle Backspace at text offset 0 (and Delete at the end) in onKeyDown for Prose/Heading/Quote. Merge through the source: replace the previous block's lines plus this block's lines with the joined text, then resume with the caret at the join.

When execCommand('undo') is a no-op (queryCommandEnabled('undo') is false), fall back to CodeMirror's undo(). Its history groups preview writes under 'input.type.previewEdit'.
- **[medium] ⌘Z inside a session undoes one character at a time; in web preview mode ⌘Z after the session ends does nothing**
  - file: src/app/App.ts
  - expected: One ⌘Z undoes the typing burst (Chrome's default coalescing, as in a plain contenteditable). ⌘Z after the session undoes the preview edit.
  - actual: Step 1: 'undo tes'. Each ⌘Z removes a single character. Control check: a plain contenteditable with a per-keystroke DOM mutation elsewhere on the page shows the same behaviour, so the per-keystroke CodeMirror and status-bar DOM updates break Chrome's typing coalescing.
Step 2: nothing happens. The web build has no global undo binding outside CodeMirror; the desktop menu's runHistory does switch to split.
  - repro: 1. Click into a paragraph, type 'undo test' at 30 ms per key, and press ⌘Z once.
   The packaged app's 编辑→撤销 menu item behaves the same.
2. Web preview mode: type, press Esc, then press ⌘Z.
  - fix: Route ⌘Z/⇧⌘Z during a session to CodeMirror's history, which already groups preview writes (userEvent 'input.type.previewEdit', 500 ms joins). Then re-sync the session block from the source, or end and resume the session.

Add a global Mod-z / Mod-Shift-z handler for preview mode when no session is active, matching runHistory.
- **[medium] ⌘E with a collapsed caret does not start inline code; the typed text lands outside the backticks**
  - file: src/preview/inlineEdit.ts
  - expected: '…`npm i` 完成'. The hint bar advertises '⌘E 行内代码' as the way to avoid typing backticks.
  - actual: '…npm i 完成' with no code span. ⌘B and ⌘I with a collapsed caret do work.
  - repro: Click at the end of a paragraph, press ⌘E, type 'npm i', then press → and type ' 完成'.
  - fix: toggleInlineCode inserts '<code>ZWSP</code>ZWSP' via insertHTML, and the caret ends up after the trailing ZWSP. After inserting, place the caret inside the code's text node, after the ZWSP, so the next insertText goes into <code>. Alternatively, create the element through the DOM and set the selection explicitly.
- **[medium] Per-keystroke cost grows superlinearly with list size: 300-item list 48 ms per key, 1000-item list about 385 ms per key**
  - file: src/preview/serialize.ts
  - expected: The per-keystroke preview work stays under 10 ms at p95.
  - actual: - 300 items: session start 64 ms; flush p50 39 ms / p95 48 ms, of which the preview part is 44 ms.
- 1000 items (45k chars, still under MAX_EDIT_CHARS 60000): about 385 ms per keystroke.
- 50 items: about 13 ms, including the frame wait.
- Normal blocks are fast: large.md paragraph p95 0.6 ms; medium.md tables flush p95 1.7 ms.
  - repro: bench/verify/inline-verify-perf.mjs (300 items) and an ad-hoc run with 50/300/1000 items, dev build.
1. Load a single list block of N items ('- 列表项 i：… **粗体** 与 `code`').
2. Click an item and type.
  - fix: Serialize only the top-level child (the list item) that contains the caret and splice its lines into the block's last written text, or cache the per-item serialization.

Find and remove the superlinear step (likely a whole-block pass per item in escaping or neighbour context). Alternatively, lower MAX_EDIT_CHARS for List/Quote kinds, or throttle serialization for large blocks (write on idle).
- **[low] First edit of a block rewrites non-canonical source (54 of 218 blocks); only &nbsp; changes the rendering**
  - file: src/preview/serialize.ts
  - expected: Click + Esc writes nothing: PASS, 0 writes, byte-identical. A type-and-delete ideally leaves the source unchanged, or applies only documented normalisations.
  - actual: 54 blocks changed after typing and deleting one character:
- Table delimiter row: '|---|' → '| --- |'; ':---' → ':--'.
- Escaping: '[1]', '[x]', 'arr[0]' → '\[1\]'; '$5' → '\$5'; '~~~' → '\~\~\~'.
- Whitespace: tab → space; trailing single space dropped; backslash hard break → two spaces.
- Headings: '### x ###' → '### x'; setext → ATX.
- Quotes: '>>' → '> >' with an added '>' line; lazy continuation gets '> '.
- A blank line is inserted between a heading and the paragraph, table or fence that directly follows it in one block (SPEC.md style).
- Reference links → inline; '[a](<https://x.com/a b>)' → '%20'.
- Loose ordered list gets blank lines between items.
- Entities decoded: '&copy;' → '©', and '&nbsp;' → plain space. This one changes the rendering: the non-breaking space is lost.

Also: typing two spaces collapses to one; typing four spaces at a paragraph start gives '&nbsp; '; pasting paragraphs separated by blank lines leaves '  ' lines. Fuzzing produced raw '<em>&nbsp;&nbsp;</em>' / '<strong>…&nbsp;&nbsp;</strong>' when an emphasis ends in two spaces.
  - repro: bench/verify/inline-verify-fidelity.mjs: 218 blocks from a tricky corpus, README.md, docs/SPEC.md and small.md. For each block: click it, change nothing, press Esc; then type 'x' at the end and delete it. Details are in bench/verify/out/inline-verify-fidelity.json.
  - fix: The contract accepts most of these. To reduce churn for a writer who never looks at the source:
- Keep untouched sibling lines verbatim: diff the serialized block against the baseline per top-level child and splice only the changed child's lines.
- Preserve the table delimiter row when column count and alignment are unchanged.
- Do not escape '[x]' when no link definition or following '(' / '[' makes it a link.
- Keep '&nbsp;' as an entity.
- Move leading/trailing whitespace outside emphasis instead of emitting raw HTML.
- **[low] Editor-only shortcuts (⌘1–⌘6 heading, ⌘0, ⌘⇧X task, ⌘F find) do nothing inside a preview session, with no feedback**
  - file: src/app/App.ts
  - expected: Either the command applies to the edited block (make it a heading, toggle a task) or it is routed to the editor. The typed text must be committed either way; it is.
  - actual: The session is kept, focus stays in the preview, and the source is unchanged. The keys are silently ignored, so a preview writer cannot make a heading without typing '## '.
  - repro: Click into a paragraph in the preview, type, then press ⌘2 (or ⌘F, ⌘⇧X). See bench/verify/inline-verify-interplay.mjs.
  - fix: Route editor-scope shortcuts pressed inside the contenteditable through runEditorCommand. For heading, paragraph and task, implement them in the session: rewrite the block's first line through source.replace and resume. Or at least show a toast.
- **[low] Blocks with '<!--' inside inline code, or inline raw <div> text, are refused for editing**
  - file: src/preview/serialize.ts
  - expected: Only blocks containing real HTML comments or raw block HTML are refused.
  - actual: The guard is source.includes('<!--'), which also matches inside code spans. Inline '<div>' text makes the whole paragraph non-editable.
  - repro: 1. docs/SPEC.md:285, a list whose inline code contains `/^ {0,3}<!--/`, is refused with the toast 此块请在源码中编辑.
2. So is the paragraph '文本里有 <div> 字样和 <span>内联标签</span>'.
  - fix: In unsupportedReason, strip code spans or fences before the '<!--' check, or check the DOM for comment nodes instead of the source.

## Measurements

| name | value | target | pass |
|---|---|---|---|
| fidelity: blocks round-tripped (click+Esc, type+delete) | 218 (tricky 54, README 43, SPEC 44, small-head 77) | >= 60 | ✅ |
| fidelity: click + Esc writes | 0 writes, 218/218 byte-identical | 0 | ✅ |
| fidelity: type+delete byte-identical | 164/218 (54 normalised) | documented normalisations only | ❌ |
| fidelity: type+delete changed rendering | 2 (&nbsp; entity lost; SPEC.md:392 Backspace dropped → 'editx') | 0 | ❌ |
| typing 40 chars @40 ms, caret never leaves (bold mid, block start, block end, inline code, list, nested list, table cell, code fence, quote, heading, last block) | 11/11, same element, only that block's lines changed | all | ✅ |
| literal Markdown chars typed render literally (* _ ` $ <b> [ ] \ | ~~ &amp; <url>, and # 1. - > + --- ``` | at line start) | 20/20 | all | ✅ |
| IME multi-step composition writes while composing | 0 writes; exact text after commit; Enter-confirm adds no paragraph | 0 | ✅ |
| mutations during 40 keystrokes | 40 inside session, 0 in other blocks, 0 element removals under the session section | session only, no replaceChildren | ✅ |
| structure tiles after each write (typing, Enter, Shift+Enter, list Enter, Esc) | 304 blocks tile 1029 lines; equals fresh segmentation | exact | ✅ |
| scroll sync after edit (wheel editor→preview, preview→editor) | 0-block offset in 4 samples | <= 1 block | ✅ |
| split mode: preview scroll drift typing 3 chars far down (small.md / large.md / desktop) | -28579 px / -300071 px / -28597 px (jumps to line 1) | ≈ 0 | ❌ |
| preview mode: preview scroll drift typing far down | 0 px | ≈ 0 | ✅ |
| eviction: session block after scrolling 30 screens away and back (medium.md) | same element, still editing, focus kept, off-screen typing written | kept | ✅ |
| Enter → resumed session window (small.md) | 27-42 ms (median 30) | short; input in it not lost | ❌ |
| Enter → resumed session (large.md line 50017, programmatic scroll) | never resumes (preview jumped to top) | resumes | ❌ |
| large.md session start (mousedown → session), 5 blocks | 4.7 / 0.8 / 0.7 / 0.7 / 0.8 ms | < 50 ms | ✅ |
| large.md per-keystroke preview work (flush minus CodeMirror dispatch) p50/p95/max | 0.3 / 0.6 / 1.0 ms | p95 < 10 ms | ✅ |
| large.md CodeMirror dispatch per preview write p50/p95 | 0.8 / 1.5 ms | info | ✅ |
| large.md input handlers p95 / long tasks / events with processing > 16 ms | 0.1 ms / 0 / 0 | < 2 ms / 0 / 0 | ✅ |
| 300-line list block: session start | 64.2 ms | < 50 ms | ❌ |
| 300-line list block: per-keystroke flush p50/p95 (preview part p95) | 38.6 / 48.0 ms (44.3) | p95 < 10 ms | ❌ |
| 1000-item list per keystroke | ≈385 ms | < 10 ms | ❌ |
| medium.md 20 table blocks: session start p95 / flush p95 / validity | 2.8 ms / 1.7 ms / 20 of 20 valid, structure tiles | < 50 ms / < 10 ms / all valid | ✅ |
| interplay (⌘S legacy download, ⌘/, mode→preview, ⌘⇧L, ⌘⇧P, ⌘⇧O, TOC click, Alt+click, checkboxes, links, ⌘⇧E off, drafts, new file, open file) | 21/21 | all | ✅ |
| desktop packaged app checks | 13/14 (fails: split-mode preview jump) | all | ❌ |
| desktop: first preview keystroke → macOS edited dot | 266 ms (title '● 验证一.md'); cleared after ⌘S | appears on first edit | ✅ |
| desktop: ⌘S bytes on disk (edit; Enter split + typing) | exact both | exact | ✅ |
| editing keys script | 61/69 (failures = findings above) | all | ❌ |
| console / page errors across all scripts | 0 / 0 | 0 | ✅ |
| leftover processes | :5263 free, no vite or packaged-app processes; :5173 and installed MDReader (PID 75456) untouched | none | ✅ |
