// bench/verify/v2-ses-wysiwyg.mjs — verify-session: "what the session shows is what the source holds".
// Random operations in random blocks of a mixed document (paragraphs, headings, lists, tasks, quotes, code, tables,
// math). After each round: settle, take the preview's visible text while the session is still live, press Esc
// (the block re-renders from the source), take it again: both must be equal (whitespace-normalised). Also: no
// zero-width space / raw style in the source, the structure tiles, no page error. Seed on the command line; every
// failure prints the seed, the round and the op log.
// Run: MDR_PORT=5282 node bench/verify/v2-ses-wysiwyg.mjs <seed> [--rounds N] [--doc small|mixed]
import { openB, sleep, globalTimeout, J, readRoot } from './v2-ses-lib.mjs';

const args = process.argv.slice(2);
const seed = Number(args[0] ?? 1);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ROUNDS = Number(opt('--rounds', 10));
let st = seed >>> 0 || 1;
const rnd = () => { st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return st / 0x100000000; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const MIXED = [
  '# 标题 Title', '', '段落一含**粗体**、*斜体*、`代码`和[链接](https://a.com)，以及普通文字。', '',
  '- 项目一 **粗**', '- 项目二', '  - 嵌套', '- [ ] 任务', '', '1. one', '2. two', '', '> 引用里的 *文字*', '>', '> 第二段', '',
  '| 甲 | 乙 |', '|---|---|', '| 一 | 二 |', '', '```js', 'let a = 1;', 'if (a) { b(); }', '```', '', '公式 $x^2$ 在行内。', '',
  '## 第二节', '段落二，English words here。', '', 'last line',
].join('\n') + '\n';
const DOC = opt('--doc', 'mixed') === 'small' ? readRoot('test-data/small.md').split('\n').slice(0, 80).join('\n') + '\n' : MIXED;

const B = await openB();
const stop = globalTimeout(Number(process.env.FUZZ_TIMEOUT ?? 110_000), B.close);
const { page } = B;
const log = [];
let failed = 0;
const fail = (what, detail) => { failed++; console.log(`FAIL seed=${seed} ${what}: ${detail}`); console.log(`  ops: ${log.slice(-60).join(' ')}`); };
const TYPED = ['a', 'xy', ' ', '中文', '字', '😀', '*', '_', '`', '[', ']', '#', '> ', '- ', '1. ', '|', '$', '~', '\\', '!', '<', '&', 'word ', '  '];
async function paste(text) {
  await page.evaluate((text) => {
    const dt = new DataTransfer(); dt.setData('text/plain', text);
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}
const OPS = ['type', 'type', 'type', 'type', 'enter', 'senter', 'bs', 'bs', 'del', 'tab', 'stab', 'left', 'right', 'up', 'down', 'aleft', 'sel', 'bold', 'italic', 'code', 'paste', 'undo'];
async function op() {
  const k = pick(OPS);
  log.push(k);
  switch (k) {
    case 'type': { const s = pick(TYPED); log[log.length - 1] = `T${J(s)}`; await page.keyboard.type(s); break; }
    case 'enter': await page.keyboard.press('Enter'); break;
    case 'senter': await page.keyboard.press('Shift+Enter'); break;
    case 'bs': await page.keyboard.press('Backspace'); break;
    case 'del': await page.keyboard.press('Delete'); break;
    case 'tab': await page.keyboard.press('Tab'); break;
    case 'stab': await page.keyboard.press('Shift+Tab'); break;
    case 'left': await page.keyboard.press('ArrowLeft'); break;
    case 'right': await page.keyboard.press('ArrowRight'); break;
    case 'up': await page.keyboard.press('ArrowUp'); break;
    case 'down': await page.keyboard.press('ArrowDown'); break;
    case 'aleft': await page.keyboard.press('Alt+ArrowLeft'); break;
    case 'sel': await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('Shift+ArrowLeft'); break;
    case 'bold': await page.keyboard.press('Meta+b'); break;
    case 'italic': await page.keyboard.press('Meta+i'); break;
    case 'code': await page.keyboard.press('Meta+e'); break;
    case 'paste': { const t = pick(['p\nq', 'r\n\ns', 'one', '# h\n- x']); log[log.length - 1] = `P${J(t)}`; await paste(t); break; }
    case 'undo': await sleep(80); await page.keyboard.press('Meta+z'); break;
  }
  await sleep(Math.floor(rnd() * 40));
}
const shown = () => page.evaluate(() => {
  const pv = document.querySelector('.mdr-preview');
  const secs = Array.from(pv.querySelectorAll('section.md-block'));
  return secs.map((s) => {
    const c = s.cloneNode(true);
    for (const e of Array.from(c.querySelectorAll('.katex-mathml, [data-mdr-ui], .md-code__lang, .md-codewrap > :not(pre)'))) e.remove();
    for (const e of Array.from(c.querySelectorAll('.md-math-src'))) e.textContent = '';
    for (const e of Array.from(c.querySelectorAll('.katex'))) e.textContent = '';
    for (const e of Array.from(c.querySelectorAll('br, p, li, h1, h2, h3, h4, h5, h6, tr, td, th, blockquote, pre, div, ul, ol, table'))) { e.before(' '); e.after(' '); }
    return c.textContent;
  }).join('\n').replace(/[​﻿]/g, '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
});
try {
  await B.boot('mode=split');
  await B.loadDoc(DOC);
  for (let r = 0; r < ROUNDS && !failed; r++) {
    const lines = (await B.source()).split('\n');
    const cands = lines.map((l, i) => [l, i + 1]).filter(([l]) => /[\p{L}\p{N}]{2}/u.test(l) && !/^\|[-: |]+\|$/.test(l) && !/^```/.test(l));
    if (!cands.length) break;
    const [, n] = pick(cands);
    log.push(`@${n}`);
    try { await B.clickLine(n, pick(['first', 'last'])); } catch { log.push('noclick'); continue; }
    await sleep(80);
    if (!(await B.editing())) { log.push('noedit'); continue; }
    for (let k = 0; k < 8 + Math.floor(rnd() * 8); k++) await op();
    await sleep(500); await B.settle(250);
    if (!(await B.editing())) { log.push('ended'); }
    const live = await shown();
    await page.keyboard.press('Escape');
    await sleep(300); await B.settle(300);
    const again = await shown();
    const src = await B.source();
    if (live !== again) {
      let i = 0; while (i < live.length && live[i] === again[i]) i++;
      fail(`round ${r} shown≠source`, `session showed …${J(live.slice(Math.max(0, i - 40), i + 60))}… re-render shows …${J(again.slice(Math.max(0, i - 40), i + 60))}…`);
      console.log(`  source: ${J(src.slice(0, 1200))}`);
      break;
    }
    if (/[​﻿]|style=|<span|<font/.test(src)) { fail(`round ${r} junk in source`, J(src.match(/.{0,30}(?:[​﻿]|style=|<span|<font).{0,30}/)?.[0])); break; }
    const t = await B.tiles();
    if (!t.ok) { fail(`round ${r} tiles`, J(t)); break; }
  }
  if (B.pageErrors.length) fail('page errors', J(B.pageErrors.slice(0, 3)));
  console.log(`${failed ? 'FAILED' : 'OK'} seed=${seed} ops=${log.length}`);
} catch (e) { fail('threw', e.stack.split('\n').slice(0, 3).join(' | ')); }
finally { stop(); await B.close(); process.exit(failed ? 1 : 0); }
