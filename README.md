# MDReader

高性能的本地 Markdown 浏览/编辑器（Vite + TypeScript，无 UI 框架，界面为中文）。

- **编辑器**：CodeMirror 6（Markdown 语法高亮、查找/替换、列表续行、任务项切换、多光标）。
- **预览**：markdown-it（GFM 表格 / 删除线 / 任务列表）+ highlight.js + KaTeX，在 **Web Worker** 里按段落块增量渲染，主线程只做块级 DOM 补丁。
- **性能设计**：编辑一次只重渲染受影响的块；预览按视口物化、远处块回收；结构更新走增量 delta（不会每次按键分配全文档数组）；10 万行 / 3 MB 文档打开约 100 ms 首屏，逐键更新 p95 约 35 ms。
- **功能**：编辑 / 分栏 / 预览三种模式（`⌘/` 切换），可直接在预览里编辑（`⌘⇧E` 开关），双向滚动同步，当前行高亮联动（在任一侧点击、移动光标或选中文字，该行与另一侧对应行同时显示同一种淡淡的底色），目录（TOC）跟随光标，命令面板（`⌘⇧P`），浅色/深色主题（跟随系统或手动 `⌘⇧L`），打开/保存（File System Access API，回退为下载），拖拽打开，草稿自动保存到 IndexedDB 并可恢复，导出独立 HTML。

## 使用

```bash
npm install
npm run dev          # http://localhost:5173
```

开发模式可以直接用 URL 参数打开测试文档，例如 `http://localhost:5173/?doc=/test-data/large.md&mode=split`。

```bash
npm run build        # 产物在 dist/（静态站点，可用任意静态服务器托管）
npm run preview      # 本地预览构建产物
```

## 桌面版（macOS）

把 MDReader 打包成 macOS 应用，双击 `.md` 文件就直接用它打开，`⌘S` 写回原文件。

外壳是 **Electron**（内置的正是所有性能数字所依据的 Chromium 引擎）。渲染进程由一个私有的
`app://mdreader/` 协议提供（`protocol.registerSchemesAsPrivileged` + `protocol.handle` 映射到打包后的
`dist/`），**不使用 `file://`**——这样 ES 模块、module Worker 和 IndexedDB（草稿、最近文件）才有一个稳定的源。

```bash
npm run app:icon     # 重新生成 build/icon.png（Playwright Chromium 渲染 SVG，可选）
npm run app:build    # vite build + electron-builder + 临时签名（ad-hoc codesign）
                     # 产物：release/mac-arm64/MDReader.app 和 release/MDReader-<版本>-arm64.dmg
npm run app:install  # 先备份已装的版本，再复制到 /Applications、lsregister -f；默认打开方式不动
                     # 同时会注销并删除 release/mac-arm64/MDReader.app（见下）
npm run app:install -- --set-default   # 同上，另外把 .md 的默认打开方式设为 MDReader
```

`app:install` 的几条规矩：

- MDReader 正在运行时（主进程或任何辅助进程），脚本拒绝执行，先退出应用再装。
- 删掉 `/Applications/MDReader.app` 之前，先用 `ditto -c -k --sequesterRsrc --keepParent` 把它备份到
  `release/backup/MDReader-<已装的版本>-<日期>.zip`（同一天同一版本再装一次时文件名后加 `-2`、`-3`…）；
  备份失败或备份文件为空时脚本停止，已装的版本不动。
- 只有带 `--set-default` 时才修改 `.md` 的默认打开方式；不带时只用 `--show` 打印当前的默认应用。

### 应用是临时签名的（ad-hoc），只能在这台 Mac 上运行

`app:build` 用 `codesign --force --deep --sign -` 做**临时签名**，没有开发者证书，也没有公证
（notarization）。因此这个 `.app` **只能在打包它的这台机器上运行**：拷到别的 Mac 上，Gatekeeper 会
拒绝启动（「已损坏，应移到废纸篓」）。要分发给别人，需要 Apple Developer ID 证书，把
`electron-builder.yml` 里的 `identity: null` 换成证书名，并做公证。

### 默认打开方式

`app:install -- --set-default` 会调用 `scripts/set-default-md.swift`（不带 `--set-default` 时只调用它的 `--show`，什么都不改），它只修改 Markdown 的 UTI
`net.daringfireball.markdown`，**不会碰 `public.plain-text`**（`.txt` 等文件的默认应用保持不变）。
脚本会打印修改前后的处理程序以及还原命令：

```bash
swift scripts/set-default-md.swift --show             # 只查看当前默认应用（不修改任何东西）
swift scripts/set-default-md.swift com.apple.TextEdit # 还原成别的应用
```

**还原**：这台机器上装 MDReader 之前，`.md` 的默认应用是 **MarkText**，所以还原命令是

```bash
swift scripts/set-default-md.swift com.github.marktext.marktext
```

也可以在 Finder 里选中任意 `.md` 文件 → `⌘I` 显示简介 → 「打开方式」里选别的应用 → 「全部更改…」。
如果要彻底卸载：先按上面还原默认应用，再 `rm -rf /Applications/MDReader.app`。

> macOS 26 上旧的 `LSSetDefaultRoleHandlerForContentType` 会返回成功但实际不生效，脚本改用
> `NSWorkspace.setDefaultApplication(at:toOpen:)`，并且会回读校验，真正设置失败时以非 0 退出。

### 为什么 `app:install` 会删掉 `release/mac-arm64/MDReader.app`

LaunchServices 按 bundle id 找应用。构建产物和 `/Applications` 里的副本用的是同一个
`com.zyx.mdreader`，两个都注册着的时候，`open note.md` 可能解析到构建目录——而 `npm run app:build`
会删掉并重建那个目录，于是双击就可能打开一个正在被重写、甚至已经不存在的 app。macOS 还会自己重新
注册它遇到的 bundle，手动 `lsregister -u` 留不住，所以安装脚本在复制之后直接 `lsregister -u` 并删除
构建产物，最后回读 `lsregister -dump` 确认 `com.zyx.mdreader` 只剩一个路径。需要构建产物时重新
`npm run app:build` 即可；`bench/electron/packaged-*.mjs` 在它不存在时会自动改用
`/Applications/MDReader.app`（也可以用 `MDR_APP=` 指定）。

桌面版相对网页版的差别：

- 打开的文件带绝对路径（`OpenedFile.source === 'native'`），`⌘S` 原地写回（先写临时文件再 `rename`，原子写入），不再走浏览器下载。**「导出 HTML」仍走 Chromium 的下载流程**（`blob:` + `<a download>`），会弹出系统的「存储」面板，而不是 `mdrNative` 的保存流程。
- **保真写回**（`electron/fileIO.mjs`）：文件怎么进来就怎么出去。
  - **编码**：先按严格 UTF-8 解码，失败再依次尝试 GBK / Big5 / Shift_JIS / EUC-KR / windows-1252，带 BOM 的 UTF-8 与 UTF-16 也能识别。GBK 文件就按 GBK 读、按 GBK 写（打开时提示一次），BOM 原样保留；完全认不出来的（二进制）直接拒绝打开，不会再把坏字节变成 `�` 又存回去。编辑后如果出现原编码表示不了的字符（例如往 GBK 文件里输入 emoji），保存会失败并给出「另存为」按钮。
  - **换行**：CRLF 文件保存后仍是 CRLF（CodeMirror 的文档始终是 LF，换行由外壳在写入时还原；混合换行会统一成文件里出现过的 CRLF）。
  - **符号链接 / 硬链接**：先 `realpath` 再写，符号链接仍是符号链接、目标文件真正被更新；硬链接（`nlink > 1`）改为原地写入，inode 不变，另一个名字也能看到新内容。
  - **并发修改**：记住打开时的 mtime，别的程序改过就拒绝写入并提示「文件已被其他程序修改」，提供 覆盖保存 / 重新载入 / 另存为。
- **隐私**：渲染进程带 Content-Security-Policy（`electron/protocol.mjs`），文档里的远程图片、`<img>` 追踪像素、任何 `http(s)` 子资源都会被拦下——双击别人发来的 `.md` 不该把你的 IP 和阅读时间发出去；被拦时提示一次。点击链接仍然照常交给系统浏览器（`shell.openExternal`）。
- 中文原生菜单：文件 / 编辑 / 格式 / 视图 / 窗口，含「打开最近」。除 **新建（⌘N）** 外，菜单里的自定义项一律 `registerAccelerator: false`，快捷键仍由渲染进程处理，**保证一次按键只触发一次命令**；⌘N 是渲染进程唯一没有绑定快捷键的命令，所以由菜单注册。
- 「撤销 / 重做」不是 AppKit 的 role：Chromium 的 Redo 编辑命令够不到 CodeMirror 的历史（点了没反应），所以它们是自定义菜单项，由渲染进程调用 CodeMirror 的 `undo` / `redo`；⌘Z / ⇧⌘Z 仍走 CodeMirror 自己的 keymap。
- 编辑类快捷键（⌘B / ⌘1…⌘6 等）在**预览模式**下也生效：先切回分栏并聚焦编辑器再执行，和 ⌘F 一样。
- 标题栏跟随文档标题，未保存时显示 macOS 的「已编辑」圆点；关闭窗口或退出应用时若有未保存内容，会先弹出 保存 / 不保存 / 取消。
- 窗口大小和位置记在 `~/Library/Application Support/MDReader/window-state.json`。
- 单实例：再次双击 `.md` 会在已打开的窗口里打开，而不是启动第二个应用。

开发桌面版（需要两个终端；用 5251 端口，避免占用 `npm run dev` 的 5173）：

```bash
npx vite --port 5251 --strictPort   # 终端 1
npm run app:dev                     # 终端 2，MDR_DEV_URL=http://localhost:5251
```

### 桌面版实测性能

在打包后的 `MDReader.app` 里，用和网页版同样的 `mdr:open` / `mdr:first-visible` 标记和同样的
「keystroke → mount」定义测量 `test-data/large.md`（3.04 MB / 102 004 行，复制到 `/tmp` 后打开），
两次运行结果一致（`node bench/electron/packaged-perf.mjs`）：

| 指标 | 网页版（README 基准） | 桌面版实测 |
|---|---|---|
| 打开 → 首屏可见（冷启动，进程刚起） | ≈ 100 ms | **120 ms** |
| 打开 → 首屏可见（热，Worker 已就绪） | ≈ 100 ms | **114–116 ms** |
| 逐键 keystroke → mount p95（文档中部 100 次按键） | ≈ 35 ms | **38.5–39.9 ms**（p50 ≈ 30 ms） |
| 主进程内存 | — | rss 213 MB（heap 21 MB） |
| 渲染进程内存（含 Worker） | ≈ 290 MB | 506–512 MB working set |
| 全部 4 个进程合计 | — | ≈ 865 MB working set |

首屏和按键延迟都比网页版高约 10–20%，其中一部分来自测量本身：打包版的测试钩子只在
`?perf=1` 下安装，而这个参数同时会打开性能浮层，浮层本身也要记录和渲染每个采样。内存差异是
Electron 的固有成本（Browser / GPU / Utility 三个额外进程约 360 MB），渲染进程的
working set 也包含网页版不计入的一部分常驻内存。

## 常用快捷键

| 快捷键 | 功能 |
|---|---|
| `⌘N`（桌面版） | 新建（渲染进程未绑定，由原生菜单注册） |
| `⌘S` / `⌘⇧S` / `⌘O` | 保存 / 另存为 / 打开 |
| `⌘Z` / `⌘⇧Z` | 撤销 / 重做（CodeMirror 的历史） |
| `⌘/` | 循环切换 编辑 → 分栏 → 预览 |
| `⌘⇧E` | 预览可编辑（实验性，默认关闭）开/关（见下文「预览内编辑」） |
| `⌘⇧P` | 命令面板 |
| `⌘⇧O` / `⌘⇧L` | 显示/隐藏目录 / 切换主题（跟随系统 → 浅色/深色 → 跟随系统，循环） |
| `⌘B` / `⌘I` / `⌘E` / `⌘K` | 加粗 / 斜体 / 行内代码 / 链接 |
| `⌘1`…`⌘6` / `⌘0` | 标题级别 / 正文（Chrome 会占用部分数字快捷键，可用工具栏或命令面板） |
| `⌘⇧X` | 切换任务项 |
| `⌘F` / `⌘G` / `⌘⇧G` / `⌘⌥G` | 查找替换 / 下一个 / 上一个 / 跳转到行 |

预览中：点击任务复选框会写回源码；点击或选中任意段落会给该行和左侧源码对应行加上同一种淡底色（不滚动、不移动光标）；`⌥` + 点击任意段落跳到对应源码行；`#锚点` 链接在两个面板中同步跳转。

## 预览内编辑（实验性）

不想记 Markdown 语法时，可以直接在右侧预览里改字（类似 Typora）：换行不用再打两个空格，行内代码不用再打反引号。

这是实验性功能，**默认关闭**。关闭时预览是只读的，点击只做当前行高亮联动，预览编辑的代码也不会加载。
它的代码只在打开开关时才加载：第一次打开时按钮显示为加载中，超过 300 毫秒还没加载好会提示「正在加载预览编辑功能…」，加载好之后开关才算打开。

- **打开**：工具栏上「页面 + 铅笔」按钮（按下 = 开启）、`⌘⇧E`、命令面板里的「预览可编辑（实验性）」，桌面版还有菜单 视图 → 预览可编辑（实验性）。
  打开或关闭都会记住（`localStorage` 的 `mdr.previewEdit`），下次启动照旧。
- **怎么用**：打开「预览可编辑」后，在分栏或预览模式下点一下任意段落、标题、列表、引用、代码块、表格或公式块，
  这一块就进入编辑状态（状态栏显示「预览编辑」），光标落在点击处，直接输入即可。每次改动都会转换回 Markdown，
  以一次普通的编辑写回左侧源码（撤销历史照常合并），不会滚动或抢走编辑器的焦点。
- **同一时间只编辑一个块**。HTML 块、分隔线、按纯文本显示的超大块和渲染出错的块不能在预览里改，会提示「此块请在源码中编辑」。
- **按键**：
  | 按键 | 作用 |
  |---|---|
  | `Enter` | 段落/标题中另起一段；列表中新建一项；代码块中换行；表格中不做任何事 |
  | `Backspace`（在块的最开头） | 前一块也是段落时，两段合并为一段（源码里直接拼接，中间的空行去掉）；其他情况不做任何事 |
  | `⇧Enter` | 段内换行（写回源码时自动生成行尾两个空格 + 换行） |
  | `⌘B` / `⌘I` / `⌘E` / `⌘K` | 加粗 / 斜体 / 行内代码（自动加反引号；没选中文字时，接下来输入的内容进入行内代码，再按 `⌘E` 或 `→` 离开） / 链接（在小输入框里填网址；没选中文字时插入以网址为文字的链接） |
  | `Tab` / `⇧Tab` | 列表中缩进/取消缩进；表格中移到下一个/上一个单元格 |
  | `⌘Z` / `⇧⌘Z` | 撤销/重做，走源码（CodeMirror）的撤销历史：一次连续输入是一步，刚按的 `Enter` 分段也能撤回（两块合并回去）；焦点不在编辑器里时（例如只看预览的模式）同样有效，不切换模式、不滚动 |
  | `Esc` | 结束编辑，该块按源码重新渲染 |

  粘贴一律按纯文本插入（代码块里保留每个换行；正文里空行分段）。分段后新块接上编辑之前按下的键、输入法提交的文字都不会丢。编辑时点链接只会放置光标，`⌘` + 点击才打开；任务复选框照常可以勾选。`⌘S`、`⌘/`、`⌘⇧P`
  等全局快捷键照常可用——`⌘S` 会先把最后的改动写回源码再保存（编辑状态和光标保留）；切换模式、新建/打开文件、关闭窗口会先结束预览编辑、写回改动。
  编辑过程中从菜单或工具栏点「加粗 / 斜体 / 行内代码 / 链接」作用在预览里正在编辑的块上，其他编辑器命令（标题、查找、跳转到行…）
  会先结束预览编辑，再在源码中对该块执行；在预览编辑中直接按这些命令的快捷键（`⌘1`–`⌘6`、`⌘0`、`⌘⇧X`、`⌘F`、`⌘⌥G`）
  会提示「…：预览编辑中不可用，按 Esc 结束编辑后再按」，不做任何改动。
- **两个提示**：点进刚改过、预览还没更新完的块时，点击会等预览更新（最多几秒），期间打的字随后写入；等不到、或在等待时转去别处，就不写入并提示「预览尚未更新完，刚才的输入没有写入」。点任务复选框时若认不准是哪个任务（例如这一行刚被改动），不勾选并提示「没有勾选：该任务项刚被改动，请再点一次」。
- **写回时会被规范化的写法**（渲染结果不变，只是源码写法统一）：`_斜体_` → `*斜体*`，`+` / `*` 列表符号 → `-`，
  Setext 标题（下划线式）→ `#` 标题，引用式链接 → 行内链接，`1)` → `1.`，有序列表重新编号，嵌套列表缩进统一为 2 个空格。
  表格的分隔行、标题下没有空行的紧凑写法、源码里写的 `&nbsp;` 会保留；只在需要时才转义 `$`、`[`、`~`。
  只有你真正改动过的那一块会被重写，其余源码一个字符都不动。
- **关闭**：和打开一样（同一个按钮、`⌘⇧E`、命令面板或菜单），设置同样会记住。关闭后预览恢复为只读，点击只做当前行高亮联动。
  桌面版菜单项不带勾选标记：开关状态由页面自己保存，外壳没有读取它的通道，以工具栏按钮的按下状态为准。

## 测试与性能验证

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest：159 个文件 / 4846 个用例（其中 6 个标为已知失败：K22 五个、K24 一个），抽样模式串行约 9 分钟（含分段器、增量 delta、序列化、编码检测的随机模糊测试）
npm run build
node bench/smoke.mjs # Playwright 冒烟测试（自行启动 :5199），39 项检查
node bench/electron/dev-shell.mjs       # 桌面外壳验证（自行启动 :5251），80 项检查
node bench/electron/e2e.mjs             # 桌面版端到端：真实渲染进程 × 真实外壳（自行启动 :5253），49 项检查
node bench/electron/packaged-shell.mjs  # 打包后的 .app 验证（先 npm run app:build），33 项检查
node bench/electron/packaged-e2e.mjs    # 打包后的 .app 端到端（命令行传入文档、公式、草稿、退出），21 项检查
node bench/electron/packaged-perf.mjs   # 打包后的 .app 性能测量（首屏 / 逐键 p95 / 内存）
npm run perf         # Playwright 性能基准（P1/P4/P5/P8/P11，见 docs/SPEC.md §11）
npm run bench        # worker 侧 vitest 基准
npm run gen:sample   # 重新生成 test-data/{small,medium,large,huge}.md
```

`bench/verify/` 下是多轮自动化验证留下的 Playwright 脚本（性能、渲染正确性、UX、健壮性），可按需单独运行；多数脚本通过 `MDR_BASE=http://localhost:<port>/` 指定服务器。

**单元测试：抽样与全量。** 默认（抽样）跑法：`npx vitest run --no-file-parallelism`（整套，串行；不要同时跑两个整套）或
`npx vitest run test/serialize.roundtrip.test.ts`（单个文件）。几个重的模糊测试默认只跑确定的样本：medium.md 每 10 个块取 1 个、
delta 模糊测试种子 1–40 加每 3 个预览种子取 1 个、review-fuzz 每 7 个种子取 1 个、列表缓存模糊测试 10 个种子 × 30 次编辑，
每个用例都有显式超时。全量：`MDR_FULL_FUZZ=1 npx vitest run --no-file-parallelism`（`test/serialize.listcache.test.ts` 全量单独约 4–5 分钟）；
转义模糊测试可调 `MDR_FUZZ_SEED=<n> MDR_FUZZ_N=<次数>`。
`test/electron.fileIO.differential.test.ts` 把编码检测与冻结的 0.1.0 解码器 `test/fixtures/fileIO-0.1.0.mjs` 对比（约 13.3 万个输入）。0.2.0 默认关闭 `DECODER_OVERRIDES`，读法与 0.1.0 完全一致，保存改动的字节不比 0.1.0 多；暂不启用的覆盖规则在测试里显式打开后另行检查。
`R3D_DIR=<临时目录> node bench/electron/r3-d-parity.mjs` 在系统 Node 和 Electron 自带的运行时（`ELECTRON_RUN_AS_NODE=1`，不开窗口）里各跑 24.3 万个输入：与 0.1.0 读法差异 0、更差的保存 0（约 3 分钟，最后打印 PARITY OK）；
这个夹具含原始控制字节，**不要编辑或重新格式化，只能用 cp 复制**。

**预览内编辑的浏览器验证**（headless Chromium，各自启动并关闭自己的 Vite，端口用 `MDR_PORT=<port>` 指定，不要用 5173；
跑的时候不要同时改 `src/`，否则 Vite 会整页重载、结果作废）：

| 脚本 | 内容 | 当前结果 |
|---|---|---|
| `bench/verify/inline-edit-e2e.mjs` | 端到端主流程 | 22/22 |
| `bench/verify/inline-edit.mjs` | 基本编辑与转义 | 24/24 |
| `bench/verify/inline-verify-fidelity.mjs` | 222 个块点一下/改一下，渲染不变（会覆盖 `bench/verify/out/inline-verify-fidelity.json`） | 5/5，0 块渲染改变 |
| `bench/verify/inline-verify-editing.mjs` | 按键、粘贴、撤销、格式键 | 69/69 |
| `bench/verify/inline-verify-render.mjs` | 编辑时预览不跳、焦点不丢 | 12/13（最后一步是脚本在本机的前提问题，见 `bench/verify/v2-cfm-render-diag.mjs`） |
| `bench/verify/inline-verify-interplay.mjs` | 与 worker、滚动、源码编辑的配合 | 21/21 |
| `bench/verify/inline-verify-resume.mjs` | 回车分段后不丢输入（含输入法） | 13/13 |
| `bench/verify/inline-verify-perf.mjs` | 性能：300 项列表每键 flush p95 2.2–3.4 ms、会话开始 24–43 ms（每次只测一回，结果在两档之间跳，第六轮前的代码同样是 24–42 ms；含 U12 保真关卡，预算 50 ms） | 5/5 |
| `bench/verify/fixB-session.mjs` | U1、U3–U6 的真实 Chrome 检查 | 21/21 |
| `bench/verify/fixA-large-jump.mjs`、`fixA-undo-outside.mjs` | large.md 跳动与回车续接；编辑器外 ⌘Z、编辑中的提示 | 4/4、5/5 |
| `bench/verify/fixF-web-drop.mjs` | 网页版：确认框在屏时拖入的文件不丢 | 9/9 |
| `bench/verify/fixC-listperf.mjs`、`fixC-nbsp.mjs` | 大列表序列化开销；Chromium 输入不产生 NBSP 的证据 | 300 项会话开始 9–13 ms（指示性目标 20），1000 项 27–30 ms |
| `bench/verify/fix2-g-walk.mjs` | U12 保真关卡在项目文档上的误拒（`MDR_MODE=click` 真实点击 / `direct` 快速；要先在 `MDR_PORT` 起好 Vite） | 2 107 块，拒绝 8（全是 FINDINGS-0.2.0-r1.md 里未转义 HTML 的标签汤），普通块 0，写入 0 |
| `bench/verify/v2-*.mjs` | 第二阶段验证员的复现与回归脚本（`MDR_PORT`；`v2-ses-*` 会在端口上留一个 Vite） | 见 docs/FINDINGS-0.2.0-r1.md；fuzz 种子 1–28 + 大文档 1–6、wysiwyg 1–22 全过；v2-ses-merge 17/25（8 个是 K8） |
| `bench/verify/v3-*.mjs` | 第二次复验（r2）的复现与回归脚本（`MDR_PORT` / `MDR_URL`） | 见 docs/FINDINGS-0.2.0-r2.md；还失败的只有已接受或延后的组（K16、K20、K22、K23、K24、K25）和在第三轮修复前就同样失败的用例；v3-ses-fuzz 31 个种子全过 |
| `bench/verify/r3-*.mjs` | 第三轮修复员的检查（删空块邻居矩阵、离开会话的拖选、公式/图片前的光标、粘贴替换选区、拖放文件、保留名扫描的 Chromium 差分） | 全过：r3-ia-empty 288/288、r3-ia-drag 与 0.1.1 逐字相同、r3-p-drop 17/17、r3-t-chromium 漏 0 |
| `bench/verify/v4-*.mjs`、`v5-*.mjs`、`r4-*.mjs` | 第三次复验（r3）的复现、第四轮挑战者与开关关闭审查的脚本、第四轮修复员的检查（`MDR_PORT`；需要 0.1.1 对照的另给 `MDR_BASE_PORT`） | 见 docs/FINDINGS-0.2.0-r3.md 与 CONTRACT §11；还失败的只有已接受（K25–K27）或推迟到 0.2.0 之后的项（J7、J11、J29、CHA-3/4/6–9、CHB-2/4/5）和第四轮之前就同样失败的用例；四个随机测试 182 个种子全过；v5-chc-ticks 548 例没有一次勾到别的任务（判定脚本报的 6 个 WRONG 是编辑器里删的正是被点任务自己的字、判定找不到它，0.1.1 上同样） |
| `bench/verify/r5-*.mjs` | 第五轮修复员、挑战者与审查员的检查：公式与图片在 Chromium 合并后不变（r5-fa-recreate、r5-fa-joins、r5-fa-tasku23、r5-ca-joins）、链接地址里的转义保持转义（r5-ca-escapes）、编辑代码按需加载（r5-pl-noload、r5-pl-user、r5-rl-races、r5-rl-testboot、r5-fl-loading，`MDR_URL` 指向正式构建） | r5-fa-recreate 28/28、r5-fa-tasku23 7/7、r5-fa-joins 708/720（12 个是已接受的列表项第二段 Enter+Backspace；要每个容器单独跑）、r5-ca-escapes ent- 5/5（dup- 两例按 C2 两处都写成转义，脚本按个数相等判为 FAIL）、r5-rl-races 37/37、r5-pl-user 75/75、r5-fl-loading 28/28 |
| `bench/verify/r6-*.mjs` | 第六轮修复员、挑战者与集成者的检查：用字符引用写的不可见字符编辑后仍是引用（r6-cr-edits、r6-cr-swap）、总闸（r6-cr-guard；`node --import ./bench/verify/r6-fr-guardhook.mjs <脚本>` 统计任何脚本里总闸拦下的次数）、格式命令（r6-fr-bold、r6-cr-format）、被安全过滤改过的块不能编辑（r6-frb-rulet、r6-int-rulet）；第五轮验证员的定义脚本 `bench/verify/v6-*.mjs` | r6-cr-edits 22/22、r6-cr-swap 0/8 写出、r6-cr-guard 20/20、r6-cr-format 21、r6-fr-bold 17 例、r6-frb-rulet 25/25、r6-int-rulet 11/11；v6-von-linktext 20/20，v6-vr-entity、v6-vr-fffc、v6-vr-bold 均 PASS；所有脚本总闸 0 次 |
| `bench/verify/r7-*.mjs`、`bench/electron/r7-c7-desk.mjs` | 第七轮修复员与挑战者的检查：保存进行中换文档（r7-fs-table、r7-c7-save；网页上等待只能在 Vite 开发服务器上缩短）、过滤报错的块（r7-fn-san、r7-fn-diff、r7-c7-san）、导出（r7-fp-export、r7-c7-export）、两边开始编辑的块相同（r7-fp-starts：真实点击，树对已发布的 dist）、退格合并（r7-fm-merge、r7-c7-merge）、font 简写（r7-fm-font、r7-c7-font） | 全过；挑战者的 5 个低级点（C7-1 至 C7-5）已接受，写在「已知限制」 |
| `bench/verify/fix2-*.mjs` | 第二轮修复员的检查（指针与选择、删空块、粘贴预算、链接激活、保留名标记、草稿流程…） | 全过 |

**桌面版验证**（都通过 `bench/electron/_electron.mjs` 启动：隔离的配置目录，不碰真实配置和最近文档列表）：
开发模式 `node bench/electron/verify-files.mjs`（70 项）、`node bench/electron/verify-guards.mjs`（165 项）、
`MDR_PORT=<port> node bench/electron/fixF-guards.mjs`（36 项：打开/丢弃/关闭流程 R1–R3）；这三个加 `MDR_BASE=http://localhost:<port>` 就用已经在跑的 Vite。
对一个解包的应用目录（含 `dist/`、`electron/`、`package.json`，不需要 node_modules）：
`MDR_APP_DIR=<目录> node bench/electron/open-lifecycle.mjs`（27 项；负载高时加 `MDR_TIMEOUT_MS=600000`；`MDR_SKIP=16,17,18` 跳过编码检查），
`verify-hotfix-review-r2.mjs`、`verify-final-review-normal.mjs`、`verify-final-review-nav.mjs` 也接受 `MDR_APP_DIR`（或 `MDR_EXE`）。
编码检测的对比基准：`node bench/electron/lead-gbk-differential.mjs`（应为 0 处翻转）。
`v2-shell-*.mjs`、`v2-flow-desk.mjs` 用 `MDR_TARGET=staging|baseline|dev` 选应用目录，`v2-dec-e2e.mjs`、`v2-rev-desktop.mjs` 用 `MDR_APP_DIR`；
`verify-hotfix-behaviour.mjs` 不设 `MDR_EXE` 时会启动 /Applications 里的应用，测试候选版本时一定要给 `MDR_EXE`。
0.2.1 候选（`release/staging-0.2.1.noindex`，第七轮修复后；除主脚本和编辑功能的代码块外与已发布的 0.2.0 逐文件相同）：open-lifecycle 27/27、v2-shell-nav 22/22、v2-shell-life 75/78（e1 为提示项，e4 两项 = K9）、v2-shell-startup 10/10、v2-shell-doclink 4/4、v2/v3/v4-dec-e2e 与 0.2.0 相同、v2-flow-desk 30/32（D7 = K9，D3 crash = G35）、v3-flow-desk 65/68（K2、K4、K10）、v4-flow-desk 25/25、v3-shell-queue 196/196、v3-shell-vectors 5/6、v4-sesa-desk 6/9（J7 两项、J15）、r4-rel-desk 15/15、r5-pl-desk 13/13、r5-rl-desk 31/31、v5-sw-desk 14/14、v5-offk-save 6/6、其余 v5-offk-*（不含用系统剪贴板的 copy、menu）与 0.2.0 逐例相同、lead-gbk-differential 0 处翻转、r3-d-parity 读法差别 0。桌面脚本里写死 `release/staging-0.2.0.noindex` 的，用 `MDR_STAGING_DIR=<目录>` 换成别的候选目录。
第六轮修复后的候选（`release/staging-0.2.0-r6.noindex`，除编辑功能的代码块 `inlineEdit-*.js` 外与第五轮候选逐文件相同）：open-lifecycle 27/27、r4-rel-desk 15/15、r5-pl-desk 13/13、r5-rl-desk 31/31、v5-sw-desk 14/14、v4-sesa-desk 6/9（J7 两项、J15）。0.2.0 候选（staging，第五轮修复后）当前结果：open-lifecycle 27/27、v2-shell-nav 22/22、v2-shell-life 75/78（e1 为脚本自注的提示项，e4 两项 = K9）、v2-shell-startup 10/10、v2-shell-doclink 4/4、v2-flow-desk 30/32（D7 = K9，D3 crash = G35）、v3-flow-desk 65/68（K2 = K25；K4、K10 在 0.1.1 上同样失败）、v4-flow-desk 25/25、v3-shell-queue 196/196、v3-shell-vectors 5/6（6 个页面脚本向量在 0.1.1 上同样坏）、v3-app-staging 5/5、v4-sesa-desk 6/9（J7 两项、J15）、r4-rel-desk 15/15（首次启动开关关、菜单项「预览可编辑（实验性）」）、r5-pl-desk 13/13（开关关时不读编辑功能的代码文件，打开后读一次、会话可用）、r3-d-parity PARITY OK、lead-gbk-differential 0 处翻转；v3-dec-e2e 与 0.1.1 基线逐行相同，v2-dec-e2e、v4-dec-e2e 只差两边都解不了码的文件的提示 / 拖放拒绝（R3 / G31 决定）；`bench/electron/v5-offk-*.mjs` 候选对 0.1.1 只差已决定的项（其中 copy、menu 会临时改动并还原系统剪贴板）。`repro-closed-window.mjs` 也接受 `MDR_APP_DIR`，两者都不给时拒绝运行。开关关闭（发布配置）对 0.1.1 的常设关卡：`bench/verify/v5-offc-probes.mjs all`（160 例，144 相同，其余 16 例都是开关本身或已决定的差异）、`v5-offc-rest.mjs`（DOM 与样式相同）、`v5-offd-matrix.mjs`（2 126 例，四个分片，开发服务器 1 610 相同 / 70 已归类 / 446 跳过）、`v5-offd-fuzz.mjs`、`v5-atp-probes.mjs`；`bench/verify/r4-rel-default.mjs` 在不带 `?perf=1` 的正式构建上 44/44。

## 目录结构

```
src/shared/    冻结的模块契约（类型、worker 协议、事件总线、快捷键匹配、i18n）
src/worker/    渲染 Worker：文档镜像、分段器、markdown-it、高亮、KaTeX、大纲/统计、LRU 缓存、草稿
src/preview/   预览：块级 DOM 补丁、高度模型与视口物化、滚动同步、目录、交互、DOMPurify
src/editor/    CodeMirror 编辑器、命令、快捷键、工具栏、命令面板、主题
src/app/       组合根：布局、主题、状态栏、全局快捷键、worker 客户端（含重启）、对话框、导出
src/files/     文件服务（原生路径 / File System Access / 回退）、最近文件、草稿存储
electron/      桌面外壳：主进程、预加载桥（window.mdrNative）、app:// 协议、中文菜单、窗口状态
scripts/       图标生成、安装到 /Applications、LaunchServices 默认打开方式
docs/          SPEC.md（设计规格）、CONTRACT.md（集成契约）、各轮验证记录
```

## 已知限制

- 极大文档（`test-data/huge.md`，6.6 MB / 34 万行，超出设计目标的 10 MB / 10 万行）渲染进程内存约 570 MB，规格目标 450 MB 未达成；3 MB 的 `large.md` 约 290 MB，达标。
- 编辑器侧每次按键约 15–25 ms 的主线程开销来自 CodeMirror 自身的 Markdown 解析（已按文档大小分级：>128 KB 关闭代码块内嵌语言高亮，>256 KB 关闭 Markdown 语法解析）。
- 单个块的源码超过 200 KB 时以纯文本显示（预览中有提示）。
- 预览按块独立渲染，跨空行的 HTML 容器（如 `<details>`）只支持常见写法。
- 本版读取文件的编码识别与 0.1.1 相同：Big5、Shift_JIS、EUC-KR、没有 BOM 的 UTF-16 文件和 0.1.1 一样打开（多数会显示成乱码），也不会弹「不是有效的 UTF-8」的提示；保存时改动的字节不会比 0.1.1 多。
- 预览可编辑打开时，在预览里点进一段后，空格、Shift+空格、Home、End 都作用于文字，不再翻页或滚动；想只读可关闭「预览可编辑」（`⌘⇧E`）。默认关闭时这些键照常翻页、滚动。
- 在预览里紧挨着软换行（源码里两行之间没有空行）打字或删字，会把这两行源码并成一行，显示效果不变。
- 两种少见写法不能在预览里编辑（会提示「此块请在源码中编辑」）：一个列表块里连着三个以上同类列表；文档里定义了名为 `x` 的引用（`[x]: 网址`）时的任务列表。
- 在段落开头按退格把两段合并时，源码是直接拼起来的，接缝处的 `*`、`[` 等符号可能和另一段的配成一对（例如变成斜体）；按 `⌘Z` 可以还原。
- 在预览里按回车新建的空段落，打字之前不会写进源码；没有写协议的网址（`www.example.com`）所在的块第一次在预览里编辑时会写成完整链接；在一个几万字、中间没有空格的超长单词里打字很慢。
- 点击任务复选框前的一瞬间，如果这一行刚被改动（行首字符被删或被替换、行内插入了换行）、文档被整体替换，或者这一块自上次渲染以来已经有 4096 次以上的修改，这一下不会勾选，并提示「没有勾选：该任务项刚被改动，请再点一次」；再点一次即可。
- 一行任务被复制成两行后立刻点击，勾选落在下面那一行。
- 用脚本直接触发、没有真实按下动作的点击不会勾选任务；键盘可以用 Tab 移到复选框再按空格。读屏软件对包着任务复选框的文字执行「按下」会勾选该任务（与 0.1.1 相同）。
- 用 Tab 移到文档里被隐藏的任务复选框再按空格，会勾选看不见的任务（与 0.1.1 相同）。
- 跳到很远的位置后按住 Shift 点击，选区起点偶尔落在文档开头。
- 长文档切换显示模式后，编辑器的滚动位置可能差几行。
- 换文档时如果正在保存，会先等保存结束（最多 10 秒，网页版「打开」最多 4 秒），等待期间界面没有提示。
- 保存超过 10 秒还没结束时会照常询问是否丢弃；此后保存失败、而你在看到失败提示后仍选「丢弃」，输入的内容不会保留。
- 桌面版：未命名文档「另存为」还没写完时关闭窗口并选「不保存」，下次启动可能提示恢复一份其实已经保存的草稿。
- 一次拖入多个文件且第一个不是 Markdown 时，不会打开其中的 Markdown 文件（与 0.1.1 相同）。
- 桌面版里 mailto: / tel: 链接点了没反应；含四字节字符的 GB18030 文件只能另存为 UTF-8；旧的网页存储方式下，一个标签页保存会删掉另一个标签页里同名未命名文档的草稿（与 0.1.1 相同）。

- 两栏的滚动位置不一致时勾选任务，编辑器会滚动到被勾选的那一行。
- 源码里有 `<?form>` 这类处理指令的段落，预览中这一块显示为「渲染此段落时出错」框（把这一块的 HTML 当文字显示），其余内容照常。导出 HTML 时这一块同样是这个框（框里是浏览器重新整理过的写法，例如 `<?form>` 写成 `<?form ?>`）；原始 HTML 标签跨了好几段时（例如 `<details>` 包住几段文字），整个标签里的内容都在同一个框里。
- 导出 HTML 时，个别文档里「无法安全显示的块」会按过滤后的普通内容导出，而不是提示框。

**「预览可编辑（实验性）」打开后才会遇到的已知限制**。这是实验性功能，默认关闭，它的代码只在打开时才加载；默认关闭时下面这些都不会出现：

- 第一次打开「预览可编辑」时需要加载编辑功能的代码；加载失败时会提示「预览编辑功能加载失败，请刷新页面或重启应用后重试」，开关保持关闭。浏览器不会再次请求加载失败的代码，只有刷新页面（网页版）或重启应用（桌面版）才能重试；按开关时失败，会把开关记成关闭，下次启动不再提示；启动时自动加载失败，开关的设置不变。
- 一个块第一次被编辑、它的 Markdown 写法同时被规范化时，紧接着的撤销或重做可能把光标放到块内别处。
- 清空一个块后立刻在它下方双击或三击，选中的可能是再下一块的内容。
- 粘贴多段文字且最后一段带换行后，接着输入的字可能落在最后一个词里面；撤销一次可恢复。
- 三击带公式的一行再按右方向键，光标会进到公式里，随后的输入无效；重新点击一次即可。
- 编辑中按住任务复选框、移开后松手，按 Esc 后立刻再点这个框，这一下可能不生效；再点一次即可。
- 在列表项的第二段开头按 Enter 再按 Backspace，会在合并后的文字前多出一个空列表项。
- 在任务项里把光标移到复选框前面（Home），按 Enter 再按 Backspace，会留下一个反斜杠换行。
- 在预览编辑里剪切后再粘贴，公式、图片和加粗不会还原（粘贴按纯文字处理）；移动公式和图片请在编辑器里做。
- 紧跟在公式或图片后面按 Enter 再按 Backspace，两行不会并回去；行间公式后面还可能多出一个星号。
- 在带强制换行的列表项开头按 Enter 再按 Backspace，列表项会在换行处被拆开。
- 任务列表里用 Delete 把含行间公式的下一项并上来时，要按 Esc 才写回源码，在此之前被并进来的复选框仍显示在屏幕上。
- 某个公式的 TeX 源码在编辑中无法确定时，这一块不写回源码，并提示「此块请在源码中编辑」。
- 链接地址里用 HTML 实体或反斜杠转义写的部分、同一块里写法不一致的同一个地址，编辑这一块后地址里其他看得见的转义会写成字符本身（看不见的字符仍保持百分号转义，链接地址不变）。
- 在引用或宽松列表项里选中跨两段的文字后打字或粘贴，源码里会写出 `&nbsp;`（显示成普通空格）；剪切一个词后，留下的不间断空格在源码里写成 `&nbsp;`。
- 删空一块的同一瞬间再按一次退格（极快的连按），上方不是段落时这次退格不起作用，接着打的字写在删掉的位置。
- 删掉没有结尾换行的文档的最后一块，文件末尾会补上一个换行。
- 在宽松列表里按 `⌘A` 再退格，会留下一个空的列表项，接着打字会写成「- 字」加一个空的「-」。
- `⌘A` 选中整个预览之后，第一次点进某一块不会开始编辑，要再点一次。
- 在段内换行（行尾两个空格）的正前方按回车，打的字落到换行后面，新段落以一个反斜杠换行开头。
- 编辑中从工具栏或命令面板执行「标题」「切换任务项」等命令，会作用在这一块的第一行或最后一行，而不是光标所在的那一行。
- 编辑中弹出「放弃更改」确认框时点「取消」，焦点不回到原处，下一个按键会丢失，要先点回去。
- 在加粗、斜体、删除线或链接里的公式、图片前按回车，可能多写出一个换行；在标题里的图片、带链接的图片前按回车，打的字会落到图片后面。
- 粘贴开头或结尾带空行的文字时，那个空行不会变成分段，粘贴的内容会接在光标所在的段落里。
- 段落中间在空格前按回车、紧接着按退格，那个空格会丢失。
- 退格把一段并到以行内代码或加粗结尾的段落后，接着打的字会进到代码或加粗里面。
- `⌘Z` / `⇧⌘Z` 或退格合并之后，如果这一行里有不成对的 `*`、`_`、不认识的 `&名字;`、四字节字符的数字实体或行内代码里的反斜杠，光标会偏 1–4 个字符；在公式块（`$$`）的 TeX 源码里撤销后，光标落在 TeX 末尾。
- 删空一块、而它上下两块在源码里因此并成一块时，空着的编辑位置显示在合并后那块的下面（打的字仍写在原来的位置）；删空一块后若左侧源码里它上方的几行被改动且这几行内容彼此重复，打的字可能写到上一块的位置。
- 刚按回车分段并按 `Esc` 结束编辑、预览还没更新时就点进后半段，打的字可能落到前半段末尾；在左侧编辑器开头插入内容后、预览还没更新时点预览的第一块，打的字可能落进新插入的那块。
- 预览还没更新完时连续点两处并各打几个字，第一处的字不会写入，会提示「预览尚未更新完，刚才的输入没有写入」；预览迟迟没有更新时，点击后打的字也会这样提示后丢弃。
- 选中位于行首的整段链接文字后粘贴或打字，链接会丢失（`⌘Z` 可以还原）；行中间的链接不受影响。
- 在任务项里用 `⇧Enter` 加了段内换行后按 `Esc`，马上点这个任务的复选框会不勾选并提示「没有勾选：该任务项刚被改动，请再点一次」；按 `Esc` 后这一块重新显示之前很快地连点两个复选框，第一个也会这样提示。
- 在编辑器外撤销时，如果被撤销的位置不在屏幕内，预览不会滚动过去。
- 输入法正在组字时按 Esc，不会结束编辑；组字结束后再按一次。
- 源码里用字符引用（如 `&shy;`、`&emsp;`、`&zwnj;`）或链接里的百分号转义写的不可见字符，预览编辑后仍然保持为引用；同一块里同一个字符既有原样又有引用两种写法时，会统一写成引用。
- 同一块里同一个不可见字符有几种引用写法时，预览编辑后会统一成第一种写法。
- 在预览里修改一个裸链接的文字后，它会被写成 `[文字](地址)` 的形式，地址不变。
- 如果一次预览编辑会让源码里多出你没有输入的不可见字符，这次编辑不会写入，并提示「此块请在源码中编辑」。
- 含有会被安全过滤改动的原始 HTML（例如 iframe、script、带事件属性或 `javascript:` 链接的标签）的块不能在预览里编辑，会提示「此块请在源码中编辑」；链接或图片的标题、图片说明首尾带空格或含 `-->`、`]>` 时（安全过滤会修剪或删掉它们）也一样。
- 下面这些少见的块也不能在预览里编辑（会提示「此块请在源码中编辑」）：链接或图片地址里原样写着某个不可见字符、同一块别处又用引用写了它；引用定义的标题里、或原始 HTML 的 `<code>` 里用引用写了不可见字符；原始 HTML 属性里用引用写了控制字符，或用不带分号的 `&nbsp` 写了不间断空格。
- 正文或标题里的 `&#13;` 预览编辑后会写成换行，显示不变；紧挨着不可见字符引用的 `_`、`*` 前面可能多出一个反斜杠，显示也不变。
- 合并两行时浏览器顺手去掉的多余加粗、斜体样式（同一元素上还有别的样式时），之后也不会写回源码，显示不变。
- 用 CSS `font` 简写并带 `!important` 或 `var()` 的样式，加粗、斜体后仍可能被展开或不生效；在加粗文字里对用 `font` 简写的文字再加粗，源码写成 `bold`（700），比预览里的加粗（600）稍粗。

## 许可证

MIT，见 [LICENSE](LICENSE)。

仓库里不含两个大的性能测试文档（`test-data/huge.md`、`test-data/large.md`），需要时运行 `npm run gen:sample` 生成。
