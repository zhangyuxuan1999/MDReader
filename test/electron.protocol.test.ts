// app://mdreader/ scheme: MIME table and the path-traversal guard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_INDEX_URL, APP_SCHEME_PRIVILEGES, CSP_DEV, CSP_PACKAGED, DEFAULT_CONTENT_TYPE, contentTypeFor, createAppProtocolHandler, resolveAppPath } from '../electron/protocol.mjs';

const ROOT = '/app/dist';

describe('APP_SCHEME_PRIVILEGES', () => {
  it('declares everything the renderer needs (modules, module worker, fetch, IndexedDB)', () => {
    expect(APP_SCHEME_PRIVILEGES.scheme).toBe('app');
    expect(APP_SCHEME_PRIVILEGES.privileges).toMatchObject({
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    });
    expect(APP_INDEX_URL).toBe('app://mdreader/index.html');
  });
});

describe('contentTypeFor', () => {
  it('serves JS modules as text/javascript', () => {
    expect(contentTypeFor('/d/index.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('/d/render.worker.mjs')).toBe('text/javascript; charset=utf-8');
  });

  it('covers the asset types Vite emits', () => {
    expect(contentTypeFor('/d/index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('/d/index.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('/d/KaTeX_Main.woff2')).toBe('font/woff2');
    expect(contentTypeFor('/d/KaTeX_Main.woff')).toBe('font/woff');
    expect(contentTypeFor('/d/KaTeX_Main.ttf')).toBe('font/ttf');
    expect(contentTypeFor('/d/i.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('/d/x.json')).toBe('application/json; charset=utf-8');
  });

  it('falls back to application/octet-stream', () => {
    expect(contentTypeFor('/d/blob.bin')).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeFor('/d/noext')).toBe(DEFAULT_CONTENT_TYPE);
    // Object.prototype keys must not leak through the lookup table.
    expect(contentTypeFor('/d/x.constructor')).toBe(DEFAULT_CONTENT_TYPE);
  });

  it('is case insensitive', () => {
    expect(contentTypeFor('/d/A.CSS')).toBe('text/css; charset=utf-8');
  });
});

/** vitest runs with the project root as cwd. */
const REPO = process.cwd();

describe('resolveAppPath', () => {
  it('maps / to index.html', () => {
    expect(resolveAppPath(ROOT, 'app://mdreader/')).toBe(path.join(ROOT, 'index.html'));
    expect(resolveAppPath(ROOT, 'app://mdreader')).toBe(path.join(ROOT, 'index.html'));
  });

  it('resolves normal assets', () => {
    expect(resolveAppPath(ROOT, 'app://mdreader/assets/index-abc.js')).toBe(path.join(ROOT, 'assets/index-abc.js'));
    expect(resolveAppPath(ROOT, 'app://mdreader/assets/index.js?v=2#x')).toBe(path.join(ROOT, 'assets/index.js'));
  });

  it('decodes percent escapes', () => {
    expect(resolveAppPath(ROOT, 'app://mdreader/assets/a%20b.css')).toBe(path.join(ROOT, 'assets/a b.css'));
  });

  it('refuses to escape the root', () => {
    for (const url of [
      'app://mdreader/../../etc/passwd',
      'app://mdreader/assets/../../../../etc/passwd',
      'app://mdreader/%2e%2e/%2e%2e/etc/passwd',
      'app://mdreader/..%2f..%2fetc%2fpasswd',
    ]) {
      // Either rejected outright, or the traversal collapsed harmlessly INSIDE dist/.
      const got = resolveAppPath(ROOT, url);
      expect(got === null || got.startsWith(`${ROOT}/`), `${url} escaped to ${got}`).toBe(true);
    }
    expect(resolveAppPath(ROOT, 'app://mdreader/../../etc/passwd')).toBe(path.join(ROOT, 'etc/passwd'));
  });

  it('rejects NUL bytes, backslashes and malformed escapes', () => {
    expect(resolveAppPath(ROOT, 'app://mdreader/a%00b.js')).toBeNull();
    expect(resolveAppPath(ROOT, 'app://mdreader/a%ZZb.js')).toBeNull();
    expect(resolveAppPath(ROOT, 'app://mdreader/a%5Cb.js')).toBeNull();
    expect(resolveAppPath(ROOT, 'not a url')).toBeNull();
  });
});

// ---------------------------------------------------------------- fix round 2: CSP
describe('Content-Security-Policy', () => {
  /** Directive → sources, for readable assertions. */
  const parse = (csp: string): Record<string, string[]> =>
    Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...src]) => [name, src]));

  it('keeps a document opened by double-click off the network', () => {
    const d = parse(CSP_PACKAGED);
    // A tracking pixel in someone else's Markdown is a read receipt: no directive may name a remote
    // scheme or a wildcard. data:/blob: are local and stay allowed.
    for (const [name, sources] of Object.entries(d)) {
      for (const s of sources) {
        expect(/^(https?|wss?):|^\*$/.test(s), `${name} allows ${s}`).toBe(false);
      }
    }
    expect(d['img-src']).toEqual(["'self'", 'app:', 'data:', 'blob:']);
    expect(d['default-src']).toEqual(["'self'", 'app:']);
    expect(d['connect-src']).toEqual(["'self'", 'app:']);
    expect(d['frame-src']).toEqual(["'none'"]);
    expect(d['object-src']).toEqual(["'none'"]);
  });

  it('needs no inline script (index.html loads theme-boot.js instead)', () => {
    expect(parse(CSP_PACKAGED)['script-src']).not.toContain("'unsafe-inline'");
    const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
    expect(html).toContain('theme-boot.js');
    expect(/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html), 'index.html has an inline script').toBe(false);
    expect(fs.existsSync(path.join(REPO, 'public', 'theme-boot.js'))).toBe(true);
  });

  it('lets the dev server work while keeping the same privacy rules', () => {
    const d = parse(CSP_DEV);
    expect(d['script-src']).toContain("'unsafe-eval'"); // Vite's dev transforms
    for (const [name, sources] of Object.entries(d)) {
      for (const s of sources) {
        expect(/^https:|^http:\/\/(?!localhost)/.test(s), `${name} allows ${s}`).toBe(false);
      }
    }
  });

  it('is attached to every app:// response', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-proto-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
    const handler = createAppProtocolHandler(dir);
    const res = await handler(new Request('app://mdreader/index.html'));
    expect(res.headers.get('content-security-policy')).toBe(CSP_PACKAGED);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
