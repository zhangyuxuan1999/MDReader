// Lead experiment: does the scored decoder ever flip genuine Simplified-Chinese GBK text away from GBK?
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = '/Users/zyx/LocalDocuments/MDReader';
const neu = await import(pathToFileURL(root + '/electron/fileIO.mjs').href);
// 0.1.0 reference: the frozen byte-for-byte copy (identical to release/_installed-asar/electron/fileIO.mjs).
const old = await import(pathToFileURL(root + '/test/fixtures/fileIO-0.1.0.mjs').href);
const table = neu.legacyEncoderTable('gbk');
const enc = (s) => { const out = []; for (const ch of s) { const cp = ch.codePointAt(0); if (cp < 0x80) out.push(cp); else { const b = table.get(ch); if (!b) return null; out.push(...b); } } return Buffer.from(out); };
let src = '';
for (const f of ['docs/AGENT-LOG.md', 'README.md', 'docs/WIP-inline-edit.md']) { try { src += fs.readFileSync(root + '/' + f, 'utf8'); } catch {} }
const han = [...src].filter((c) => { const cp = c.codePointAt(0); return cp >= 0x4e00 && cp <= 0x9fff && table.has(c); });
console.log('han chars available:', han.length, 'distinct:', new Set(han).size);
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const wrappers = { bare: (s) => s, mdAscii: (s) => '# Title\n\nSome plain ASCII text, then: ' + s + '\n\n- item one\n- item two\n' };
for (const [wname, wrap] of Object.entries(wrappers)) {
  for (const L of [1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 50, 100]) {
    const N = 4000; let flips = 0, oldBad = 0, thrown = 0; const winners = {}; const examples = [];
    for (let i = 0; i < N; i++) {
      const start = Math.floor(rnd() * (han.length - L));
      const snippet = han.slice(start, start + L).join('');
      const text = wrap(snippet);
      const buf = enc(text); if (!buf) continue;
      let o; try { o = old.decodeBuffer(buf); } catch { o = { encoding: 'THROW', text: '' }; }
      if (!(o.encoding === 'gbk' && o.text === text)) { oldBad++; continue; } // only count cases 0.1.0 got right
      let n; try { n = neu.decodeBuffer(buf); } catch { n = { encoding: 'THROW', text: '' }; thrown++; }
      if (!(n.encoding === 'gbk' && n.text === text)) { flips++; winners[n.encoding] = (winners[n.encoding] || 0) + 1; if (examples.length < 3) examples.push(snippet + '=>' + n.encoding); }
    }
    console.log(wname.padEnd(8), 'L=' + String(L).padEnd(4), 'flips', String(flips).padStart(5), '/', N - oldBad, 'oldWrong', oldBad, JSON.stringify(winners), examples.join(' | '));
  }
}
