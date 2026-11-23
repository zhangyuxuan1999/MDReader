// src/editor/phrases.ts — zh-CN translations for every phrase CodeMirror's bundled UI (search panel,
// go-to-line panel, announcements) passes through EditorState.phrases. Keys are CM's English originals.
export const zhCN: Record<string, string> = {
  // @codemirror/search — panel
  Find: '查找',
  Replace: '替换',
  next: '下一个',
  previous: '上一个',
  all: '全选',
  'match case': '区分大小写',
  'by word': '全词匹配',
  regexp: '正则',
  replace: '替换',
  'replace all': '全部替换',
  close: '关闭',
  // @codemirror/search — announcements
  'current match': '当前匹配',
  'on line': '所在行',
  'replaced $ matches': '已替换 $ 处匹配',
  'replaced match on line $': '已替换第 $ 行的匹配',
  // @codemirror/search — go to line
  'Go to line': '跳转到行',
  go: '跳转',
  // @codemirror/view
  'Selection deleted': '已删除选区',
  'Control character': '控制字符',
  // @codemirror/language (folding is not enabled, kept for completeness of the phrase table)
  'folded code': '已折叠代码',
  unfold: '展开',
  'Folded lines': '已折叠行',
  'Unfolded lines': '已展开行',
  'Fold line': '折叠行',
  'Unfold line': '展开行',
  to: '到',
  // @codemirror/autocomplete (only closeBrackets is used; harmless)
  Completions: '补全',
};
