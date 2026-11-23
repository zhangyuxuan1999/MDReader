// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLayout, disposeLayout, installSplitResize } from '../src/app/layout';
import { createToasts } from '../src/app/toast';
import { confirmDialog } from '../src/app/dialogs';
import { LS_SPLIT } from '../src/shared/types';

describe('createLayout', () => {
  beforeEach(() => localStorage.clear());

  it('builds the CONTRACT §2 skeleton', () => {
    const root = document.createElement('div');
    const layout = createLayout(root);
    expect(root.className).toBe('mdr-app');
    expect(root.dataset.mode).toBe('split');
    expect(root.dataset.toc).toBe('open');
    expect(Array.from(root.children).map((c) => c.tagName + '.' + c.className)).toEqual([
      'HEADER.mdr-toolbar', 'DIV.mdr-main', 'FOOTER.mdr-statusbar', 'DIV.mdr-overlay',
    ]);
    const main = root.querySelector('.mdr-main')!;
    expect(Array.from(main.children).map((c) => c.className)).toEqual([
      'mdr-pane mdr-pane--toc', 'mdr-pane mdr-pane--editor', 'mdr-gutter', 'mdr-pane mdr-pane--preview',
    ]);
    expect(layout.els.toc).toBe(main.children[0]);
    expect(layout.els.gutter).toBe(main.children[2]);
    expect(layout.els.overlay).toBe(root.children[3]);
  });

  it('toggles mode and toc attributes', () => {
    const layout = createLayout(document.createElement('div'));
    layout.setMode('preview');
    expect(layout.getMode()).toBe('preview');
    layout.setTocVisible(false);
    expect(layout.isTocVisible()).toBe(false);
    expect(layout.els.toc.parentElement!.parentElement!.dataset.toc).toBe('closed');
  });

  // finding r3: "AppHandle.dispose() does not undo createLayout … a second createApp duplicates the
  // whole UI". LayoutApi is frozen, so the teardown lives in the module-level side table.
  it('disposeLayout leaves the root exactly as it was found, so a second createLayout yields one shell', () => {
    const root = document.createElement('div');
    root.className = 'host';
    document.body.appendChild(root);
    const layout = createLayout(root);
    layout.setMode('preview');
    layout.setTocVisible(false);
    expect(root.children).toHaveLength(4);

    disposeLayout(layout);
    expect(root.children).toHaveLength(0);
    expect(root.className).toBe('host');
    expect(root.dataset.mode).toBeUndefined();
    expect(root.dataset.toc).toBeUndefined();

    createLayout(root);
    expect(root.querySelectorAll('.mdr-toolbar')).toHaveLength(1);
    expect(root.querySelectorAll('.mdr-main')).toHaveLength(1);
    expect(root.querySelectorAll('.mdr-statusbar')).toHaveLength(1);
    expect(root.querySelectorAll('.mdr-overlay')).toHaveLength(1);
    root.remove();
  });

  it('the split-resize disposer cancels a pending frame instead of writing --split after teardown', () => {
    const root = document.createElement('div');
    const layout = createLayout(root);
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => frames.push(fn));
    const cancelled: number[] = [];
    vi.stubGlobal('cancelAnimationFrame', (id: number) => cancelled.push(id));
    const off = installSplitResize(root, layout.els, () => {});
    const { gutter } = layout.els;
    gutter.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
    gutter.dispatchEvent(new MouseEvent('pointermove', { clientX: 500, bubbles: true }));
    expect(frames).toHaveLength(1);
    off();
    expect(cancelled).toEqual([1]);   // was leaked before the fix: the frame stayed scheduled
    vi.unstubAllGlobals();
  });

  it('restores a valid persisted --split only', () => {
    localStorage.setItem(LS_SPLIT, '1.5fr');
    const a = document.createElement('div');
    createLayout(a);
    expect(a.style.getPropertyValue('--split')).toBe('1.5fr');
    localStorage.setItem(LS_SPLIT, 'url(evil)');
    const b = document.createElement('div');
    createLayout(b);
    expect(b.style.getPropertyValue('--split')).toBe('');
  });
});

// jsdom does no layout, so these guard the two CSS invariants the shell depends on: the recent-files
// dropdown must not be clipped by its chip, and the app grid must not be widened by the toolbar.
describe('layout.css invariants', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/layout.css'), 'utf8');
  const rule = (selector: string): string => {
    const i = css.indexOf(`\n${selector} {`);
    expect(i, `rule ${selector} not found`).toBeGreaterThan(-1);
    return css.slice(i, css.indexOf('}', i));
  };

  it('.mdr-toolbar__file does not clip its dropdown; the name keeps the ellipsis', () => {
    expect(rule('.mdr-toolbar__file')).not.toMatch(/overflow\s*:\s*hidden/);
    expect(rule('.mdr-toolbar__file')).toMatch(/min-width\s*:\s*0/);
    expect(rule('.mdr-toolbar__name')).toMatch(/overflow\s*:\s*hidden/);
    expect(rule('.mdr-toolbar__name')).toMatch(/text-overflow\s*:\s*ellipsis/);
  });

  it('below 900 px an open TOC is an overlay panel, not a dead 0-px column', () => {
    const mq = css.slice(css.indexOf('@media (max-width: 900px)'));
    expect(mq).toMatch(/\.mdr-app\[data-toc="open"\] \.mdr-pane--toc/);
    expect(mq).toMatch(/position\s*:\s*absolute/);
    expect(mq).toMatch(/width\s*:\s*min\(var\(--toc-w\)/);
    expect(mq).toMatch(/box-shadow\s*:\s*var\(--mdr-shadow\)/);
    // …and it must never be display:none'd back into invisibility at that width.
    expect(mq).not.toMatch(/\.mdr-app \.mdr-pane--toc\s*\{[^}]*display\s*:\s*none/);
    // The overlay needs a containing block.
    expect(rule('.mdr-main')).toMatch(/position\s*:\s*relative/);
  });

  it('.mdr-app has one explicit shrinkable column and the toolbar wraps instead of overflowing', () => {
    expect(rule('.mdr-app')).toMatch(/grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/);
    expect(rule('.mdr-toolbar')).toMatch(/flex-wrap\s*:\s*wrap/);
    expect(rule('.mdr-toolbar')).toMatch(/min-width\s*:\s*0/);
    expect(rule('.mdr-statusbar')).toMatch(/min-width\s*:\s*0/);
  });
});

describe('toasts and dialogs', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('auto-dismisses plain toasts and keeps action toasts until a button is pressed', () => {
    vi.useFakeTimers();
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const toasts = createToasts(overlay);
    toasts.show({ text: '已保存' });
    const run = vi.fn();
    toasts.show({ text: '发现草稿', actions: [{ label: '恢复', run }] });
    expect(overlay.querySelectorAll('.mdr-toast')).toHaveLength(2);
    vi.advanceTimersByTime(4000);
    expect(overlay.querySelectorAll('.mdr-toast')).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(overlay.querySelectorAll('.mdr-toast')).toHaveLength(1);
    overlay.querySelector<HTMLButtonElement>('.mdr-toast__btn')!.click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(overlay.querySelectorAll('.mdr-toast')).toHaveLength(0);
  });

  it('coalesces identical plain toasts (timer restarted, counter shown) but never action toasts', () => {
    vi.useFakeTimers();
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const toasts = createToasts(overlay);
    for (let i = 0; i < 5; i++) {
      toasts.show({ text: '暂不支持打开相对链接' });
      vi.advanceTimersByTime(60);
    }
    expect(overlay.querySelectorAll('.mdr-toast')).toHaveLength(1);
    expect(overlay.querySelector('.mdr-toast__text')!.textContent).toBe('暂不支持打开相对链接 ×5');
    // A different kind or text is a different toast.
    toasts.show({ text: '暂不支持打开相对链接', kind: 'error' });
    toasts.show({ text: '其他消息' });
    expect(overlay.querySelectorAll('.mdr-toast')).toHaveLength(3);
    // The timer restarted with the last repeat, so the coalesced toast lives ~4 s from then.
    vi.advanceTimersByTime(3900);
    expect(overlay.querySelectorAll('.mdr-toast')).toHaveLength(3);
    vi.advanceTimersByTime(500);
    expect(overlay.querySelectorAll('.mdr-toast')).toHaveLength(1); // only the 8 s error toast left
    // Once gone, the same text shows a fresh toast again (count restarts).
    toasts.show({ text: '暂不支持打开相对链接' });
    expect(overlay.querySelector('.mdr-toast__text')!.textContent).toBe('暂不支持打开相对链接');

    const run = vi.fn();
    toasts.show({ text: '发现未保存的草稿', actions: [{ label: '恢复', run }] });
    toasts.show({ text: '发现未保存的草稿', actions: [{ label: '恢复', run }] });
    expect(overlay.querySelectorAll('.mdr-toast__btn')).toHaveLength(2);
  });

  it('danger dialogs focus 取消 and Enter then cancels; plain dialogs focus ok and Enter confirms', async () => {
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const p1 = confirmDialog(overlay, { text: '放弃更改？', ok: '丢弃', danger: true });
    const dialog = overlay.querySelector<HTMLElement>('.mdr-dialog')!;
    expect((document.activeElement as HTMLElement).textContent).toBe('取消');
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await expect(p1).resolves.toBe(false);

    const p2 = confirmDialog(overlay, { text: '放弃更改？', ok: '丢弃', danger: true });
    overlay.querySelector<HTMLButtonElement>('.mdr-dialog__btn--danger')!.focus();
    overlay.querySelector<HTMLElement>('.mdr-dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await expect(p2).resolves.toBe(true);

    const p3 = confirmDialog(overlay, { text: 'x', ok: 'ok' });
    expect((document.activeElement as HTMLElement).textContent).toBe('ok');
    overlay.querySelector<HTMLElement>('.mdr-dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await expect(p3).resolves.toBe(true);
  });

  it('confirmDialog resolves true on ok and false on Escape', async () => {
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const p1 = confirmDialog(overlay, { text: '放弃更改？', ok: '丢弃', danger: true });
    const dialog = overlay.querySelector<HTMLElement>('.mdr-dialog')!;
    expect(dialog.textContent).toContain('放弃更改？');
    dialog.querySelector<HTMLButtonElement>('.mdr-dialog__btn--danger')!.click();
    await expect(p1).resolves.toBe(true);
    expect(overlay.querySelector('.mdr-dialog')).toBeNull();

    const p2 = confirmDialog(overlay, { text: 'x', ok: 'ok' });
    overlay.querySelector<HTMLElement>('.mdr-dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(p2).resolves.toBe(false);
  });
});
