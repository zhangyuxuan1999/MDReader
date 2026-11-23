// v2-dec-corpus.mjs — seeded generators of realistic text for the decoder differential (verify-decoder,
// 0.2.0 stage 2a). Text written for this verifier; nothing taken from the fixer's corpora.
// Library only: imported by v2-dec-diff.mjs, v2-dec-thresholds.mjs, v2-dec-roundtrip.mjs.
import * as old from '../../test/fixtures/fileIO-0.1.0.mjs';

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
export const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

// ------------------------------------------------------------------ encoders
const singleByteTables = new Map();
/** char → byte for a single-byte WHATWG label (built by decoding 0..255). */
function sbTable(label) {
  let t = singleByteTables.get(label);
  if (t) return t;
  t = new Map();
  const d = new TextDecoder(label);
  for (let b = 0; b < 256; b++) {
    const s = d.decode(Uint8Array.of(b));
    if (s !== '\uFFFD' && !t.has(s)) t.set(s, b);
  }
  singleByteTables.set(label, t);
  return t;
}
const SINGLE = new Set(['windows-1250', 'windows-1251', 'koi8-r', 'iso-8859-7', 'windows-1253', 'windows-1254', 'iso-8859-15', 'iso-8859-2', 'windows-1252', 'iso-8859-5', 'macintosh']);
const gb4 = new Map();
/** GB18030 four-byte sequence of an astral / non-GBK char, by brute force over the 4-byte space actually
 *  used by WHATWG gb18030 (ranges index): decode candidates until one matches. Cached. */
function gb18030Four(ch) {
  if (gb4.has(ch)) return gb4.get(ch);
  const d = new TextDecoder('gb18030');
  const cp = ch.codePointAt(0);
  let found = null;
  if (cp >= 0x10000) {
    const ptr = cp - 0x10000 + 189000;
    const b1 = Math.floor(ptr / 12600), r1 = ptr % 12600;
    const b2 = Math.floor(r1 / 1260), r2 = r1 % 1260;
    const b3 = Math.floor(r2 / 10), b4 = r2 % 10;
    found = [b1 + 0x81, b2 + 0x30, b3 + 0x81, b4 + 0x30];
  } else {
    outer: for (let a = 0x81; a <= 0x84; a++) for (let b = 0x30; b <= 0x39; b++) for (let c = 0x81; c <= 0xfe; c++) for (let e = 0x30; e <= 0x39; e++) {
      if (d.decode(Uint8Array.of(a, b, c, e)) === ch) { found = [a, b, c, e]; break outer; }
    }
  }
  if (found && d.decode(Uint8Array.from(found)) !== ch) found = null;
  gb4.set(ch, found);
  return found;
}
/** Text → bytes in `label`, or null when not representable. gb18030 = GBK table + 4-byte sequences. */
export function encode(text, label) {
  if (label === 'utf-8') return Buffer.from(text, 'utf8');
  if (label === 'utf-16le') return Buffer.from(text, 'utf16le');
  if (label === 'utf-16be') return Buffer.from(text, 'utf16le').swap16();
  const out = [];
  if (SINGLE.has(label)) {
    const t = sbTable(label);
    for (const ch of text) { const b = t.get(ch); if (b === undefined) return null; out.push(b); }
    return Buffer.from(out);
  }
  const t = old.legacyEncoderTable(label === 'gb18030' ? 'gbk' : label);
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { out.push(cp); continue; }
    let b = t.get(ch);
    if (!b && label === 'gb18030') b = gb18030Four(ch);
    if (!b) return null;
    for (const x of b) out.push(x);
  }
  return Buffer.from(out);
}

// ------------------------------------------------------------------ vocabulary (written for this verifier)
export const ZH = [
  '周一上午九点在三楼会议室开项目例会，请大家提前十分钟到场。',
  '这个接口在高并发下偶尔超时，排查后发现是连接池配置太小。',
  '我们把数据库从五点七升级到八点零，迁移脚本已经跑完。',
  '下单页面的按钮颜色不对，设计稿里是深蓝色，线上显示成了紫色。',
  '春节前最后一个版本，只修严重问题，新功能一律延期到二月。',
  '用户反馈说导出的表格里日期变成了数字，需要统一成年月日格式。',
  '图书馆周末开放时间调整为上午八点半到晚上九点。',
  '妈妈说晚饭做了红烧肉和西红柿炒鸡蛋，让我早点回家。',
  '这本小说讲的是一个年轻医生在山村卫生院工作的故事。',
  '天气预报说明天有小雨，气温十二到十八度，出门记得带伞。',
  '请把发票抬头写成公司全称，税号在合同第二页。',
  '报销单需要部门经理签字后再交给财务，每月二十五号截止。',
  '训练营第三周的作业是实现一个简单的命令行记账工具。',
  '服务器机房搬迁期间，内网会中断大约两个小时。',
  '感谢各位老师和同学一年来的支持与帮助！',
  '如有疑问，请联系人事部张老师，分机号八二零三。',
  '火车票改签要在开车前办理，退票按时间收取手续费。',
  '新同事入职第一天要领电脑、门禁卡和工牌。',
  '他说的对，但是我们还得考虑成本和工期。',
  '这道菜的关键是火候，油热了再下锅，翻炒三十秒就出锅。',
];
export const ZH_RARE = ['堃', '喆', '昇', '祎', '玥', '赟', '镕', '珺', '琍', '瑢', '翀', '旻', '甯', '堉', '鍪', '龘', '曌', '囧', '槑', '燚', '犇', '淼', '鑫', '焱', '垚', '靐', '罍', '彧', '昉', '昰'];
export const HANT = [
  '這份報告會在下週三之前寄給各位董事。',
  '臺北市今天下午氣溫回升，傍晚可能有短暫陣雨。',
  '請問這附近有沒有便利商店或藥局？',
  '我們團隊負責維護舊系統，同時規劃新架構的遷移。',
  '十月十日是國慶日，學校放假一天。',
  '電腦螢幕突然閃爍，重新開機後恢復正常。',
  '這間餐廳的牛肉麵湯頭濃郁，麵條很有嚼勁。',
  '請將檔案儲存為純文字格式，並附上說明。',
  '二十年前的老照片，記錄了外婆家門口那棵榕樹。',
  '會議紀錄已上傳到共用資料夾，請大家確認。',
];
export const JA = ['こんにちは、よろしくお願いします。', 'カタカナとひらがなが混ざった文章です。', '東京駅で待ち合わせしましょう。', '設定ファイルを読み込めませんでした。', 'ありがとうございました！', '今日はいい天気ですね。'];
export const KO = ['안녕하세요, 반갑습니다.', '서울역에서 만나요.', '파일을 저장하지 못했습니다.', '감사합니다!', '오늘 날씨가 좋네요.', '회의는 내일 오후 세 시입니다.'];
export const KO_HANJA = ['大韓民國 憲法 第一條', '韓國 歷史 硏究', '學校 敎育 問題'];
export const LATIN = {
  fr: ['Le café est fermé le dimanche, mais la boulangerie reste ouverte.', '« Où êtes-vous allés pendant les vacances d’été ? »', 'ÉCOLE PRIMAIRE ÉLÉMENTAIRE — RÉUNION DES PARENTS', 'Il a reçu une lettre de son frère aîné à Noël.', 'Œuvres complètes, tome II : poèmes et essais.'],
  de: ['Die Straße vor dem Rathaus wird ab Montag gesperrt.', 'Größere Änderungen müssen vorher abgestimmt werden.', 'ÜBERGRÖSSE: Fußball-Weltmeisterschaft für Mädchen', 'Schöne Grüße aus München und viel Glück!'],
  es: ['¿Dónde está la estación de autobuses? ¡Muchas gracias!', 'El niño comió piña y jamón en la cena.', 'AÑO NUEVO EN LA CIUDAD DE MÉXICO', 'La canción ganó el premio de la crítica.'],
  pt: ['A educação pública é uma questão de cidadania.', 'Não sei se ele já chegou à estação.', 'AÇÃO E REAÇÃO: AS LIÇÕES DO VERÃO', 'Coração, informação e opinião são palavras comuns.'],
  is: ['Þetta er íslenskur texti með þ og ð og æ.', 'Ég heiti Guðrún og bý í Reykjavík.', 'ÞJÓÐMINJASAFN ÍSLANDS'],
  pl: ['Zażółć gęślą jaźń — pchnąć w tę łódź jeża.', 'Łódź jest trzecim co do wielkości miastem w Polsce.', 'Proszę o szybką odpowiedź.'],
  ru: ['Съешь же ещё этих мягких французских булок, да выпей чаю.', 'Москва — столица Российской Федерации.', 'Пожалуйста, сохраните файл перед выходом.'],
  el: ['Καλημέρα σας, τι κάνετε;', 'Η Αθήνα είναι η πρωτεύουσα της Ελλάδας.', 'Ευχαριστώ πολύ για τη βοήθεια.'],
  tr: ['Çalışma saatleri hafta içi dokuzdan beşe kadardır.', 'İstanbul’un en güzel semti hangisi?', 'Şu ağacın gölgesinde oturalım.', 'ĞÜŞİÖÇ büyük harfler'],
};
export const ASCII_BITS = ['const x = 42;', 'npm run build', 'https://example.com/path?q=1&lang=zh-CN', 'v0.2.0', '2026-11-20', 'TODO: fix later', 'SELECT * FROM users WHERE id = 7;', 'git log --oneline', 'C:\\Users\\Public\\Documents', '| a | b |', 'foo_bar_baz', 'HTTP/1.1 200 OK', '(1) (2) (3)', '127.0.0.1:8080'];
const FW_PUNCT = ['，', '。', '！', '？', '；', '：', '“', '”', '‘', '’', '（', '）', '【', '】', '《', '》', '、', '……', '——', '·', '～', '％', '＃', '＠', '＋', '＝'];
const NAMES = ['王建国', '李秀英', '张伟', '刘洋', '陈静', '杨帆', '赵敏', '黄晓明', '周杰', '吴昊天', '徐子轩', '孙丽', '马晓燕', '朱玥', '胡喆', '郭堃'];
const PLACES = ['北京市海淀区中关村大街27号', '上海市浦东新区世纪大道100号', '广州市天河区体育西路8号', '深圳市南山区科技园南区', '成都市武侯区人民南路四段', '杭州市西湖区文三路90号'];

// ------------------------------------------------------------------ document generators (all return strings)
function zhSentence(r, rareRate = 0) {
  let s = pick(r, ZH);
  if (rareRate && r() < rareRate) { const i = int(r, 0, s.length - 1); s = s.slice(0, i) + pick(r, ZH_RARE) + s.slice(i); }
  return s;
}
export const GEN = {
  zhMarkdown(r, rare = 0) {
    const out = [`# ${pick(r, ['会议纪要', '周报', '项目说明', '使用手册', '读书笔记'])} ${int(r, 1, 30)}`, ''];
    const nb = int(r, 1, 6);
    for (let i = 0; i < nb; i++) {
      const k = int(r, 0, 5);
      if (k === 0) out.push(`## ${zhSentence(r, rare).slice(0, int(r, 2, 8))}`, '');
      else if (k === 1) { for (let j = int(r, 1, 4); j > 0; j--) out.push(`- ${zhSentence(r, rare)}${r() < 0.3 ? ' ' + pick(r, ASCII_BITS) : ''}`); out.push(''); }
      else if (k === 2) out.push('| 姓名 | 地址 | 电话 |', '| --- | --- | --- |', `| ${pick(r, NAMES)} | ${pick(r, PLACES)} | 138${int(r, 10000000, 99999999)} |`, '');
      else if (k === 3) out.push('```js', `// ${zhSentence(r).slice(0, 10)}`, pick(r, ASCII_BITS), '```', '');
      else if (k === 4) out.push(`${zhSentence(r, rare)}${pick(r, FW_PUNCT)}参见 [文档](https://example.com/docs/${int(r, 1, 99)}) 和 \`${pick(r, ASCII_BITS)}\`。`, '');
      else out.push(`${int(r, 1, 9)}. ${zhSentence(r, rare)}${zhSentence(r, rare)}`, '');
    }
    return out.join('\n');
  },
  zhShort(r) { // 1–30 Han characters, the hard region
    const s = zhSentence(r) + zhSentence(r);
    const a = int(r, 0, s.length - 1);
    return s.slice(a, a + int(r, 1, 30));
  },
  zhInEnglish(r) { return `The meeting (${zhSentence(r).slice(0, int(r, 1, 6))}) is at 3pm. ${pick(r, ASCII_BITS)}`; },
  names(r) { const n = int(r, 1, 6); const o = []; for (let i = 0; i < n; i++) o.push(`${pick(r, NAMES)},${pick(r, PLACES)},${int(r, 18, 80)}`); return 'name,address,age\n' + o.join('\n'); },
  srt(r) { const o = []; for (let i = 1; i <= int(r, 1, 5); i++) o.push(`${i}\n00:0${int(r, 0, 9)}:${int(r, 10, 59)},${int(r, 100, 999)} --> 00:0${int(r, 0, 9)}:${int(r, 10, 59)},${int(r, 100, 999)}\n${zhSentence(r).slice(0, int(r, 4, 16))}\n`); return o.join('\n'); },
  log(r) { const o = []; for (let i = 0; i < int(r, 1, 8); i++) o.push(`2026-11-${int(r, 10, 30)} 0${int(r, 0, 9)}:${int(r, 10, 59)}:${int(r, 10, 59)} ${pick(r, ['INFO', 'WARN', 'ERROR'])} [${pick(r, ['main', 'db', 'http'])}] ${r() < 0.5 ? zhSentence(r).slice(0, int(r, 3, 14)) : pick(r, ASCII_BITS)}`); return o.join('\n'); },
  hant(r) { const o = []; for (let i = 0; i < int(r, 1, 5); i++) o.push(pick(r, HANT)); return (r() < 0.5 ? '# 筆記\n\n' : '') + o.join(r() < 0.5 ? '\n' : ''); },
  hantShort(r) { const s = pick(r, HANT) + pick(r, HANT); const a = int(r, 0, s.length - 1); return s.slice(a, a + int(r, 1, 30)); },
  zhWithKana(r) { return `${zhSentence(r)}日语里说「${pick(r, JA)}」${zhSentence(r)}`; },
  ja(r) { const o = []; for (let i = 0; i < int(r, 1, 5); i++) o.push(pick(r, JA)); return o.join('\n'); },
  ko(r) { const o = []; for (let i = 0; i < int(r, 1, 5); i++) o.push(pick(r, KO)); if (r() < 0.3) o.push(pick(r, KO_HANJA)); return o.join('\n'); },
  latin(r, lang) { const o = []; for (let i = 0; i < int(r, 1, 4); i++) o.push(pick(r, LATIN[lang])); return o.join(r() < 0.5 ? '\n\n' : ' '); },
  mixedUtf8(r) { return `${zhSentence(r)} — ${pick(r, JA)} ${pick(r, KO)} ${pick(r, LATIN.fr)} 😀 ${pick(r, ASCII_BITS)}`; },
};

/** Line-ending variants of an LF text. */
export function withEol(text, kind, r) {
  if (kind === 'lf') return text;
  if (kind === 'crlf') return text.replace(/\n/g, '\r\n');
  if (kind === 'cr') return text.replace(/\n/g, '\r');
  return text.replace(/\n/g, () => pick(r, ['\n', '\r\n', '\r'])); // mixed
}
