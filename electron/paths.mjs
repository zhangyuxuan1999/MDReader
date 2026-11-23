// electron/paths.mjs — pure path helpers shared by the main process and the node-side unit tests.
// No 'electron' import here on purpose: test/electron.paths.test.ts imports this file directly.
import fs from 'node:fs';
import path from 'node:path';

/** Extensions the app declares in electron-builder.yml `fileAssociations` (plus .txt, which the picker offers). */
export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'txt'];
export const MARKDOWN_EXT_RE = /\.(md|markdown|mdown|mkd|mkdn|txt)$/i;

/** Absolute, NUL-free, non-empty string. Every IPC path argument goes through this before touching fs. */
export function isValidAbsolutePath(p) {
  return typeof p === 'string' && p.length > 0 && !p.includes('\0') && path.isAbsolute(p);
}

/** True when `p` exists and is a regular file (symlinks followed); never throws. */
function isRegularFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Document paths carried in a process argv (Windows/Linux launch, and macOS `open` of a second instance).
 * Skips argv[0] (the executable), every `-`/`--` switch, the Electron app path used by `electron .`.
 * A Markdown/text extension is taken as is; any other entry (README, LICENSE, notes.log …) is taken
 * only when it is an existing regular file — never a directory (the app directory), a FIFO, a missing
 * path — and not one of `opts.exclude` (the executable, the app path, the main script).
 * Relative paths resolve against `cwd`. `opts.isFile` replaces the fs check (unit tests).
 */
export function pathsFromArgv(argv, cwd = process.cwd(), opts = {}) {
  const isFile = typeof opts.isFile === 'function' ? opts.isFile : isRegularFile;
  const exclude = new Set(
    (Array.isArray(opts.exclude) ? opts.exclude : []).filter((x) => typeof x === 'string' && x).map((x) => path.resolve(x)),
  );
  const out = [];
  const list = Array.isArray(argv) ? argv.slice(1) : [];
  for (const raw of list) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    if (raw.startsWith('-')) continue;           // --inspect, -psn_0_123 (macOS Finder), …
    if (raw === '.' || raw === './') continue;   // `electron .`
    if (raw.includes('\0')) continue;
    const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    if (!MARKDOWN_EXT_RE.test(raw)) {
      if (exclude.has(path.resolve(abs)) || !isFile(abs)) continue;
    }
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

/** Map a node fs error to the NativeFileError codes of src/shared/native.ts. */
export function nativeErrorFor(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return { code: 'ENOENT', message: '文件不存在或已被移动' };
    case 'EACCES':
      return { code: 'EACCES', message: '没有访问该文件的权限' };
    case 'EPERM':
      // macOS privacy protection (TCC) answers EPERM; the renderer looks for the marker 隐私与安全性.
      return { code: 'EACCES', message: '没有访问该文件的权限（可能被系统的隐私与安全性设置拒绝）' };
    case 'EISDIR':
      return { code: 'EISDIR', message: '这是一个文件夹，不是文件' };
    case 'EIO':
    case 'EBUSY':
    case 'ENOSPC':
    case 'EROFS':
      return { code: 'EIO', message: err && err.message ? String(err.message) : '读写失败' };
    default:
      return { code: 'UNKNOWN', message: err && err.message ? String(err.message) : '未知错误' };
  }
}

/**
 * The non-blocking warning shown after a file was read with invalid bytes replaced by U+FFFD
 * (`info.replacedBytes`, fileIO's lenient decode), or null when there is nothing to say.
 * The save promise (U+FFFD written back, original bytes lost) is only true for UTF-8, where saving
 * writes the text as it is shown; for any other encoding the wording states only what was read.
 */
export function replacedBytesWarning(info) {
  if (!info || !info.replacedBytes) return null;
  const name = typeof info.name === 'string' && info.name ? info.name : '未命名.md';
  const n = info.replacedBytes;
  const enc = typeof info.encoding === 'string' ? info.encoding.toLowerCase() : '';
  if (enc === 'utf-8') {
    return {
      message: `「${name}」不是完全有效的 UTF-8 文本`,
      detail: `其中 ${n} 处无效字节已显示为 �。保存时这些位置会写成 �（U+FFFD），原来的字节不会保留。`,
    };
  }
  const label = enc ? `按 ${enc.toUpperCase()} 编码读取时，` : '读取时，';
  return {
    message: `「${name}」中有无法识别的字节`,
    detail: `${label}其中 ${n} 处无法识别的字节已显示为 �。`,
  };
}

/** `url` has the origin of `base` (both parsed as URLs; false for an empty base or a bad URL). */
export function isOnOrigin(base, url) {
  if (!base) return false;
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * Dev shell only (S3): the navigation the page asks for is a reload of the dev page itself (Vite's
 * full reload is location.reload()): `url` is on the dev URL's origin and, ignoring the fragment,
 * equal to the page shown (`currentUrl`). Every other page-initiated navigation is cancelled.
 */
export function isDevReload(devUrl, currentUrl, url) {
  if (!isOnOrigin(devUrl, url)) return false;
  try {
    const next = new URL(url);
    const cur = new URL(currentUrl);
    next.hash = '';
    cur.hash = '';
    return next.href === cur.href;
  } catch {
    return false;
  }
}
