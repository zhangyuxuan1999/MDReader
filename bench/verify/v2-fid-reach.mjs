// bench/verify/v2-fid-reach.mjs — verify-fidelity (0.2.0 stage 2a): are the serializer defects found in
// jsdom (test/v2-fid-*.test.ts) reachable with real typing in Chromium? Each scenario loads a small
// document, starts a session by clicking a needle, types with the real keyboard, leaves with Esc, and
// compares the source and the re-rendered preview with what the session showed.
// Run: MDR_PORT=5281 [MDR_NOSERVER=1] node bench/verify/v2-fid-reach.mjs [scenario-filter]   (own vite on MDR_PORT, killed at exit;
// writes nothing into the tree; global timeout 100 s)
import { startServer, stopServer, openBrowser, sleep } from './inline-verify-lib.mjs';

const TIMEOUT = setTimeout(() => { console.log('GLOBAL TIMEOUT'); stopServer(); process.exit(3); }, 100_000);
const filter = process.argv[2] ?? '';

/** scenario: doc, needle to click, steps (async (B, page)), check(after source, preview block html) */
const S = [
  { id: 'bare-before-mail-cjk', doc: '请联系<support@example.com>获取帮助。\n', click: '获取', steps: 'xBS',
    ok: (src, html) => /href="mailto:support@example.com"/.test(html) },
  { id: 'bare-before-mail-cjk-space', doc: '请联系<support@example.com> 获取帮助。\n', click: '获取', steps: async (B, page) => { await B.caretEnd(); await page.keyboard.type('吧'); },
    ok: (src, html) => /href="mailto:support@example.com"/.test(html) },
  { id: 'pua-e000-paragraph', doc: '图标\uE000文字与说明\n', click: '说明', steps: async (B, page) => { await B.caretEnd(); await page.keyboard.type('x'); },
    ok: (src) => src === '图标\uE000文字与说明x\n' },
  { id: 'pua-e002-table', doc: '| 名 | 图\uE002标 |\n|---|---|\n| 1 | 2 |\n', click: '名', steps: async (B, page) => { await B.caretEnd(); await page.keyboard.type('x'); },
    ok: (src, html) => (html.match(/<th[\s>]/g) ?? []).length === 2 },   // fix-serial-1: /<th/ also counted <thead
  { id: 'math-pipe-in-cell', doc: '| 名称 | 公式 |\n|---|---|\n| 绝对值 | $\\|x\\|$ |\n', click: '绝对值', steps: async (B, page) => { await B.joined('绝对值', 'after'); await page.keyboard.type('x'); },
    ok: (src, html) => (html.match(/<td/g) ?? []).length === 2 && /md-math/.test(html) },
  { id: 'merge-dollar', line: 3, doc: '价格 $x\n\ny$ 之后\n', click: '之后', steps: async (B, page) => { await B.joined('y$ 之后', 'before'); await page.keyboard.press('Backspace'); await new Promise((r) => setTimeout(r, 400)); },
    ok: (src, html) => !/md-math/.test(html) },
  { id: 'merge-tilde', line: 3, doc: '甲 ~~乙\n\n丙~~ 丁\n', click: '丁', steps: async (B, page) => { await B.joined('丙~~ 丁', 'before'); await page.keyboard.press('Backspace'); await new Promise((r) => setTimeout(r, 400)); },
    ok: (src, html) => !/<s>/.test(html) },
  { id: 'bare-before-http-letter', doc: '版本v2<https://example.com/a> 说明\n', click: '说明', steps: 'xBS',
    ok: (src, html) => /href="https:\/\/example.com\/a"/.test(html) },
  { id: 'bare-before-mail-letter', doc: '编号A<a@example.com> 说明\n', click: '说明', steps: 'xBS',
    ok: (src, html) => /href="mailto:a@example.com"/.test(html) },
  { id: 'bare-before-strong', doc: '**注意！**<https://example.com/x> 详见\n', click: '详见', steps: 'xBS',
    ok: (src, html) => /<strong>注意！<\/strong>/.test(html) },
  { id: 'bare-after-paren', doc: '文档 <https://example.com/docs>(英文) 可参考\n', click: '可参考', steps: 'xBS',
    ok: (src, html) => /href="https:\/\/example.com\/docs"/.test(html) },
  { id: 'bare-after-quote', doc: '见 <https://example.com/a>"引号" 说明\n', click: '说明', steps: 'xBS',
    ok: (src, html) => /href="https:\/\/example.com\/a"/.test(html) },
  { id: 'percent-link-text', doc: '[https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87](https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87) 词条\n', click: '词条', steps: 'xBS',
    ok: (src, html) => />https:\/\/zh.wikipedia.org\/wiki\/%E4%B8%AD%E6%96%87</.test(html) },
  { id: 'thematic-typed', doc: '原来的文字\n', click: '原来', steps: async (B, page) => { await B.joined('原来的文字', 'select'); await page.keyboard.type('-- -'); },
    ok: (src, html) => !/<hr/.test(html) && /-- -/.test(html) },
  { id: 'thematic-list-item', doc: '- 第一项\n- 第二项\n', click: '第二项', steps: async (B, page) => { await B.joined('第二项', 'select'); await page.keyboard.type('--- ---'); },
    ok: (src, html) => !/<hr/.test(html) },
  { id: 'heading-hash-trailing-space', doc: '## Learn C\n\n正文\n', click: 'Learn', steps: async (B, page) => { await B.caretEnd(); await page.keyboard.type(' # '); },
    ok: (src, html) => /Learn C #/.test(html.replace(/&nbsp;| /g, ' ')) },
  { id: 'heading-hash-after-em', doc: '## 话题 *标签*\n\n正文\n', click: '话题', steps: async (B, page) => { await B.caretEnd(); await page.keyboard.type(' #'); },
    ok: (src, html) => /#/.test(html.replace(/id="[^"]*"/g, '')) },
  { id: 'heading-hash-two-spaces', doc: '## 话题\n\n正文\n', click: '话题', steps: async (B, page) => { await B.caretEnd(); await page.keyboard.type('  #'); },
    ok: (src, html) => /#/.test(html.replace(/id="[^"]*"/g, '')) },
  { id: 'nbsp-para-in-quote', doc: '> 第一段\n>\n> &nbsp;\n>\n> 第三段\n', click: '第一段', steps: 'xBS',
    ok: (src) => src.includes('&nbsp;') },
  { id: 'nbsp-list-item', doc: '- 项目一\n- &nbsp;\n- 项目三\n', click: '项目一', steps: 'xBS',
    ok: (src, html) => (html.match(/<li/g) ?? []).length === 3 },
  { id: 'nbsp-under-heading', doc: '## 标题\n&nbsp;\n', click: '标题', steps: 'xBS',
    ok: (src) => src.includes('&nbsp;') },
  { id: 'math-then-digit', doc: '公式 $x$ 1 个与 $y$ 结尾\n', click: '个与', steps: async (B, page) => { await B.joined(' 1 个', 'before'); await page.keyboard.press('Delete'); },
    ok: (src, html) => (html.match(/class="md-math/g) ?? []).length === 2 },
  { id: 'em-inner-star', doc: '前 *a * b* 后\n', click: '后', steps: async (B, page) => { await B.joined('a * b', 'before'); await page.keyboard.press('Delete'); },
    ok: (src, html) => /<em>/.test(html) },
  { id: 'glued-formatting-html', doc: '**粗体**~~删除~~ 文本\n', click: '文本', steps: 'xBS',
    ok: (src) => !/<strong>|<del>/.test(src) },
];

if (process.env.MDR_NOSERVER === '1') process.removeListener('exit', stopServer);
else await startServer();
const B = await openBrowser();
const { page } = B;
const results = [];
try {
  await B.boot('mode=split');
  for (const s of S) {
    if (filter && !s.id.includes(filter)) continue;
    try {
      await B.loadDoc(s.doc, 'reach.md');
      await B.clickLine(s.line ?? 1, 'first', s.click);
      await sleep(150);
      if (!(await B.editing())) { results.push({ id: s.id, verdict: 'NO-SESSION' }); console.log(`NO-SESSION ${s.id}`); continue; }
      const shown = await page.evaluate(() => document.querySelector('.mdr-preview .is-editing')?.innerHTML ?? '');
      if (s.steps === 'xBS') { await B.caretEnd(); await page.keyboard.type('x'); await sleep(80); await page.keyboard.press('Backspace'); }
      else await s.steps(B, page);
      await sleep(150);
      const during = await page.evaluate(() => document.querySelector('.mdr-preview .is-editing')?.innerHTML ?? '');
      await B.esc();
      await sleep(200);
      await page.evaluate(() => window.__mdr.waitIdle());
      const src = await B.source();
      const html = await page.evaluate(() => {
        const pv = window.__mdr.app.preview;
        let out = ''; const n = window.__mdr.app.editor.view.state.doc.lines;
        for (let l = 1; l <= n;) { const b = pv.blockAtLine(l); if (!b) break; const el = pv.elementOfBlock(b.id); out += (el?.innerHTML ?? '') + '\n'; l = b.startLine + Math.max(1, b.lineCount); }
        return out;
      });
      const ok = s.ok(src, html);
      results.push({ id: s.id, verdict: ok ? 'HELD' : 'BROKEN', src, html: html.replace(/\s(data-l|data-mdr-o)="[^"]*"/g, '').slice(0, 300), during: during.replace(/\s(data-l|data-mdr-o)="[^"]*"/g, '').slice(0, 300), shown: shown.slice(0, 120) });
      console.log(`${ok ? 'HELD  ' : 'BROKEN'} ${s.id}\n   before ${JSON.stringify(s.doc)}\n   after  ${JSON.stringify(src)}\n   session DOM ${JSON.stringify(during.replace(/\s(data-l|data-mdr-o|class|id)="[^"]*"/g, '').slice(0, 240))}\n   preview ${JSON.stringify(html.replace(/\s(data-l|data-mdr-o|class|id)="[^"]*"/g, '').slice(0, 240))}`);
    } catch (err) {
      results.push({ id: s.id, verdict: 'ERROR', err: String(err).slice(0, 200) });
      console.log(`ERROR ${s.id}: ${String(err).slice(0, 200)}`);
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
  console.log('SUMMARY ' + results.map((r) => `${r.id}=${r.verdict}`).join(' '));
  if (B.pageErrors.length) console.log('PAGE ERRORS', B.pageErrors.slice(0, 3));
} finally {
  await B.browser.close().catch(() => {});
  if (process.env.MDR_NOSERVER !== '1') stopServer();
  clearTimeout(TIMEOUT);
}
