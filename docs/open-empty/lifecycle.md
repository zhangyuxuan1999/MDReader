# 打开文档丢失 / 显示为空 —— 生命周期与事件时序（hunt:lifecycle，2026-11-20）

Target: the installed `/Applications/MDReader.app` (0.1.0, build 2026-09-21). Every run used a fresh
`--user-data-dir` (mktemp) and synthetic documents (`hunt-a.md` 117 chars / 3 h1, `hunt-b.md` 195 chars / 5 h1).
The main process was driven with `app.emit('open-file' | 'activate' | 'second-instance')` and
`BrowserWindow` methods. `webContents.prototype.send` was wrapped to record every `mdr:open-file` /
`mdr:command` the shell actually sent (the `sends` field in the logs).

Scripts (each takes `MDR_EXE`, defaults to the installed app, cleans up its profiles and docs):

| script | scenarios |
|---|---|
| `bench/electron/hunt-lifecycle-lib.mjs` | shared helpers (isolated launch, snapshots, send recorder, watchdog) |
| `bench/electron/hunt-lifecycle-window.mjs [name…]` | closed / minimised / hidden / app-hidden / fullscreen / clean / same file / crash / reload / second-instance / menu with no window / close via 不保存 |
| `bench/electron/hunt-lifecycle-guards.mjs [name…]` | dirty guard 取消/丢弃, two opens while dirty, open during the 新建 guard, open during the close dialog, quit right after open |
| `bench/electron/hunt-lifecycle-startup.mjs [name…]` | cold start with 1 / 2 / relative args, early open-file, open-file 0/50/150/400/1000 ms after createWindow, draft races |
| `bench/electron/hunt-lifecycle-gestures.mjs` | menu-role gestures (inconclusive, see harness note) + what a crashed window looks like |

Run each in the background (`nohup node bench/electron/hunt-lifecycle-window.mjs > log 2>&1 &`): a full
script takes 40–90 s.

## Results

| scenario | expected | actual | verdict |
|---|---|---|---|
| window closed → open-file (known cause) | A, 117 chars | new window, `未命名.md`, 0 chars, 0 preview blocks; **0** `mdr:open-file` sent | FAIL (F1) |
| closed → open-file + `activate` in the same tick (double-click + Dock event) | A | `未命名.md`, 0 chars, 0 sends | FAIL (F1) |
| closed → close via dirty dialog 不保存 → open-file | A | `未命名.md`, 0 chars + a 「发现未保存的草稿，是否恢复？」 offer for the discarded text | FAIL (F1 + F7) |
| closed → two open-files back to back (same tick, and 50 ms apart) | A then B | B shown (195 chars); only B sent, A silently dropped | partial (F1) |
| closed → `activate` (Dock click) → 1.5 s → open-file | A | A, 117 chars, 6 blocks | PASS |
| `activate` then open-file 0 / 50 / 150 / 400 / 1000 ms after createWindow | A | A every time, exactly 1 send each | PASS |
| minimised → open-file | A, restored | A, minimized 1→0 | PASS |
| `win.hide()` → open-file | A, visible | A, visible 0→1 | PASS |
| `app.hide()` (⌘H) → open-file | A, unhidden | A, isHidden true→false | PASS |
| fullscreen → open-file | A | A, still fullscreen | PASS |
| window open, clean: A then B | A, B | A then B | PASS |
| same file again while clean | A unchanged | A, 117 chars (reloaded from disk) | PASS |
| renderer crash → open-file B | B | renderer stays dead (`isCrashed` true), B sent to the crashed WebContents and lost; `activate` does not recover; capturePage 0×0; title still names the old doc | FAIL (F3) |
| renderer crash → close window → open-file | A | `未命名.md`, 0 chars (F1 again) | FAIL (F1) |
| `webContents.reload()` + open-file 30 ms later | A | `未命名.md`, 0 chars; the send went to the loading page (`loading:true`) | FAIL (F6, not user-reachable today) |
| second-instance with a file, window open | A | A | PASS |
| second-instance with a file, window closed | a window with A | **no window at all**, 0 sends, windows 0 | FAIL (F2) |
| window closed → 文件 → 打开… / 新建 | a window (or a panel) | nothing; windows stay 0 | FAIL (F5) |
| dirty → open-file → 取消 | text kept | guard `取消/丢弃` once, 10 chars kept, title `● 未命名.md` | PASS |
| dirty → open-file → 丢弃 | A | A | PASS |
| dirty → A and B 100 ms apart → 丢弃 | one guard, then B | one guard, A then B, B shown | PASS |
| dirty → 文件 → 新建 (guard up) → open-file A → 丢弃 | A opened afterwards (or asked) | A silently dropped (send delivered; single-flight guard returned false); new 未命名 shown + draft offer | FAIL (F4) |
| dirty → close window (dialog up) → open-file A → 不保存 on the close dialog | A on screen | two stacked modals (`不保存/取消/保存` + `取消/丢弃`); window closes, A never shown, windows 0 | FAIL (F4b) |
| same, but 丢弃 on the guard first, then 不保存 on the stale close dialog | A stays | A loads (117 chars) under a close dialog still naming 未命名.md; 不保存 then closes the window with A | FAIL (F4b) |
| dirty → open-file + `app.quit()` 30 ms later | one question | two stacked modals (`取消/丢弃` + `不保存/取消/保存`) | FAIL (F4b) |
| clean → open-file + `app.quit()` | quits | exit 0 after 92 ms | PASS |
| close() twice while dirty | one close dialog | one | PASS |
| cold start, 1 arg / relative arg / open-file before the window | A | A | PASS |
| cold start, 2 args | A then B | both sent, B shown | PASS |
| profile with untitled draft, cold start with A | A, no untitled offer | A, 0 toasts | PASS |
| profile with A's draft, cold start with A | disk text + offer | 117 chars + 「发现未保存的草稿」 offer, not auto-applied | PASS |
| profile with both drafts, open-file 0/150/400/800 ms after boot | A + only A's offer | A every time, exactly 1 toast | PASS |
| untitled offer → 恢复 → open-file A | guard asks | guard `取消/丢弃` shown | PASS |

No console errors or page errors were captured in any run (the crash runs report `page crash`, by design).

## Findings

**F1 (high, main) — confirmed cause, characterised.** Trigger: any path that destroys the BrowserWindow while
the app keeps running (red button, ⌘W, 关闭窗口, closing through the dirty dialog with 不保存 or 保存,
closing a crashed window), followed by an `open-file` (Finder double-click, Open With, dragging onto the
Dock icon, Dock / 打开最近 — all of which macOS delivers as `open-file`). `openQueue` stays `ready` after
`closed`, so `push → deliver` runs with `mainWindow === null` and returns; `createWindow()` then calls
`reset()` on an empty queue. Not triggered by: minimise, `win.hide()`, ⌘H, fullscreen, ⌘Q + relaunch
(cold start), or a Dock click before the double-click. Emitting `activate` in the same tick does not
help. With several files at once only the first is lost (the window comes up showing the last one).
Aggravation: if the closed window held an untitled draft, the empty replacement window also pops the
「发现未保存的草稿，是否恢复？」 offer for that old text (F7), which looks like the file "opened wrong".

**F2 (high, main) — second-instance with the window closed: no window, path dropped.** The handler only
queues and calls `focusWindow()`, which is a no-op without a window; nothing calls `createWindow()`.
Reached by launching the binary with a file from a terminal while the app sits in the Dock windowless.
`node bench/electron/hunt-lifecycle-window.mjs secondInstanceWindowClosed` → windows 0, sends [].

**F3 (high, main) — after a renderer crash the window stays dead and swallows every later open.**
No `render-process-gone` recovery (no reload, no new window); `deliver` sends to the crashed
WebContents. The window stays visible with the stale title of the previous document and no content;
`activate` does nothing. `node bench/electron/hunt-lifecycle-window.mjs rendererCrashThenOpen`.

**F4 (medium, renderer) — open-file during the 新建 / 打开 guard is silently dropped.**
`confirmDiscard`'s single-flight (`guardOpen`) returns false for the second caller; the native opener
treats false as "user kept the document" and drops the path. `hunt-lifecycle-guards.mjs openWhileNewGuard`.

**F4b (medium, renderer + main) — open-file / quit during the close question stacks a second modal, and
answers act on stale state.** The close dialog (`chooseDialog` in src/app/native.ts) is not part of the
guard single-flight. 不保存 on the close dialog closes the window and the pending open vanishes
(windows 0); answering the guard first loads A, but the stale close dialog (still naming 未命名.md) then
closes the window with A. `hunt-lifecycle-guards.mjs openWhileCloseDialog_closeDontSave
openWhileCloseDialog_guardDiscardThenClose quitRightAfterOpenDirty`.

**F5 (medium, main) — with no window, 文件 → 打开… / 新建 (and their shortcuts) do nothing.** `sendCommand`
targets `getFocusedWindow() || mainWindow`, both null. Not a lost document, but the obvious recovery
("open it from the menu") fails silently. `hunt-lifecycle-window.mjs menuOpenWindowClosed`.

**F6 (low, main) — the queue is never reset when the page reloads.** An open-file during a reload goes
to the loading page and is lost; the reloaded preload's `readyForFiles` is a no-op because the queue is
still `ready`. Not reachable in the packaged menu today, but any crash-recovery reload added for F3 must
reset the queue on `did-start-loading`/`render-process-gone`. `hunt-lifecycle-window.mjs reloadThenOpenImmediately`.

**F7 (low, renderer) — 不保存 / 丢弃 leave the untitled draft in IndexedDB**, so the next untitled
document offers to restore text the user just discarded (seen after F1 and after 新建 → 丢弃).

**Harness note.** Clicking menu ROLE items (`close`, `minimize`, `hide`) from `app.evaluate` has no
effect under Playwright (`hunt-lifecycle-gestures.mjs`, before/after window state unchanged), so the
gesture mapping above uses the equivalent `BrowserWindow.close()/minimize()/hide()` and `app.hide()`.

## What did NOT reproduce (no race found)

The startup scratch buffer never overwrote a launch document (subscription happens after
`openFile(newFile())`), the 400 ms untitled-draft offer never appeared over a launch document, a target
document's draft is only offered (never auto-applied), and open-file at 0–1000 ms after a window was
created was always delivered exactly once.
