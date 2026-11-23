// electron/fileIO.mjs — file fidelity for the desktop shell (CONTRACT §10, fix round 2).
//
// Everything that must survive an open → ⌘S round trip lives here:
//   * text encoding  — UTF-8 (with/without BOM), UTF-16 (BOM), and the legacy CJK encodings a
//                      Chinese Windows box still produces (GBK/Big5/Shift_JIS/EUC-KR). A file is
//                      decoded with its REAL encoding and written back in that same encoding;
//                      `fsp.readFile(p,'utf8')` used to turn every stray byte into U+FFFD and the
//                      next save persisted the damage.
//   * BOM            — kept byte-for-byte.
//   * line endings   — a CRLF file stays CRLF even though CodeMirror's document is always LF.
//   * symlinks       — the write follows the link (realpath) instead of replacing it.
//   * hard links     — a file with nlink > 1 is written in place so the inode (and its other names)
//                      survive; the rename dance would silently detach them.
//   * concurrency    — the mtime captured when the file was read is compared before writing, so a
//                      change another program made in between is reported instead of clobbered.
//
// No 'electron' import on purpose: test/electron.fileIO.test.ts drives this file directly in Node.
import { constants as fsConstants, promises as fsp } from 'node:fs';
import path from 'node:path';

/** Messages the renderer branches on (src/files/nativeBackend.ts keeps the matching predicates). */
export const CONFLICT_MESSAGE = '文件已被其他程序修改，保存会覆盖对方的改动';
export const UNDECODABLE_MESSAGE = '无法识别该文件的文本编码（可能是二进制文件）';
export const unrepresentableMessage = (label, ch) =>
  `文档包含 ${label.toUpperCase()} 编码无法表示的字符「${ch}」，请用「另存为」保存为 UTF-8`;

/** Legacy encodings tried, in this order, when the bytes are not valid UTF-8: 0.1.0 took the FIRST one
 *  that decodes cleanly (so GBK whenever GBK decodes cleanly), and that is still the answer unless an
 *  override below holds (decision S4). */
export const LEGACY_ENCODINGS = ['gbk', 'big5', 'shift_jis', 'euc-kr', 'windows-1252'];
/** The labels the "another clean CJK label" override may choose instead of 0.1.0's answer: every
 *  Big5 / Shift_JIS / EUC-KR double-byte pair is also a valid GBK pair, so 0.1.0 showed Traditional
 *  Chinese, Japanese and Korean files as GBK garbage. windows-1252 is never chosen over 0.1.0's answer
 *  (S4 (c) enumerates the overrides; Latin text that happens to be clean GBK stays as 0.1.0 read it). */
const CJK_LABELS = ['gbk', 'big5', 'shift_jis', 'euc-kr'];

/**
 * Decision S4 (c): the one switch for every override of 0.1.0's answer. With it off (this constant, or
 * `decodeBuffer(buf, false)`), decodeBuffer IS the 0.1.0 decoder: same text, label, BOM flag and the
 * same refusals (test/electron.fileIO.differential.test.ts proves it on its whole corpus, and
 * bench/electron/r3-d-parity.mjs inside Electron's own runtime).
 * Decision S4 (f) (H7): OFF in 0.2.0. The overrides stay in the code and in the unit tests (which pass
 * `true`); switching one on again needs a differential against the frozen 0.1.0 decoder run inside
 * Electron's runtime (H28).
 */
export const DECODER_OVERRIDES = false;

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/** 0.1.0's "control character" test for a legacy decode, exactly: C0 minus TAB/LF/CR (no DEL, no C1 —
 *  so windows-1252 accepts 81 / 8D / 8F / 90 / 9D, as Czech / Slovak CP1250 files need). The frozen
 *  file holds these as raw bytes; here they are escapes. */
const CONTROL_RE_010 = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
/** Stricter test for a reading an OVERRIDE proposes: C0 minus TAB/LF/CR, DEL and the C1 range (a CJK
 *  decoder that produces any of them has guessed wrong). */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
/** "Hard" control characters: C0 minus TAB/LF/CR and minus the ones real text files do carry —
 *  BEL, BS, VT, FF (page breaks) and ESC (ANSI colour codes in pasted terminal output) — plus DEL.
 *  Used only to tell binary from text. */
const HARD_CONTROL_RE_G = /[\u0000-\u0006\u000E-\u001A\u001C-\u001F\u007F]/g;
/** Binary refusal: a reading is refused when MORE than this share of its characters are hard controls.
 *  0.1.0 accepted every strict-UTF-8 file; a 2 % threshold over all controls (hotfix draft) refused ANSI
 *  logs, form-feed files and short files with a few NULs — so the bar is deliberately high. */
const UTF8_BINARY_CONTROL_SHARE = 0.5;
/** Lenient UTF-8 evidence (S4 (b)): at least this share of the non-ASCII characters are valid sequences
 *  (a run of U+FFFD counts once: one stray byte inside a character yields 2–4 of them) … */
const UTF8_LENIENT_MIN_SCORE = 0.9;
/** … and at least this many valid multi-byte characters (two GBK characters can look like UTF-8). */
const UTF8_LENIENT_MIN_VALID = 8;
/** Scoring looks at this many non-ASCII characters at most (a 30 MB file must not take seconds). */
const SCORE_SAMPLE_CHARS = 200_000;
/** NUL-pattern detection of BOM-less UTF-16 looks at this many bytes at most. */
const UTF16_SNIFF_BYTES = 1 << 20;
/** BOM-less UTF-16 sniff, by the share of byte pairs that carry a NUL on ONE side (the side with
 *  more of them). Bytes that are strictly valid UTF-8 are read as UTF-16 only at ≥ 40 % (ASCII in
 *  UTF-16 is ~100 %; 0.1.0 read every strictly valid UTF-8 file as UTF-8, and UTF-8 Markdown with a
 *  NUL every few characters stays UTF-8) and only from 4 such pairs on (a 4-byte "ab\0c" is not
 *  evidence). Bytes that are NOT valid UTF-8 — which 0.1.0 always refused when they hold a NUL — need
 *  5 % (UTF-16 CJK has few NULs). */
const UTF16_SIDE_SHARE_STRICT_UTF8 = 0.4;
const UTF16_SIDE_SHARE_OTHERWISE = 0.05;
const UTF16_MIN_NUL_PAIRS_STRICT_UTF8 = 4;
/**
 * "Another clean CJK label" evidence: the label replaces 0.1.0's answer only with at least
 * MIN_EVIDENCE_CHARS non-ASCII characters in its own decode AND a score at least EVIDENCE_MARGIN above
 * the score of 0.1.0's answer (and, S4 (d), only when its encoder gives the file's bytes back).
 * Measured (fixer-D, 2026-11-20) as "score of the wrong label minus score of GBK" on genuine GBK:
 *   - windows of the repository's Chinese docs and of general prose: up to +0.60 at 1–2 Han
 *     characters, +0.14 at 10, +0.013 at 15, below 0 from 16 on;
 *   - random GB2312 level-1 strings (no word structure: the adversarial case), 60 000 per length:
 *     +0.15 at 16, +0.12 at 20, +0.075 at 24, +0.02 at 50 (always EUC-KR: GB2312 level 1 and the
 *     KS X 1001 Hangul block occupy the same byte rows).
 * and as "score of the true label minus score of GBK" on genuine text, 20 000 windows: Big5 ≥ 0.385,
 * EUC-KR ≥ 0.286, Shift_JIS ≥ 0.72 from 20 characters on. 20 characters and 0.2 leave ≥ 0.08 on
 * both sides.
 */
const MIN_EVIDENCE_CHARS = 20;
const EVIDENCE_MARGIN = 0.2;
/**
 * … and the label's reading must look like its language, because the score favours any reading whose
 * characters fall into "level 1" rows, which random pairs of GBK-extension characters (GBK/3, GBK/4:
 * name characters, traditional forms) do in Shift_JIS and Big5. Measured (fix-decoder, 2026-11-20) on
 * 60 000 random GBK/3 and GBK/4 strings of 12–60 characters that pass the two rules above:
 *   - share of the TOP characters (weight 1: TOP_HAN / TOP_HANGUL, kana for Shift_JIS) in the reading:
 *     Big5 false readings 0 (none above 0), genuine Big5 windows of 20–120 characters ≥ 0.15
 *     (11 of 19 902 below 0.2); EUC-KR genuine ≥ 0.48;
 *   - share of kana in a Shift_JIS reading: false ≤ 0.087, genuine Japanese windows ≥ 0.35.
 */
const MIN_TOP_SHARE = 0.1;
const MIN_KANA_SHARE_SJIS = 0.2;
/** Large files: the CJK and lenient decisions are made on a bounded sample (start, middle, end; each
 *  cut after a byte below 0x30, where no legacy or UTF-8 sequence can continue); the winner must then
 *  hold for the whole file. */
const SAMPLE_CHUNK_BYTES = 24 * 1024;
/** Message for a FIFO / socket / device named like a document. */
export const NOT_REGULAR_MESSAGE = '这不是普通文件（可能是管道、套接字或设备），无法打开';

// Frequent characters, used as evidence that a legacy decode produced real text. Simplified AND
// Traditional forms (GBK vs Big5), plus the kanji Japanese shares; and the frequent Hangul syllables.
const TOP_HAN = new Set(
  '的一是不了人我在有他这为之大来以个中上们到说国和地也子时道出而要于就下得可你年生自会那后能对着事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与好看学进种将还分此心前面又定见只主没公从已向关本开文动工实现长内点高正新问通意理明使气物外机等全部力表间性体加被重知及电相但样手头很最美回位度次员西应因话四做感线解系政两期利提百情何资题任社比给原入合活世少五接件九才区放程更名白展变口北山教月车条至林质八再别带结光整近单族制象联反志听记建打报片论元边量深强计今神转平眼每包老受即拉图石色海路张果难华权指六门品运决信农保收特斗书声证改总直取务米金命南连安府须设管七太识复革切亲队委快千格'
  + '這為來個們說國時會對過發還種進點學開長現問與從關實動當經無麼軍見將變話體機頭應電區號視錢書條萬東車語讓認論記請員團選議產業聽質裡標題繁檔內容第句單項目傳間讀寫邊門愛氣張隊報顯總導處務'
  + '見出語本日番内容項',
);
const TOP_HANGUL = new Set(
  '이다는의에가하고지을를도한서기로으자사리인수대아시어게나있해일정보적우들것주만그전요내부상말여문제니거습화공년국장소동성경원실결과생면중연회할했된되라무비까모안위없신계관방개단세명물미발본분선식야영오용유음입재조터통학후각간감강건곳구권근금급날남너노늘님당더데든때또래러렇려력런름마많매머목민바반배번법변별병산새설손순술스씨았않알앞약양었엇업예왜외운월육은익임잘저점좀종줄직진질집차처천체초최추치친카크타태테트특파편평포표품프피필합항행현형호활획효히둘째하나번째',
);

/** Share of hard control characters (HARD_CONTROL_RE_G) in (a prefix of) a decoded text. */
function hardControlShare(text) {
  const s = text.length > 400_000 ? text.slice(0, 400_000) : text;
  if (s.length === 0) return 0;
  const m = s.match(HARD_CONTROL_RE_G);
  return m ? m.length / s.length : 0;
}

function ioError(message, code = 'EIO') {
  const e = new Error(message);
  e.code = code;
  return e;
}

export function conflictError() {
  const e = ioError(CONFLICT_MESSAGE);
  e.mdrConflict = true;
  return e;
}

// ---------------------------------------------------------------- decoding

/** Strict decode, or null. `partialEnd`: an incomplete sequence at the very end is not an error
 *  (streaming decode of a sample cut at an arbitrary byte). */
function decodeWith(buf, label, partialEnd = false) {
  try {
    return new TextDecoder(label, { fatal: true }).decode(buf, { stream: partialEnd });
  } catch {
    return null;
  }
}

/**
 * The 0.1.0 decoder, unchanged (electron/fileIO.mjs of the installed 0.1.0 and 0.1.1, frozen as
 * test/fixtures/fileIO-0.1.0.mjs): a BOM, else strict UTF-8, else the FIRST of LEGACY_ENCODINGS that
 * decodes cleanly (CONTROL_RE_010), else EIO. Every answer of decodeBuffer starts from this one.
 */
function decodeBuffer010(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    const text = decodeWith(buf.subarray(3), 'utf-8');
    if (text !== null) return { text, encoding: 'utf-8', bom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    const text = decodeWith(buf.subarray(2), 'utf-16le');
    if (text !== null) return { text, encoding: 'utf-16le', bom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const text = decodeWith(buf.subarray(2), 'utf-16be');
    if (text !== null) return { text, encoding: 'utf-16be', bom: true };
  }
  const utf8 = decodeWith(buf, 'utf-8');
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8', bom: false };
  for (const label of LEGACY_ENCODINGS) {
    const text = decodeWith(buf, label);
    // A decoder that "succeeds" but produces control characters has guessed wrong (binary, or the
    // wrong legacy table): keep looking.
    if (text !== null && !CONTROL_RE_010.test(text)) return { text, encoding: label, bom: false };
  }
  throw ioError(UNDECODABLE_MESSAGE);
}

/**
 * Bytes → { text, encoding, bom } (+ `replaced`, the U+FFFD count, for a lenient UTF-8 reading).
 * Throws an EIO error when nothing decodes. `encoding` is a WHATWG label; `bom` is true when the file
 * carried one (it is stripped from `text` and written back by `encodeText`).
 *
 * Decision S4: 0.1.0's answer (decodeBuffer010), replaced only by one of the enumerated overrides,
 * each with its own evidence test (`overrideOf`). `overrides` = false returns 0.1.0's answer as is.
 */
export function decodeBuffer(buf, overrides = DECODER_OVERRIDES) {
  let base = null;
  let refusal = null;
  try {
    base = decodeBuffer010(buf);
  } catch (e) {
    refusal = e;
  }
  if (overrides) {
    const o = overrideOf(buf, base);
    if (o === REFUSE) throw ioError(UNDECODABLE_MESSAGE);
    if (o) return o;
  }
  if (refusal) throw refusal;
  return base;
}

const REFUSE = Symbol('refuse');

/**
 * The overrides of 0.1.0's answer `base` (null = 0.1.0 refused the bytes), S4 (c). Returns the reading
 * that replaces it, REFUSE, or null (0.1.0's answer stands). The complete list:
 *   1. BOM-less UTF-16 — the NUL pattern of UTF-16 (sniffUtf16) and a plausible decode in one byte
 *      order. Over a strict-UTF-8 answer only at ≥ 40 % one-sided NUL pairs; otherwise only where 0.1.0
 *      refused (a NUL byte makes every legacy decode fail 0.1.0's control test).
 *   2. Binary refusal — the only rule that refuses what 0.1.0 opened: a strict-UTF-8 answer of which
 *      more than half the characters are hard controls (UTF-32, zero-filled files, executables).
 *   3. Lenient UTF-8 — bytes that are not valid UTF-8, read as UTF-8 with U+FFFD for the invalid
 *      sequences (main warns): only with ≥ UTF8_LENIENT_MIN_VALID valid multi-byte characters and a
 *      valid share ≥ UTF8_LENIENT_MIN_SCORE, over the whole file, and not binary.
 *   4. Another clean CJK label — over a GBK / Big5 / Shift_JIS / EUC-KR answer: a different CJK label
 *      that decodes cleanly with ≥ MIN_EVIDENCE_CHARS characters, a score ≥ EVIDENCE_MARGIN higher and
 *      a reading that looks like its language (MIN_TOP_SHARE; Shift_JIS also MIN_KANA_SHARE_SJIS).
 *      windows-1252 is not a candidate: it never replaces 0.1.0's answer.
 * Every override that names a label other than 0.1.0's needs its encoder to give the bytes back
 * (S4 (d), `encodesBack`), except lenient UTF-8, whose U+FFFD cannot (main says so).
 */
function overrideOf(buf, base) {
  if (base && base.bom) return null; // a BOM and a clean decode after it: 0.1.0's answer
  const hasNul = buf.indexOf(0) !== -1;
  if (base && base.encoding === 'utf-8') {
    // Strictly valid UTF-8, no BOM.
    if (hasNul) {
      const utf16 = sniffUtf16(buf, UTF16_SIDE_SHARE_STRICT_UTF8, UTF16_MIN_NUL_PAIRS_STRICT_UTF8); // 1
      if (utf16) return utf16;
    }
    if (hardControlShare(base.text) > UTF8_BINARY_CONTROL_SHARE) return REFUSE; // 2
    return null;
  }
  // Not valid UTF-8: 0.1.0 read a legacy encoding, or refused.
  if (hasNul) {
    const utf16 = sniffUtf16(buf, UTF16_SIDE_SHARE_OTHERWISE, 1); // 1
    if (utf16) return utf16;
  }
  const lenient = lenientUtf8Reading(buf); // 3
  if (lenient) return lenient;
  if (base && CJK_LABELS.includes(base.encoding)) return otherCjkReading(buf, base); // 4
  return null;
}

function resultOf(text, encoding, replaced, bom = false) {
  const out = { text, encoding, bom };
  if (replaced) out.replaced = replaced;
  return out;
}

/**
 * S4 (d): does encodeText give `buf` back for `text` in `label` (no BOM; line endings as they are —
 * the EOL normalisation of a save is K10, not an encoding question)?
 */
function encodesBack(text, label, buf, whatwg = true) {
  if (label === 'utf-16le' || label === 'utf-16be') {
    const le = Buffer.from(text, 'utf16le');
    return (label === 'utf-16le' ? le : le.swap16()).equals(buf);
  }
  // The table as a dense array by UTF-16 code unit (a Map lookup per character took ~200 ms for 5 MB):
  // 0x10000 | byte for a 1-byte sequence, (lead << 8) | trail for a 2-byte one, -1 for none (every
  // table entry is one BMP character; a surrogate has no entry, as an astral character has none).
  const codes = encoderCodes(label, whatwg);
  const n = buf.length;
  let k = 0;
  for (let i = 0; i < text.length; i++) {
    const v = codes[text.charCodeAt(i)];
    if (v < 0) return false;
    if (v > 0xffff) {
      if (buf[k++] !== (v & 0xff)) return false;
    } else {
      if (buf[k] !== v >> 8 || buf[k + 1] !== (v & 0xff)) return false;
      k += 2;
    }
  }
  return k === n;
}

const encoderCodeArrays = new Map();
function encoderCodes(label, whatwg) {
  const key = `${label} ${whatwg}`;
  let codes = encoderCodeArrays.get(key);
  if (codes) return codes;
  codes = new Int32Array(0x10000).fill(-1);
  for (const [ch, bytes] of legacyEncoderTable(label, whatwg)) {
    codes[ch.charCodeAt(0)] = bytes.length === 1 ? 0x10000 | bytes[0] : (bytes[0] << 8) | bytes[1];
  }
  encoderCodeArrays.set(key, codes);
  return codes;
}

/** Override 4: a clean CJK reading other than 0.1.0's GBK / Big5 / Shift_JIS / EUC-KR answer, or null. */
function otherCjkReading(buf, base) {
  const { sample, partialEnd } = sampleOf(buf);
  const whole = sample === buf;
  const baseText = whole ? base.text : decodeWith(sample, base.encoding, partialEnd);
  if (baseText === null) return null;
  const baseScore = measureLegacy(baseText, base.encoding).score;
  let best = null;
  for (const label of CJK_LABELS) {
    if (label === base.encoding) continue;
    const text = decodeWith(sample, label, partialEnd);
    if (text === null || CONTROL_RE.test(text)) continue;
    const m = measureLegacy(text, label);
    const looksLikeIt = m.top >= m.n * MIN_TOP_SHARE && (label !== 'shift_jis' || m.kana >= m.n * MIN_KANA_SHARE_SJIS);
    if (m.n >= MIN_EVIDENCE_CHARS && m.score >= baseScore + EVIDENCE_MARGIN && looksLikeIt && (!best || m.score > best.score)) {
      best = { label, text, score: m.score };
    }
  }
  if (!best) return null;
  const text = whole ? best.text : decodeWith(buf, best.label);
  if (text === null || CONTROL_RE.test(text) || !encodesBack(text, best.label, buf)) return null;
  return resultOf(text, best.label);
}

/** Override 3: the lenient UTF-8 reading when its evidence holds (decided on the sample first, then
 *  required again of the whole file), or null. */
function lenientUtf8Reading(buf) {
  const { sample, partialEnd } = sampleOf(buf);
  if (sample !== buf && !lenientEvidence(lenientUtf8(sample, partialEnd))) return null;
  const l = lenientUtf8(buf);
  if (l.replaced === 0 || !lenientEvidence(l) || hardControlShare(l.text) > UTF8_BINARY_CONTROL_SHARE) return null;
  return resultOf(l.text, 'utf-8', l.replaced, l.bom);
}

const lenientEvidence = (l) => l.valid >= UTF8_LENIENT_MIN_VALID && l.score >= UTF8_LENIENT_MIN_SCORE;

/**
 * The bytes a decision looks at: the whole buffer when it is small; otherwise a chunk from the start,
 * the middle and the end. A chunk boundary inside the file sits right after a byte below 0x30 — no
 * UTF-8, GBK / GB18030, Big5, Shift_JIS or EUC-KR sequence continues past such a byte, so the chunks
 * decode as they would in place and can be concatenated. A middle / end chunk without such a byte near
 * its edges is left out; when even the start chunk has none near its end (CJK text with no newline or
 * space for kilobytes), the sample is the start chunk alone and `partialEnd` tells the decision to
 * ignore an incomplete last sequence (streaming decode).
 */
function sampleOf(buf) {
  const n = buf.length;
  if (n <= SAMPLE_CHUNK_BYTES * 4) return { sample: buf, partialEnd: false };
  const safeEnd = (from, to) => {
    const lim = Math.max(from, to - 4096);
    let end = to;
    while (end > lim && buf[end - 1] >= 0x30) end--;
    return end > lim ? end : -1;
  };
  const safeStart = (at) => {
    const lim = Math.min(n, at + 4096);
    let start = at;
    while (start < lim && buf[start - 1] >= 0x30) start++;
    return start < lim ? start : -1;
  };
  const headEnd = safeEnd(0, SAMPLE_CHUNK_BYTES);
  if (headEnd < 0) return { sample: buf.subarray(0, SAMPLE_CHUNK_BYTES), partialEnd: true };
  const parts = [buf.subarray(0, headEnd)];
  const mid = safeStart(Math.floor(n / 2));
  if (mid >= 0) {
    const end = safeEnd(mid, Math.min(n, mid + SAMPLE_CHUNK_BYTES));
    if (end > mid) parts.push(buf.subarray(mid, end));
  }
  const tail = safeStart(n - SAMPLE_CHUNK_BYTES);
  if (tail >= 0) parts.push(buf.subarray(tail)); // ends at the end of the file: a cut-off last character counts
  return { sample: Buffer.concat(parts), partialEnd: false };
}

const UTF8_FFFD = Buffer.from([0xef, 0xbf, 0xbd]);

function countSeq(bytes, seq) {
  let n = 0;
  for (let i = bytes.indexOf(seq); i !== -1; i = bytes.indexOf(seq, i + 1)) n++;
  return n;
}

/** Override 1: BOM-less UTF-16 by its NUL pattern, or null. `minShare`: share of byte pairs that must
 *  carry a NUL on the side that has more of them; `minPairs`: and at least this many such pairs. */
function sniffUtf16(buf, minShare, minPairs) {
  const n = buf.length;
  if (n < 4 || n % 2 !== 0) return null;
  const limit = Math.min(n, UTF16_SNIFF_BYTES) & ~1;
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i + 1 < limit; i += 2) {
    const a = buf[i];
    const b = buf[i + 1];
    if (a === 0 && b === 0) return null; // U+0000: not text
    if (a === 0) evenNul++;
    else if (b === 0) oddNul++;
  }
  // ASCII in UTF-16 is "byte, NUL"; CJK has no NULs except U+xx00 (一 is U+4E00), so the side the
  // NULs are on is not decisive — decode both byte orders and keep the one that reads as text.
  const side = Math.max(evenNul, oddNul);
  if (side < minPairs || side < (limit / 2) * minShare) return null;
  let best = null;
  for (const label of ['utf-16le', 'utf-16be']) {
    const text = decodeWith(buf, label);
    if (text === null || hardControlShare(text) > 0.01) continue;
    const share = plausibleShare(text);
    if (!best || share > best.share) best = { text, label, share };
  }
  if (!best || best.share < 0.9 || !encodesBack(best.text, best.label, buf)) return null;
  return { text: best.text, encoding: best.label, bom: false };
}

/** Share of characters that ordinary text is made of (ASCII, Latin-1 letters, general punctuation,
 *  CJK, kana, Hangul, full-width forms). A UTF-16 text read in the wrong byte order is mostly not. */
function plausibleShare(text) {
  const s = text.length > 100_000 ? text.slice(0, 100_000) : text;
  if (s.length === 0) return 0;
  let ok = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      (c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d
      || (c >= 0xc0 && c <= 0x17f) || (c >= 0x2000 && c <= 0x206f)
      || (c >= 0x3000 && c <= 0x30ff) || (c >= 0x4e00 && c <= 0x9fff)
      || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xff00 && c <= 0xffef)
    ) ok++;
  }
  return ok / s.length;
}

/**
 * Non-fatal UTF-8 for bytes that are ALMOST UTF-8 (one stray 0xFF / 0x80, a file cut off inside its
 * last character). `score` = share of non-ASCII characters that were valid sequences (a run of
 * U+FFFD counts once); `valid` = valid non-ASCII characters; `replaced` = how many invalid sequences
 * became U+FFFD (a genuine EF BF BD is not counted).
 */
function lenientUtf8(buf, partialEnd = false) {
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = new TextDecoder('utf-8').decode(bom ? buf.subarray(3) : buf, { stream: partialEnd });
  let replaced = 0; // U+FFFD characters
  let damage = 0;   // runs of consecutive U+FFFD
  let valid = 0;
  let prevBad = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      prevBad = false;
      continue;
    }
    const bad = c === 0xfffd;
    if (bad) {
      replaced++;
      if (!prevBad) damage++;
    } else if (c < 0xdc00 || c > 0xdfff) valid++; // a surrogate pair counts once
    prevBad = bad;
  }
  const genuine = replaced > 0 ? countSeq(buf, UTF8_FFFD) : 0;
  replaced = Math.max(0, replaced - genuine);
  damage = Math.max(0, damage - genuine);
  valid += genuine;
  return { text, bom, valid, replaced, score: valid + damage ? valid / (valid + damage) : 0 };
}

/**
 * How plausible a CJK decode is: the mean, over (a sample of) its non-ASCII characters, of a weight
 * that is high for frequent characters of that encoding's language (TOP lists, kana for Shift_JIS,
 * the KS X 1001 Hangul block for EUC-KR) and for the encoding's own punctuation rows, and near zero
 * for what a mis-decode produces (PUA, extension rows, rare characters, kana out of place). The byte
 * position of each character is looked up in the encoder table of the same label.
 */
export function scoreLegacy(text, label) {
  return measureLegacy(text, label).score;
}

/** `scoreLegacy` plus `n`, the number of non-ASCII characters it is based on (the evidence), `top`,
 *  how many of them have weight 1 (TOP lists, kana for Shift_JIS), and `kana`, how many are kana. */
function measureLegacy(text, label) {
  const w = weightTable(label);
  let sum = 0;
  let n = 0;
  let top = 0;
  let kana = 0;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) continue;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < len) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        sum += 0.02; // astral (GB18030 four-byte): never a frequent character
        i++;
      } else sum += w[c];
    } else {
      sum += w[c];
      if (w[c] >= 1) top++;
      if (c >= 0x3041 && c <= 0x30ff) kana++;
    }
    if (++n >= SCORE_SAMPLE_CHARS) break;
  }
  return { score: n ? sum / n : 0, n, top, kana };
}

function charWeight(label, ch, cp, table) {
  const kana = cp >= 0x3041 && cp <= 0x30ff;
  if (label === 'euc-kr') {
    if (TOP_HANGUL.has(ch)) return 1;
  } else if (TOP_HAN.has(ch)) return 1;
  if (label === 'shift_jis' && kana) return 1;
  const bytes = table.get(ch);
  const single = !!bytes && bytes.length === 1;
  const code = !bytes ? -1 : bytes.length === 2 ? (bytes[0] << 8) | bytes[1] : bytes[0];
  const inRange = (lo, hi) => code >= lo && code <= hi && (code & 0xff) >= (lo & 0xff) && (code & 0xff) <= (hi & 0xff);
  switch (label) {
    case 'gbk':
      if (inRange(0xb0a1, 0xd7fe)) return 0.4; // GB2312 level 1
      if (inRange(0xd8a1, 0xf7fe)) return 0.2; // GB2312 level 2
      if (inRange(0xa1a1, 0xa3fe)) return 0.5; // CJK punctuation, full-width forms
      return 0.02;
    case 'big5':
      if (code >= 0xa140 && code <= 0xa3bf) return 0.5; // punctuation
      if (code >= 0xa440 && code <= 0xc67e) return 0.4; // level 1
      if (code >= 0xc940 && code <= 0xf9d5) return 0.2; // level 2
      return 0.02;
    case 'shift_jis':
      if (single) return 0.1; // half-width katakana: what GBK bytes look like through Shift_JIS
      if (code >= 0x8140 && code <= 0x81ff) return 0.5; // punctuation
      if (code >= 0x889f && code <= 0x9872) return 0.4; // JIS level 1 kanji
      if (code >= 0x989f && code <= 0xeaa4) return 0.2; // JIS level 2 kanji
      return 0.02;
    case 'euc-kr':
      if (cp >= 0xac00 && cp <= 0xd7a3 && inRange(0xb0a1, 0xc8fe)) return 0.4; // KS X 1001 Hangul
      if (inRange(0xa1a1, 0xa1fe)) return 0.5; // punctuation
      if (inRange(0xa3a1, 0xa3fe)) return 0.3; // full-width forms
      if (inRange(0xcaa1, 0xfdfe)) return 0.1; // Hanja
      return 0.02;
    default:
      return 0.02;
  }
}

// ---------------------------------------------------------------- encoding

/** char → bytes tables, built lazily (once per label) by decoding every 1- and 2-byte sequence. */
const encoderTables = new Map();

/** The WHATWG encoder table of `label` (S4 (e)); `whatwg` = false: 0.1.0's table (the first pair that
 *  decodes to a character), which differs only for Big5 and Shift_JIS (see BIG5_LAST_POINTER). */
export function legacyEncoderTable(label, whatwg = true) {
  const key = whatwg ? label : `${label} 0.1.0`;
  const cached = encoderTables.get(key);
  if (cached) return cached;
  const table = new Map();
  // Non-fatal on purpose: an invalid sequence yields U+FFFD, which is cheaper to test for than 65k
  // thrown exceptions.
  const dec = new TextDecoder(label);
  const one = new Uint8Array(1);
  for (let b = 0; b <= 0xff; b++) {
    one[0] = b;
    const s = dec.decode(one);
    if (s.length === 1 && s !== '\uFFFD' && !table.has(s)) table.set(s, [b]);
  }
  // Every 2-byte sequence in ONE decode call, each followed by LF: no legacy decoder takes LF into a
  // multi-byte sequence (an error hands it back), so the pieces between LFs are exactly what each
  // pair decodes to on its own — same table as 32 768 separate calls, in a few milliseconds.
  // (A pair whose second byte is LF never decodes to one character.)
  const pairs = new Uint8Array(128 * 255 * 3);
  let k = 0;
  for (let hi = 0x80; hi <= 0xff; hi++) {
    for (let lo = 0x00; lo <= 0xff; lo++) {
      if (lo === 0x0a) continue;
      pairs[k++] = hi;
      pairs[k++] = lo;
      pairs[k++] = 0x0a;
    }
  }
  const pieces = dec.decode(pairs).split('\n');
  let p = 0;
  for (let hi = 0x80; hi <= 0xff; hi++) {
    for (let lo = 0x00; lo <= 0xff; lo++) {
      if (lo === 0x0a) continue;
      const s = pieces[p++];
      if (s.length !== 1 || s === '\uFFFD' || (whatwg && skipsLead(label, hi))) continue;
      if (!table.has(s) || (whatwg && label === 'big5' && BIG5_LAST_POINTER.has(s))) table.set(s, [hi, lo]);
    }
  }
  encoderTables.set(key, table);
  return table;
}

/**
 * The table a save of this file uses (stored in the file's meta, `table`; undefined = the WHATWG
 * table). S4 (e) as amended (H23): the WHATWG table only when encoding the text with it gives the
 * file's bytes back and 0.1.0's table does not (e.g. Big5 with 十 as A451, CP932 bytes with ⅰ as
 * FA40); in every other case, also when neither table gives the bytes back, 0.1.0's table, so a save
 * never changes more bytes than 0.1.1's save of the same file. "Gives the bytes back" is the save
 * itself: a file whose line endings the save normalises (K10: mixed, CR only) is given back by neither
 * table, so it gets 0.1.0's. For every label but Big5 and Shift_JIS the two tables are one table
 * (legacyEncoderTable builds them by the same code), so no table is stored.
 */
export function saveTableOf(text, encoding, buf) {
  if (encoding !== 'big5' && encoding !== 'shift_jis') return undefined;
  if (applyEol(text, eolOf(text)) === text && encodesBack(text, encoding, buf) && !encodesBack(text, encoding, buf, false)) return undefined;
  return '0.1.0';
}

/** S4 (e): the tables follow the WHATWG encoders. Iterating the pairs in byte order is iterating the
 *  index pointers in order, so "the first pair that decodes to a character" is WHATWG's index
 *  pointer \u2014 except that the Big5 encoder never writes a lead byte below 0xA1 (the HKSCS rows) and
 *  takes the LAST pointer for these six code points (\u5341 is A451, not A2CC; \u5345 A4CA, not A2CE), and the
 *  Shift_JIS encoder never writes pointers 8272\u20138835 (lead bytes ED\u2013EF, the NEC-selected IBM
 *  extensions: \u2170 is FA40, not EEEF). GBK (\u20AC = 80, U+3000 = A1A1) and EUC-KR already matched. */
const BIG5_LAST_POINTER = new Set(['\u2550', '\u255E', '\u2561', '\u256A', '\u5341', '\u5345']);
const skipsLead = (label, hi) => (label === 'big5' && hi < 0xa1) || (label === 'shift_jis' && hi >= 0xed && hi <= 0xef);

/** Per label, the charWeight of every BMP code point (Float32Array(65536)); astral: 0.02. */
const weightTables = new Map();

function weightTable(label) {
  const cached = weightTables.get(label);
  if (cached) return cached;
  const table = legacyEncoderTable(label);
  const w = new Float32Array(0x10000).fill(0.02);
  const set = (ch) => {
    const cp = ch.codePointAt(0);
    if (cp < 0x10000) w[cp] = charWeight(label, ch, cp, table);
  };
  for (const ch of label === 'euc-kr' ? TOP_HANGUL : TOP_HAN) set(ch);
  if (label === 'shift_jis') for (let cp = 0x3041; cp <= 0x30ff; cp++) set(String.fromCharCode(cp));
  for (const ch of table.keys()) set(ch);
  weightTables.set(label, w);
  return w;
}

/** Applies the file's line ending to an (always LF) editor text. */
export function applyEol(text, eol) {
  return eol === 'crlf' ? text.replace(/\r\n|\r|\n/g, '\r\n') : text.replace(/\r\n|\r/g, '\n');
}

export function eolOf(text) {
  return text.includes('\r\n') ? 'crlf' : 'lf';
}

/** Text → the bytes that go on disk, in the file's own encoding. Throws EIO when a character cannot
 *  be represented in a legacy encoding (the renderer then offers 另存为). */
export function encodeText(text, meta = {}) {
  const encoding = meta.encoding || 'utf-8';
  const withEol = applyEol(text, meta.eol || 'lf');
  if (encoding === 'utf-8') {
    const body = Buffer.from(withEol, 'utf8');
    return meta.bom ? Buffer.concat([UTF8_BOM, body]) : body;
  }
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const le = Buffer.from(withEol, 'utf16le');
    const body = encoding === 'utf-16le' ? le : le.swap16();
    const bom = encoding === 'utf-16le' ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xfe, 0xff]);
    return meta.bom ? Buffer.concat([bom, body]) : body;
  }
  const table = legacyEncoderTable(encoding, meta.table !== '0.1.0');
  // A character the WHATWG table lacks (Big5: the HKSCS rows, lead bytes below A1) is written as 0.1.1
  // wrote it, with 0.1.0's table, instead of refusing a save 0.1.1 made (S4 (e) as amended).
  const fallback = meta.table !== '0.1.0' && (encoding === 'big5' || encoding === 'shift_jis') ? legacyEncoderTable(encoding, false) : null;
  const out = [];
  for (const ch of withEol) {
    const bytes = table.get(ch) || fallback?.get(ch);
    if (!bytes) throw ioError(unrepresentableMessage(encoding, ch));
    for (const b of bytes) out.push(b);
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------- per-file memory

const META_LIMIT = 200;

/**
 * What the shell remembers about every file it has read or written, keyed by RESOLVED path so a
 * symlink and its target share one entry. Bounded (insertion-ordered LRU) — a long session must not
 * grow a map of every file ever opened.
 */
export function createFileMetaStore(limit = META_LIMIT) {
  const map = new Map();
  return {
    get(key) {
      const v = map.get(key);
      if (v !== undefined) {
        map.delete(key);
        map.set(key, v);
      }
      return v;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > limit) map.delete(map.keys().next().value);
    },
    delete: (key) => map.delete(key),
    get size() {
      return map.size;
    },
  };
}

/** The path the bytes really live at: a symlink resolves to its target, everything else to itself. */
export async function resolvePath(p) {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

// ---------------------------------------------------------------- read / write

/**
 * Reads one document. `path` in the result is the path the caller asked for (the symlink, so the
 * title and the recent list show the name the user clicked); the fidelity memory is keyed by the
 * resolved path.
 */
export async function readFileInfo(p, store) {
  const real = await resolvePath(p);
  const pre = await fsp.stat(real);
  if (pre.isDirectory()) throw ioError('这是一个文件夹，不是文件', 'EISDIR');
  // A FIFO named note.md used to block the read forever — and with it every later open, because the
  // renderer opens documents one after another. Refuse anything that is not a regular file, and open
  // non-blocking so a path swapped for a FIFO between stat and open cannot hang either.
  if (!pre.isFile()) throw ioError(NOT_REGULAR_MESSAGE);
  let handle = null;
  let st;
  let buf;
  try {
    handle = await fsp.open(real, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    st = await handle.stat();
    if (!st.isFile()) throw ioError(NOT_REGULAR_MESSAGE);
    buf = await handle.readFile();
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  const { text, encoding, bom, replaced } = decodeBuffer(buf);
  const eol = eolOf(text);
  const table = replaced ? undefined : saveTableOf(text, encoding, buf);
  store?.set(real, { encoding, bom, eol, ...(table ? { table } : {}), mtimeMs: st.mtimeMs, size: st.size });
  const info = { path: p, name: path.basename(p), text, lastModified: st.mtimeMs, encoding };
  // Non-contractual extra (like `encoding`): invalid UTF-8 sequences shown as U+FFFD. Main warns.
  if (replaced) info.replacedBytes = replaced;
  return info;
}

/**
 * Writes `text` back to `p` in the file's own encoding and line endings.
 *
 * Atomic (temp file + rename) for an ordinary file; a hard-linked file (nlink > 1) is written in
 * place instead, because a rename would give this name a brand-new inode and silently disconnect
 * every other name of the same file. The in-place path is not atomic — that is the price of keeping
 * the link, and it is what every macOS editor does.
 */
export async function writeFileAtomic(p, text, store) {
  const real = await resolvePath(p);
  const known = store?.get(real);
  let st = null;
  try {
    st = await fsp.stat(real);
  } catch {
    st = null; // the file was removed since it was opened: recreate it
  }
  // Someone else wrote to the file after we read it. Refuse once, and remember the new mtime so an
  // explicit retry (the 覆盖保存 action of the renderer's toast) goes through.
  if (st && known && known.mtimeMs !== undefined && Math.abs(st.mtimeMs - known.mtimeMs) > 2) {
    store.set(real, { ...known, mtimeMs: st.mtimeMs, size: st.size });
    throw conflictError();
  }
  const meta = known || { encoding: 'utf-8', bom: false, eol: eolOf(text) };
  const data = encodeText(text, meta);

  if (st && st.nlink > 1) {
    let handle = null;
    try {
      handle = await fsp.open(real, 'r+');
      await handle.write(data, 0, data.length, 0);
      await handle.truncate(data.length);
      await handle.sync();
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  } else {
    const dir = path.dirname(real);
    const tmp = path.join(dir, `.${path.basename(real)}.mdr-${process.pid}-${Date.now().toString(36)}.tmp`);
    const mode = st ? st.mode : 0o644;
    let handle = null;
    try {
      handle = await fsp.open(tmp, 'w', mode);
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      handle = null;
      await fsp.rename(tmp, real);
    } catch (err) {
      if (handle) await handle.close().catch(() => {});
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  const after = await fsp.stat(real);
  store?.set(real, { ...meta, mtimeMs: after.mtimeMs, size: after.size });
  return { lastModified: after.mtimeMs };
}

/**
 * A path the user picked in the save panel: whatever it held before, the document is about to be
 * written there. Drop a stale entry (encoding of the file being replaced, another program's mtime)
 * but carry the CURRENT document's line endings over, so 另存为 of a Windows file stays Windows.
 */
export async function adoptSaveTarget(target, currentPath, store) {
  if (!store) return;
  const real = await resolvePath(target);
  const from = currentPath ? store.get(await resolvePath(currentPath)) : undefined;
  store.set(real, { encoding: 'utf-8', bom: false, eol: from?.eol || 'lf', mtimeMs: undefined, size: undefined });
}
