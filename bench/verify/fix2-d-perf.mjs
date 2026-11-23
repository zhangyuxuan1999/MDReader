// fix2-d-perf.mjs — fix-decoder (0.2.0 stage 2b): time to decode (and to read through readFileInfo) a
// 5 MB GBK, a 5 MB UTF-8, a 5 MB Big5 and a 5 MB windows-1252 file, candidate vs the frozen 0.1.0
// decoder (test/fixtures/fileIO-0.1.0.mjs). Gate: candidate ≤ 2 × fixture for GBK and UTF-8.
// Run: node bench/verify/fix2-d-perf.mjs   (temp files under $SCRATCH or os.tmpdir(); removed at the end;
// global timeout 100 s)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as neu from '../../electron/fileIO.mjs';
import * as old from '../../test/fixtures/fileIO-0.1.0.mjs';

setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000).unref();
const dir = fs.mkdtempSync(path.join(process.env.SCRATCH || os.tmpdir(), 'fix2-d-perf-'));
const iconv = (s, to) => execFileSync('/usr/bin/iconv', ['-f', 'UTF-8', '-t', to], { input: Buffer.from(s, 'utf8'), maxBuffer: 1 << 26 });
const ZH = '清晨的雨下得不大，街角的早点铺已经排起了长队。老板一边揉面一边和熟客聊天，说今年的小麦收成不错，面粉价格也降了一些。\n\n- 我们沿着河岸往北走，柳树刚刚发芽。\n';
const HANT = '早上的雨下得不大，街口的早餐店已經排起了長隊。老闆一邊揉麵一邊和熟客聊天，說今年的小麥收成不錯，麵粉價格也降了一些。\n';
const LAT = 'Am Morgen regnete es nur leicht, und vor der Bäckerei an der Ecke stand schon eine lange Schlange. Für die Prüfung übte sie täglich.\n';
const MB5 = 5 << 20;
const grow = (unit) => Buffer.concat(Array(Math.ceil(MB5 / unit.length)).fill(unit)).subarray(0, MB5);
const cutClean = (b, label) => { // end on a line break so that the file is clean in its encoding
  const i = b.lastIndexOf(0x0a);
  return b.subarray(0, i + 1);
};
const files = {
  gbk: cutClean(grow(iconv(ZH, 'GBK')), 'gbk'),
  'utf-8': cutClean(grow(Buffer.from(ZH, 'utf8')), 'utf-8'),
  big5: cutClean(grow(iconv(HANT, 'BIG5')), 'big5'),
  'windows-1252': cutClean(grow(iconv(LAT, 'CP1252')), 'windows-1252'),
};
const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
function time(fn, runs = 7) {
  fn(); // warm-up (encoder / weight tables are built once per process)
  const t = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    t.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return median(t);
}
try {
  for (const [label, b] of Object.entries(files)) {
    const o = old.decodeBuffer(b);
    const n = neu.decodeBuffer(b);
    const tOld = time(() => old.decodeBuffer(b));
    const tNew = time(() => neu.decodeBuffer(b));
    const tOff = time(() => neu.decodeBuffer(b, false));
    const p = path.join(dir, `${label}.md`);
    fs.writeFileSync(p, b);
    const store = neu.createFileMetaStore();
    const tRead = await (async () => {
      await neu.readFileInfo(p, store);
      const t = [];
      for (let i = 0; i < 5; i++) {
        const t0 = process.hrtime.bigint();
        await neu.readFileInfo(p, store);
        t.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      return median(t);
    })();
    const ratio = tNew / tOld;
    const gate = label === 'gbk' || label === 'utf-8' ? (ratio <= 2 ? 'PASS' : 'FAIL') : 'info';
    console.log(`${label.padEnd(13)} ${(b.length / 1048576).toFixed(2)} MB  0.1.0 ${o.encoding.padEnd(12)} ${tOld.toFixed(1).padStart(7)} ms  new ${n.encoding.padEnd(12)} ${tNew.toFixed(1).padStart(7)} ms  (×${ratio.toFixed(2)})  switch off ${tOff.toFixed(1)} ms  readFileInfo ${tRead.toFixed(1)} ms  ${gate}`);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
