# hunt:profile — 用户真实配置与真实文档（2026-11-20）

只记录路径和数字，不含任何文档内容。真实配置目录 `~/Library/Application Support/MDReader` 只读复制到
临时目录（`cp -R`，并另存一份原始副本，每次运行前从原始副本重建），所有运行都用已安装的
`/Applications/MDReader.app`（09-21 构建）加 `--user-data-dir=<副本>`。运行开始时用户没有在运行 MDReader。

脚本（都接受 `MDR_EXE`，都要求 `MDR_PROFILE` 指向副本，并拒绝使用真实配置）：

- `bench/electron/hunt-profile-dump.mjs`：导出 localStorage `mdr.*`、idb-keyval（`keyval-store`/`keyval`）、window-state.json，以及缩放和窗格尺寸
- `bench/electron/hunt-profile-recents.mjs`：通过 `app.emit('open-file')` 打开 `mdr.recent` 里最多 12 个仍存在的文档（`MDR_MODES=persisted|split,edit,preview`）
- `bench/electron/hunt-profile-closed.mjs`：已确认的关窗场景（`MDR_DOC_A`、`MDR_DOC_B`）

## 1. 持久化状态

| 项 | 值 |
|---|---|
| localStorage | 只有 `mdr.mode=split` 和 `mdr.toc=closed`；没有 `mdr.split`（用默认 1fr:1fr）、没有 `mdr.theme`（跟随系统）、没有 `mdr.previewEdit` |
| window-state.json | `{"width":1217,"height":903,"maximized":false,"x":-1553,"y":-76}`：落在第二块屏上（该屏 bounds 为 -1920,-148，1920×1080，在线），`onScreen=true`，`visible=true` |
| 缩放 | zoomFactor 1，zoomLevel 0；Preferences 文件里没有按站点保存的缩放级别 |
| IndexedDB 库 | 只有 `keyval-store@1`（另有 5 个 `http_localhost_*` 来源的库，是开发服务器留下的，与 app:// 无关） |
| 草稿 | 共 7 条（下表） |
| mdr.recent | 共 10 条：4 条是用户文档（都还在），6 条是 09-20 打包/性能测试的临时文件（都已不存在） |

草稿（只列 docId、文本长度、版本和时间）：

| docId（native:路径） | 文本长度 | 版本 | 时间（UTC） | 和文件对比 |
|---|---|---|---|---|
| …/systemslab26-NPU/Result.md | 4849 | 28 | 2026-09-25T22:55 | 比文件 mtime（09-25 06:22）新，但长度等于文件字符数 4849；打开时不弹恢复提示，说明 text 与文件相同 |
| …/castle-shooter-assets/design/game-design.md | 22973 | 2 | 2026-11-17T01:54 | 比文件 mtime（11-17 18:10）旧，所以按规则不提示 |
| /private/tmp/mdr-demo.md | 187 | 2 | 2026-09-20 | 文件已不存在 |
| …/T/mdr-perf-EHLnl8/large.md | 2075391 | 102 | 2026-09-20 | 测试残留，文件已不存在 |
| …/T/mdr-pkg-e2e-iLT8Cc/打包端到端.md | 168 | 8 | 2026-09-20 | 测试残留，文件已不存在 |
| …/T/mdr-verify-perf-AJo6kS/large.md | 2075391 | 102 | 2026-09-20 | 测试残留，文件已不存在 |
| …/T/mdr-verify-perf-vZ2fzg/large.md | 2075391 | 102 | 2026-09-20 | 测试残留，文件已不存在 |

## 2. 这些状态会不会让已加载的文档「看起来是空的」——不会

- **模式**：持久化的是 split。启动后在真实窗口尺寸（1217×871 内容区）下测得：编辑器 606×801，分隔条 6×801，预览 606×801，目录 `display:none`（已关闭）。edit 模式下编辑器 1217×801；preview 模式下预览 1217×801。三种模式下都没有渲染不出来的窗格。
- **分栏比例**：用户没有保存 `mdr.split`。读取时只接受 `/^\d+(\.\d+)?fr$/` 格式；拖动时比例会被限制在上下限之间，所以正常拖动不可能把窗格拖到 0 宽。用户状态里不存在极端比例。
- **目录**：处于 closed，`display:none`，不占宽度。
- **窗口尺寸 / 位置**：按 window-state.json 精确复现（1217×903 @ -1553,-76），窗口可见，也在屏幕范围内。
- **草稿**：用户的两份草稿都不会触发恢复提示，也不会被自动套用。启动时的「未命名」文档没有草稿。4 次打开都没有出现 toast。
- **缩放**：1.0。

## 3. 用户最近打开的真实文档（共 4 个仍存在，其余 6 个 ENOENT 已跳过）

每个文档在三种模式（persisted=split、edit、preview）下都用 `open-file` 打开，等待 2 秒：

| 路径 | 字节 | 编码（file -I） | 换行数 | 字符数（LF） | 编辑器文档长度 | 首屏渲染 mdr:first-visible | toast / 错误 |
|---|---|---|---|---|---|---|---|
| ~/Documents/deepseek-harness/default-workspace/castle-shooter-assets/design/game-design.md | 54211 | utf-8 | 1292 | 28938 | 28938 | split 20–39 ms，preview 28 ms | 无 |
| ~/LocalDocuments/AgenticAI_claude/HANDOFF-nanochat-base-A.md | 12050 | utf-8（file 报为 text/x-script.python） | 325 | 11965 | 11965 | split 18–19 ms，preview 27 ms | 无 |
| ~/Documents/Courses.nosync/AMD_NPU/systemslab26-NPU/Result.md | 4867 | utf-8 | 158 | 4849 | 4849 | split 13–21 ms，preview 17 ms | 无 |
| ~/Downloads/guitartunner.md | 4875 | utf-8 | 87 | 4821 | 4821 | split 14–20 ms，preview 22 ms | 无 |

edit 模式下没有 first-visible 标记（预览窗格是隐藏的），这是正常的。预览可见时，挂载的预览文本长度依次为
2687 / 6422 / 4253 / 4444 字符（预览是虚拟化渲染的）。12 次打开里，没有一次显示为空或只显示了一部分，也没有控制台错误。

## 4. 用用户自己的状态复现关窗场景（已复现）

运行命令（在项目根目录下）：

```
MDR_PROFILE=<副本> MDR_DOC_A=~/Documents/Courses.nosync/AMD_NPU/systemslab26-NPU/Result.md \
MDR_DOC_B=~/Documents/deepseek-harness/default-workspace/castle-shooter-assets/design/game-design.md \
node bench/electron/hunt-profile-closed.mjs
```

1. 窗口开着时打开 A：标题 Result.md，文档长度 4849，状态「已保存」。
2. 关闭窗口：窗口数 0，app 仍在运行。
3. 对 B 发 `open-file`（等同于在 Finder 里双击）：新窗口出现在保存的位置（1217×903 @ -1553,-76），**标题 `未命名.md`，文档长度 0，预览文本 0**，没有 toast，也没有错误。
4. 再对 B 发一次 `open-file`：正常打开，标题 game-design.md，文档长度 28938。

结论：用户看到的「打开非空文件却显示空白」，用用户自己的配置就能完全复现，原因就是这个主进程问题：窗口关闭后
`open-file` 带来的路径被丢弃。配置本身（模式、目录、窗口尺寸、草稿、缩放）里没有任何东西会让文档看起来是空的。
同时这也说明了为什么用户「第二次双击就好了」：窗口已经存在时，投递是正常的。

## 5. 配置卫生（低）

真实配置里留着 09-20 自动化测试写入的数据：`mdr.recent` 中 6 条临时文件记录，以及 5 条草稿（其中 3 条各
2075391 字符）。这说明当时有测试用真实配置启动过 app。它们不会造成「空白」：文件已不存在，草稿只有在同一个
docId 再次打开时才会用到。但「最近打开」列表里有 6 条打不开的记录，IndexedDB 也因此多占了约 1 MB 的
blob 空间。
