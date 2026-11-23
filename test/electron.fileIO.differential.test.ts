// Decision S2 (docs/CONTRACT.md §11, "Fix-round decisions (lead, 2026-11-20)"): the encoding detection
// of electron/fileIO.mjs may ship only when it is no worse than 0.1.0 on everything 0.1.0 got right.
//
// The reference is test/fixtures/fileIO-0.1.0.mjs: a byte-for-byte copy (cp, never retyped — it holds
// raw control bytes inside a regular expression) of electron/fileIO.mjs from the installed 0.1.0
// app.asar (release/_installed-asar/electron/fileIO.mjs; the 0.1.1 hotfix shipped the same decoder).
// sha256 af116b22a2a543398a5fa068f02d15cd4dd09534cd7f4aa7709bdb08009c84b7.
//
// Every input below is built from a KNOWN text in a KNOWN encoding, so the truth is known. Decision S4
// (c) (2026-11-20): decodeBuffer is 0.1.0's answer plus enumerated overrides, with one switch. Four
// assertions over every input of every corpus, zero exceptions:
//   (i)   whenever 0.1.0 returns the true text with the true encoding label (and BOM flag), the new
//         decoder returns the same;
//   (ii)  the new decoder never refuses bytes 0.1.0 opened, except by the binary rule;
//   (iii) a reading without replacements saves byte-exact (encodeText with the meta readFileInfo
//         stores) whenever 0.1.0's did, and always when an override chose it (K10 line endings aside);
//   (iv)  decodeBuffer(bytes, false) — every override off — equals the fixture (text, label, BOM flag;
//         a throw matches a throw).
// Decision S4 (f) (H7, 2026-11-20): 0.2.0 ships with DECODER_OVERRIDES off. (i)–(iii) therefore run
// against the DORMANT overrides, passed explicitly (`decodeBuffer(bytes, true)`), and two more checks
// pin what ships:
//   (v)   decodeBuffer(bytes) — the default — equals the fixture (text, label, BOM flag; throw = throw);
//   (vi)  S4 (e) as amended (H23): the default reading's save (encodeText with the meta readFileInfo
//         stores, saveTableOf included), unmodified and with one ASCII character appended, changes no
//         more bytes of the original than the fixture's save does (a refusal counts as infinitely
//         many; fewer is allowed and counted).
// Generation is deterministic (mulberry32, fixed seeds); where a corpus is sampled, the sample size is
// fixed and printed (stderr, after the run).
//
// Chinese sources: the repository's own README.md and docs/*.md (Simplified Chinese, technical) plus
// the general-vocabulary prose below (written for this test), plus random GB2312 level-1 strings.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as neu from '../electron/fileIO.mjs';
import * as old from './fixtures/fileIO-0.1.0.mjs';
// The stage-2a verifier's generators (read-only here; they encode with the 0.1.0 tables).
import {
  GEN as GEN_CORPUS,
  HANT as HANT_CORPUS,
  LATIN as LATIN_CORPUS,
  encode as encodeCorpus,
  int as cint,
  pick as cpick,
  rng as crng,
  withEol as withEolCorpus,
} from '../bench/verify/v2-dec-corpus.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Decoded = { text: string; encoding: string; bom: boolean; replaced?: number };
const decodeOld = (old as any).decodeBuffer as (b: Buffer) => Decoded;
const decodeNew = (neu as any).decodeBuffer as (b: Buffer, overrides?: boolean) => Decoded;
const tableOf = (old as any).legacyEncoderTable as (label: string) => Map<string, number[]>;

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- deterministic generation

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const intIn = (rnd: () => number, lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));

/** Text → bytes in a legacy encoding through the 0.1.0 encoder tables (1- and 2-byte sequences);
 *  null when a character is not representable that way. */
function encodeLegacy(text: string, label: string): Buffer | null {
  const table = tableOf(label);
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else {
      const b = table.get(ch);
      if (!b) return null;
      out.push(...b);
    }
  }
  return Buffer.from(out);
}
const iconv = (text: string, to: string): Buffer =>
  execFileSync('/usr/bin/iconv', ['-f', 'UTF-8', '-t', to], { input: Buffer.from(text, 'utf8') });

// ---------------------------------------------------------------- source texts (written for this test)

const ZH_PROSE = [
  '清晨的雨下得不大，街角的早点铺已经排起了长队。老板一边揉面一边和熟客聊天，说今年的小麦收成不错，面粉价格也降了一些。',
  '我们沿着河岸往北走，柳树刚刚发芽，水面上浮着几只野鸭。远处的山被一层薄雾遮住，只露出模糊的轮廓。',
  '奶奶做的红烧肉总是先用冰糖炒出糖色，再加酱油和黄酒慢慢炖上两个小时，出锅前撒一把葱花，香味能飘满整个院子。',
  '这座城市在唐代就是重要的商业中心，丝绸、茶叶和瓷器从这里运往四面八方。如今老城墙只剩下东南角的一段，成了市民散步的好去处。',
  '比赛进入最后五分钟，主队还落后两分。教练叫了暂停，在白板上画了一个简单的战术，队员们点点头，重新回到场上。',
  '医生建议他每天保持八小时睡眠，少喝咖啡，多吃新鲜蔬菜和水果，并且坚持散步半小时。他照做了三个月，体检报告上的指标果然好了很多。',
  '经济学家认为，消费回暖需要时间，收入预期稳定以后，家庭才愿意增加开支。政府近期出台了几项支持中小企业的措施，效果还有待观察。',
  '妹妹考上了外地的大学，临走前把自己的书一本一本地装进纸箱，又在每本书的扉页上写下买书的日期和地点。',
  '秋天的稻田一片金黄，农民们趁着晴天抢收，打谷机的声音从早响到晚。晚饭时大家围坐在一起，谈论着明年要不要多种一季油菜。',
  '图书馆的阅览室很安静，只听得见翻书的声音。窗外的银杏叶落了一地，有个小孩蹲在树下，认真地挑选最完整的那一片。',
  '他第一次独自出国旅行，在火车站迷了路，一位热心的老人用简单的英语和手势把他带到了正确的站台，还送给他一张地图。',
  '音乐会结束时，全场观众起立鼓掌，指挥转身向乐团致意。那首交响曲的最后一个乐章节奏明快，让人忍不住跟着打拍子。',
  '春节前夕，家家户户贴春联、挂灯笼，孩子们穿上新衣服跑来跑去。厨房里蒸着馒头和年糕，空气里满是甜甜的米香。',
  '科学家在南极冰层下发现了一种耐寒的微生物，它能在零下二十度的环境中缓慢生长。这一发现或许有助于研究生命起源的问题。',
  '小王把旧自行车擦得干干净净，换了新的轮胎和刹车线，准备骑着它去郊外看油菜花。朋友们笑他太节省，他却说骑车最自在。',
  '历史老师讲到郑和下西洋时，特别提到船队规模之大、航程之远，在当时的世界上都十分罕见。同学们听得入了迷，下课铃响了都没发觉。',
  '这家小店只卖三种面：牛肉面、炸酱面和阳春面。汤底每天凌晨熬制，卖完就关门，所以想吃的人往往要早点来。',
  '夜里起了大风，阳台上的花盆被吹倒了两个。第二天早上，邻居帮忙把泥土重新装好，还分给我们几株他自己培育的月季。',
  '公司今年招聘了二十多位应届毕业生，人事部门为他们安排了为期一个月的培训，内容包括业务流程、团队合作和沟通技巧。',
  '湖边的茶馆生意兴隆，老人们一边喝茶一边下象棋，旁边围了一圈看热闹的人，不时有人忍不住出主意，惹得棋手直摆手。',
];
const HANT_PROSE = [
  '早上的雨下得不大，街口的早餐店已經排起了長隊。老闆一邊揉麵一邊和熟客聊天，說今年的小麥收成不錯，麵粉價格也降了一些。',
  '我們沿著河岸往北走，柳樹剛剛發芽，水面上浮著幾隻野鴨。遠處的山被一層薄霧遮住，只露出模糊的輪廓。',
  '這座城市在唐代就是重要的商業中心，絲綢、茶葉和瓷器從這裡運往四面八方。如今老城牆只剩下東南角的一段，成了市民散步的好去處。',
  '醫生建議他每天保持八小時睡眠，少喝咖啡，多吃新鮮蔬菜和水果，並且堅持散步半小時。他照做了三個月，體檢報告上的指標果然好了很多。',
  '圖書館的閱覽室很安靜，只聽得見翻書的聲音。窗外的銀杏葉落了一地，有個小孩蹲在樹下，認真地挑選最完整的那一片。',
  '音樂會結束時，全場觀眾起立鼓掌，指揮轉身向樂團致意。那首交響曲的最後一個樂章節奏明快，讓人忍不住跟著打拍子。',
];
const JA_PROSE = [
  '朝の雨はそれほど強くなく、角のパン屋にはもう行列ができていました。店主は生地をこねながら、常連客と今年の小麦の出来について話していました。',
  '私たちは川沿いを北へ歩きました。柳の木はちょうど芽を出したばかりで、水面には何羽かの鴨が浮かんでいました。',
  '祖母の作る煮物は、まず出汁をしっかり取ってから野菜と鶏肉を入れ、弱火で一時間ほど煮込みます。台所にはいつも優しい香りが広がっていました。',
  '図書館の閲覧室はとても静かで、ページをめくる音しか聞こえません。窓の外では銀杏の葉が地面一面に散っていました。',
  '試合は残り五分、ホームチームはまだ二点負けていました。監督はタイムを取り、ホワイトボードに簡単な作戦を描きました。',
  '彼は初めて一人で海外旅行に出かけ、駅で道に迷いましたが、親切な老人が身振り手振りで正しいホームまで案内してくれました。',
];
const KO_PROSE = [
  '아침 비는 그리 세지 않았고, 길모퉁이 빵집 앞에는 벌써 줄이 길게 늘어서 있었다. 주인은 반죽을 하면서 단골손님과 올해 밀 농사 이야기를 나누었다.',
  '우리는 강을 따라 북쪽으로 걸었다. 버드나무에는 막 새싹이 돋았고, 물 위에는 오리 몇 마리가 떠 있었다.',
  '할머니가 만드시는 된장찌개는 먼저 멸치로 국물을 내고, 두부와 애호박을 넣어 천천히 끓인다. 부엌에는 언제나 구수한 냄새가 가득했다.',
  '도서관 열람실은 아주 조용해서 책장 넘기는 소리만 들렸다. 창밖에는 은행잎이 땅 위에 가득 떨어져 있었다.',
  '경기는 오 분밖에 남지 않았고, 홈팀은 아직 두 점 뒤지고 있었다. 감독은 작전 시간을 요청하고 칠판에 간단한 전술을 그렸다.',
  '그는 처음으로 혼자 해외여행을 떠났다가 기차역에서 길을 잃었지만, 친절한 노인이 손짓으로 올바른 승강장까지 데려다주었다.',
];
const LATIN_PROSE = [
  'Le matin, la pluie était légère et la boulangerie du coin avait déjà une longue file d’attente.',
  'Nous avons marché le long de la rivière vers le nord ; les saules commençaient à peine à bourgeonner.',
  'Ma grand-mère préparait toujours un gâteau aux pommes le dimanche, et toute la maison sentait la cannelle.',
  'Après le concert, le public s’est levé pour applaudir, et le chef d’orchestre a salué les musiciens.',
  'Il était déçu de ne pas être sélectionné, mais il a continué à s’entraîner chaque soir après l’école.',
  'Am Morgen regnete es nur leicht, und vor der Bäckerei an der Ecke stand schon eine lange Schlange.',
  'Wir gingen am Fluss entlang nach Norden; die Weiden trieben gerade die ersten Knospen aus.',
  'Die Großmutter kochte sonntags immer Gemüsesuppe, und im ganzen Haus duftete es nach frischen Kräutern.',
  'Nach dem Konzert erhoben sich die Zuhörer, und der Dirigent verbeugte sich vor dem Orchester.',
  'Für die Prüfung übte sie täglich zwei Stunden, obwohl ihr die schwierigen Übungen große Mühe machten.',
  'Por la mañana llovía poco y la panadería de la esquina ya tenía una larga fila de clientes.',
  'Caminamos junto al río hacia el norte; los sauces apenas empezaban a echar brotes.',
  '¿Quién preparó la cena de anoche? Mi abuela cocinó un guiso de garbanzos con pimentón y azafrán.',
  'Después del concierto, el público se puso de pie y el director saludó a la orquesta con una sonrisa.',
  '¡Qué sorpresa! El niño encontró una moneda antigua en el jardín, junto al árbol más pequeño.',
];
const ASCII_LINES = [
  '# Release notes', '## Usage', 'This is a plain paragraph of English text in Markdown.', '- item one', '- item two',
  '1. first step', '```js', 'const x = 1 + 2;', '```', '> a quote', '| a | b |', '|---|---|', '| 1 | 2 |',
  'See [the docs](https://example.com/docs) for **details** and `code`.', '',
];
const MIXED_SCRIPTS = [
  'Привет, мир! Это проверка.', 'Γειά σου κόσμε.', 'مرحبا بالعالم', 'नमस्ते दुनिया', 'こんにちは世界', '안녕하세요 세계',
  'Ünïcödé façade naïve café', 'Ελληνικά και English', 'שלום עולם', 'ไทย ภาษา', 'Tiếng Việt có dấu',
];
const EMOJI = ['😀', '🎉', '👍🏽', '🇨🇳', '𠀀', '𝄞', '🧪', '👨‍👩‍👧', '✅', '©', '™', '€', '—', '…'];

/** Simplified-Chinese Han characters (GBK-encodable, 2 bytes) of the repository docs, in order. */
function docsHan(): string[] {
  const table = tableOf('gbk');
  let src = '';
  const files = ['README.md', ...fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).sort().map((f) => `docs/${f}`)];
  for (const f of files) {
    try {
      src += fs.readFileSync(path.join(ROOT, f), 'utf8');
    } catch {
      /* missing file: skipped */
    }
  }
  return [...src].filter((c) => {
    const cp = c.codePointAt(0)!;
    return cp >= 0x4e00 && cp <= 0x9fff && table.get(c)?.length === 2;
  });
}

// ---------------------------------------------------------------- the differential

/** `text: null` = no reading is the truth (a file cut inside a character, an encoding neither version
 *  supports): the case only feeds checks (ii)–(iv). */
type Case = { name: string; bytes: Buffer; text: string | null; encoding: string; bom: boolean };
type Tally = {
  total: number;
  oldRight: number;
  newRight: number;
  /** (i) 0.1.0 returned the true text (label, BOM flag) and the new decoder does not. */
  regressions: string[];
  /** (ii) 0.1.0 opened the bytes and the new decoder refuses them, other than by the binary rule. */
  refusals: string[];
  /** (iii) read without replacements, and the save is not byte-exact although 0.1.0's was, or
   *  although an override (not 0.1.0's answer) chose the reading. */
  roundTrips: string[];
  /** (iv) decodeBuffer(bytes, false) differs from the fixture (text, label, BOM flag, or a throw). */
  switchOff: string[];
  /** G26 / S4 (a): a reading with U+FFFD replacements in any encoding but UTF-8 (lenient GBK). */
  nonUtf8Replaced: string[];
  /** Files whose save keeps 0.1.0's table (electron/fileIO.mjs saveTableOf: 0.1.0's own Big5 /
   *  Shift_JIS answer that only 0.1.0's table gives back). */
  table010: number;
  /** How many inputs an override answered (the new reading differs from 0.1.0's). */
  overridden: number;
  /** (v) S4 (f): decodeBuffer(bytes) — the default — differs from the fixture. */
  defaultDiff: string[];
  /** (vi) the default reading's save changes more bytes than the fixture's (unmodified or +x). */
  worseSave: string[];
  /** (vi) … changes fewer (allowed: the WHATWG table gives the bytes back, 0.1.0's does not). */
  fewerSave: number;
};
/** Bytes of `a` that differ from `b` (position by position, plus the length difference). */
const changedBytes = (a: Buffer, b: Buffer) => {
  let n = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n;
};

const encodeOld = (old as any).encodeText as (text: string, meta: object) => Buffer;
const encodeNew = (neu as any).encodeText as (text: string, meta: object) => Buffer;
const eolOfNew = (neu as any).eolOf as (text: string) => string;
/** The binary rule's measure (electron/fileIO.mjs HARD_CONTROL_RE_G, hardControlShare). */
const HARD_CONTROL_RE_G = /[\u0000-\u0006\u000E-\u001A\u001C-\u001F\u007F]/g;
const hardShare = (s: string) => {
  const p = s.length > 400_000 ? s.slice(0, 400_000) : s;
  return p.length ? (p.match(HARD_CONTROL_RE_G)?.length ?? 0) / p.length : 0;
};
/** Only LF or only CRLF line endings (K10: a save normalises mixed / CR-only endings). */
const pureEol = (s: string) => !/\r(?!\n)/.test(s) && (!s.includes('\r\n') || !/(^|[^\r])\n/.test(s));
const saveTableOf = (neu as any).saveTableOf as (text: string, encoding: string, buf: Buffer) => string | undefined;
/** What a save writes for an unedited reading: encodeText with the meta readFileInfo stores. */
function decodesBack(enc: (t: string, m: object) => Buffer, d: Decoded, bytes: Buffer, table?: string): boolean {
  try {
    return enc(d.text, { encoding: d.encoding, bom: d.bom, eol: eolOfNew(d.text), ...(table ? { table } : {}) }).equals(bytes);
  } catch {
    return false;
  }
}
const short = (s: string) => JSON.stringify(s.slice(0, 40));
const push = (list: string[], s: string) => list.push(list.length < 12 ? s : '…');

function runCases(cases: Iterable<Case>): Tally {
  const t: Tally = { total: 0, oldRight: 0, newRight: 0, regressions: [], refusals: [], roundTrips: [], switchOff: [], nonUtf8Replaced: [], table010: 0, overridden: 0, defaultDiff: [], worseSave: [], fewerSave: 0 };
  for (const c of cases) {
    t.total++;
    let o: Decoded | null = null;
    let n: Decoded | null = null;
    let oErr = '';
    try {
      o = decodeOld(c.bytes);
    } catch (e) {
      oErr = (e as Error).message;
    }
    try {
      n = decodeNew(c.bytes, true); // S4 (f): the dormant overrides, passed explicitly
    } catch {
      n = null;
    }
    const ascii = c.text !== null && !/[^\x00-\x7f]/.test(c.text);
    const right = (d: Decoded | null) => !!d && c.text !== null && d.text === c.text && d.bom === c.bom && (d.encoding === c.encoding || (ascii && d.encoding === 'utf-8'));
    const got = n ? `${n.encoding}${n.replaced ? `+R${n.replaced}` : ''} ${short(n.text)}` : 'THROW';
    // (i)
    if (right(n)) t.newRight++;
    if (right(o)) {
      t.oldRight++;
      if (!right(n)) push(t.regressions, `${c.name}: ${short(c.text!)} → ${got}`);
    }
    // (ii)
    if (o && !n && !(o.encoding === 'utf-8' && !o.bom && hardShare(o.text) > 0.5)) push(t.refusals, `${c.name}: 0.1.0 ${o.encoding} → THROW`);
    if (n && n.replaced && n.encoding !== 'utf-8') push(t.nonUtf8Replaced, `${c.name}: ${got}`);
    // (iii)
    const overridden = !!n && (!o || o.encoding !== n.encoding || o.text !== n.text || o.bom !== n.bom);
    if (overridden) t.overridden++;
    const table = n && !n.replaced ? saveTableOf(n.text, n.encoding, c.bytes) : undefined;
    if (table) t.table010++;
    if (n && !n.replaced && !decodesBack(encodeNew, n, c.bytes, table)) {
      const oldRt = !!o && decodesBack(encodeOld, o, c.bytes);
      if (oldRt && !overridden) push(t.roundTrips, `${c.name}: ${n.encoding} save not byte-exact (0.1.0's was)`);
      else if (overridden && (oldRt || pureEol(n.text))) push(t.roundTrips, `${c.name}: override ${o ? o.encoding : 'REFUSED'} → ${n.encoding}, save not byte-exact`);
    }
    // (iv)
    let off: Decoded | null = null;
    let offErr = '';
    try {
      off = decodeNew(c.bytes, false);
    } catch (e) {
      offErr = (e as Error).message;
    }
    const same = o && off ? JSON.stringify(off) === JSON.stringify({ text: o.text, encoding: o.encoding, bom: o.bom }) : !o && !off && offErr === oErr;
    if (!same) push(t.switchOff, `${c.name}: 0.1.0 ${o ? o.encoding : 'THROW'} / switch off ${off ? off.encoding : 'THROW'}`);
    // (v)
    let def: Decoded | null = null;
    let defErr = '';
    try {
      def = decodeNew(c.bytes);
    } catch (e) {
      defErr = (e as Error).message;
    }
    const sameDef = o && def ? JSON.stringify(def) === JSON.stringify({ text: o.text, encoding: o.encoding, bom: o.bom }) : !o && !def && defErr === oErr;
    if (!sameDef) push(t.defaultDiff, `${c.name}: 0.1.0 ${o ? o.encoding : 'THROW'} / default ${def ? def.encoding : 'THROW'}`);
    // (vi)
    if (o && def && sameDef) {
      const tableDef = saveTableOf(def.text, def.encoding, c.bytes);
      for (const add of ['', 'x']) {
        const want = Buffer.concat([c.bytes, Buffer.from(add)]);
        let a = Infinity;
        let b = Infinity;
        try {
          a = changedBytes(encodeNew(def.text + add, { encoding: def.encoding, bom: def.bom, eol: eolOfNew(def.text), ...(tableDef ? { table: tableDef } : {}) }), want);
        } catch { /* a refusal */ }
        try {
          b = changedBytes(encodeOld(o.text + add, { encoding: o.encoding, bom: o.bom, eol: (old as any).eolOf(o.text) }), want);
        } catch { /* a refusal */ }
        if (a > b) push(t.worseSave, `${c.name}${add ? ' +x' : ''}: ${def.encoding} save changes ${a} bytes, 0.1.0's ${b}`);
        else if (a < b) t.fewerSave++;
      }
    }
  }
  return t;
}

const report: string[] = [];
/** R3D_DUMP=<dir>: every input of check() is also written there (one NDJSON file per corpus, lines
 *  {"fam","b64"}), so bench/electron/r3-d-parity.mjs runs the same inputs inside Electron's runtime. */
const DUMP = process.env.R3D_DUMP || '';
let dumpN = 0;
function check(label: string, cases: Iterable<Case>): Tally {
  if (DUMP) {
    const list = [...cases];
    const fam = label.replace(/\s+/g, ' ').trim();
    fs.writeFileSync(path.join(DUMP, `diff-${String(++dumpN).padStart(3, '0')}.ndjson`), list.map((c) => JSON.stringify({ fam: `diff ${fam}`, b64: c.bytes.toString('base64') })).join('\n') + '\n');
    cases = list;
  }
  const t = runCases(cases);
  report.push(
    `${label.padEnd(46)} cases ${String(t.total).padStart(6)}  0.1.0 right ${String(t.oldRight).padStart(6)}  new right ${String(t.newRight).padStart(6)}`
      + `  overridden ${String(t.overridden).padStart(5)}  (i) ${t.regressions.length} (ii) ${t.refusals.length} (iii) ${t.roundTrips.length} (iv) ${t.switchOff.length}`
      + ` (v) ${t.defaultDiff.length} (vi) ${t.worseSave.length}${t.fewerSave ? ` [fewer bytes changed: ${t.fewerSave}]` : ''}`
      + (t.table010 ? `  [saved with 0.1.0's table: ${t.table010}]` : ''),
  );
  return t;
}
/** The assertions of decision S4 over one corpus ((v) and (vi): S4 (f) and the amended S4 (e)). */
function expectClean(t: Tally): void {
  expect({ regressions: t.regressions, refusals: t.refusals, roundTrips: t.roundTrips, switchOff: t.switchOff, nonUtf8Replaced: t.nonUtf8Replaced, defaultDiff: t.defaultDiff, worseSave: t.worseSave })
    .toEqual({ regressions: [], refusals: [], roundTrips: [], switchOff: [], nonUtf8Replaced: [], defaultDiff: [], worseSave: [] });
}
afterAll(() => {
  // Corpus sizes and results, written straight to stderr (vitest hides console output of passing files).
  fs.writeSync(2, `\nfileIO differential vs 0.1.0\n${report.join('\n')}\n`);
});

// ---------------------------------------------------------------- (a) UTF-8

function* utf8Docs(seed: number, count: number): Generator<string> {
  const rnd = mulberry32(seed);
  const zh = ZH_PROSE.join('');
  for (let i = 0; i < count; i++) {
    const parts: string[] = [];
    const k = intIn(rnd, 1, 12);
    for (let j = 0; j < k; j++) {
      const r = rnd();
      if (r < 0.35) parts.push(pick(rnd, ASCII_LINES));
      else if (r < 0.6) {
        const a = intIn(rnd, 0, zh.length - 1);
        parts.push(zh.slice(a, a + intIn(rnd, 1, 60)));
      } else if (r < 0.75) parts.push(pick(rnd, MIXED_SCRIPTS));
      else if (r < 0.85) parts.push(Array.from({ length: intIn(rnd, 1, 4) }, () => pick(rnd, EMOJI)).join(''));
      else parts.push(pick(rnd, LATIN_PROSE));
    }
    yield parts.join(pick(rnd, ['\n', '\n\n', ' ', '']));
  }
}

function* utf8Plain(): Generator<Case> {
  let i = 0;
  for (const text of utf8Docs(101, 3000)) {
    const v = i++ % 4;
    const t = v === 1 || v === 3 ? text.replace(/\n/g, '\r\n') : text;
    const bom = v >= 2;
    const body = Buffer.from(t, 'utf8');
    yield { name: `utf8#${i}${bom ? '+bom' : ''}${v % 2 ? '+crlf' : ''}`, bytes: bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body, text: t, encoding: 'utf-8', bom };
  }
}

/** Share of byte pairs with a NUL on the side that has more of them (the UTF-16 sniff measure). */
function nulSideShare(b: Buffer): number {
  if (b.length < 2) return 0;
  let even = 0;
  let odd = 0;
  for (let i = 0; i + 1 < b.length; i += 2) {
    if (b[i] === 0) even++;
    else if (b[i + 1] === 0) odd++;
  }
  return Math.max(even, odd) / Math.floor(b.length / 2);
}
let denseNulSkipped = 0;
let majorityNulSkipped = 0;

function* utf8Nuls(): Generator<Case> {
  const rnd = mulberry32(202);
  let i = 0;
  const docs = [...utf8Docs(203, 400)];
  for (const base of docs) {
    i++;
    if (!base) continue;
    const chars = [...base];
    const variants: string[] = [];
    // every k-th character
    const k = pick(rnd, [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 30, 40, 60, 100, 200]);
    variants.push(chars.map((c, j) => ((j + 1) % k === 0 ? `${c}\u0000` : c)).join(''));
    // random positions at a density
    const d = pick(rnd, [0.002, 0.01, 0.03, 0.05, 0.08, 0.12, 0.2]);
    variants.push(chars.map((c) => (rnd() < d ? `\u0000${c}` : c)).join(''));
    // at the start / at the end / a cluster in the middle / zero padding at the end (≤ 25 %)
    variants.push(`\u0000${base}`, `${base}\u0000`, `${base.slice(0, base.length >> 1)}\u0000\u0000\u0000${base.slice(base.length >> 1)}`);
    variants.push(base + '\u0000'.repeat(Math.max(1, Math.floor(chars.length * pick(rnd, [0.05, 0.15, 0.25])))));
    for (const [vi, text] of variants.entries()) {
      const bytes = Buffer.from(text, 'utf8');
      // Decision S2: NULs on one side of ≥ 40 % of the byte pairs is UTF-16 territory, not "sparse".
      if (nulSideShare(bytes) >= 0.4) {
        denseNulSkipped++;
        continue;
      }
      // NULs in more than half of the characters: the binary rule (UTF-32, zero-filled), not sparse.
      const nuls = text.split('\u0000').length - 1;
      if (nuls * 2 > [...text].length) {
        majorityNulSkipped++;
        continue;
      }
      yield { name: `utf8-nul#${i}.${vi}`, bytes, text, encoding: 'utf-8', bom: false };
    }
  }
}

function* utf8Controls(): Generator<Case> {
  const rnd = mulberry32(303);
  const ctl = ['\u001b[31m', '\u001b[0m', '\u001b[2K', '\f', '\u0007', '\b', '\u000b', '\u001b'];
  let i = 0;
  for (const base of utf8Docs(304, 600)) {
    i++;
    const chars = [...base];
    const d = pick(rnd, [0.005, 0.02, 0.05, 0.1, 0.2]);
    const text = chars.map((c) => (rnd() < d ? pick(rnd, ctl) + c : c)).join('');
    yield { name: `utf8-ctl#${i}`, bytes: Buffer.from(text, 'utf8'), text, encoding: 'utf-8', bom: false };
  }
}

function* utf8Short(): Generator<Case> {
  // every 1-byte file of a text character
  const one = [9, 10, 13, 7, 8, 11, 12, 27];
  for (let b = 0x20; b <= 0x7e; b++) one.push(b);
  for (const b of one) yield { name: `utf8-1byte-${b}`, bytes: Buffer.from([b]), text: String.fromCharCode(b), encoding: 'utf-8', bom: false };
  // every 2-byte sequence (U+0080–U+07FF)
  for (let cp = 0x80; cp <= 0x7ff; cp++) {
    const text = String.fromCodePoint(cp);
    yield { name: `utf8-2byte-${cp}`, bytes: Buffer.from(text, 'utf8'), text, encoding: 'utf-8', bom: false };
  }
  // random strings of 1–8 bytes from ASCII, 2-, 3- and 4-byte characters
  const rnd = mulberry32(404);
  const pool = ['a', 'Z', '7', ' ', '\n', '#', '-', '.', 'é', 'ß', 'Ж', 'ü', '中', '文', '的', '一', '、', '。', 'あ', '한', '€', '😀', '𠀀'];
  for (let i = 0; i < 4000; i++) {
    let text = '';
    const max = intIn(rnd, 1, 8);
    for (;;) {
      const c = pick(rnd, pool);
      if (Buffer.byteLength(text + c, 'utf8') > max) break;
      text += c;
    }
    if (!text) continue;
    yield { name: `utf8-short#${i}`, bytes: Buffer.from(text, 'utf8'), text, encoding: 'utf-8', bom: false };
  }
}

// ---------------------------------------------------------------- (b) UTF-16 with BOM

function* utf16Bom(): Generator<Case> {
  let i = 0;
  for (const text of utf8Docs(505, 1500)) {
    i++;
    const le = Buffer.from(text, 'utf16le');
    if (i % 2) yield { name: `utf16le#${i}`, bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), le]), text, encoding: 'utf-16le', bom: true };
    else yield { name: `utf16be#${i}`, bytes: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(le).swap16()]), text, encoding: 'utf-16be', bom: true };
  }
}

// ---------------------------------------------------------------- (c) GBK / GB18030

const HAN_LENGTHS = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 50, 100];
const wrapMd = (s: string) => `# Title\n\nSome plain ASCII text, then: ${s}\n\n- item one\n- item two\n`;

/** All windows when there are at most `max`, else `max` windows at seeded random offsets. */
function windows(chars: string[], L: number, max: number, rnd: () => number): string[] {
  const total = chars.length - L + 1;
  const out: string[] = [];
  if (total <= 0) return out;
  if (total <= max) for (let i = 0; i < total; i++) out.push(chars.slice(i, i + L).join(''));
  else for (let k = 0; k < max; k++) {
    const i = Math.floor(rnd() * total);
    out.push(chars.slice(i, i + L).join(''));
  }
  return out;
}

function* gbkCases(source: string[], tag: string, perLength: number, seed: number): Generator<Case> {
  const rnd = mulberry32(seed);
  for (const L of HAN_LENGTHS) {
    for (const s of windows(source, L, perLength, rnd)) {
      for (const [w, text] of [['bare', s], ['md', wrapMd(s)]] as const) {
        const bytes = encodeLegacy(text, 'gbk');
        if (bytes) yield { name: `${tag}-${w}-L${L}`, bytes, text, encoding: 'gbk', bom: false };
      }
    }
  }
}

/** GB2312 level 1 (rows 0xB0–0xD7, the 3755 most frequent Han characters). */
function gb2312Level1(): string[] {
  const dec = new TextDecoder('gbk');
  const out: string[] = [];
  for (let hi = 0xb0; hi <= 0xd7; hi++) {
    for (let lo = 0xa1; lo <= 0xfe; lo++) {
      if (hi === 0xd7 && lo > 0xf9) continue;
      out.push(dec.decode(Uint8Array.of(hi, lo)));
    }
  }
  return out;
}

// ---------------------------------------------------------------- (d) windows-1252 / Latin-1

function* latinCases(): Generator<Case> {
  const rnd = mulberry32(606);
  let i = 0;
  const texts: string[] = [];
  for (const s of LATIN_PROSE) {
    texts.push(s);
    const words = s.split(' ');
    for (let L = 1; L <= words.length; L++) for (let a = 0; a + L <= words.length; a += Math.max(1, L >> 1)) texts.push(words.slice(a, a + L).join(' '));
  }
  for (let k = 0; k < 300; k++) texts.push(Array.from({ length: intIn(rnd, 2, 6) }, () => pick(rnd, LATIN_PROSE)).join(pick(rnd, [' ', '\n', '\n\n'])));
  for (const t of texts) {
    for (const text of [t, wrapMd(t), `## ${t}\n\n${t}\n`]) {
      const bytes = encodeLegacy(text, 'windows-1252');
      if (!bytes) continue;
      i++;
      yield { name: `latin#${i}`, bytes, text, encoding: 'windows-1252', bom: false };
    }
  }
}

// ---------------------------------------------------------------- (e) Big5 / Shift_JIS / EUC-KR (gains)

function* cjkOtherCases(prose: string[], label: string, seed: number): Generator<Case> {
  const rnd = mulberry32(seed);
  const table = tableOf(label);
  const chars = [...prose.join('\n')].filter((c) => c.codePointAt(0)! < 0x80 || table.has(c));
  for (const L of [1, 2, 3, 5, 8, 12, 16, 20, 30, 50, 100, 200]) {
    for (const s of windows(chars, L, 120, rnd)) {
      for (const text of [s, wrapMd(s)]) {
        const bytes = encodeLegacy(text, label);
        if (bytes) yield { name: `${label}-L${L}`, bytes, text, encoding: label, bom: false };
      }
    }
  }
}

// ---------------------------------------------------------------- tests

describe('decodeBuffer — differential against 0.1.0 (decision S2)', () => {
  it('the encoder tables agree with /usr/bin/iconv (spot check)', () => {
    expect(encodeLegacy(ZH_PROSE[0], 'gbk')!.equals(iconv(ZH_PROSE[0], 'GBK'))).toBe(true);
    expect(encodeLegacy(LATIN_PROSE[7], 'windows-1252')!.equals(iconv(LATIN_PROSE[7], 'CP1252'))).toBe(true);
    expect(encodeLegacy(HANT_PROSE[1], 'big5')!.equals(iconv(HANT_PROSE[1], 'BIG5'))).toBe(true);
    expect(encodeLegacy(KO_PROSE[1], 'euc-kr')!.equals(iconv(KO_PROSE[1], 'EUC-KR'))).toBe(true);
  });

  it('(a) UTF-8: ASCII, Chinese, emoji / astral, mixed scripts, BOM, CRLF', () => {
    expectClean(check('(a) utf-8 documents (BOM / CRLF variants)', utf8Plain()));
  });
  it('(a) UTF-8 with sparse NULs at many densities and positions', () => {
    const t = check('(a) utf-8 with sparse NULs', utf8Nuls());
    report.push(`    (left out: ${denseNulSkipped} variants with NULs on one side of ≥ 40 % of the pairs, ${majorityNulSkipped} with NULs in > 50 % of the characters)`);
    expectClean(t);
  });
  it('(a) UTF-8 with control characters (ESC sequences, FF, BEL, BS, VT)', () => {
    expectClean(check('(a) utf-8 with control characters', utf8Controls()));
  });
  it('(a) very short UTF-8 files (1 to 8 bytes)', () => {
    expectClean(check('(a) utf-8, 1–8 bytes', utf8Short()));
  });
  it('(b) UTF-16 LE / BE with BOM', () => {
    expectClean(check('(b) utf-16 le/be with BOM', utf16Bom()));
  });

  it('(c) GBK: every window of 1–100 Han characters of the written prose, bare and in Markdown', () => {
    const han = [...ZH_PROSE.join('')].filter((c) => /\p{Script=Han}/u.test(c));
    expectClean(check(`(c) gbk prose windows (all, ${han.length} Han)`, gbkCases(han, 'prose', 1e9, 1)));
  });
  it('(c) GBK: windows with punctuation (raw prose, not only Han)', () => {
    const chars = [...ZH_PROSE.join('')];
    expectClean(check('(c) gbk prose windows incl. punctuation (≤400/L)', gbkCases(chars, 'punct', 400, 2)));
  });
  it('(c) GBK: windows of the repository docs (sampled: 700 per length)', () => {
    const han = docsHan();
    expect(han.length).toBeGreaterThan(5000);
    expectClean(check(`(c) gbk docs windows (${han.length} Han, 700/L)`, gbkCases(han, 'docs', 700, 3)));
  });
  it('(c) GBK: random GB2312 level-1 strings (500 per length)', () => {
    const lvl1 = gb2312Level1();
    const rnd = mulberry32(4);
    const fake = Array.from({ length: 20000 }, () => pick(rnd, lvl1));
    expectClean(check('(c) gbk random GB2312 level-1 (500/L)', gbkCases(fake, 'lvl1', 500, 5)));
  });
  it('(c) GB18030: four-byte sequences (iconv)', () => {
    // (macOS iconv has no GB18030 mapping for € or astral characters)
    const extra = ['㐀', '㈠', '‰', '·', '—', '〇', '䶮', '①', 'ⅰ', '•', '㑇', 'ǹ'];
    const rnd = mulberry32(6);
    const cases: Case[] = [];
    for (let i = 0; i < 300; i++) {
      const a = intIn(rnd, 0, ZH_PROSE.join('').length - 40);
      let s = ZH_PROSE.join('').slice(a, a + intIn(rnd, 1, 40));
      s += Array.from({ length: intIn(rnd, 1, 3) }, () => pick(rnd, extra)).join('');
      const text = i % 2 ? wrapMd(s) : s;
      cases.push({ name: `gb18030#${i}`, bytes: iconv(text, 'GB18030'), text, encoding: 'gbk', bom: false });
    }
    expectClean(check('(c) gb18030 incl. 4-byte sequences', cases));
  });

  it('(d) windows-1252 / Latin-1 prose (French, German, Spanish) in several lengths', () => {
    expectClean(check('(d) windows-1252 prose', latinCases()));
  });

  it('(e) Big5 / Shift_JIS / EUC-KR windows: no regression (0.1.0 is rarely right here)', () => {
    const t1 = check('(e) big5 windows', cjkOtherCases(HANT_PROSE, 'big5', 7));
    const t2 = check('(e) shift_jis windows', cjkOtherCases(JA_PROSE, 'shift_jis', 8));
    const t3 = check('(e) euc-kr windows', cjkOtherCases(KO_PROSE, 'euc-kr', 9));
    for (const t of [t1, t2, t3]) expectClean(t);
  });
});

// ---------------------------------------------------------------- (f)–(k) the verifier's corpora (S4)
//
// Generators of bench/verify/v2-dec-corpus.mjs and v2-dec-thresholds.mjs (stage 2a, written by the
// verifier, not by a fixer): realistic documents of many kinds, Latin-script languages in the
// single-byte code pages, GBK-extension characters, NUL padding, files cut at every position, mixed
// files. Sampled (fixed seeds, sizes printed in the report) so that the file stays under 30 s.

/** Big5 / Shift_JIS bytes as real encoders write them (WHATWG = iconv / CP950 / CP932 for these
 *  texts); every other label through the corpus encoder (0.1.0 tables; GBK and EUC-KR are identical). */
function encodeReal(text: string, label: string): Buffer | null {
  if (label === 'big5-010') return encodeCorpus(text, 'big5');
  if (label !== 'big5' && label !== 'shift_jis') return encodeCorpus(text, label);
  const table = (neu as any).legacyEncoderTable(label) as Map<string, number[]>;
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else {
      const b = table.get(ch);
      if (!b) return null;
      out.push(...b);
    }
  }
  return Buffer.from(out);
}
const PER_FAMILY = 400;
const EOLS = ['lf', 'crlf', 'cr', 'mixed'] as const;

/** v2-dec-diff.mjs's families: what the generator makes, in `label` (truth label `as`). */
function* verifierFamily(name: string, make: (r: () => number) => string, label: string, as = label, unreachable = false): Generator<Case> {
  const r = crng([...name].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) >>> 0);
  let made = 0;
  for (let tries = 0; made < PER_FAMILY && tries < PER_FAMILY * 5; tries++) {
    let text = make(r);
    const lr = r();
    if (lr < 0.01) text = Array.from({ length: cint(r, 300, 500) }, () => make(r)).join('\n'); // > 96 KB: the sampled decision
    else if (lr < 0.05) text = Array.from({ length: cint(r, 10, 60) }, () => make(r)).join('\n');
    else if (lr < 0.15) text = text.slice(0, cint(r, 1, 6));
    text = withEolCorpus(text, cpick(r, EOLS), r);
    const enc = encodeReal(text, label);
    if (!enc) continue;
    let bytes = enc;
    let bom = false;
    if (label === 'utf-8' && r() < 0.25) [bytes, bom] = [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), enc]), true];
    if (label === 'utf-16le' && r() < 0.5) [bytes, bom] = [Buffer.concat([Buffer.from([0xff, 0xfe]), enc]), true];
    if (label === 'utf-16be' && r() < 0.5) [bytes, bom] = [Buffer.concat([Buffer.from([0xfe, 0xff]), enc]), true];
    made++;
    yield { name: `${name}#${made}`, bytes, text: unreachable ? null : text, encoding: as, bom };
  }
}

const SIMPLE_GB = ['zhMarkdown', 'zhShort', 'zhInEnglish', 'names', 'srt', 'log', 'hant', 'hantShort', 'zhWithKana'];
const LATIN_EXTRA: Record<string, string[]> = { // v2-dec-thresholds.mjs latin()
  pt: ['INFORMAÇÕES IMPORTANTES', 'Atenção: a instalação não está concluída.', 'ORIENTAÇÕES GERAIS', 'Configurações e opções de exportação.', 'São Paulo, março de 2026.', 'Não há solução.'],
  es: ['¿Ésta es la canción? ¡Ánimo!', 'AÑO NUEVO — ÉXITO', 'Pequeño año, mañana señor.'],
  fr: ['ÉTÉ ÉCOLE ÉLÉMENTAIRE', 'Château, forêt, élève, déjà, où.', '« Ça va ? » — « Très bien. »'],
  de: ['ÄÖÜ GRÖSSE', 'Größe, Maß, Füße, Öl.', 'Schöne Grüße aus Köln.'],
  is: ['Þjóðhátíð í Eyjum.', 'ÍSLENSKA ÞJÓÐIN', 'Ég á æðislegan dag.'],
  da: ['Ærø, Æbelø og Ålborg.', 'Smørrebrød og øl.', 'BLÅBÆRGRØD'],
  ca: ['L’àvia té una cançó.', 'Això és molt bonic.', 'Col·lecció d’art.'],
};
/** Czech / Slovak (CP1250: ť = 9D, Ť = 8D, ž = 9E, Ź = 8F, š = 9A …) — written for this test. */
const CS_SK = ['Chuť jídla a ťava.', 'Šťastný nový rok!', 'Žluťoučký kůň úpěl ďábelské ódy.', 'Ďakujem za pomoc, priateľ.', 'Ťažké časy, ďaleká cesta.', 'ŤAVA A ĎATEL', 'Poznámky k vydání 2.0', 'Źródło: archiv města.'];

function* latinExtra(lang: string): Generator<Case> {
  const sents = [...(LATIN_CORPUS[lang] || []), ...LATIN_EXTRA[lang]];
  const r = crng(lang.charCodeAt(0) * 7 + lang.charCodeAt(1));
  for (let i = 0; i < 600; i++) {
    const parts: string[] = [];
    for (let j = cint(r, 1, 6); j > 0; j--) parts.push(cpick(r, sents));
    const text = (r() < 0.3 ? `# ${cpick(r, sents)}\n\n` : '') + parts.join(cpick(r, [' ', '\n', '\n\n']));
    const bytes = encodeCorpus(text, 'windows-1252');
    if (bytes) yield { name: `cp1252-${lang}#${i}`, bytes, text, encoding: 'windows-1252', bom: false };
  }
}
function* czechSlovak(): Generator<Case> {
  const r = crng(1250);
  for (let i = 0; i < 400; i++) {
    const text = Array.from({ length: cint(r, 1, 5) }, () => cpick(r, CS_SK)).join(cpick(r, [' ', '\n', '\n\n']));
    const bytes = encodeCorpus(text, 'windows-1250');
    if (bytes) yield { name: `cp1250-cs#${i}`, bytes, text: null, encoding: 'windows-1250', bom: false };
  }
}

/** v2-dec-thresholds.mjs gbkPools(): GBK text 0.1.0 reads correctly, by character pool and layout. */
function gbkPools(): Record<string, string[]> {
  const table = tableOf('gbk');
  const pools: Record<string, string[]> = { top: [], l1: [], l2: [], gbk3: [], gbk4: [], hantText: [], rare: [] };
  const TOP = new Set([...'的一是不了人我在有他这为之大来以个中上们到说国和地也子时道出而要于就下得可你年生自会那后能对着事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与好看学进种将还分此心前面又定见只主没公从已向关本开文动工实现长内点高正新问通意理明使气物外机等全部力表间性体加被重知及电相但样手头很最美回位度次员西应因话四做感线解系政两期利提百情何资题任社比给原入合活世少五接件九才区放程更名白展变口北山教月车条至林质八再别带结光整近单族制象联反志听记建打报片论元边量深强计今神转平眼每包老受即拉图石色海路张果难华权指六门品运决信农保收特斗书声证改总直取务米金命南连安府须设管七太识复革切亲队委快千格']);
  for (const [ch, b] of table) {
    if (b.length !== 2) continue;
    const code = (b[0] << 8) | b[1];
    const cp = ch.codePointAt(0)!;
    if (cp < 0x4e00 || cp > 0x9fff) continue;
    if (TOP.has(ch)) pools.top.push(ch);
    else if (code >= 0xb0a1 && code <= 0xd7fe && b[1] >= 0xa1) pools.l1.push(ch);
    else if (code >= 0xd8a1 && code <= 0xf7fe && b[1] >= 0xa1) pools.l2.push(ch);
    else if (b[0] >= 0x81 && b[0] <= 0xa0) pools.gbk3.push(ch);
    else pools.gbk4.push(ch);
  }
  for (const s of HANT_CORPUS) for (const ch of s) if (table.has(ch) && /\p{Script=Han}/u.test(ch)) pools.hantText.push(ch);
  pools.rare = [...'堃喆昇祎玥赟镕珺琍瑢翀旻甯堉鍪龘曌囧槑燚犇淼鑫焱垚靐罍彧昉昰'].filter((c) => table.has(c));
  return pools;
}
function* gbkPoolCases(perPoint: number): Generator<Case> {
  const pools = gbkPools();
  const fwp = ['，', '。', '、', '；'];
  for (const pool of Object.keys(pools)) for (const lay of ['run', 'spaced', 'sentence']) {
    for (const k of [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 19, 20, 21, 25, 30, 40]) {
      const r = crng(k * 131 + pool.length * 17 + lay.length + 9);
      for (let i = 0; i < perPoint; i++) {
        let s = '';
        for (let j = 0; j < k; j++) {
          s += cpick(r, pools[pool]);
          if (lay === 'spaced' && j < k - 1) s += cpick(r, [' ', ' | ', ', ', '\n- ', '：']);
          if (lay === 'sentence' && j < k - 1 && r() < 0.12) s += cpick(r, fwp);
        }
        if (lay === 'sentence') s = cpick(r, ['', '# ', '- ', '> ']) + s + cpick(r, ['。', '', '\n']);
        const bytes = encodeCorpus(s, 'gbk');
        if (bytes) yield { name: `gbk-${pool}-${lay}-k${k}`, bytes, text: s, encoding: 'gbk', bom: false };
      }
    }
  }
}

/** Documents with NUL bytes: padding at the end / start, sparse NULs (0.1.0 refuses every legacy
 *  reading with a NUL; UTF-8 with NULs on one side of ≥ 40 % of the pairs is K7's UTF-16 rule). */
function* nulPadded(): Generator<Case> {
  const r = crng(4040);
  const labels = ['gbk', 'windows-1252', 'big5', 'utf-8'] as const;
  const gens: Record<string, (r: () => number) => string> = {
    gbk: (q) => GEN_CORPUS.zhMarkdown(q), 'windows-1252': (q) => GEN_CORPUS.latin(q, cpick(q, ['fr', 'de', 'pt', 'es'])), big5: (q) => GEN_CORPUS.hant(q), 'utf-8': (q) => GEN_CORPUS.mixedUtf8(q),
  };
  for (let i = 0; i < 1200; i++) {
    const label = cpick(r, labels);
    const base = gens[label](r);
    const body = encodeReal(base, label);
    if (!body) continue;
    const v = cint(r, 0, 3);
    let bytes: Buffer;
    let text: string | null;
    if (v === 0) [bytes, text] = [Buffer.concat([body, Buffer.alloc(cint(r, 1, 64))]), null];
    else if (v === 1) [bytes, text] = [Buffer.concat([Buffer.alloc(cint(r, 1, 8)), body]), null];
    else if (v === 2) {
      const at = cint(r, 0, body.length);
      [bytes, text] = [Buffer.concat([body.subarray(0, at), Buffer.alloc(1), body.subarray(at)]), null];
    } else {
      const b = Buffer.from(body);
      for (let q = 1; q < b.length; q += 2) if (r() < 0.05) b[q] = 0;
      [bytes, text] = [b, null];
    }
    if (label === 'utf-8' && text === null) {
      // the truth, when the NULs did not cut a character: NUL is U+0000 in UTF-8
      const t = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      if (!t.includes('�') && nulSideShare(bytes) < 0.4 && (t.split('\u0000').length - 1) * 2 <= [...t].length) text = t;
    }
    yield { name: `nul-${label}-v${v}#${i}`, bytes, text, encoding: label, bom: false };
  }
}

/** Every prefix and every suffix of short documents in each encoding (cut inside a character or not). */
function* cutEverywhere(): Generator<Case> {
  const r = crng(5050);
  const docs: Array<[string, string]> = [];
  for (let i = 0; i < 4; i++) {
    docs.push(['utf-8', GEN_CORPUS.zhShort(r) + '\n' + GEN_CORPUS.mixedUtf8(r)]);
    docs.push(['gbk', GEN_CORPUS.zhMarkdown(r).slice(0, 80)]);
    docs.push(['big5', GEN_CORPUS.hant(r).slice(0, 60)]);
    docs.push(['shift_jis', GEN_CORPUS.ja(r).slice(0, 60)]);
    docs.push(['euc-kr', GEN_CORPUS.ko(r).slice(0, 60)]);
    docs.push(['windows-1252', GEN_CORPUS.latin(r, cpick(r, ['fr', 'de', 'pt', 'es', 'is'])).slice(0, 120)]);
  }
  for (const [label, text] of docs) {
    const body = encodeReal(text, label);
    if (!body) continue;
    for (let k = 1; k < body.length; k++) {
      for (const [side, part] of [['head', body.subarray(0, k)], ['tail', body.subarray(k)]] as const) {
        let truth: string | null = null;
        try {
          const t = new TextDecoder(label, { fatal: true }).decode(part);
          if (side === 'head' ? text.startsWith(t) : text.endsWith(t)) truth = t;
        } catch {
          truth = null;
        }
        yield { name: `cut-${label}-${side}${k}`, bytes: Buffer.from(part), text: truth, encoding: label, bom: false };
      }
    }
  }
}

/** A UTF-8 majority with one GBK paragraph, and the reverse (no reading is the truth). */
function* mixedFiles(): Generator<Case> {
  const r = crng(6060);
  for (let i = 0; i < 300; i++) {
    const paras = Array.from({ length: cint(r, 2, 5) }, () => GEN_CORPUS.zhMarkdown(r));
    const g = cint(r, 0, paras.length - 1);
    const utf8Major = i % 2 === 0;
    const parts = paras.map((p, j) => ((j === g) === utf8Major ? encodeCorpus(p, 'gbk') : Buffer.from(p, 'utf8')));
    if (parts.some((p) => !p)) continue;
    yield { name: `mixed-${utf8Major ? 'utf8-major' : 'gbk-major'}#${i}`, bytes: Buffer.concat(parts.flatMap((p) => [p!, Buffer.from('\n\n')])), text: null, encoding: 'utf-8', bom: false };
  }
}

describe('decodeBuffer — the verifier\'s corpora (decision S4): (i) no regression (ii) no new refusal (iii) byte-exact save (iv) switch off = 0.1.0', () => {
  it('(f) v2-dec-diff families: GBK / UTF-8 documents of every kind, GB18030, Big5 / Shift_JIS / EUC-KR, UTF-16', () => {
    const all: Tally[] = [];
    for (const g of SIMPLE_GB) {
      all.push(check(`(f) gbk:${g}`, verifierFamily(`gbk:${g}`, (r) => GEN_CORPUS[g](r, 0.15), 'gbk')));
      all.push(check(`(f) utf8:${g}`, verifierFamily(`utf8:${g}`, (r) => GEN_CORPUS[g](r, 0.15), 'utf-8')));
    }
    all.push(check('(f) gb18030:rare4', verifierFamily('gb18030:rare4', (r) => GEN_CORPUS.zhShort(r) + cpick(r, ['㐀', '𠀀', '😀', '䶮', '𪚥', '€']) + GEN_CORPUS.zhShort(r), 'gb18030', 'gbk')));
    all.push(check('(f) big5:hant (WHATWG bytes)', verifierFamily('big5:hant', (r) => GEN_CORPUS.hant(r), 'big5')));
    all.push(check('(f) big5:hantShort (WHATWG bytes)', verifierFamily('big5:hantShort', (r) => GEN_CORPUS.hantShort(r), 'big5')));
    all.push(check('(f) big5:hant (0.1.0 table: 十 = A2CC)', verifierFamily('big5-010:hant', (r) => GEN_CORPUS.hant(r), 'big5-010', 'big5')));
    all.push(check('(f) sjis:ja', verifierFamily('sjis:ja', (r) => GEN_CORPUS.ja(r), 'shift_jis')));
    all.push(check('(f) euckr:ko', verifierFamily('euckr:ko', (r) => GEN_CORPUS.ko(r), 'euc-kr')));
    all.push(check('(f) utf8:mixed', verifierFamily('utf8:mixed', (r) => GEN_CORPUS.mixedUtf8(r), 'utf-8')));
    all.push(check('(f) utf16le:zh', verifierFamily('utf16le:zh', (r) => GEN_CORPUS.zhMarkdown(r), 'utf-16le')));
    all.push(check('(f) utf16be:zh', verifierFamily('utf16be:zh', (r) => GEN_CORPUS.zhMarkdown(r), 'utf-16be')));
    all.push(check('(f) utf16le:en', verifierFamily('utf16le:en', (r) => GEN_CORPUS.zhInEnglish(r).replace(/[^\x00-\x7f]/g, 'x'), 'utf-16le')));
    for (const t of all) expectClean(t);
  });
  it('(g) Latin-script languages: windows-1252 (pt de is ca es da fr), ISO-8859-15, CP1250 / CP1251 / KOI8-R / CP1253 / ISO-8859-7 / CP1254, UTF-8', () => {
    const all: Tally[] = [];
    for (const lang of ['pt', 'de', 'is', 'ca', 'es', 'da', 'fr']) all.push(check(`(g) cp1252 ${lang} (v2-dec-thresholds latin)`, latinExtra(lang)));
    for (const lang of ['fr', 'de', 'es', 'pt', 'is']) all.push(check(`(g) cp1252:${lang}`, verifierFamily(`cp1252:${lang}`, (r) => GEN_CORPUS.latin(r, lang), 'windows-1252')));
    all.push(check('(g) iso15:fr', verifierFamily('iso15:fr', (r) => GEN_CORPUS.latin(r, 'fr').replace(/Œ/g, 'OE').replace(/œ/g, 'oe').replace(/[’«»—]/g, "'"), 'iso-8859-15', 'windows-1252')));
    all.push(check('(g) cp1250 cs / sk (no truth: not a supported label)', czechSlovak()));
    for (const [label, lang] of [['windows-1250', 'pl'], ['windows-1251', 'ru'], ['koi8-r', 'ru'], ['windows-1253', 'el'], ['iso-8859-7', 'el'], ['windows-1254', 'tr']] as const) {
      all.push(check(`(g) ${label}:${lang} (no truth)`, verifierFamily(`${label}:${lang}`, (r) => GEN_CORPUS.latin(r, lang), label, label, true)));
    }
    for (const lang of ['fr', 'de', 'pl', 'ru', 'el', 'tr']) all.push(check(`(g) utf8:${lang}`, verifierFamily(`utf8:${lang}`, (r) => GEN_CORPUS.latin(r, lang), 'utf-8')));
    for (const t of all) expectClean(t);
  });
  it('(h) GBK-extension characters (GBK/3, GBK/4, name characters) and GB2312 pools, 1–40 characters, three layouts', () => {
    expectClean(check('(h) gbk pools × layouts × lengths (25/point)', gbkPoolCases(25)));
  });
  it('(i) NUL-padded and NUL-holed files', () => {
    expectClean(check('(i) nul padding / holes', nulPadded()));
  });
  it('(j) files cut at every position (prefixes and suffixes)', () => {
    expectClean(check('(j) cut at every byte', cutEverywhere()));
  });
  it('(k) mixed files: UTF-8 majority with one GBK paragraph, and the reverse', () => {
    expectClean(check('(k) mixed utf-8 / gbk paragraphs (no truth)', mixedFiles()));
  });
});

// ---------------------------------------------------------------- what the rewrite gains (D3)

let tmp: string;
beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdr-fileio-diff-'));
});
afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('decodeBuffer — realistic Big5 / Shift_JIS / EUC-KR documents read and save in their own encoding', () => {
  const docs: Array<[string, string, string]> = [
    ['big5', 'BIG5', `# 遊記\n\n${HANT_PROSE.slice(0, 2).join('')}\n`],
    ['big5', 'BIG5', `${HANT_PROSE[3]}\n\n- ${HANT_PROSE[4]}\n`],
    ['shift_jis', 'SHIFT_JIS', `# 日記\n\n${JA_PROSE.slice(0, 2).join('')}\n`],
    ['shift_jis', 'SHIFT_JIS', `${JA_PROSE[2]}\n\n> ${JA_PROSE[5]}\n`],
    ['euc-kr', 'EUC-KR', `# 일기\n\n${KO_PROSE.slice(0, 2).join(' ')}\n`],
    ['euc-kr', 'EUC-KR', `${KO_PROSE[2]}\n\n1. ${KO_PROSE[4]}\n`],
  ];
  for (const [label, charset, text] of docs) {
    it(`${charset}: ${JSON.stringify(text.slice(0, 14))}… (${[...text].length} chars)`, async () => {
      const bytes = iconv(text, charset);
      const edited = `${text}\n${label === 'euc-kr' ? '추가' : label === 'big5' ? '新增' : '追加'}\n`;
      // S4 (f): the dormant override (passed explicitly) reads the label; an edit saves in it
      const r = decodeNew(bytes, true);
      expect(r).toMatchObject({ encoding: label, text });
      const table = saveTableOf(r.text, r.encoding, bytes);
      expect(encodeNew(edited, { encoding: r.encoding, bom: r.bom, eol: eolOfNew(r.text), ...(table ? { table } : {}) }).equals(iconv(edited, charset))).toBe(true);
      // by default (overrides off) open and save do exactly what 0.1.1 does with the same file and edit
      const outcome = async (io: any, name: string) => {
        const p = path.join(tmp, `${name}-${label}-${text.length}.md`);
        await fsp.writeFile(p, bytes);
        const store = io.createFileMetaStore();
        const info = await io.readFileInfo(p, store);
        const ed = `${info.text}\n${label === 'euc-kr' ? '추가' : label === 'big5' ? '新增' : '追加'}\n`;
        let saved: string;
        try {
          await io.writeFileAtomic(p, ed, store);
          saved = (await fsp.readFile(p)).toString('hex');
        } catch (e) {
          saved = `THROW ${(e as Error).message}`;
        }
        return { text: info.text, encoding: info.encoding, saved };
      };
      expect(await outcome(neu, 'new')).toEqual(await outcome(old, 'old'));
    });
  }
  it('a paragraph-length GBK document is still GBK (and saves as GBK)', async () => {
    const text = `# 随笔\n\n${ZH_PROSE.slice(0, 3).join('')}\n`;
    expect(decodeNew(iconv(text, 'GBK'))).toMatchObject({ encoding: 'gbk', text });
  });
});

// Lead decision S4 (a) (2026-11-20): no lenient GBK in 0.2.0. A damaged GBK file gets 0.1.0's answer
// (windows-1252 / Big5 mojibake, or a refusal) and a save keeps every byte; these cases asserted a
// lenient GBK reading with U+FFFD before S4 (it overturned clean windows-1252 text: G22).
describe('decodeBuffer — damaged GBK and mixed files (D4, S4 (a): no lenient GBK)', () => {
  const text = `# 会议纪要\n\n${ZH_PROSE.slice(4, 7).join('')}\n\n- ${ZH_PROSE[9]}\n`;
  const g = iconv(text, 'GBK');
  const asOld = (b: Buffer) => {
    const o = decodeOld(b);
    return { text: o.text, encoding: o.encoding, bom: o.bom };
  };
  const savesBack = (b: Buffer) => {
    const r = decodeNew(b);
    return encodeNew(r.text, { encoding: r.encoding, bom: r.bom, eol: eolOfNew(r.text) }).equals(b);
  };
  it('the last character cut off: 0.1.0\'s answer (no U+FFFD), and a save keeps every byte', () => {
    const body = iconv(text.trimEnd(), 'GBK'); // ends with a Han character, no newline
    const damaged = body.subarray(0, body.length - 1); // half of the last character
    const r = decodeNew(damaged);
    expect(r).toEqual(asOld(damaged));
    expect(decodeNew(damaged, true)).toEqual(asOld(damaged)); // the dormant overrides too (S4 (f))
    expect(r.replaced).toBeUndefined();
    expect(savesBack(damaged)).toBe(true);
  });
  it('one stray 0x80 byte between two characters: € in GBK, clean, the text intact around it (0.1.0)', () => {
    const at = g.indexOf(iconv('教练', 'GBK'));
    const damaged = Buffer.concat([g.subarray(0, at), Buffer.from([0x80]), g.subarray(at)]);
    const r = decodeNew(damaged);
    expect(r).toEqual(asOld(damaged));
    expect(decodeNew(damaged, true)).toEqual(asOld(damaged)); // the dormant overrides too (S4 (f))
    expect(r.encoding).toBe('gbk');
    expect(r.text).toContain('€教练叫了暂停');
    expect(r.text).toContain(ZH_PROSE[9]);
  });
  it('one stray 0xFF byte between two characters: 0.1.0\'s answer, no U+FFFD', () => {
    const at = g.indexOf(iconv('教练', 'GBK'));
    const damaged = Buffer.concat([g.subarray(0, at), Buffer.from([0xff]), g.subarray(at)]);
    const r = decodeNew(damaged);
    expect(r).toEqual(asOld(damaged));
    expect(decodeNew(damaged, true)).toEqual(asOld(damaged)); // the dormant overrides too (S4 (f))
    expect(r.replaced).toBeUndefined();
  });
  it('readFileInfo reports no replacedBytes for a damaged GBK file (0.1.0\'s answer)', async () => {
    const body = iconv(text.trimEnd(), 'GBK');
    const p = path.join(tmp, 'damaged-gbk.md');
    await fsp.writeFile(p, body.subarray(0, body.length - 1));
    const info = await (neu as any).readFileInfo(p, (neu as any).createFileMetaStore());
    expect(info.encoding).toBe(decodeOld(body.subarray(0, body.length - 1)).encoding);
    expect('replacedBytes' in info).toBe(false);
  });
  it('a UTF-8 part followed by a larger GBK part: 0.1.0\'s answer, and a save keeps every byte', () => {
    const b = Buffer.concat([Buffer.from('# 标题\n\n一小段 UTF-8 文字。\n\n', 'utf8'), g]);
    expect(decodeNew(b)).toEqual(asOld(b));
    expect(decodeNew(b, true)).toEqual(asOld(b)); // the dormant overrides too (S4 (f))
    expect(savesBack(b)).toBe(true);
  });
  it('a GBK part followed by a larger UTF-8 part: the UTF-8 part reads, never windows-1252', () => {
    const u = Buffer.from(`\n\n${ZH_PROSE.slice(10, 16).join('\n')}\n`, 'utf8');
    const b = Buffer.concat([iconv('# 旧的标题\n\n短短一句。\n', 'GBK'), u]);
    expect(decodeNew(b)).toEqual(asOld(b)); // default: 0.1.0 (S4 (f))
    const r = decodeNew(b, true); // the dormant override 3
    expect(r.encoding).toBe('utf-8');
    expect(r.text).toContain(ZH_PROSE[12]);
    expect(r.replaced).toBeGreaterThan(0);
  });
  it('Latin prose with one invalid byte stays windows-1252 (the run rule does not touch it)', () => {
    const t = LATIN_PROSE.slice(0, 5).join('\n');
    const r = decodeNew(iconv(t, 'CP1252'));
    expect(r).toMatchObject({ encoding: 'windows-1252', text: t });
  });
});

describe('decodeBuffer — large files: the decision is made on a sample, the whole file decodes (D5)', () => {
  const gbkPara = iconv(`${ZH_PROSE.join('\n')}\n\n`, 'GBK');
  const big = (unit: Buffer, bytes: number) => Buffer.concat(Array(Math.ceil(bytes / unit.length)).fill(unit));
  it('a 4 MB GBK file reads as GBK, whole', () => {
    const b = big(gbkPara, 4 << 20);
    const r = decodeNew(b);
    expect(r.encoding).toBe('gbk');
    expect(r.text.length).toBe(new TextDecoder('gbk').decode(b).length);
  });
  it('a 2 MB GBK file without a single newline or space (no safe cut: streaming sample)', () => {
    const b = big(iconv(ZH_PROSE.join(''), 'GBK'), 2 << 20);
    const end = b.length - (b.length % 2);
    const r = decodeNew(b.subarray(0, end));
    expect(r.encoding).toBe('gbk');
    expect(r.text.startsWith(ZH_PROSE[0])).toBe(true);
  });
  it('a 2 MB Big5 file reads as Big5', () => {
    const b = big(iconv(`${HANT_PROSE.join('\n')}\n`, 'BIG5'), 2 << 20);
    expect(decodeNew(b)).toEqual(decodeOld(b)); // default: 0.1.0 (S4 (f))
    expect(decodeNew(b, true).encoding).toBe('big5'); // the dormant override 4
  });
  it('a large GBK file damaged where the sample does not look: 0.1.0\'s answer for the whole file (S4 (a))', () => {
    const b = big(gbkPara, 2 << 20);
    const at = Math.floor(b.length / 4) - (Math.floor(b.length / 4) % 2); // not in the start / middle / end chunks
    const damaged = Buffer.concat([b.subarray(0, at), Buffer.from([0xff]), b.subarray(at)]);
    const o = decodeOld(damaged);
    for (const ov of [undefined, true]) { // the default and the dormant overrides (S4 (f))
      const r = decodeNew(damaged, ov);
      expect({ encoding: r.encoding, same: r.text === o.text, replaced: r.replaced }).toEqual({ encoding: o.encoding, same: true, replaced: undefined });
    }
  });
  it('ASCII where the sample looks, GBK only elsewhere: still GBK', () => {
    const ascii = Buffer.from('plain ascii line of a large log file\n'.repeat(20000));
    const q = ascii.length >> 2;
    const r = decodeNew(Buffer.concat([ascii.subarray(0, q), gbkPara, ascii.subarray(q)]));
    expect(r.encoding).toBe('gbk');
    expect(r.text).toContain(ZH_PROSE[3]);
  });
  it('a 12 MB UTF-8 file with one bad byte: UTF-8 with replacements, not windows-1252', () => {
    const u = big(Buffer.from(`${ZH_PROSE.join('\n')}\nsome ascii text\n`, 'utf8'), 12 << 20);
    const damaged = Buffer.concat([u.subarray(0, u.length >> 1), Buffer.from([0xff]), u.subarray(u.length >> 1)]);
    const d = decodeNew(damaged);
    const o = decodeOld(damaged);
    expect({ encoding: d.encoding, same: d.text === o.text, bom: d.bom }).toEqual({ encoding: o.encoding, same: true, bom: o.bom }); // default: 0.1.0 (S4 (f))
    const r = decodeNew(damaged, true); // the dormant override 3
    expect(r.encoding).toBe('utf-8');
    expect(r.replaced).toBeGreaterThan(0);
    expect(r.replaced).toBeLessThan(5);
  });
});
