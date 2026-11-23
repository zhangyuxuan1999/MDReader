// electron/protocol.mjs — the privileged `app://mdreader/` scheme that serves the built renderer.
// file:// is never used: ES modules, the module Worker and IndexedDB (drafts/recents) all need a
// real, stable origin. Pure helpers (contentTypeFor / resolveAppPath) have no 'electron' import so
// test/electron.protocol.test.ts can exercise the traversal guard and the MIME table in Node.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'mdreader';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`;

/** Passed to protocol.registerSchemesAsPrivileged() BEFORE app.ready. */
export const APP_SCHEME_PRIVILEGES = {
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
};

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/**
 * Content-Security-Policy for the renderer (fix round 2). A Markdown file the user double-clicked
 * is untrusted input, and the desktop app is the system handler for it: nothing in a document may
 * reach the network, so no tracking pixel / read receipt can fire and no `<img>` can leak the
 * reader's IP, time and User-Agent.
 *   - img/media allow data: and blob: (inline images and the HTML export), never http(s).
 *   - style-src needs 'unsafe-inline': CodeMirror and highlight.js inject <style> elements, and the
 *     sanitised preview HTML keeps style attributes.
 *   - script-src stays strict — index.html has no inline script (the pre-paint theme bootstrap is
 *     public/theme-boot.js exactly so this can hold).
 */
export const CSP_PACKAGED = [
  "default-src 'self' app:",
  "img-src 'self' app: data: blob:",
  "media-src 'self' app: data: blob:",
  "font-src 'self' app: data:",
  "style-src 'self' app: 'unsafe-inline'",
  "script-src 'self' app:",
  "connect-src 'self' app:",
  "worker-src 'self' app: blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Dev mode (MDR_DEV_URL): same privacy rules, plus what the Vite dev server itself needs —
 *  inline/eval'd module shims, the HMR WebSocket, and source maps over http://localhost. */
export const CSP_DEV = [
  "default-src 'self' http://localhost:* ws://localhost:*",
  "img-src 'self' http://localhost:* data: blob:",
  "media-src 'self' http://localhost:* data: blob:",
  "font-src 'self' http://localhost:* data:",
  "style-src 'self' http://localhost:* 'unsafe-inline'",
  "script-src 'self' http://localhost:* 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'self' http://localhost:* ws://localhost:*",
  "worker-src 'self' http://localhost:* blob:",
  "frame-src 'none'",
  "object-src 'none'",
].join('; ');

export const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export function contentTypeFor(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return Object.prototype.hasOwnProperty.call(CONTENT_TYPES, ext) ? CONTENT_TYPES[ext] : DEFAULT_CONTENT_TYPE;
}

/**
 * app://mdreader/<...> → an absolute path inside `root`, or null when the request escapes it.
 * '/' serves index.html. Percent escapes are decoded first, then the path is normalised, so
 * '/../', '/%2e%2e/' and '//..%2f' all collapse before the prefix check.
 */
export function resolveAppPath(root, requestUrl) {
  let pathname;
  try {
    pathname = new URL(String(requestUrl)).pathname;
  } catch {
    return null;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent escape
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded === '' || decoded === '/') decoded = '/index.html';
  const normalized = path.posix.normalize(decoded);
  if (!normalized.startsWith('/')) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(base, `.${normalized}`);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

function plain(status, body) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** protocol.handle('app', createAppProtocolHandler(root)). `root` is dist/. */
export function createAppProtocolHandler(root) {
  return async function handleAppRequest(request) {
    const file = resolveAppPath(root, request.url);
    if (!file) return plain(400, 'Bad Request');
    try {
      const data = await fs.readFile(file);
      return new Response(data, {
        status: 200,
        headers: {
          'content-type': contentTypeFor(file),
          'cache-control': 'no-cache',
          'access-control-allow-origin': APP_ORIGIN,
          // Every app:// response carries it, not just index.html: the Worker and any future
          // document context inherit the same rules.
          'content-security-policy': CSP_PACKAGED,
        },
      });
    } catch (err) {
      if (err && err.code === 'EISDIR') {
        try {
          const data = await fs.readFile(path.join(file, 'index.html'));
          return new Response(data, {
            status: 200,
            headers: { 'content-type': CONTENT_TYPES['.html'], 'content-security-policy': CSP_PACKAGED },
          });
        } catch {
          return plain(404, 'Not Found');
        }
      }
      return plain(404, 'Not Found');
    }
  };
}
