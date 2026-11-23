# hunt:files — 文件内容、路径与权限（查找员 2，2026-11-20）

被测对象：已安装的 `/Applications/MDReader.app`（0.1.0，2026-09-21 构建），每次启动都用全新的 `--user-data-dir`（mktemp），
`app.addRecentDocument` 在主进程里被替换为空函数，临时路径不会进入 macOS「打开最近」。语料全部是合成内容，
在系统临时目录生成并在结束时删除。没有修改 electron/ 或 src/。

## 脚本

| 脚本 | 作用 |
|---|---|
| `bench/electron/hunt-files-corpus.mjs` | 生成 69 个用例（编码 17、换行 4、内容形态 13、文件名/路径 21、文件系统 14）。`node bench/electron/hunt-files-corpus.mjs` 打印清单后自删。 |
| `bench/electron/hunt-files-run.mjs` | 执行器。warm：窗口开着，先 文件→新建 复位，再 `app.emit('open-file')`；cold：把路径作为命令行参数冷启动。比对编辑器文档（长度、首尾 20 字符、FNV 哈希）、预览块数、标题、状态栏、toast（MutationObserver 记录，9 秒后再看一次是否还在）、console/pageerror。 |
| `bench/electron/hunt-files-save.mjs` | 后续验证：被错误解码的文件编辑后 ⌘S 会怎样。 |

复现命令（项目根目录，后台运行，约 4 分钟）：

```
nohup node bench/electron/hunt-files-run.mjs --phase=both --out=/tmp/hf.json > /tmp/hf.log 2>&1 &
node bench/electron/hunt-files-run.mjs --phase=cold --cold-all --only=fs-missing,enc-big5,enc-utf8-truncated,fs-dir-named-md,enc-utf16le-nobom-zh,shape-5mb-line
node bench/electron/hunt-files-save.mjs
```
（`MDR_EXE=<可执行文件>` 可换成别的构建。）

## 结论先说

* **没有找到**「UTF-8 / 带 BOM / UTF-16 带 BOM / GBK 的正常非空 .md 在窗口开着或冷启动时被显示为空」的情况。换行（LF/CRLF/CR/混合）、
  front matter、纯 HTML、纯注释、纯代码块、2000 个空行后才有文字、只有空白加一个字符、5 MB 单行、NUL 字节、30 MB 文件、纯引用定义、
  所有文件名/路径用例（中文、emoji、空格、# % ? & + = 引号、反斜杠、换行、点开头、250 字节文件名、977 字节路径、.MD、.markdown/.mdown/.mkd/.mkdn、
  无扩展名、.txt、NFD 路径）、符号链接/链式链接/硬链接/只读文件，都逐字一致（哈希相同）。
  用户报告的「打开非空文件显示为空」的主因仍是 lead 已确认的「关窗后 open-file 被丢」；本文件列出的是**其它会让用户看到空白或乱码的文件类别**。
* 所有「打不开」的情况，最终画面都是**空白的「未命名.md」+ 一条 8 秒后消失的 toast**（冷启动时尤为明显）——这在用户眼里就是「打开了一个非空文件却显示是空的」。

## 发现

### F1（high, main）Big5 / Shift_JIS / EUC-KR 文件被当成 GBK 解码，显示为乱码；编辑后保存会把新字写成 GBK 字节，静默损坏文件
* warm 与 cold 都复现：`enc-big5`、`enc-shiftjis`、`enc-euckr` 全部显示为 GBK 乱码（例：Big5 的「標題」显示为「夹肈」），toast 还说
  「该文件是 GBK 编码，已按原编码读取，保存时也写回 GBK」。
* `hunt-files-save.mjs`：在 Big5 文件末尾输入「新增」并 ⌘S → toast「已保存」，磁盘上按 Big5 读出来是「陔崝」。
* 原因：`electron/fileIO.mjs` `decodeBuffer` 按 `LEGACY_ENCODINGS = ['gbk','big5','shift_jis','euc-kr','windows-1252']` 顺序取第一个
  fatal 解码成功的结果；Big5（首字节 A1–F9，尾字节 40–7E/A1–FE）、EUC-KR（A1–FE/A1–FE）、Shift_JIS 的双字节对几乎全部是合法的 GBK 双字节对，
  所以 GBK 永远先赢。没有任何频率/语言判定。

### F2（high, main）UTF-8 文件里只要有一个坏字节（截断的下载、拼接错误），整篇中文显示为 windows-1252 乱码
* `enc-utf8-invalid-ff`（偏移 20 插入 0xFF）、`enc-utf8-invalid-80`（一个孤立 0x80）、`enc-utf8-truncated`（文件末尾截断在 3 字节序列中间）：
  warm 与 cold 都显示为「# æ ‡é¢˜ …」，toast「该文件是 WINDOWS-1252 编码」。理想行为是按 UTF-8 显示、坏字节处一个 U+FFFD 并提示。
* 后续：输入「中」后 ⌘S → 「保存失败：文档包含 WINDOWS-1252 编码无法表示的字符「中」，请用「另存为」保存为 UTF-8」，磁盘未变；
  但若用户照提示另存为 UTF-8，写下去的就是乱码本身（推论，未执行保存面板）。
* 原因：严格 UTF-8 失败后直接走 legacy 列表；`CONTROL_RE` 实际只有 `[\x00-\x08\x0B\x0C\x0E-\x1F]`（注释说还含 C1 区，但字节里没有），
  WHATWG windows-1252 能解码任何字节，所以这条兜底几乎总是"成功"。
* 同类：`enc-latin1-trap`（ISO-8859-1，每个重音字母后面都跟字母，如「Über élan façade Zürich」）被解成 GBK：「Z黵ich」「躡er」。
  `enc-latin1-safe`（重音字母后跟空格/标点）与 `enc-cp1252` 正确。

### F3（medium, main）无 BOM 的 UTF-16LE：纯 ASCII 内容显示成夹着 NUL 的文字；含中文时直接拒绝打开
* `enc-utf16le-nobom-ascii`：文档长度 156（应为 78），每个字符后跟 U+0000，预览只剩 1 个块。
* `enc-utf16le-nobom-zh`：toast「打开失败：无法识别该文件的文本编码（可能是二进制文件）」，冷启动时用户停在空白「未命名.md」。
* 原因：`decodeBuffer` 只认带 BOM 的 UTF-16；ASCII 的 UTF-16LE 恰好是合法 UTF-8（NUL 也合法），UTF-8 分支不检查控制字符。

### F4（medium, renderer + main）打不开时只有 8 秒后消失的 toast，冷启动时用户面对空白「未命名.md」；文案误导
冷启动（命令行参数）与 warm 都复现，9 秒后 toast 已不在，标题「未命名.md」，状态栏「未命名.md · 未命名」，编辑器 0 字符：
| 用例 | toast 文案 | 问题 |
|---|---|---|
| `fs-chmod000`（模拟 TCC 拒绝 / 无读权限） | 需要重新授权访问该文件 | 桌面版没有任何"重新授权"入口，这是网页版 File System Access 的文案；不告诉用户是权限问题、也不说文件名 |
| `fs-dir-000`（所在文件夹无权限） | 需要重新授权访问该文件 | 同上 |
| `fs-missing` / `fs-symlink-dangling` / `fs-deleted-race` | 文件已不存在，已从最近列表移除 | 双击打开的文件根本不在最近列表里；不说文件名 |
| `fs-dir-named-md` | 打开失败：这是一个文件夹，不是文件 | 尚可，但同样会消失 |
| `enc-utf16le-nobom-zh` | 打开失败：无法识别该文件的文本编码（可能是二进制文件） | 同 F3 |
* 原因：`src/app/native.ts` `createNativeOpener` 对 NotAllowedError 用 `T.needReauth`、对 NotFoundError 用 `T.fileNotFound`，toast 用
  默认的错误超时（已安装构建里 `yg=8e3`）；`electron/paths.mjs` `nativeErrorFor` 把 `EPERM`（TCC 拒绝时 macOS 返回的就是 EPERM）与
  `EACCES` 合并为同一个 `EACCES`，渲染端无法区分"隐私权限拒绝"与普通权限问题；`src/files/nativeBackend.ts` `toOpenError` 再把它变成
  NotAllowedError。失败时窗口内容不变——冷启动时就是启动时创建的空白草稿。

### F5（medium, main）命名管道（FIFO）名为 .md：读取永远挂起，之后所有打开请求都排在它后面，什么都打不开
* `fs-fifo`：6 秒内无 toast、无变化；紧接着打开普通文件 `fs-after-fifo` → 6 秒后仍是空白「未命名.md」。
  测试脚本以非阻塞方式打开写端再关闭（EOF）后，`after-fifo.md` 才出现。
* 原因：`readFileInfo` 先 `stat`（只排除目录），然后 `fsp.readFile` 在 FIFO 上一直阻塞；渲染端 `installNative` 用一条 promise 链串行处理
  open-file（`chain = chain.then(() => host.openPath(path))`），挂起的那一个堵住了后面所有的。现实中少见，但同样的"读永远不返回"也可能出现在
  卡住的网络卷上（未测试）。应只接受 `st.isFile()`，并给读取加超时。

### F6（low, main）冷启动命令行参数里的无扩展名文件被静默丢弃
* cold `ext-none`（`MDReader /path/README`）：没有任何提示，空白「未命名.md」。通过 open-file（Finder 路径）打开同一文件正常。
* 原因：`pathsFromArgv` 只接受 `MARKDOWN_EXT_RE` 匹配的参数。只影响终端启动。

## 正常（逐字一致）的类别
编码：UTF-8、UTF-8 BOM、UTF-16LE BOM、UTF-16BE BOM、GBK、GB18030（含 4 字节字符「㐀」，按 gbk 标签解码正确）、ISO-8859-1（安全样本）、windows-1252 弯引号/€。
换行：LF、CRLF、CR、混合。形态：front matter（含只有 front matter）、纯 HTML / details、纯注释、纯代码块、缩进代码、2000 空行后文字、
空白+单字符、纯引用定义、NUL 字节、5 MB 单行（toast「大文件：已关闭语法高亮」）、30 MB（17,476,297 字符，warm 与 cold 都完整，冷启动约 4 秒）。
名称与路径：全部 21 个。文件系统：符号链接、相对链式链接、硬链接、只读、0 字节随即写满（读到写满后的内容）。
console：整个 warm 会话 1 条 error（`<img src="logo.png">` 的 404，预期），0 个 pageerror。

## 隐私保护文件夹（TCC）
* 没有在用户的桌面/文稿/下载/iCloud 创建任何文件，没有触发弹窗。
* 用户 `~/Library/Application Support/com.apple.TCC/TCC.db`（只读查询）：179 条记录中 `com.zyx.mdreader` 为 0 条——MDReader 从未被授予或拒绝过任何
  TCC 服务（包括文稿/桌面/下载文件夹）。双击打开的文件由 Finder 的"用户意图"隐式授权，不需要记录；但从应用内最近列表、或下次启动后按路径重新读取
  受保护文件夹里的文件时，系统会弹窗或返回 EPERM（未实际触发）。
* 统一日志（`log show --last 7d`，谓词 com.apple.TCC / tccd + mdreader，后台运行）：tccd 的日志实际只保留到今天 00:31（约 1 小时），
  其中与 MDReader 有关的只有本次测试启动时 WindowServer 的检查，没有文件夹访问拒绝记录。所以**无法从日志证明**用户遇到过 TCC 拒绝；
  如果遇到，用户看到的就是 F4 里 chmod 000 的画面：8 秒的「需要重新授权访问该文件」，然后是空白文档。
