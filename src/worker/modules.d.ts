// src/worker/modules.d.ts — type shim for markdown-it-task-lists (ships no declarations).
declare module 'markdown-it-task-lists' {
  import type { MarkdownIt } from 'markdown-it';
  interface TaskListsOptions { enabled?: boolean; label?: boolean; labelAfter?: boolean }
  const plugin: (md: MarkdownIt, options?: TaskListsOptions) => void;
  export default plugin;
}
