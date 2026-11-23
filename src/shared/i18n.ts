// src/shared/i18n.ts — zh-CN UI strings shared by two or more modules. Module-private strings live in the module.
export const T = {
  appName: 'MDReader',
  untitled: '未命名.md',
  // file
  fileNew: '新建', fileOpen: '打开', fileSave: '保存', fileSaveAs: '另存为', fileDownload: '下载', fileExportHtml: '导出 HTML',
  // view
  modeEdit: '编辑', modeSplit: '分栏', modePreview: '预览', cycleMode: '切换模式',
  toggleToc: '显示/隐藏目录', toggleTheme: '切换主题', palette: '命令面板', mountAll: '全部渲染',
  // edit
  bold: '加粗', italic: '斜体', inlineCode: '行内代码', link: '链接', heading: '标题', paragraph: '正文',
  find: '查找/替换', toggleTask: '切换任务项', gotoLine: '跳转到行',
  // status
  saved: '已保存', unsaved: '未保存', draftSaved: '草稿已存', untitledState: '未命名',
  rendering: '渲染中', line: '行', col: '列', words: '字数', chars: '字符', readingAbout: '约', minutes: '分钟',
  // dialogs / toasts
  discardChanges: '当前文档尚未保存，是否放弃更改？',
  draftFound: '发现未保存的草稿，是否恢复？', restore: '恢复', discard: '丢弃',
  rendererRestarted: '渲染器已重启', rendererFailed: '渲染器多次崩溃，已停止自动重启',
  relativeLinkUnsupported: '暂不支持打开相对链接',
  needReauth: '需要重新授权访问该文件', fileNotFound: '文件已不存在，已从最近列表移除',
  saveFailed: '保存失败', saved_ok: '已保存', mathUnavailable: '公式渲染不可用（KaTeX 加载失败）',
  renderError: '渲染此段落时出错',
} as const;

export type TKey = keyof typeof T;
