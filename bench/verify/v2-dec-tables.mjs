// v2-dec-tables.mjs — per legacy label: does every 2-byte sequence the decoder accepts round-trip
// through the encoder table (candidate) byte for byte? And are candidate and 0.1.0 tables equal?
// Run: node bench/verify/v2-dec-tables.mjs
import * as neu from '../../electron/fileIO.mjs';
import * as old from '../../test/fixtures/fileIO-0.1.0.mjs';
setTimeout(() => { console.error('global timeout'); process.exit(2); }, 90_000).unref();
for (const label of neu.LEGACY_ENCODINGS) {
  const tn = neu.legacyEncoderTable(label), to = old.legacyEncoderTable(label);
  let diff = 0; for (const [k, v] of tn) { const o = to.get(k); if (!o || o.join() !== v.join()) diff++; }
  for (const k of to.keys()) if (!tn.has(k)) diff++;
  const dec = new TextDecoder(label, { fatal: true });
  let ok = 0, bad = 0; const ex = [];
  for (let hi = 0x80; hi <= 0xff; hi++) for (let lo = 0x40; lo <= 0xff; lo++) {
    let s; try { s = dec.decode(Uint8Array.of(hi, lo)); } catch { continue; }
    if ([...s].length !== 1) continue;
    const b = tn.get(s);
    if (b && b.length === 2 && b[0] === hi && b[1] === lo) ok++;
    else { bad++; if (ex.length < 12) ex.push(`${hi.toString(16)}${lo.toString(16)}→${s}(U+${s.codePointAt(0).toString(16)})→${b ? b.map((x) => x.toString(16)).join('') : 'none'}`); }
  }
  console.log(label, 'tableDiff(new vs 0.1.0)=', diff, 'pairs ok=', ok, 'non-roundtrip=', bad, ex.join(' '));
}
