// argv → document paths, IPC path validation and fs-error mapping.
import { describe, expect, it } from 'vitest';
import { isValidAbsolutePath, nativeErrorFor, pathsFromArgv, MARKDOWN_EXT_RE } from '../electron/paths.mjs';

describe('pathsFromArgv', () => {
  it('keeps Markdown paths and drops the executable, switches and the app path', () => {
    const argv = ['/Applications/MDReader.app/Contents/MacOS/MDReader', '--inspect', '.', '/docs/a.md', 'b.markdown'];
    expect(pathsFromArgv(argv, '/work')).toEqual(['/docs/a.md', '/work/b.markdown']);
  });

  it('ignores the macOS Finder process-serial switch and non-Markdown files', () => {
    const argv = ['exe', '-psn_0_123456', '/docs/photo.png', '/docs/archive.zip', '/docs/notes.mkdn'];
    expect(pathsFromArgv(argv, '/work')).toEqual(['/docs/notes.mkdn']);
  });

  it('deduplicates and tolerates junk argv', () => {
    expect(pathsFromArgv(['exe', '/a.md', '/a.md'], '/w')).toEqual(['/a.md']);
    expect(pathsFromArgv([], '/w')).toEqual([]);
    expect(pathsFromArgv(null as unknown as string[], '/w')).toEqual([]);
    expect(pathsFromArgv(['exe', '/a\0.md'], '/w')).toEqual([]);
  });

  it('S1/ext-none: an existing regular file without a Markdown extension is taken; dirs, missing paths, switches and exclusions are not', () => {
    const files = new Set(['/docs/README', '/work/LICENSE', '/Applications/MDReader.app/Contents/MacOS/MDReader', '/app/electron/main.mjs']);
    const opts = {
      isFile: (p: string) => files.has(p),
      exclude: ['/Applications/MDReader.app/Contents/MacOS/MDReader', '/app', '/app/electron/main.mjs'],
    };
    const argv = [
      '/Applications/MDReader.app/Contents/MacOS/MDReader',
      '--remote-debugging-port=0', '-psn_0_1',
      '/app', // the app directory (`electron /app`): a directory, and excluded
      '/app/electron/main.mjs', // `electron electron/main.mjs`: a file, but excluded
      '/Applications/MDReader.app/Contents/MacOS/MDReader', // the executable again: excluded
      '/docs/README', 'LICENSE', '/docs/missing', '/docs/folder', '/docs/a.md',
    ];
    expect(pathsFromArgv(argv, '/work', opts)).toEqual(['/docs/README', '/work/LICENSE', '/docs/a.md']);
    // the real fs check: this test file exists, its directory is not a regular file
    expect(pathsFromArgv(['exe', __filename, __dirname], '/w')).toEqual([__filename]);
  });

  it('accepts every declared extension', () => {
    for (const ext of ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'txt']) {
      expect(MARKDOWN_EXT_RE.test(`/x/doc.${ext}`)).toBe(true);
    }
    expect(MARKDOWN_EXT_RE.test('/x/doc.pdf')).toBe(false);
  });
});

describe('isValidAbsolutePath', () => {
  it('accepts absolute paths only', () => {
    expect(isValidAbsolutePath('/tmp/a.md')).toBe(true);
    expect(isValidAbsolutePath('a.md')).toBe(false);
    expect(isValidAbsolutePath('')).toBe(false);
    expect(isValidAbsolutePath('/tmp/a\0.md')).toBe(false);
    expect(isValidAbsolutePath(null as unknown as string)).toBe(false);
    expect(isValidAbsolutePath(7 as unknown as string)).toBe(false);
  });
});

describe('nativeErrorFor', () => {
  it('maps fs codes to the NativeFileError codes of src/shared/native.ts', () => {
    expect(nativeErrorFor({ code: 'ENOENT' }).code).toBe('ENOENT');
    expect(nativeErrorFor({ code: 'ENOTDIR' }).code).toBe('ENOENT');
    expect(nativeErrorFor({ code: 'EACCES' }).code).toBe('EACCES');
    expect(nativeErrorFor({ code: 'EPERM' }).code).toBe('EACCES');
    expect(nativeErrorFor({ code: 'EPERM' }).message).toContain('隐私与安全性');
    expect(nativeErrorFor({ code: 'EACCES' }).message).not.toContain('隐私与安全性');
    expect(nativeErrorFor({ code: 'EISDIR' }).code).toBe('EISDIR');
    expect(nativeErrorFor({ code: 'ENOSPC' }).code).toBe('EIO');
    expect(nativeErrorFor({ code: 'EWHAT', message: 'boom' })).toEqual({ code: 'UNKNOWN', message: 'boom' });
    expect(nativeErrorFor(undefined).code).toBe('UNKNOWN');
  });

  it('always carries a non-empty message', () => {
    for (const code of ['ENOENT', 'EACCES', 'EISDIR', 'EIO', 'NOPE']) {
      expect(nativeErrorFor({ code }).message.length).toBeGreaterThan(0);
    }
  });
});
