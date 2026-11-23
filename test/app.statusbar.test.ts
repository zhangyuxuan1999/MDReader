// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createStatusBar, disposeStatusBar, fmt } from '../src/app/statusbar';
import type { DocStats } from '../src/shared/types';

const stats: DocStats = { chars: 1234, charsNoSpace: 1000, cjk: 300, latinWords: 45, lines: 40, readingMinutes: 2 };

describe('statusbar formatting', () => {
  it('formats the spec strings in zh-CN', () => {
    expect(fmt.pos(12, 4)).toBe('行 12, 列 5');
    expect(fmt.words(stats)).toBe('字数 345');
    expect(fmt.chars(stats)).toBe('字符 1234');
    expect(fmt.reading(stats)).toBe('约 2 分钟');
    expect(fmt.file('a.md', 'saved')).toBe('a.md · 已保存');
    expect(fmt.file('a.md', 'dirty')).toBe('a.md · 未保存');
    expect(fmt.file('a.md', 'draft')).toBe('a.md · 草稿已存');
    expect(fmt.file('未命名.md', 'untitled')).toBe('未命名.md · 未命名');
    expect(fmt.mode('split')).toBe('分栏');
    expect(fmt.progress(0.371)).toBe('渲染中 37%');
    expect(fmt.progress(7)).toBe('渲染中 100%');
  });
});

describe('createStatusBar', () => {
  it('creates the seven data-stat spans in order and updates them', () => {
    const parent = document.createElement('footer');
    const bar = createStatusBar(parent);
    const spans = Array.from(parent.querySelectorAll<HTMLElement>('.mdr-statusbar__item'));
    expect(spans.map((s) => s.dataset.stat)).toEqual(['pos', 'words', 'chars', 'reading', 'file', 'mode', 'progress']);
    const by = (id: string) => parent.querySelector<HTMLElement>(`[data-stat="${id}"]`)!;

    expect(by('pos').textContent).toBe('行 1, 列 1');
    expect(by('progress').hidden).toBe(true);

    bar.setStats(stats);
    bar.setCursor(7, 0);
    bar.setFile('notes.md', 'dirty');
    bar.setMode('preview');
    bar.setProgress(0.5);
    expect(by('words').textContent).toBe('字数 345');
    expect(by('reading').hidden).toBe(false);
    expect(by('pos').textContent).toBe('行 7, 列 1');
    expect(by('file').textContent).toBe('notes.md · 未保存');
    expect(by('file').dataset.state).toBe('dirty');
    expect(by('mode').textContent).toBe('预览');
    expect(by('progress').hidden).toBe(false);
    expect(by('progress').textContent).toBe('渲染中 50%');

    bar.setProgress(null);
    expect(by('progress').hidden).toBe(true);
    bar.setStats({ ...stats, readingMinutes: 0 });
    expect(by('reading').hidden).toBe(true);
  });

  it('disposeStatusBar removes the spans it appended (App.dispose tears the shell down)', () => {
    const parent = document.createElement('footer');
    const bar = createStatusBar(parent);
    const other = document.createElement('span');
    parent.appendChild(other);
    expect(parent.querySelectorAll('.mdr-statusbar__item')).toHaveLength(7);
    disposeStatusBar(bar);
    expect(parent.querySelectorAll('.mdr-statusbar__item')).toHaveLength(0);
    expect(parent.children).toHaveLength(1);   // nothing else is touched
    expect(parent.firstElementChild).toBe(other);
  });
});
