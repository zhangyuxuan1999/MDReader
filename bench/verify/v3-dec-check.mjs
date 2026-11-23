// v3-dec-check.mjs — the classification of bench/verify/v3-dec-diff.mjs as a synchronous ESM module (no
// top-level await), so that it can be require()d inside the Electron main process
// (bench/electron/v3-dec-diff-electron.mjs). Generated from v3-dec-diff.mjs; same classes (see there).
const FFFD = String.fromCharCode(0xfffd);
export function makeChecker(neu, old, noshape = null) {
  const HARD = /[\u0000-\u0006\u000E-\u001A\u001C-\u001F\u007F]/g;
  const hardShare = (t) => { const s = t.slice(0, 400000); if (!s.length) return 0; const m = s.match(HARD); return m ? m.length / s.length : 0; };

  function dec(f, b, ...a) { try { return f(b, ...a); } catch (e) { return { refused: true, msg: e.message }; } }
  const same = (a, b) => (a.refused && b.refused) || (!a.refused && !b.refused && a.text === b.text && a.encoding === b.encoding && a.bom === b.bom);
  function metaOf(d, b) {
    const table = d.replaced ? undefined : neu.saveTableOf(d.text, d.encoding, b);
    return { encoding: d.encoding, bom: d.bom, eol: neu.eolOf(d.text), ...(table ? { table } : {}) };
  }
  function encNew(text, meta) { try { return neu.encodeText(text, meta); } catch (e) { return null; } }
  function encOld(text, meta) { try { return old.encodeText(text, meta); } catch (e) { return null; } }
  /** encodeText piece by piece, line separators kept as they are. */
  function rawEncode(text, meta) {
    const out = [];
    if (meta.bom) out.push(neu.encodeText('', meta));
    for (const p of text.split(/(\r\n|\r|\n)/)) {
      if (p === '') continue;
      const piece = p === '\r' ? rawCr(meta) : p === '\r\n' ? encNew('\n', { ...meta, bom: false, eol: 'crlf' }) : encNew(p, { ...meta, bom: false, eol: 'lf' });
      if (piece === null) return null;
      out.push(piece);
    }
    return Buffer.concat(out);
  }
  function rawCr(meta) { return meta.encoding === 'utf-16le' ? Buffer.from([13, 0]) : meta.encoding === 'utf-16be' ? Buffer.from([0, 13]) : Buffer.from([13]); }
  const eq = (a, b) => a === null ? b === null : b !== null && a.equals(b);

  const stats = {};
  const examples = {};
  const gains = {};
  const bump = (fam, k) => { stats[fam] ??= {}; stats[fam][k] = (stats[fam][k] || 0) + 1; };
  function note(fam, k, info) {
    bump(fam, k);
    examples[k] ??= [];
    if (examples[k].length < 12) examples[k].push({ fam, ...info });
  }

  function check(fam, b, truth, trueLabel, bom) {
    bump(fam, 'n');
    const o = dec(old.decodeBuffer, b);
    const n = dec(neu.decodeBuffer, b);
    const off = dec(neu.decodeBuffer, b, false);
    const hex = b.length <= 400 ? b.toString('hex') : undefined;
    const brief = (d) => d.refused ? 'REFUSED' : `${d.encoding}${d.bom ? '+bom' : ''}${d.replaced ? ` repl=${d.replaced}` : ''}`;
    // step 2: the switch
    if (!same(o, off)) note(fam, 'off', { hex, o: brief(o), off: brief(off) });
    else if (!o.refused) {
      const mOld = { encoding: o.encoding, bom: o.bom, eol: old.eolOf(o.text) };
      const mOff = metaOf(off, b);
      // untouched bytes: a save of (text + add) must start with the original bytes whenever the
      // unmodified save of that reading is exact (uniform line endings only)
      const uniform = !/\r(?!\n)/.test(o.text) && !(/\r\n/.test(o.text) && /(^|[^\r])\n/.test(o.text));
      const so0 = encOld(o.text, mOld), sf0 = encNew(off.text, mOff);
      const oldExact = !!so0 && so0.equals(b), offExact = !!sf0 && sf0.equals(b);
      if (!eq(so0, sf0)) note(fam, oldExact && !offExact ? 'offSaveWorse' : !oldExact && offExact ? 'offSaveBetter' : 'offSaveBothInexact', { hex, enc: o.encoding, table: mOff.table });
      for (const add of ['x', '\n十', '\n卅', '═', 'ⅰ', '≒', '∵', '¬', '①', '㈱']) {
        if (!uniform) break;
        const so = encOld(o.text + add, mOld);
        const sf = encNew(off.text + add, mOff);
        const oldKeeps = oldExact && !!so && so.subarray(0, b.length).equals(b);
        const offKeeps = offExact && !!sf && sf.subarray(0, b.length).equals(b);
        if (oldKeeps && !offKeeps) note(fam, 'offEditBreaksUntouched', { hex, enc: o.encoding, add, table: mOff.table });
        if (!eq(so, sf)) bump(fam, 'offEditNewCharBytesDiffer ' + o.encoding + ' ' + add.trim());
      }
    }
    if (!n.refused && !n.replaced) {
      const uniformN = !/\r(?!\n)/.test(n.text) && !(/\r\n/.test(n.text) && /(^|[^\r])\n/.test(n.text));
      const mN = metaOf(n, b);
      const sn0 = encNew(n.text, mN);
      if (uniformN && sn0 && sn0.equals(b)) for (const add of ['x', '\n十', '═', 'ⅰ', '≒', '①']) {
        const sn = encNew(n.text + add, mN);
        if (sn && !sn.subarray(0, b.length).equals(b)) note(fam, 'candEditBreaksUntouched', { hex, enc: n.encoding, add, table: mN.table });
      }
    }
    const oRight = !o.refused && o.text === truth && o.encoding === trueLabel && o.bom === bom;
    const nRight = !n.refused && n.text === truth && n.encoding === trueLabel && n.bom === bom;
    if (oRight && !nRight) {
      note(fam, 'i', { hex: b.length <= 4000 ? b.toString('hex') : undefined, len: b.length, o: brief(o), n: brief(n), nText: n.text?.slice(0, 80) });
      if (n.replaced) bump(fam, 'lenientOverGood');
    }
    if (n.refused && !o.refused) {
      if (o.encoding === 'utf-8' && hardShare(o.text) > 0.5) bump(fam, 'binaryRule');
      else note(fam, 'ii', { hex, o: brief(o) });
    }
    if (!n.refused && !n.replaced && !o.refused) {
      const so = encOld(o.text, { encoding: o.encoding, bom: o.bom, eol: old.eolOf(o.text) });
      const sn = encNew(n.text, metaOf(n, b));
      const oldExact = so !== null && so.equals(b);
      const newExact = sn !== null && sn.equals(b);
      if (oldExact && !newExact) note(fam, 'iii', { hex, o: brief(o), n: brief(n) });
    }
    if (!n.refused && !n.replaced && (o.refused || n.encoding !== o.encoding)) {
      // line endings as they are (K10 normalisation is not an encoding question)
      const sn = rawEncode(n.text, metaOf(n, b));
      if (!(sn && sn.equals(b))) note(fam, 'iv', { hex, o: brief(o), n: brief(n) });
    }
    if (!n.refused && n.encoding !== 'utf-8' && n.text.includes(FFFD) && !(o.text || '').includes(FFFD)) note(fam, 'v', { hex, n: brief(n) });
    if (['big5', 'shift_jis', 'euc-kr'].includes(trueLabel)) {
      gains[fam + ' ' + trueLabel] ??= { n: 0, old: 0, cand: 0, noshape: 0 };
      const g = gains[fam + ' ' + trueLabel];
      g.n++;
      if (oRight) g.old++;
      if (nRight) g.cand++;
      if (noshape) {
        const x = dec(noshape.decodeBuffer, b);
        if (!x.refused && x.text === truth && x.encoding === trueLabel) g.noshape++;
      }
    }
    return { o, n };
  }


  return { check, stats, examples, gains };
}
