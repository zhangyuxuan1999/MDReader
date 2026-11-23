// test/fix2-e-shell.test.ts — fix-shell (0.2.0 stage 2b): the pure pieces of the shell fixes.
//  - S3 (G37): in the dev shell only a reload of the dev page itself may pass will-navigate;
//    the packaged shell (no dev URL) lets no page-initiated navigation through.
//  - warnReplaced: the save promise (U+FFFD written back) is made only for a file read as UTF-8.
import { describe, expect, it } from 'vitest';
import { isDevReload, isOnOrigin, replacedBytesWarning } from '../electron/paths.mjs';

describe('S3: isDevReload / isOnOrigin', () => {
  const dev = 'http://localhost:5305';
  it('packaged shell (no dev URL): nothing is a dev reload, nothing is on the dev origin', () => {
    expect(isDevReload('', 'app://mdreader/index.html', 'app://mdreader/index.html')).toBe(false);
    expect(isDevReload('', 'app://mdreader/index.html', 'app://mdreader/nonexistent.md')).toBe(false);
    expect(isOnOrigin('', 'http://localhost:5305/')).toBe(false);
  });
  it('dev shell: location.reload() of the page shown passes (fragment ignored)', () => {
    expect(isDevReload(dev, 'http://localhost:5305/', 'http://localhost:5305/')).toBe(true);
    expect(isDevReload(dev, 'http://localhost:5305/?perf=1', 'http://localhost:5305/?perf=1')).toBe(true);
    expect(isDevReload(dev, 'http://localhost:5305/#a', 'http://localhost:5305/')).toBe(true);
  });
  it('dev shell: any other URL of the dev origin, another origin or app:// is cancelled', () => {
    expect(isDevReload(dev, 'http://localhost:5305/', 'http://localhost:5305/nonexistent.md')).toBe(false);
    expect(isDevReload(dev, 'http://localhost:5305/', 'http://localhost:5305/?x=1')).toBe(false);
    expect(isDevReload(dev, 'http://localhost:5305/', 'http://localhost:5306/')).toBe(false);
    expect(isDevReload(dev, 'http://localhost:5305/', 'https://localhost:5305/')).toBe(false);
    expect(isDevReload(dev, 'http://localhost:5305/', 'app://mdreader/index.html')).toBe(false);
    expect(isDevReload(dev, 'http://localhost:5305/', 'about:blank')).toBe(false);
    expect(isDevReload(dev, 'http://localhost:5305/', 'not a url')).toBe(false);
    expect(isDevReload(dev, '', 'http://localhost:5305/')).toBe(false);
  });
  it('isOnOrigin compares origins, not prefixes', () => {
    expect(isOnOrigin(dev, 'http://localhost:5305/a/b?c')).toBe(true);
    expect(isOnOrigin(dev, 'http://localhost:53050/')).toBe(false);
    expect(isOnOrigin(dev, 'http://localhost:5305.evil.test/')).toBe(false);
  });
});

describe('warnReplaced wording (replacedBytesWarning)', () => {
  it('nothing replaced: no dialog', () => {
    expect(replacedBytesWarning(null)).toBeNull();
    expect(replacedBytesWarning({ name: 'a.md', encoding: 'utf-8' })).toBeNull();
    expect(replacedBytesWarning({ name: 'a.md', encoding: 'utf-8', replacedBytes: 0 })).toBeNull();
  });
  it('UTF-8: the 0.1.1 wording, including what saving does', () => {
    const w = replacedBytesWarning({ name: 'a.md', encoding: 'utf-8', replacedBytes: 3 });
    expect(w).toEqual({
      message: '「a.md」不是完全有效的 UTF-8 文本',
      detail: '其中 3 处无效字节已显示为 �。保存时这些位置会写成 �（U+FFFD），原来的字节不会保留。',
    });
  });
  it('any other encoding: names it, says nothing about UTF-8 or about saving', () => {
    for (const encoding of ['gbk', 'gb18030', 'big5', 'shift_jis', 'euc-kr', 'utf-16le', '', undefined]) {
      const w = replacedBytesWarning({ name: 'b.md', encoding, replacedBytes: 2 });
      expect(w).not.toBeNull();
      const all = `${w!.message} ${w!.detail}`;
      expect(all).not.toContain('UTF-8');
      expect(all).not.toContain('保存');
      expect(all).toContain('2 处');
      expect(w!.message).toContain('「b.md」');
      if (encoding) expect(w!.detail).toContain(encoding.toUpperCase());
    }
  });
});
