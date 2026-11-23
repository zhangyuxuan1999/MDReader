// bench/electron/_electron.mjs — the ONLY way bench scripts launch MDReader / Electron.
//
// Why: `electron.launch()` without a `--user-data-dir` runs with the user's REAL profile
// (~/Library/Application Support/MDReader — the dev shell calls app.setName('MDReader') too), and
// an isolated profile still does not isolate the macOS recent-documents list (keyed by bundle id).
// Tests run that way left dead recent entries and stale drafts in the real profile (2026-09-20).
//
// What this wrapper guarantees for every launch:
//   1. a `--user-data-dir` is always present. A script that passes its own keeps it; otherwise ONE
//      temp profile per script process is used for all its launches (so restart / draft-restore
//      checks still see their own earlier state) and removed when the process exits;
//   2. `app.addRecentDocument` is stubbed in the main process right after launch.
//
// Usage: `import { electron } from './_electron.mjs'` instead of
//        `import { _electron as electron } from '@playwright/test'`. Same API.
import { _electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let sharedProfile = null;

/** The temp profile this process uses when a script does not bring its own. */
export function isolatedProfile() {
  if (!sharedProfile) {
    sharedProfile = mkdtempSync(path.join(os.tmpdir(), 'mdr-iso-'));
    process.on('exit', () => {
      try {
        rmSync(sharedProfile, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });
  }
  return sharedProfile;
}

const hasProfileArg = (args) => args.some((a) => typeof a === 'string' && a.startsWith('--user-data-dir'));

export const electron = {
  /** Same as Playwright's `_electron.launch`, plus the two guarantees above. */
  async launch(options = {}) {
    const args = Array.isArray(options.args) ? [...options.args] : [];
    if (!hasProfileArg(args)) args.push(`--user-data-dir=${isolatedProfile()}`);
    const app = await _electron.launch({ ...options, args });
    try {
      await app.evaluate(({ app: a }) => {
        a.addRecentDocument = () => {};
      });
    } catch {
      // the app may already be quitting (a second instance that lost the lock): nothing to stub
    }
    return app;
  },
};
