# 进行中：预览内编辑（in-preview editing）— 断点记录

更新时间：2026-09-27 01:00（工作流 wf_32ea7e6a-223 因用量限制中断，限额 05:00 重置）

## 状态

| 角色 | 状态 |
|---|---|
| app 工程师（应用端接线/开关/菜单） | ✅ 已完成，结果已缓存（下方） |
| preview 工程师（serialize.ts + inlineEdit.ts + createPreview 新成员） | ⚠️ 代码已全部落盘（未提交报告）：src/preview/serialize.ts、inlineEdit.ts、createPreview.ts 新成员、preview.css、test/serialize.roundtrip.test.ts、test/inlineEdit.test.ts；turndown 已安装。tsc 0 错误、vitest 59 文件 / 1279 用例全过。lead 于 2026-09-27 做过一次冒烟（见下） |
| 集成员 | ❌ 未开始 |
| 验证员 / 修复员 | ❌ 未开始 |

## 恢复方式

用 Workflow 工具恢复（已完成的 app 工程师会直接命中缓存）：

```
Workflow({ scriptPath: "/Users/zyx/.claude/projects/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/workflows/scripts/md-editor-inline-edit-wf_32ea7e6a-223.js", resumeFromRunId: "wf_32ea7e6a-223" })
```

恢复前先确认：`npx tsc --noEmit` 目前只有 `src/preview/createPreview.ts` 缺少新 PreviewApi 成员的报错（预期）；`npx vitest run` 全绿。完成后要做：`npx wrangler deploy`（网页版）、`npm run app:build && npm run app:install`（桌面版）。

## app 工程师的完整报告

### 改动文件

- src/app/previewEdit.ts
- src/app/App.ts
- src/app/focusLine.ts
- src/app/statusbar.ts
- src/app/shortcuts.ts
- src/editor/toolbar.ts
- src/styles/layout.css
- electron/menu.mjs
- test/electron.menu.test.ts
- test/app.previewEdit.test.ts
- README.md

### 实现说明

New module src/app/previewEdit.ts holds the app side of the feature.

(1) createSourceAccess(editor) is the value App passes as PreviewOptions.source.
- read(startLine, lineCount) returns exactly those lines from editor.view.state.doc, joined with '\n' and with no trailing newline. It is clamped to the document, and an impossible range reads as ''.
- replace(startLine, lineCount, text) makes ONE view.dispatch with scrollIntoView:false and does not change focus. If the CodeMirror caret was inside [from, to] it moves to the end of the new text; otherwise CodeMirror's own mapping keeps it where it was. Identical text writes nothing. A range that no longer fits the document gets a console.warn and no write.
- DEVIATION: the userEvent is 'input.type.previewEdit', not 'input.previewEdit'. CM6 history only joins userEvents that match /^(input\.type|delete)($|\.)/, so the literal contract tag would make every rAF write its own undo step. The contract's stated goal is that "consecutive edits group for undo". The new tag still satisfies tr.isUserEvent('input'), and a test proves one undo reverts a burst. It is exported as PREVIEW_EDIT_USER_EVENT.

(2) createPreviewEdit({bus, preview, read, write, onToggle, onSession}) handles the toggle and the session flag.
- It reads LS_PREVIEW_EDIT: default ON, and only '0'/'false'/'off' mean off. It applies the value with preview.setPreviewEditable at startup without writing it back and emits 'previewEdit:changed'.
- It tracks bus 'previewEdit:session'. commit() calls preview.endEditSession() only while a session is live. Turning the toggle off commits first.
- App registers 'view.togglePreviewEdit' (title 预览可编辑, 'Mod-Shift-e', scope global). Running it toggles, persists '1'/'0' and shows a short toast. The palette picks it up from the registry.

(3) Toolbar: a pencil-on-page button sits right after the three mode buttons.
- Its pressed state comes from setToolbarPreviewEdit(toolbar, on), a side-table accessor like setToolbarTheme.
- setToolbarEditorRouter lets App take a click on an editor-scope button while a session is live.

(4) Interplay in App.ts:
- Save (⌘S, 另存为, the close-guard save and conflict re-save) calls previewEdit.commit() before editor.getText().
- These also commit before they act: non-initial mode switches, confirmDiscard (new/open/drop/recent/native open), openFile before setDoc, restoreDraft before setDoc, export, and the web beforeunload plus Electron close/quit dirty checks (through isDirtyCommitted).
- runEditorCommand (shortcut hook, native menu, toolbar router) behaves differently while a session is live:
  - edit.bold/italic/code/link: a synthetic keydown built from the command's shortcut is sent to the focused preview element or section.md-block.is-editing, so the session's own key handler does the work. The mode is not switched and the editor is not focused. A re-entrancy flag stops the synthetic event bouncing back through the window shortcut listener.
  - Any other editor command (heading, find, gotoLine…): the session is committed, CodeMirror's caret is placed on the edited block's first line if it was not already inside that block, and then the usual switch-to-split + focus + run happens.
- The native 撤销/重做 items call document.execCommand('undo'/'redo') during a session instead of undoing CodeMirror underneath it.
- shortcuts.ts also treats [contenteditable="plaintext-only"] as a host that handles its own keys.
- Focus line: wireFocusLine gained an optional previewEditing() predicate. While a session is live, a typing-caused doc:cursor from an unfocused editor is ignored; otherwise the preview's tint would jump to wherever CodeMirror's caret sits after each write.
- Status bar: setStatusPreviewEditing (side-table, StatusBarApi untouched) makes the mode slot read e.g. 「分栏 · 预览编辑」 and sets data-preview-edit. layout.css tints it with --mdr-accent.

(5) Desktop: electron/menu.mjs adds 视图 → 预览可编辑 right after 切换模式. It uses 'Shift+CmdOrCtrl+E' with registerAccelerator:false and sends 'view.togglePreviewEdit'.
- DOCUMENTED CHOICE: there is no checkmark. The frozen bridge has no renderer→shell channel except NativeDocumentState, so main could only guess the state, and the guess would drift as soon as the user toggled from the keyboard or toolbar. The toolbar's pressed state is the indicator. This is explained in menu.mjs and README.

(6) README gains a 预览内编辑 section covering how it works, the keys, what gets normalised and how to turn it off, plus a ⌘⇧E row in the shortcut table.

### 验证

- `npx tsc --noEmit 2>&1 | grep -E "src/(app|editor)|electron"` prints nothing. The only remaining tsc error is the expected one in src/preview/createPreview.ts: the new PreviewApi members are not implemented yet.
- test/app.previewEdit.test.ts: 22 tests, all pass. It covers:
  - source.read: exact multi-line reads, blank lines, clamping.
  - source.replace:
    - behaviour: more/fewer lines in exactly one transaction; trailing blank lines kept verbatim.
    - tagging: userEvent tag plus isUserEvent('input'); no scrollIntoView or effects; focus left on an outside element.
    - caret: moved when inside the range, left alone when before it, mapped when after it.
    - guards: no transaction for identical text; stale range warns and does nothing.
    - undo: a burst of writes is undone in one step.
  - The toggle: default ON without writing to storage; stored '0' restored; '1'/'0' persisted; bus events; commit only while a session is live; turning off commits first.
  - shortcutKeyEvent produces events that matchShortcut accepts.
  - Full createApp in jsdom with real CodeMirror, registry, toolbar, status bar and shortcuts (preview, scroll sync, worker, drafts, recent and file service faked):
    - source is wired to the live document and bumps editor.version;
    - the toggle is ON by default, its button sits next to the mode buttons with aria-pressed, and it is registered as global Mod-Shift-e;
    - ⌘⇧E and the toolbar button toggle and persist, and a stored OFF survives a restart;
    - ⌘S ends the session first, and the saved text includes the commit's write;
    - the status bar shows 预览编辑;
    - a mode switch and file.new end the session;
    - during a session, ⌘B and the toolbar 加粗 go to the editing block: no mode switch, no editor focus, CodeMirror unchanged, and no ping-pong when the host lacks the contenteditable attribute;
    - ⌘1 during a session commits it, switches to split and applies the heading to the edited block's line;
    - without a session the old ⌘B-in-预览 behaviour is unchanged;
    - the focus line ignores typing-caused cursor events while a session is live.
- The updated test/electron.menu.test.ts passes, including a new test for 视图 → 预览可编辑.
- Full `npx vitest run`: 56 files, 1159 tests, all pass.
- No browser check: src/preview/inlineEdit.ts has not landed, so there is nothing to click end-to-end. No servers were started and no background processes were left running.

### 跨模块请求（集成员需处理）

- **src/shared/types.ts**：Amend the PreviewSourceAccess.replace doc comment: writes are tagged userEvent 'input.type.previewEdit' (exported as PREVIEW_EDIT_USER_EVENT from src/app/previewEdit.ts), not 'input.previewEdit'. Update CONTRACT §11 the same way.
  - 原因：CodeMirror's history only groups userEvents that match /^(input\.type|delete)($|\.)/. The literal 'input.previewEdit' makes every rAF write its own undo step, which breaks the contract's own goal that consecutive edits group for undo. The new tag keeps isUserEvent('input') true.
- **src/preview/inlineEdit.ts**：(a) endEditSession() must flush any pending (rAF-coalesced) serialization SYNCHRONOUSLY through source.replace before it returns, and emit 'previewEdit:session' {id:null}. (b) Emit 'previewEdit:session' {id} on every session start and {id:null} on every end, including splits and remounts. (c) The session's keydown handler must accept untrusted synthetic keydowns (Mod-b/i/e/k built with key + code + metaKey/ctrlKey per shared/keys IS_MAC) dispatched on the focused preview element or on section.md-block.is-editing. Native menu and toolbar format commands are forwarded that way. (d) Mark the editing block with section.md-block.is-editing, as the contract says. If you use contenteditable="plaintext-only", shortcuts.ts already accepts it.
  - 原因：App relies on (a) for ⌘S, the dirty guards, mode switches and window close. It relies on (b) for the runEditorCommand bypass, the status bar hint and the focus-line guard, and on (c)/(d) to route menu and toolbar formatting into the session.

### 遗留问题

- Until the preview engineer implements setPreviewEditable/endEditSession/blockOfElement, createApp throws at startup (preview.setPreviewEditable is not a function). The user's own dev server on :5173 will show that error on its next hot reload until src/preview lands.
- The Electron menu item has no checkmark, because the frozen bridge has no renderer-to-shell state channel. This is documented in electron/menu.mjs and the README, and the toolbar's pressed state is the indicator. A checkmark would need a new bridge method or an executeJavaScript read in main.mjs (not my file).
- userEvent tag deviates from the contract string (see crossModuleRequests). If the lead wants the literal 'input.previewEdit' instead, change the one PREVIEW_EDIT_USER_EVENT constant in src/app/previewEdit.ts. Consecutive preview writes would then each become their own CodeMirror undo step.
- src/editor/keymap.ts and src/styles/editor.css needed no change. The toggle is a global command handled by shortcuts.ts, and the pressed look reuses .mdr-toolbar__btn.is-active. The status bar tint went into src/styles/layout.css, the app engineer's file per CONTRACT §2.
- Command-palette editor commands chosen during a session still go straight to registry.run (the palette is not mine). Whether the session survives the palette taking focus is up to the preview's blur handling.
- The README test-count line (52 files / 1099 tests) is stale; the current count is 56 files / 1159 tests. I left it for the integrator because other engineers are adding tests this round.

## lead 冒烟结果（2026-09-27，Playwright，small.md 分栏，端口 5265）

- 开关默认开，工具栏按钮 aria-pressed=true。
- 点击段落 → `.md-block.is-editing` + `contenteditable=true`，提示条「预览编辑中 · Esc 结束 · Shift+Enter 换行 · ⌘E 行内代码」出现。
- 输入「【预览里打的】」→ 源码第 3 行实时变为「本【预览里打的】文件由 …」，编辑中块未被重渲染。
- Shift+Enter 再输入「第二行」→ 源码变为两行，第一行末尾带两个空格（硬换行正确）。
- Esc → 会话结束。全程无 console/page 错误。
- 观察到的小问题（待验证员确认）：会话结束后状态栏残留「渲染中 100%」未清除；README 的测试计数行已过期。

## 尚未完成（恢复后由集成员 / 验证员 / 修复员做）

1. 集成员：处理上面的 2 条跨模块请求（types.ts 注释中的 userEvent 标签；确认 `inlineEdit.end()` 会同步冲刷 rAF 挂起的序列化并发出 `previewEdit:session` null）；按工作流脚本里的清单跑完整 e2e（Enter 分段并把光标移到新块、⌘E/⌘B/⌘I/⌘K、列表 Enter、代码块、表格 Tab、KaTeX 保持、IME 组合期间不写回、⌘Z 分组、large.md 只改对应行、开关关闭/持久化）；桌面 app 菜单 视图 → 预览可编辑 + ⌘S 落盘。
2. 验证员：按脚本中的 (a)–(f) 做保真度 / 编辑 / 渲染 / 交互 / 性能 / 桌面检查。
3. 修复员：只在有 high/medium 发现时运行。
4. 收尾：`npx wrangler deploy`；`npm run app:build && npm run app:install`；更新 README 测试计数；更新 docs/CONTRACT.md §11 的 userEvent 标签说明。

## preview 工程师恢复运行（2026-09-30）改动

- 对照 CONTRACT §11 逐条核对 serialize.ts / inlineEdit.ts / createPreview.ts / preview.css：会话模型、键位、粘贴、IME、HTML 挂起/释放、不驱逐、焦点行、提示条、序列化规则均已实现，无需重写。
- 处理 app 工程师跨模块请求：
  - (a) `end()`（即 `endEditSession()`）现在先取消挂起的 rAF，再**同步**序列化并 `source.replace`（IME 组合中的文字也写回；清空的块写成空），返回前必发 `previewEdit:session {id:null}`。显式结束**不再续接**到分段后的新块，并丢弃之前分段仍在等待的续接——返回后不会有会话自己冒出来（⌘S / 切模式 / 打开文件 / 关窗依赖这一点）。任意主键 mousedown 也会丢弃等待中的续接。
  - (b) 每次开始发 `{id}`、每次结束（含分段、块被替换）发 `{id:null}`——原本已满足。
  - (c) 合成（untrusted）keydown：在 `section.md-block.is-editing` 或焦点元素上派发的 Mod-b/i/e/k 会被会话处理——新增测试（用 App 的 `shortcutKeyEvent`）+ 浏览器里点工具栏「加粗」验证。
  - (d) `.is-editing` 标记——原本已满足。
- 测试：test/inlineEdit.test.ts 新增 4 个（IME 中 end 同步写回、未到帧的分段在 end 时写回且之后不续接、end 丢弃等待中的续接、合成 ⌘E）；每个测试后 dispose 预览，避免旧预览的 window 监听串扰。
- 浏览器：bench/verify/inline-edit.mjs 新增 2 步（endEditSession 同步写回 + 事件序列 `[null]`；工具栏加粗不结束会话），全部 24 项通过，无 console/page 错误。
- lead 冒烟提到的「渲染中 100%」残留：本次按相同流程（点击→输入→Esc）复测，状态栏无残留，未复现。
- 回应 app 工程师遗留 ①（⌘S 结束会话导致光标回块首、紧接着打的字丢失）：createPreview 返回对象上新增额外成员 `flushEditSession()`（同 `mountedCount` 的做法，类型为 `PreviewApi & {…}`）= 同步写回挂起内容、保留会话与光标、不发会话事件；+1 测试。待集成员：在 types.ts 的 PreviewApi 加 `flushEditSession(): void`，App 的 ⌘S 改调它（其余 commit 场景仍用 endEditSession）。
