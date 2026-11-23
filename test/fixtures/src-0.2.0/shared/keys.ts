// src/shared/keys.ts — CodeMirror-style shortcut notation matcher for window-level keydown handlers.
// Notation: 'Mod-s', 'Mod-Shift-p', 'Mod-Alt-g', 'Mod-/', 'Mod-1'. 'Mod' is ⌘ on macOS, Ctrl elsewhere.

export const IS_MAC: boolean =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

const CODE_KEY: Record<string, string> = {
  Slash: '/', Period: '.', Comma: ',', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Space: ' ',
};

/** Key name derived from the physical key (layout independent) when possible, else from e.key. */
function physicalKey(e: KeyboardEvent): string | null {
  const code = e.code || '';
  if (code.startsWith('Key') && code.length === 4) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  if (code in CODE_KEY) return CODE_KEY[code];
  return null;
}

export interface ParsedShortcut { mod: boolean; ctrl: boolean; alt: boolean; shift: boolean; key: string }

export function parseShortcut(s: string): ParsedShortcut {
  const parts = s.split('-');
  // A trailing '-' key ('Mod--') yields empty parts; treat the last non-empty token as key, or '-' itself.
  let key = parts[parts.length - 1];
  if (key === '' && s.endsWith('-')) key = '-';
  const mods = parts.slice(0, -1).map((p) => p.toLowerCase());
  return {
    mod: mods.includes('mod'),
    ctrl: mods.includes('ctrl') || mods.includes('control'),
    alt: mods.includes('alt') || mods.includes('option'),
    shift: mods.includes('shift'),
    key: key.length === 1 ? key.toLowerCase() : key,
  };
}

export function matchShortcut(e: KeyboardEvent, s: string): boolean {
  const p = parseShortcut(s);
  const wantMeta = p.mod && IS_MAC;
  const wantCtrl = p.ctrl || (p.mod && !IS_MAC);
  if (e.metaKey !== wantMeta) return false;
  if (e.ctrlKey !== wantCtrl) return false;
  if (e.altKey !== p.alt) return false;
  if (e.shiftKey !== p.shift) return false;
  const k = (e.key || '').length === 1 ? e.key.toLowerCase() : e.key;
  if (k === p.key) return true;
  const phys = physicalKey(e);
  return phys !== null && phys === p.key;
}

/** Human readable label for menus/tooltips: 'Mod-Shift-p' → '⌘⇧P' on mac, 'Ctrl+Shift+P' elsewhere. */
export function formatShortcut(s: string): string {
  const p = parseShortcut(s);
  const keyLabel = p.key.length === 1 ? p.key.toUpperCase() : p.key;
  if (IS_MAC) {
    return `${p.ctrl ? '⌃' : ''}${p.alt ? '⌥' : ''}${p.shift ? '⇧' : ''}${p.mod ? '⌘' : ''}${keyLabel}`;
  }
  const parts: string[] = [];
  if (p.mod || p.ctrl) parts.push('Ctrl');
  if (p.alt) parts.push('Alt');
  if (p.shift) parts.push('Shift');
  parts.push(keyLabel);
  return parts.join('+');
}
