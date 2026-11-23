// bench/verify/v3-fid-mathprobe.mjs — verify-fidelity probe: Enter right before an inline formula (a
// contenteditable=false atom), with and without a space before it: the DOM of the session right after the key,
// and the written source. Leaves the Vite on MDR_PORT running (v2-ses-lib.mjs). Writes nothing into the tree.
import { openB, sleep, J, globalTimeout } from './v2-ses-lib.mjs';
let B = null;
const stop = globalTimeout(100_000, async () => { await B?.close(); });
try {
  B = await openB();
  await B.boot('mode=split');
  const cases = [['abc $x$ y\n', 'abc', 'Enter'], ['abc$x$ y\n', 'abc', 'Enter'], ['abc  $x$ y\n', 'abc', 'Enter'], ['abc $x$ y\n', 'abc', 'Shift+Enter'],
    ['abc ![i](https://e.example/i.png) y\n', 'abc', 'Enter'], ['- abc $x$ y\n- b\n', 'abc', 'Enter'], ['abc **b** y\n', 'abc', 'Enter'], ['abc&nbsp;$x$ y\n', 'abc', 'Enter']];
  for (const [doc, needle, key] of cases) {
    await B.loadDoc(doc, 'm.md'); await B.settle(300);
    await B.clickLine(1, 'first', needle.slice(0, 2));
    await sleep(150);
    await B.caretAt(needle, 'after');
    await B.page.keyboard.press(key);
    const dom = await B.page.evaluate(() => document.querySelector('.mdr-preview .is-editing')?.innerHTML.replace(/<span class="katex">.*?<\/span><\/span><\/span>/g, '[K]').slice(0, 400));
    await sleep(200);
    const dom2 = await B.page.evaluate(() => document.querySelector('.mdr-preview .is-editing')?.innerHTML.replace(/<span class="katex">[\s\S]*?annotation[\s\S]*?<\/span><\/span>/g, '[K]').slice(0, 300));
    await B.page.keyboard.type('Z');
    await sleep(150); await B.page.keyboard.press('Escape'); await B.settle(300);
    console.log(`${J(doc)} ${key}:\n   at once ${J(dom)}\n   later   ${J(dom2)}\n   source  ${J(await B.source())}`);
  }
} finally { stop(); await B?.close(); }
