// bench/verify/v4-dec-check.mjs — verify-decoder (0.2.0 stage 2d): the per-input checks of the v4
// decoder differential, as plain functions so the SAME code runs in the system Node and inside the
// Electron main process (bench/electron/v4-dec-diff.mjs loads it there with createRequire).
//   makeChecker(N, O, D) -> { check(buf, name), checkFile(buf, name, dir), tables(), summary() }
//   N = the tree's / candidate's electron/fileIO.mjs, O = the frozen 0.1.0 fixture,
//   D = optional copy of N whose dormant override helpers throw 'DORMANT:<fn>' (proves "off is off").
// Read: decodeBuffer(buf) (default argument) vs O.decodeBuffer(buf): text, label, BOM, replaced, error.
// Save: meta as readFileInfo stores it (saveTableOf included) vs 0.1.0's meta; texts raw and LF-only
// (what CodeMirror hands back), each unmodified and + 'x', + a CJK character, + duplicate-mapped
// characters; changed ORIGINAL bytes (positional mismatches + length difference, the appended
// character's own bytes excluded) of N against O: more = FAIL, fewer = counted, same count but other
// bytes for an unmodified text = FAIL, other bytes only in the typed character = counted.
const CJK = { gbk: '中', big5: '中', shift_jis: '日', 'euc-kr': '한', 'windows-1252': 'é', 'utf-8': '中', 'utf-16le': '中', 'utf-16be': '中' };
const DUPS = {
  big5: ['十', '卅', '═', '╞', '╡', '╪', '兀', '嗀'],
  shift_jis: ['ⅰ', '≒', '∵', '¬', '∩', '纊', '①', '￢', '＇', '髙'],
  gbk: ['€', '・', '〓', '兀'],
  'euc-kr': ['·', '〓'],
};

function diffCount(a, b) {
  let n = Math.abs(a.length - b.length);
  const m = Math.min(a.length, b.length);
  for (let i = 0; i < m; i++) if (a[i] !== b[i]) n++;
  return n;
}
const sig = (f) => {
  try {
    const r = f();
    return { ok: true, r };
  } catch (e) {
    return { ok: false, msg: String(e && e.message), code: e && e.code };
  }
};

export function makeChecker(N, O, D = null) {
  const S = {
    inputs: 0, readDiff: 0, dormantReached: 0, saveWorse: 0, saveSameCountDiff: 0, saveFewer: 0,
    newRefusal: 0, fewerRefusal: 0, typedDiff: 0, savesChecked: 0, files: 0, fileFail: 0,
    labels: {}, tableWhatwg: 0, fails: [], fewer: [], typed: [],
  };
  const fail = (kind, name, detail) => { if (S.fails.length < 60) S.fails.push({ kind, name, detail }); };

  function check(buf, name) {
    S.inputs++;
    const a = sig(() => N.decodeBuffer(buf));
    const b = sig(() => O.decodeBuffer(buf));
    if (D) {
      const d = sig(() => D.decodeBuffer(buf));
      if (!d.ok && /DORMANT/.test(d.msg)) { S.dormantReached++; fail('dormant', name, d.msg); }
    }
    const ja = a.ok ? JSON.stringify([a.r.text, a.r.encoding, a.r.bom, a.r.replaced ?? 0]) : 'ERR ' + a.msg;
    const jb = b.ok ? JSON.stringify([b.r.text, b.r.encoding, b.r.bom, 0]) : 'ERR ' + b.msg;
    const lab = a.ok ? a.r.encoding : 'REFUSED';
    S.labels[lab] = (S.labels[lab] || 0) + 1;
    if (ja !== jb) {
      S.readDiff++;
      fail('read', name, { neu: ja.slice(0, 120), old: jb.slice(0, 120) });
      return;
    }
    if (!a.ok) return;
    const { text, encoding, bom } = a.r;
    const table = a.r.replaced ? undefined : N.saveTableOf(text, encoding, buf);
    if (table === undefined && (encoding === 'big5' || encoding === 'shift_jis')) S.tableWhatwg++;
    const metaN = { encoding, bom, eol: N.eolOf(text), ...(table ? { table } : {}) };
    const metaO = { encoding, bom, eol: O.eolOf(text) };
    const lf = text.replace(/\r\n?/g, '\n');
    const adds = ['', 'x', CJK[encoding] || '中', ...(DUPS[encoding] || [])];
    for (const [tn, t] of [['raw', text], ['lf', lf]]) {
      if (tn === 'lf' && lf === text) continue;
      for (const add of adds) {
        S.savesChecked++;
        const on = sig(() => N.encodeText(t + add, metaN));
        const oo = sig(() => O.encodeText(t + add, metaO));
        const tag = `${tn}+${add ? add : '(none)'}`;
        if (!on.ok && oo.ok) { S.newRefusal++; fail('newRefusal', name, { tag, msg: on.msg }); continue; }
        if (on.ok && !oo.ok) { S.fewerRefusal++; continue; }
        if (!on.ok) continue;
        const addN = add ? N.encodeText(add, { ...metaN, bom: false, eol: 'lf' }) : Buffer.alloc(0);
        const addO = add ? O.encodeText(add, { ...metaO, bom: false, eol: 'lf' }) : Buffer.alloc(0);
        const bodyN = on.r.subarray(0, on.r.length - addN.length);
        const bodyO = oo.r.subarray(0, oo.r.length - addO.length);
        const dN = diffCount(bodyN, buf);
        const dO = diffCount(bodyO, buf);
        if (dN > dO) { S.saveWorse++; fail('saveWorse', name, { tag, dN, dO, encoding, table }); }
        else if (dN < dO) { S.saveFewer++; if (S.fewer.length < 30) S.fewer.push({ name, tag, dN, dO, encoding }); }
        else if (!bodyN.equals(bodyO)) { S.saveSameCountDiff++; fail('sameCountDiff', name, { tag, dN, encoding, table }); }
        else if (!on.r.equals(oo.r)) { S.typedDiff++; if (S.typed.length < 30) S.typed.push({ name, tag, encoding, neu: addN.toString('hex'), old: addO.toString('hex') }); }
      }
    }
  }

  /** The real readFileInfo / writeFileAtomic of both modules on two temp copies; edit = append 'x'. */
  async function checkFile(buf, name, dir) {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    S.files++;
    const out = {};
    for (const [k, M] of [['n', N], ['o', O]]) {
      const p = path.join(dir, `${k}-${S.files}.md`);
      fs.writeFileSync(p, buf);
      const store = M.createFileMetaStore();
      try {
        const info = await M.readFileInfo(p, store);
        await M.writeFileAtomic(p, info.text, store);
        const same = fs.readFileSync(p);
        const t2 = info.text.replace(/\r\n?/g, '\n') + 'x';
        let err2 = null;
        try { await M.writeFileAtomic(p, t2, store); } catch (e) { err2 = e.message; }
        out[k] = { info: JSON.stringify([info.text, info.encoding, info.replacedBytes ?? 0]), same: same.toString('hex'), edited: err2 ? 'ERR ' + err2 : fs.readFileSync(p).toString('hex') };
      } catch (e) {
        out[k] = { err: e.message };
      } finally {
        fs.rmSync(p, { force: true });
      }
    }
    if (JSON.stringify(out.n) !== JSON.stringify(out.o)) {
      const n = out.n;
      const o = out.o;
      // a differing edited save is only a failure when it changes more original bytes
      let bad = true;
      if (n.info && o.info && n.info === o.info && n.same === o.same && !n.edited.startsWith('ERR') && !o.edited.startsWith('ERR')) {
        const dn = diffCount(Buffer.from(n.edited, 'hex').subarray(0, buf.length), buf);
        const dl = diffCount(Buffer.from(o.edited, 'hex').subarray(0, buf.length), buf);
        bad = dn > dl;
      }
      if (n.info && o.info && n.info === o.info && n.same !== o.same) {
        const dn = diffCount(Buffer.from(n.same, 'hex'), buf);
        const dl = diffCount(Buffer.from(o.same, 'hex'), buf);
        bad = dn >= dl;
      }
      if (bad) { S.fileFail++; fail('file', name, { n: JSON.stringify(n).slice(0, 200), o: JSON.stringify(o).slice(0, 200) }); }
    }
  }

  /** Encoder tables of N (WHATWG and 0.1.0 variants) against O's, in this runtime. */
  function tables() {
    const res = {};
    for (const label of ['gbk', 'big5', 'shift_jis', 'euc-kr', 'windows-1252']) {
      const o = O.legacyEncoderTable(label);
      const row = { old: o.size };
      for (const w of [true, false]) {
        const n = N.legacyEncoderTable(label, w);
        let missing = 0, extra = 0, differ = 0;
        const samples = [];
        for (const [ch, bytes] of o) {
          const nb = n.get(ch);
          if (!nb) { missing++; if (samples.length < 6) samples.push(['missing', ch, Buffer.from(bytes).toString('hex')]); }
          else if (Buffer.from(nb).toString('hex') !== Buffer.from(bytes).toString('hex')) { differ++; if (samples.length < 6) samples.push(['differ', ch, Buffer.from(bytes).toString('hex'), Buffer.from(nb).toString('hex')]); }
        }
        for (const ch of n.keys()) if (!o.has(ch)) { extra++; if (samples.length < 6) samples.push(['extra', ch]); }
        row[w ? 'whatwg' : 't010'] = { size: n.size, missing, extra, differ, samples };
      }
      res[label] = row;
    }
    return res;
  }

  return { check, checkFile, tables, summary: () => S };
}
