// bench/verify/v3-fid-softprobe.mjs — verify-fidelity probe: what Chromium does to the collapsible line feed of a
// soft line break when a key is typed next to it (DOM text before / after, then the written source). Leaves the
// Vite on MDR_PORT running (v2-ses-lib.mjs). Writes nothing into the tree.
import { openB, sleep, J, globalTimeout } from './v2-ses-lib.mjs';
let B = null;
const stop = globalTimeout(100_000, async () => { await B?.close(); });
try {
  B = await openB();
  await B.boot('mode=split');
  for (const [doc, needle, where, key] of [['abc\ndef\n', 'abc', 'after', 'Q'], ['abc\ndef\n', 'abc', 'after', 'Backspace'], ['abc  \ndef\n', 'abc', 'after', 'Q'], ['abc\\\ndef\n', 'abc', 'after', 'Q'], ['ab c\ndef\n', 'ab', 'after', 'Q']]) {
    await B.loadDoc(doc, 's.md'); await B.settle(300);
    await B.clickLine(1, 'first', 'abc'.slice(0, 2));
    await sleep(150);
    await B.caretAt(needle, where);
    const before = await B.page.evaluate(() => (document.querySelector('.mdr-preview .is-editing p')?.innerHTML));
    if (key.length === 1) await B.page.keyboard.type(key); else await B.page.keyboard.press(key);
    const after = await B.page.evaluate(() => document.querySelector('.mdr-preview .is-editing p')?.innerHTML);
    await sleep(100); await B.page.keyboard.press('Escape'); await B.settle(300);
    console.log(`${J(doc)} ${key}: DOM ${J(before)} -> ${J(after)}; source ${J(await B.source())}`);
  }
} finally { stop(); await B?.close(); }
