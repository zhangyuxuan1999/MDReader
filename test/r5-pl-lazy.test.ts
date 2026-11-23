// @vitest-environment jsdom
// test/r5-pl-lazy.test.ts — proto-lazy (0.2.0 stage 2f, rule L: the editing code is loaded on demand). Checks:
//   L2 the stand-in INLINE_EDIT_OFF answers every member exactly as a real createInlineEdit API that was never turned on;
//   L2/L3 createPreview: before the chunk is loaded setPreviewEditable(true) returns a promise and nothing is editable or
//         installed until it settles; a later off withdraws it (one instance at most, none installed then); once loaded,
//         a new preview turns on synchronously;
//   L3/L4 the switch controller (createPreviewEdit): the button / stored value / 'previewEdit:changed' follow what is TRUE,
//         the last toggle wins, a failure reports 'failed', deferStart is withdrawn by a set().
//   fix-lazy (the lead's final rule L): RL-1 a failed toggle stores '0', a failed startup load stores nothing; RL-2
//         onLoading (busy, byUser) for a load on its way for a wish of on; the texts of L4 and RL-2.
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/r5-pl-lazy.test.ts
// The tests run in file order on purpose: the first createPreview cases need the chunk NOT loaded yet.
import { describe, expect, it, vi } from 'vitest';
import { createPreview } from '../src/preview/createPreview';
import { INLINE_EDIT_OFF, inlineEditLoaded, loadInlineEdit } from '../src/preview/inlineEditLoader';
import { createBus } from '../src/shared/bus';
import { createPreviewEdit, PREVIEW_EDIT_T, type PreviewEditOutcome } from '../src/app/previewEdit';
import type { PreviewApi, PreviewSourceAccess } from '../src/shared/types';

class FakeResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
vi.stubGlobal('ResizeObserver', FakeResizeObserver);

function source(): PreviewSourceAccess {
  const lines = ['para one', '', 'para two'];
  return { read: (s, c) => lines.slice(s - 1, s - 1 + c).join('\n'), replace: () => {}, history: () => null };
}
function preview(): PreviewApi {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return createPreview({ parent, bus: createBus(), request: () => {}, viewport: () => {}, resync: () => {}, source: source() });
}
const hints = (): number => document.querySelectorAll('.mdr-preview__edit-hint').length;

describe('createPreview before and after the chunk (rule L2, L3)', () => {
  it('not loaded: on returns a promise, nothing is editable or installed until it settles', async () => {
    expect(inlineEditLoaded()).toBeNull();
    const pv = preview();
    expect(hints()).toBe(0);
    const r = pv.setPreviewEditable(true);
    expect(r).toBeInstanceOf(Promise);
    expect(pv.isPreviewEditable()).toBe(false);
    expect(hints()).toBe(0);
    await expect(r).resolves.toBe(true);
    expect(pv.isPreviewEditable()).toBe(true);
    expect(hints()).toBe(1);
    expect(pv.setPreviewEditable(false)).toBeUndefined();          // off: at once, the module stays
    expect(pv.isPreviewEditable()).toBe(false);
    expect(pv.setPreviewEditable(true)).toBeUndefined();           // on again: at once
    expect(pv.isPreviewEditable()).toBe(true);
    expect(hints()).toBe(1);                                       // one instance
    pv.dispose();
    expect(hints()).toBe(0);
  });
  it('loaded: a new preview turns on synchronously; on, off before settling would withdraw (here: sync)', async () => {
    await loadInlineEdit();
    const pv = preview();
    expect(hints()).toBe(0);                                       // nothing installed while off
    expect(pv.setPreviewEditable(true)).toBeUndefined();
    expect(pv.isPreviewEditable()).toBe(true);
    pv.dispose();
  });
});

describe('the stand-in answers what the real module answers with the switch off and no session (rule L2)', () => {
  it('member by member', async () => {
    const m = await loadInlineEdit();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const real = m.createInlineEdit({
      root, bus: createBus(), source: source(),
      blockOfElement: () => null, elementOfBlock: () => null, blockInfo: () => null, blockAtLine: () => null,
      isFresh: () => false, hold: () => {}, release: () => {},
    });
    const el = document.createElement('p');
    root.appendChild(el);
    for (const api of [real, INLINE_EDIT_OFF]) {
      api.setEditable(false);
      api.afterStructure();
      api.afterMount(1);
      api.end();
      api.flush();
    }
    expect(INLINE_EDIT_OFF.isEditable()).toBe(real.isEditable());
    expect(INLINE_EDIT_OFF.activeId()).toBe(real.activeId());
    expect(INLINE_EDIT_OFF.keepsRemoved(1)).toBe(real.keepsRemoved(1));
    expect(INLINE_EDIT_OFF.keepsRemoved(1, 7)).toBe(real.keepsRemoved(1, 7));
    expect(INLINE_EDIT_OFF.isEditingTarget(el)).toBe(real.isEditingTarget(el));
    expect(INLINE_EDIT_OFF.isEditingTarget(null)).toBe(real.isEditingTarget(null));
    expect(INLINE_EDIT_OFF.isResuming()).toBe(real.isResuming());
    real.dispose();
    INLINE_EDIT_OFF.dispose();
  });
});

describe('the switch controller follows what is true (rule L3, L4)', () => {
  function fake() {
    const pending: Array<{ on: boolean; resolve(v: boolean): void; reject(e: unknown): void }> = [];
    let editable = false;
    const pv = {
      setPreviewEditable: (on: boolean): void | Promise<boolean> => {
        if (!on) { editable = false; return; }
        return new Promise<boolean>((resolve, reject) => pending.push({ on, resolve: (v) => { editable = v; resolve(v); }, reject }));
      },
      endEditSession: () => {},
      flushEditSession: () => {},
      editable: () => editable,
    };
    const store = new Map<string, string>();
    const toggles: boolean[] = [];
    const failures: unknown[] = [];
    const bus = createBus();
    const changed: boolean[] = [];
    bus.on('previewEdit:changed', (v) => { changed.push(v); });
    return { pv, pending, store, toggles, failures, bus, changed };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('startup with the stored wish on: off at once, on when installed, nothing written', async () => {
    const f = fake();
    f.store.set('mdr.previewEdit', '1');
    const ctl = createPreviewEdit({ bus: f.bus, preview: f.pv, read: (k) => f.store.get(k) ?? null, write: (k, v) => f.store.set(k, v), onToggle: (on) => f.toggles.push(on) });
    expect(ctl.isOn()).toBe(false);
    expect(f.toggles).toEqual([false]);
    f.pending[0].resolve(true);
    await flush();
    expect(ctl.isOn()).toBe(true);
    expect(f.toggles).toEqual([false, true]);
    expect(f.changed).toEqual([false, true]);
    expect(f.store.get('mdr.previewEdit')).toBe('1');
  });

  it('on, off, on while the chunk is on its way: the last toggle wins, reported once', async () => {
    const f = fake();
    const ctl = createPreviewEdit({ bus: f.bus, preview: f.pv, read: (k) => f.store.get(k) ?? null, write: (k, v) => f.store.set(k, v), onToggle: (on) => f.toggles.push(on) });
    const out: PreviewEditOutcome[] = [];
    ctl.toggle((r) => out.push(r));               // on (pending)
    expect(ctl.isOn()).toBe(false);
    expect(f.store.has('mdr.previewEdit')).toBe(false);
    ctl.toggle((r) => out.push(r));               // off: at once
    expect(out).toEqual(['off']);
    expect(f.store.get('mdr.previewEdit')).toBe('0');
    ctl.toggle((r) => out.push(r));               // on (pending)
    f.pending[0].resolve(true);                   // the first one settles: withdrawn, ignored
    await flush();
    expect(out).toEqual(['off']);
    f.pending[1].resolve(true);
    await flush();
    expect(out).toEqual(['off', 'on']);
    expect(ctl.isOn()).toBe(true);
    expect(f.store.get('mdr.previewEdit')).toBe('1');
  });

  it('a failure of a toggle: reported, off, and off is what is stored (RL-1)', async () => {
    const f = fake();
    const ctl = createPreviewEdit({ bus: f.bus, preview: f.pv, read: (k) => f.store.get(k) ?? null, write: (k, v) => f.store.set(k, v), onUnavailable: (e) => f.failures.push(e) });
    expect(f.store.has('mdr.previewEdit')).toBe(false);
    const out: PreviewEditOutcome[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ctl.toggle((r) => out.push(r));
    f.pending[0].reject(new TypeError('Failed to fetch dynamically imported module'));
    await flush();
    warn.mockRestore();
    expect(out).toEqual(['failed']);
    expect(f.failures.length).toBe(1);
    expect(ctl.isOn()).toBe(false);
    expect(f.store.get('mdr.previewEdit')).toBe('0');
  });

  it('deferStart: the stored wish waits for run(); a set() before it withdraws it', async () => {
    const f = fake();
    f.store.set('mdr.previewEdit', '1');
    let run: (() => void) | null = null;
    const ctl = createPreviewEdit({ bus: f.bus, preview: f.pv, read: (k) => f.store.get(k) ?? null, write: (k, v) => f.store.set(k, v), deferStart: (r) => { run = r; } });
    expect(f.pending.length).toBe(0);
    expect(ctl.isOn()).toBe(false);
    ctl.set(false);
    run!();
    expect(f.pending.length).toBe(0);
    expect(ctl.isOn()).toBe(false);
    expect(f.store.get('mdr.previewEdit')).toBe('0');
  });

  // ---- fix-lazy (stage 2f, the lead's final rule L: RL-1, RL-2, the failure text)
  const opts = (f: ReturnType<typeof fake>, extra: Partial<Parameters<typeof createPreviewEdit>[0]> = {}) => ({
    bus: f.bus, preview: f.pv, read: (k: string) => f.store.get(k) ?? null, write: (k: string, v: string) => { f.store.set(k, v); },
    onToggle: (on: boolean) => { f.toggles.push(on); }, onUnavailable: (e: unknown) => { f.failures.push(e); }, ...extra,
  });
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  it('RL-1: a failure of the startup load keeps a stored 1; a failed press then stores 0, so the next start is quiet', async () => {
    const f = fake();
    f.store.set('mdr.previewEdit', '1');
    let run: (() => void) | null = null;
    const warn = quiet();
    const ctl = createPreviewEdit(opts(f, { deferStart: (r) => { run = r; } }));
    run!();
    f.pending[0].reject(new TypeError('Failed to fetch dynamically imported module'));
    await flush();
    expect(f.failures.length).toBe(1);
    expect(f.store.get('mdr.previewEdit')).toBe('1');            // a passing failure at start: the wish survives
    expect(ctl.isOn()).toBe(false);
    const out: PreviewEditOutcome[] = [];
    ctl.toggle((r) => out.push(r));                               // the button shows off: the press turns it on
    f.pending[1].reject(new TypeError('Failed to fetch dynamically imported module'));
    await flush();
    warn.mockRestore();
    expect(out).toEqual(['failed']);
    expect(f.failures.length).toBe(2);
    expect(f.store.get('mdr.previewEdit')).toBe('0');            // RL-1: off is the truth, and it is stored
    expect(ctl.isOn()).toBe(false);
    expect(f.toggles.every((t) => t === false)).toBe(true);       // the button never showed on
    // the next start reads '0': no load is asked for, nothing can fail
    const g = fake();
    g.store.set('mdr.previewEdit', f.store.get('mdr.previewEdit')!);
    createPreviewEdit(opts(g, { deferStart: (r) => { r(); } }));
    expect(g.pending.length).toBe(0);
    expect(g.failures.length).toBe(0);
  });

  it('RL-1: a failure of the startup load without deferStart (test hooks) writes nothing either', async () => {
    const f = fake();
    f.store.set('mdr.previewEdit', '1');
    const warn = quiet();
    createPreviewEdit(opts(f));
    f.pending[0].reject(new Error('boom'));
    await flush();
    warn.mockRestore();
    expect(f.failures.length).toBe(1);
    expect(f.store.get('mdr.previewEdit')).toBe('1');
  });

  it('RL-2: onLoading says when a load for a wish of on is on its way, and who asked', async () => {
    const f = fake();
    const seen: string[] = [];
    const onLoading = (busy: boolean, byUser: boolean) => { seen.push(`${busy}:${byUser}`); };
    const ctl = createPreviewEdit(opts(f, { onLoading }));
    expect(seen).toEqual([]);                                     // off at start: no load
    ctl.toggle();                                                 // on: the chunk is on its way
    expect(seen).toEqual(['true:true']);
    ctl.toggle();                                                 // withdrawn: busy ends at once
    expect(seen).toEqual(['true:true', 'false:true']);
    ctl.toggle();                                                 // on again: busy again
    expect(seen).toEqual(['true:true', 'false:true', 'true:true']);
    f.pending[0].resolve(true);                                   // the withdrawn one settles: nothing
    await flush();
    expect(seen.length).toBe(3);
    f.pending[1].resolve(true);                                   // the last one: installed, busy ends
    await flush();
    expect(seen).toEqual(['true:true', 'false:true', 'true:true', 'false:true']);
    expect(ctl.isOn()).toBe(true);
    // the module installed (or its chunk here): setPreviewEditable answers synchronously, nothing is ever busy
    const g = fake();
    const seen2: string[] = [];
    const sync = { ...g.pv, setPreviewEditable: (): void => {} };
    const ctl2 = createPreviewEdit(opts(g, { preview: sync, onLoading: (b, u) => { seen2.push(`${b}:${u}`); } }));
    ctl2.toggle();
    ctl2.toggle();
    ctl2.toggle();
    expect(ctl2.isOn()).toBe(true);
    expect(seen2).toEqual([]);
  });

  it('RL-2: the startup load is busy but not the user\'s; a press during it joins it as the user\'s; a failure and off() end it', async () => {
    const f = fake();
    f.store.set('mdr.previewEdit', '1');
    const seen: string[] = [];
    let run: (() => void) | null = null;
    const ctl = createPreviewEdit(opts(f, { deferStart: (r) => { run = r; }, onLoading: (b, u) => { seen.push(`${b}:${u}`); } }));
    expect(seen).toEqual([]);                                     // waiting for the first idle: nothing loads yet
    run!();
    expect(seen).toEqual(['true:false']);
    ctl.toggle();                                                 // shows off: the press turns it on and joins
    expect(seen).toEqual(['true:false', 'true:true']);
    const warn = quiet();
    f.pending[1].reject(new Error('boom'));
    f.pending[0].reject(new Error('boom'));
    await flush();
    warn.mockRestore();
    expect(seen).toEqual(['true:false', 'true:true', 'false:true']);
    expect(f.failures.length).toBe(1);                            // one report: the startup's was withdrawn by the press
    expect(f.store.get('mdr.previewEdit')).toBe('0');
    // off() while a load is on its way ends the busy state
    const g = fake();
    const seen2: string[] = [];
    const ctl2 = createPreviewEdit(opts(g, { onLoading: (b, u) => { seen2.push(`${b}:${u}`); } }));
    ctl2.toggle();
    ctl2.off();
    expect(seen2).toEqual(['true:true', 'false:false']);
    g.pending[0].resolve(true);
    await flush();
    expect(seen2.length).toBe(2);
    expect(ctl2.isOn()).toBe(false);
    void ctl;
  });

  it('the texts of rule L: the failure asks for a reload or a restart (not the network); the loading text', () => {
    expect(PREVIEW_EDIT_T.loadFailed).toBe('预览编辑功能加载失败，请刷新页面或重启应用后重试');
    expect(PREVIEW_EDIT_T.loading).toBe('正在加载预览编辑功能…');
  });
});
