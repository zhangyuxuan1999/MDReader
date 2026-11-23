// bench/electron/hunt-files-corpus.mjs — hunt:files corpus generator (open-empty investigation, 2026-11-20).
//
// Builds a corpus of NON-EMPTY Markdown files under a fresh temp directory: encodings, line endings,
// content shapes, file names / paths and file-system cases. Every case carries the text a correct
// reader must show (`expect`, already LF-normalised the way CodeMirror stores it) or `expectError`.
//
//   node bench/electron/hunt-files-corpus.mjs            # build, print a summary, delete again
//   import { buildCorpus } from './hunt-files-corpus.mjs' # used by hunt-files-run.mjs
//
// All content is synthetic. Legacy encodings are produced with /usr/bin/iconv (authoritative tables).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ZH = '# 标题\n\n这是一个中文文档，包含一些内容。第二句话在这里。\n\n- 列表项一\n- 列表项二\n';
const ZH_HANT = '# 標題\n\n這是一個繁體中文文件，包含一些內容。第二句話在這裡。\n\n- 清單項目一\n- 清單項目二\n';
const JA = '# 見出し\n\nこれは日本語の文書です。内容があります。二番目の文です。\n\n- 項目一\n- 項目二\n';
const KO = '# 제목\n\n이것은 한국어 문서입니다. 내용이 있습니다. 두 번째 문장입니다.\n\n- 항목 하나\n- 항목 둘\n';
const LATIN_SAFE = '# Café\n\nCafé au lait, crème brûlée, voilà.\n';
const LATIN_TRAP = '# Zürich\n\nÜber élan façade Zürich Mädchen\n'; // every accented char is followed by a letter
const CP1252 = '# Quotes\n\n“Hello” – it’s €5.\n';
const BASIC = '# Hello\n\nSome **bold** text and a [link](https://example.com).\n\n1. one\n2. two\n';

const lf = (s) => s.replace(/\r\n?/g, '\n');
const iconv = (text, to) => execFileSync('/usr/bin/iconv', ['-f', 'UTF-8', '-t', to], { input: Buffer.from(text, 'utf8') });

/** @returns {{dir: string, cases: Array<object>, cleanup: () => void}} */
export function buildCorpus(baseDir) {
  const root = fs.realpathSync(baseDir || fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mdr-hunt-files-')));
  const cases = [];
  const add = (id, group, rel, data, extra = {}) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (data !== null) fs.writeFileSync(p, data);
    const c = { id, group, path: p, ...extra };
    if (c.expect === undefined && !c.expectError && typeof data === 'string') c.expect = lf(data);
    cases.push(c);
    return c;
  };

  // ---------------------------------------------------------------- encodings
  add('enc-utf8', 'encoding', 'enc/utf8.md', ZH);
  add('enc-utf8-bom', 'encoding', 'enc/utf8-bom.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ZH)]), { expect: ZH });
  add('enc-utf16le-bom', 'encoding', 'enc/utf16le-bom.md', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ZH, 'utf16le')]), { expect: ZH });
  add('enc-utf16be-bom', 'encoding', 'enc/utf16be-bom.md', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(ZH, 'utf16le').swap16()]), { expect: ZH });
  add('enc-utf16le-nobom-ascii', 'encoding', 'enc/utf16le-nobom-ascii.md', Buffer.from(BASIC, 'utf16le'), { expect: BASIC });
  add('enc-utf16le-nobom-zh', 'encoding', 'enc/utf16le-nobom-zh.md', Buffer.from(ZH, 'utf16le'), { expect: ZH });
  add('enc-gbk', 'encoding', 'enc/gbk.md', iconv(ZH, 'GBK'), { expect: ZH });
  add('enc-gb18030-4byte', 'encoding', 'enc/gb18030.md', iconv(ZH + '\n扩展字 㐀 与 ㈠ 符号\n', 'GB18030'), { expect: ZH + '\n扩展字 㐀 与 ㈠ 符号\n' });
  add('enc-big5', 'encoding', 'enc/big5.md', iconv(ZH_HANT, 'BIG5'), { expect: ZH_HANT });
  add('enc-shiftjis', 'encoding', 'enc/sjis.md', iconv(JA, 'SHIFT_JIS'), { expect: JA });
  add('enc-euckr', 'encoding', 'enc/euckr.md', iconv(KO, 'EUC-KR'), { expect: KO });
  add('enc-latin1-safe', 'encoding', 'enc/latin1-safe.md', iconv(LATIN_SAFE, 'ISO-8859-1'), { expect: LATIN_SAFE });
  add('enc-latin1-trap', 'encoding', 'enc/latin1-trap.md', iconv(LATIN_TRAP, 'ISO-8859-1'), { expect: LATIN_TRAP });
  add('enc-cp1252', 'encoding', 'enc/cp1252.md', iconv(CP1252, 'CP1252'), { expect: CP1252 });
  {
    // UTF-8 Chinese with a few invalid bytes (a truncated multi-byte sequence + a stray 0xFF / 0x80).
    const good = Buffer.from(ZH);
    const bad1 = Buffer.concat([good.subarray(0, 20), Buffer.from([0xff]), good.subarray(20)]);
    add('enc-utf8-invalid-ff', 'encoding', 'enc/utf8-invalid-ff.md', bad1, { expect: lf(ZH), note: 'one 0xFF byte inserted at offset 20; ideal: UTF-8 with one U+FFFD (or a clear refusal)' });
    const bad2 = Buffer.concat([good, Buffer.from([0xe4, 0xb8])]); // truncated last character
    add('enc-utf8-truncated', 'encoding', 'enc/utf8-truncated.md', bad2, { expect: lf(ZH), note: 'file ends inside a 3-byte sequence (cut-off download)' });
    const bad3 = Buffer.concat([good.subarray(0, 30), Buffer.from([0x80]), good.subarray(30)]);
    add('enc-utf8-invalid-80', 'encoding', 'enc/utf8-invalid-80.md', bad3, { expect: lf(ZH), note: 'one stray 0x80 continuation byte' });
  }

  // ---------------------------------------------------------------- line endings
  add('eol-lf', 'eol', 'eol/lf.md', BASIC);
  add('eol-crlf', 'eol', 'eol/crlf.md', BASIC.replace(/\n/g, '\r\n'));
  add('eol-cr', 'eol', 'eol/cr.md', BASIC.replace(/\n/g, '\r'));
  add('eol-mixed', 'eol', 'eol/mixed.md', '# Mixed\r\n\r\nline a\nline b\rline c\r\n');

  // ---------------------------------------------------------------- content shapes
  add('shape-frontmatter', 'shape', 'shape/frontmatter.md', '---\ntitle: 测试\ntags: [a, b]\n---\n\n# 正文\n\n内容在这里。\n');
  add('shape-frontmatter-only', 'shape', 'shape/frontmatter-only.md', '---\ntitle: 只有元数据\ndate: 2026-11-20\n---\n');
  add('shape-html-only', 'shape', 'shape/html-only.md', '<div align="center">\n  <img src="logo.png" width="100">\n  <h1>项目名称</h1>\n  <p>简介文字</p>\n</div>\n');
  add('shape-html-details', 'shape', 'shape/html-details.md', '<details>\n<summary>点开查看</summary>\n\n隐藏的内容\n\n</details>\n');
  add('shape-comments-only', 'shape', 'shape/comments-only.md', '<!-- 注释一 -->\n<!--\n多行注释\n第二行\n-->\n');
  add('shape-code-only', 'shape', 'shape/code-only.md', '```python\nprint("hello")\nfor i in range(3):\n    print(i)\n```\n');
  add('shape-blank2000', 'shape', 'shape/blank2000.md', '\n'.repeat(2000) + '# 末尾的标题\n\n文字\n');
  add('shape-ws-onechar', 'shape', 'shape/ws-onechar.md', ' \t \n   \n\t\t\n    x');
  add('shape-refdefs-only', 'shape', 'shape/refdefs-only.md', '[a]: https://example.com\n[b]: /path "title"\n[c]: <./x y.md>\n');
  add('shape-nul', 'shape', 'shape/nul.md', '# NUL\n\nbefore\u0000after\n\nmore\u0000\u0000text\n');
  add('shape-indented-code', 'shape', 'shape/indented.md', '    indented code line 1\n    indented code line 2\n');
  {
    const line = 'abcdefghij'.repeat(500 * 1024) + '\n'; // 5 MB single line
    add('shape-5mb-line', 'shape', 'shape/5mb-line.md', line, { slow: true });
  }
  {
    const para = '## 段落标题\n\n这是一段用于填充大文件的中文和 English mixed text，包含 **粗体** 与 `code`。\n\n';
    const n = Math.ceil((30 * 1024 * 1024) / Buffer.byteLength(para));
    const big = para.repeat(n) + '# 文件结尾\n';
    add('shape-30mb', 'shape', 'shape/30mb.md', big, { slow: true, cold: true });
  }

  // ---------------------------------------------------------------- names and paths
  const nameCase = (id, name, extra = {}) => add(id, 'name', path.join('names', name), BASIC, extra);
  nameCase('name-cjk', '中文文件名.md', { cold: true });
  nameCase('name-emoji', '📝 笔记 🚀.md');
  nameCase('name-spaces', 'my  notes file .md');
  nameCase('name-hash', '#1 issue#2.md');
  nameCase('name-percent', '100% done %20 %E4%B8%AD.md');
  nameCase('name-question', 'what?.md');
  nameCase('name-amp-plus-eq', 'a&b+c=d.md');
  nameCase('name-quotes', 'he said "hi" it\'s.md');
  nameCase('name-backslash', 'back\\slash.md');
  nameCase('name-newline', 'line\nbreak.md');
  nameCase('name-leading-dot', '.hidden.md');
  nameCase('name-250b', 'n'.repeat(250 - 3) + '.md');
  {
    // > 900 bytes: nested 9 levels of 100-byte directory names.
    const segs = Array.from({ length: 9 }, (_, i) => `${i}`.padEnd(100, 'd'));
    nameCase('name-path-900b', path.join(...segs, 'deep.md'), { cold: true });
  }
  nameCase('name-upper-MD', 'UPPER.MD', { cold: true });
  nameCase('ext-markdown', 'x.markdown');
  nameCase('ext-mdown', 'x.mdown');
  nameCase('ext-mkd', 'x.mkd');
  nameCase('ext-mkdn', 'x.mkdn');
  nameCase('ext-none', 'README', { cold: true });
  nameCase('ext-txt', 'notes.txt');
  {
    const nfc = nameCase('name-nfd-request', 'café-résumé.md');
    nfc.openPath = nfc.path.normalize('NFD'); // Finder may hand over a decomposed path
  }

  // ---------------------------------------------------------------- file-system cases
  const target = add('fs-target', 'fs', 'fs/target.md', ZH);
  {
    const l1 = path.join(root, 'fs', 'link1.md');
    fs.symlinkSync(target.path, l1);
    cases.push({ id: 'fs-symlink', group: 'fs', path: l1, expect: lf(ZH) });
    const l2 = path.join(root, 'fs', 'link2.md');
    const l3 = path.join(root, 'fs', 'link3.md');
    fs.symlinkSync(l1, l2);
    fs.symlinkSync('link2.md', l3); // relative link in the chain
    cases.push({ id: 'fs-symlink-chain', group: 'fs', path: l3, expect: lf(ZH) });
    const dangling = path.join(root, 'fs', 'dangling.md');
    fs.symlinkSync(path.join(root, 'fs', 'nowhere.md'), dangling);
    cases.push({ id: 'fs-symlink-dangling', group: 'fs', path: dangling, expectError: true });
    const hard = path.join(root, 'fs', 'hard.md');
    fs.linkSync(target.path, hard);
    cases.push({ id: 'fs-hardlink', group: 'fs', path: hard, expect: lf(ZH) });
  }
  {
    const ro = add('fs-readonly', 'fs', 'fs/readonly.md', ZH);
    fs.chmodSync(ro.path, 0o444);
    const denied = add('fs-chmod000', 'fs', 'fs/denied.md', ZH, { expectError: true, cold: true, expect: undefined });
    fs.chmodSync(denied.path, 0o000);
    const ddir = path.join(root, 'fs', 'denied-dir');
    fs.mkdirSync(ddir);
    fs.writeFileSync(path.join(ddir, 'inside.md'), ZH);
    fs.chmodSync(ddir, 0o000);
    cases.push({ id: 'fs-dir-000', group: 'fs', path: path.join(ddir, 'inside.md'), expectError: true });
  }
  {
    const d = path.join(root, 'fs', 'folder.md');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'child.md'), BASIC);
    cases.push({ id: 'fs-dir-named-md', group: 'fs', path: d, expectError: true });
  }
  add('fs-deleted-race', 'fs', 'fs/deleted.md', ZH, { expectError: true, expect: undefined, deleteAfterEmit: true });
  cases.push({ id: 'fs-missing', group: 'fs', path: path.join(root, 'fs', 'never-existed.md'), expectError: true });
  {
    const fifo = path.join(root, 'fs', 'pipe.md');
    execFileSync('/usr/bin/mkfifo', [fifo]);
    cases.push({ id: 'fs-fifo', group: 'fs', path: fifo, expectError: true, fifo: true });
    // Opened right after the FIFO, in the same session: does the hung read block later documents?
    const after = add('fs-after-fifo', 'fs', 'fs/after-fifo.md', BASIC);
    after.afterFifo = true;
  }
  add('fs-zero-then-filled', 'fs', 'fs/zero-then-filled.md', '', { expect: lf(BASIC), fillAfterMs: 0, fill: BASIC,
    note: 'file is 0 bytes when open-file fires and is filled immediately afterwards (another program still writing)' });

  const cleanup = () => {
    try {
      // restore permissions so the tree can be removed
      for (const c of cases) {
        try { fs.chmodSync(path.dirname(c.path), 0o755); } catch { /* gone */ }
        try { const st = fs.lstatSync(c.path); if (st.isDirectory()) fs.chmodSync(c.path, 0o755); else if (!st.isSymbolicLink()) fs.chmodSync(c.path, 0o644); } catch { /* gone */ }
      }
      fs.rmSync(root, { recursive: true, force: true });
    } catch (e) {
      console.error('cleanup failed', root, e.message);
    }
  };
  return { dir: root, cases, cleanup };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { dir, cases, cleanup } = buildCorpus();
  for (const c of cases) {
    let size = '-';
    try { size = fs.lstatSync(c.path).size; } catch { /* missing on purpose */ }
    console.log(`${c.id.padEnd(26)} ${String(size).padStart(10)}  ${path.relative(dir, c.path).slice(0, 80).replace(/\n/g, '\\n')}`);
  }
  console.log(`${cases.length} cases in ${dir}`);
  cleanup();
  console.log('removed', !fs.existsSync(dir));
}
