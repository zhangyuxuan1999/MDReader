// electron/windowState.mjs — remembers the window size/position in a tiny JSON file inside
// app.getPath('userData'). (electron-store is not allowed and not needed for five numbers.)
// `sanitizeWindowState` is pure so test/electron.windowState.test.ts can cover the guards.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_WIDTH = 1400;
export const DEFAULT_HEIGHT = 900;
export const MIN_WIDTH = 640;
export const MIN_HEIGHT = 420;
export const STATE_FILE = 'window-state.json';

const int = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

/**
 * @param {unknown} raw            parsed JSON (anything, including junk)
 * @param {{x:number,y:number,width:number,height:number}[]} [areas] display work areas; when given,
 *        a position whose top-left is not inside any of them is dropped (monitor unplugged).
 */
export function sanitizeWindowState(raw, areas) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const state = {
    width: Math.max(MIN_WIDTH, int(s.width) ?? DEFAULT_WIDTH),
    height: Math.max(MIN_HEIGHT, int(s.height) ?? DEFAULT_HEIGHT),
    maximized: s.maximized === true,
  };
  const x = int(s.x);
  const y = int(s.y);
  if (x !== null && y !== null) {
    const visible =
      !Array.isArray(areas) ||
      areas.length === 0 ||
      areas.some((a) => x >= a.x - 40 && y >= a.y - 40 && x < a.x + a.width - 40 && y < a.y + a.height - 40);
    if (visible) {
      state.x = x;
      state.y = y;
    }
  }
  return state;
}

export function readWindowState(userDataDir, areas) {
  try {
    const raw = fs.readFileSync(path.join(userDataDir, STATE_FILE), 'utf8');
    return sanitizeWindowState(JSON.parse(raw), areas);
  } catch {
    return sanitizeWindowState(null, areas);
  }
}

export function writeWindowState(userDataDir, state) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, STATE_FILE), JSON.stringify(sanitizeWindowState(state)), 'utf8');
    return true;
  } catch {
    return false; // never let a failed preference write break closing the window
  }
}
