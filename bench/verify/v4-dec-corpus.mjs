// bench/verify/v4-dec-corpus.mjs — verify-decoder (0.2.0 stage 2d, fix round 3 re-verification).
// Library: seeded generators of NEW real-looking inputs for the decoder differential (nobody used these
// pools before). Writes nothing itself; encodes with macOS /usr/bin/iconv (real encoders), one iconv call
// per (family, target) by joining the texts with an ASCII separator line.
//   buildCorpus(seed, { big: false }) -> [{ name, fam, buf }]
// Families: gbk-notes (tables, numbers, units, dates), gbk-h7 (GBK byte pairs that are valid UTF-8),
// gbk-log, gbk-csv (+ UTF-8 BOM CSV), big5 / big5-hkscs prose, sjis / cp932 prose (NEC/IBM rows,
// half-width kana), euc-kr / cp949 prose, utf8 with invalid bytes, utf16 with and without BOM, NUL and
// control bytes, BOM x line-ending variants, cuts inside a character, sizes 0 B .. several MB around the
// 96 KiB sampling threshold of the dormant code. No backslash-u escapes in this file (tool hazard):
// control characters are built with String.fromCharCode / byte arrays.
import { spawnSync } from 'node:child_process';

export function rng(seed) {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const W = (s) => s.split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------- pools (written for this verifier)
const ZH = W(`
报销 差旅 住宿 餐费 交通 出差 审批 部门 财务 经理 主管 同事 新人 培训 入职 离职 考勤 加班 调休 年假
体重 血压 心率 步数 睡眠 跑步 游泳 骑行 健身 饮食 早餐 午餐 晚餐 蔬菜 水果 牛奶 鸡蛋 米饭 面条
房租 水费 电费 燃气 物业 宽带 话费 保险 贷款 利息 存款 理财 基金 股票 收入 支出 余额 预算 账单
小时 分钟 元 千元 万元 公斤 千克 米 公里 平方米 摄氏度 百分之 毫升 升 吨 台 套 份 次 天 周 月 年
一 二 三 四 五 六 七 八 九 十 百 千 万 第一 第二 第三 上旬 中旬 下旬 季度 年初 年底 月初 月底
苹果 香蕉 橙子 西瓜 葡萄 草莓 土豆 白菜 番茄 黄瓜 猪肉 牛肉 鸡肉 鱼 虾 豆腐 大米 面粉 食用油 酱油
电脑 显示器 键盘 鼠标 打印机 硬盘 内存 路由器 手机 平板 耳机 充电器 数据线 投影仪 摄像头 音箱
`);
const ZH_SENT = [
  '上个月的电费比平时高了不少，可能是空调开得太多。',
  '周三下午三点在三楼会议室开例会，请大家准时参加。',
  '这台打印机经常卡纸，已经报修两次了，还没有人来处理。',
  '体检报告显示血脂偏高，医生建议少吃油腻的食物，多运动。',
  '本季度的销售额比去年同期增长了百分之十二，主要来自线上渠道。',
  '小区周六上午停水，时间大约四个小时，请提前储水。',
  '孩子的作业是写一篇关于秋天的作文，不少于四百字。',
  '新买的书架今天到了，安装说明写得不太清楚，花了一个多小时才装好。',
];
const ZH_TW = [
  '這次旅行的行程安排得很緊湊，每天都要早起趕車。',
  '圖書館週末延長開放時間，歡迎同學多加利用。',
  '請在下週五之前把報告交給老師，逾期將不予受理。',
  '颱風來襲，市政府宣布明天停止上班上課。',
  '這家餐廳的牛肉麵非常有名，排隊的人總是很多。',
  '會議紀錄已經整理完畢，請各位確認後簽名回傳。',
  '電腦突然當機，剛才寫的資料全部都不見了，真是令人沮喪。',
  '捷運新路線預計明年年底通車，沿線房價已經開始上漲。',
];
const HK = '啲嘅咗喺冇嚟嘢佢哋睇';
const JA = [
  '明日の会議は午後二時から第三会議室で行います。',
  'この資料は社外秘ですので、取り扱いには十分ご注意ください。',
  '駅前の新しいパン屋さんは、朝七時から営業しているそうです。',
  'ご注文いただいた商品は、本日発送いたしました。',
  '台風の影響で、新幹線の一部区間が運転を見合わせています。',
  'ﾃｽﾄﾃﾞｰﾀは半角ｶﾀｶﾅで入力してください。',
  '①準備 ②実行 ③確認、ⅰ～ⅹの項目を順に処理する。≒∵∫√',
  '髙橋さんと﨑山さんは、来週の出張に同行します。',
];
const KO = [
  '내일 오전 열 시에 본사 회의실에서 회의가 있습니다.',
  '이번 주말에는 가족과 함께 바닷가로 여행을 갈 예정입니다.',
  '주문하신 상품은 오늘 발송되었으며 이틀 안에 도착합니다.',
  '서울의 겨울은 생각보다 훨씬 춥고 바람이 많이 붑니다.',
  '보고서는 금요일까지 제출해 주시기 바랍니다.',
  '學校 圖書館은 週末에도 開放합니다.',
  '똠방각하 쓩 뷁 햏 같은 낱말은 완성형에 없습니다.',
];

const pad = (n, w = 2) => String(n).padStart(w, '0');
const date = (r) => `${int(r, 2019, 2026)}年${int(r, 1, 12)}月${int(r, 1, 28)}日`;

function gbkNote(r, size) {
  const out = [`# ${pick(r, ZH)}${pick(r, ZH)}记录`, ''];
  while (out.join('\n').length < size) {
    const k = r();
    if (k < 0.3) {
      out.push(`| 日期 | 项目 | 数量 | 金额 |`, `|---|---|---:|---:|`);
      const rows = int(r, 2, 12);
      for (let i = 0; i < rows; i++) out.push(`| ${int(r, 1, 12)}-${pad(int(r, 1, 28))} | ${pick(r, ZH)} | ${int(r, 1, 99)}${pick(r, ['小时', '公斤', '次', '份', '台', '天'])} | ${int(r, 1, 9999)}.${pad(int(r, 0, 99))}元 |`);
      out.push('');
    } else if (k < 0.55) {
      out.push(`- ${date(r)} ${pick(r, ZH)}：${int(r, 1, 500)}${pick(r, ['元', '千元', '万元', '米', '公里', '摄氏度', '小时'])}`);
    } else if (k < 0.8) {
      out.push(pick(r, ZH_SENT));
    } else {
      out.push(`${pick(r, ZH)}${pick(r, ZH)}${pick(r, ZH)}，共计${int(r, 1, 100)}${pick(r, ['小时', '元', '一'])}，${pick(r, ['已完成', '待确认', '未开始'])}。`);
    }
  }
  return out.join('\n') + (r() < 0.8 ? '\n' : '');
}

function gbkLog(r, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const lvl = pick(r, ['INFO', 'WARN', 'ERROR', 'DEBUG']);
    out.push(`2026-${pad(int(r, 1, 12))}-${pad(int(r, 1, 28))} ${pad(int(r, 0, 23))}:${pad(int(r, 0, 59))}:${pad(int(r, 0, 59))}.${pad(int(r, 0, 999), 3)} [${lvl}] worker-${int(r, 1, 8)} ${pick(r, ['任务完成', '连接超时，正在重试', '用户登录成功', '磁盘空间不足', '读取配置文件失败', '缓存已刷新', '请求耗时'])} id=${int(r, 1000, 99999)} cost=${int(r, 1, 900)}ms`);
  }
  return out.join('\n') + '\n';
}

function csv(r, n) {
  const out = ['姓名,部门,城市,电话,入职日期,月薪,备注'];
  const names = W('王伟 李娜 张敏 刘洋 陈静 杨帆 赵磊 黄婷 周杰 吴昊 徐丽 孙强 马超 朱琳 胡斌 郭峰');
  for (let i = 0; i < n; i++) {
    const note = r() < 0.3 ? `"${pick(r, ZH_SENT).replace('，', '，"" ')}"` : pick(r, ['', '试用期', '外派', '兼职']);
    out.push(`${pick(r, names)},${pick(r, ['研发部', '市场部', '财务部', '行政部'])},${pick(r, ['北京', '上海', '深圳', '成都', '杭州'])},138${int(r, 10000000, 99999999)},${int(r, 2010, 2026)}/${int(r, 1, 12)}/${int(r, 1, 28)},${int(r, 4000, 40000)},${note}`);
  }
  return out.join('\r\n') + '\r\n';
}

function prose(r, sents, size, extra = '') {
  let s = '# ' + pick(r, sents).slice(0, int(r, 2, 6)) + '\n\n';
  while (s.length < size) {
    s += pick(r, sents);
    if (extra && r() < 0.15) s += extra[int(r, 0, extra.length - 1)];
    if (r() < 0.25) s += '\n';
    if (r() < 0.08) s += '\n- ' + pick(r, sents).slice(0, 10) + '\n';
  }
  return s.slice(0, Math.max(size, 1)) + '\n';
}

// ---------------------------------------------------------------- encoding (iconv, batched)
const SEP = '\n@@V4SEP@@\n';
function iconvMany(texts, target) {
  if (texts.length === 0) return [];
  const joined = texts.join(SEP);
  // -c drops characters the target lacks (iconv then exits 1; the output is still complete)
  const res = spawnSync('/usr/bin/iconv', ['-c', '-f', 'UTF-8', '-t', target], { input: Buffer.from(joined, 'utf8'), maxBuffer: 1 << 30 });
  if (res.status > 1 || !res.stdout) throw new Error(`iconv ${target} failed: ${res.status}`);
  const out = res.stdout;
  const sep = Buffer.from(SEP, 'latin1');
  const parts = [];
  let at = 0;
  for (;;) {
    const i = out.indexOf(sep, at);
    if (i < 0) { parts.push(out.subarray(at)); break; }
    parts.push(out.subarray(at, i));
    at = i + sep.length;
  }
  if (parts.length !== texts.length) throw new Error(`iconv split mismatch ${target}: ${parts.length} != ${texts.length}`);
  return parts.map((p) => Buffer.from(p));
}

/** GBK characters whose two GBK bytes form a valid UTF-8 two-byte sequence (lead C2..DF, trail 80..BF):
 *  the H7 family (小 D0A1, 时 CAB1, 元 D4AA, 一 D2BB …). Computed once with iconv. */
let h7Pool = null;
function h7Chars() {
  if (h7Pool) return h7Pool;
  const cands = [...new Set((ZH.join('') + ZH_SENT.join('')).replace(/[，。：、a-z0-9\s]/g, ''))];
  const enc = iconvMany(cands, 'GBK');
  h7Pool = cands.filter((c, i) => enc[i].length === 2 && enc[i][0] >= 0xc2 && enc[i][0] <= 0xdf && enc[i][1] >= 0x80 && enc[i][1] <= 0xbf);
  return h7Pool;
}

function eolVariant(s, r) {
  const k = r();
  if (k < 0.55) return s;
  if (k < 0.8) return s.replace(/\n/g, '\r\n');
  if (k < 0.9) return s.replace(/\n/g, '\r');
  let i = 0;
  return s.replace(/\n/g, () => (i++ % 3 === 0 ? '\r\n' : '\n'));
}

/** Cut a buffer inside the last multi-byte character (or anywhere). */
function cut(buf, r) {
  if (buf.length < 3) return buf;
  let at = int(r, 1, buf.length - 1);
  for (let i = buf.length - 1; i > 0 && i > buf.length - 12; i--) if (buf[i - 1] >= 0x80) { at = i; break; }
  return buf.subarray(0, at);
}

// ---------------------------------------------------------------- the corpus
export function buildCorpus(seed, opts = {}) {
  const r = rng(seed);
  const items = [];
  const jobs = []; // { target, text, name, fam, post }
  const add = (target, text, name, fam, post) => jobs.push({ target, text, name, fam, post });
  const sizes = [5, 12, 30, 80, 200, 600, 1500, 5000];
  for (let i = 0; i < 6; i++) add('CP936', eolVariant(gbkNote(r, pick(r, sizes)), r), `gbk-notes-${seed}-${i}`, 'gbk-notes');
  // H7 family: mostly characters whose GBK pairs are valid UTF-8, plus digits/ASCII and a few others
  const pool = h7Chars();
  for (let i = 0; i < 6; i++) {
    const n = int(r, 3, 400);
    let s = `# ${pick(r, pool)}${pick(r, pool)}\n\n`;
    for (let k = 0; k < n; k++) {
      const x = r();
      s += x < 0.75 ? pick(r, pool) : x < 0.85 ? String(int(r, 0, 99)) : x < 0.9 ? ' | ' : x < 0.95 ? '\n' : pick(r, ZH);
    }
    add('CP936', eolVariant(s + '\n', r), `gbk-h7-${seed}-${i}`, 'gbk-h7');
  }
  add('CP936', gbkLog(r, int(r, 1, 60)), `gbk-log-${seed}`, 'gbk-log');
  add('CP936', gbkLog(r, int(r, 1, 20)).replace(/\[ERROR\]/g, String.fromCharCode(27) + '[31m[ERROR]' + String.fromCharCode(27) + '[0m'), `gbk-log-ansi-${seed}`, 'gbk-log');
  add('CP936', csv(r, int(r, 1, 80)), `gbk-csv-${seed}`, 'gbk-csv');
  add('UTF-8', csv(r, int(r, 1, 30)), `utf8bom-csv-${seed}`, 'gbk-csv', (b) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b]));
  add('GB18030', gbkNote(r, 200) + '𠀀𪚥', `gb18030-astral-${seed}`, 'gbk-notes');
  for (let i = 0; i < 4; i++) add(pick(r, ['BIG5', 'CP950']), eolVariant(prose(r, ZH_TW, pick(r, sizes)), r), `big5-${seed}-${i}`, 'big5');
  add('BIG5-HKSCS', prose(r, ZH_TW, pick(r, sizes), HK), `big5hkscs-${seed}`, 'big5');
  add('BIG5', prose(r, ZH_TW, 60) + '第十章，卅年，═╞╡╪', `big5-dup-${seed}`, 'big5');
  for (let i = 0; i < 4; i++) add(pick(r, ['SHIFT_JIS', 'CP932']), eolVariant(prose(r, JA, pick(r, sizes)), r), `sjis-${seed}-${i}`, 'sjis');
  add('CP932', prose(r, JA.slice(5), pick(r, sizes)), `cp932-nec-${seed}`, 'sjis');
  {
    // half-width katakana CSV (kana right before ASCII: GBK and Big5 fail, 0.1.0 reads Shift_JIS)
    const KN = W('ｱｲｳ ｶｷｸ ｻｼｽ ﾀﾁﾂ ﾅﾆﾇ ﾊﾋﾌ ﾏﾐﾑ ﾔﾕﾖ ﾗﾘﾙ ﾜｦﾝ ﾃﾞｰﾀ ｺｰﾄﾞ ｼｮｳﾋﾝ ﾊﾞﾝｺﾞｳ');
    const rows = ['ｺｰﾄﾞ,ｼｮｳﾋﾝﾒｲ,ｽｳﾘｮｳ,ﾀﾝｶ'];
    for (let k = int(r, 1, 40); k > 0; k--) rows.push(`${int(r, 1, 999)},${pick(r, KN)}${pick(r, KN)},${int(r, 1, 99)},${int(r, 10, 9999)}` + (r() < 0.3 ? `,${pick(r, JA)}` : ''));
    add(pick(r, ['SHIFT_JIS', 'CP932']), rows.join(pick(r, ['\n', '\r\n'])) + '\n', `sjis-hwcsv-${seed}`, 'sjis');
  }
  for (let i = 0; i < 3; i++) add(pick(r, ['EUC-KR', 'CP949']), eolVariant(prose(r, KO.slice(0, 6), pick(r, sizes)), r), `euckr-${seed}-${i}`, 'euckr');
  add('CP949', prose(r, KO, pick(r, sizes)), `cp949-uhc-${seed}`, 'euckr');
  add('WINDOWS-1252', 'Caf' + String.fromCharCode(0xe9) + ' cr' + String.fromCharCode(0xe8) + 'me, na' + String.fromCharCode(0xef) + 've ' + String.fromCharCode(0x20ac) + int(r, 1, 99) + '\n', `cp1252-${seed}`, 'latin');

  // encode in batches per target
  const byTarget = new Map();
  for (const j of jobs) { if (!byTarget.has(j.target)) byTarget.set(j.target, []); byTarget.get(j.target).push(j); }
  for (const [target, js] of byTarget) {
    const bufs = iconvMany(js.map((j) => j.text), target);
    js.forEach((j, i) => {
      const b = j.post ? j.post(bufs[i]) : bufs[i];
      items.push({ name: j.name, fam: j.fam, buf: b });
      if (r() < 0.25) items.push({ name: j.name + '-cut', fam: j.fam + '-cut', buf: cut(b, r) });
    });
  }

  // UTF-8 with invalid bytes
  const BAD = [[0xff], [0x80], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xe4, 0xb8], [0xf4, 0x90, 0x80, 0x80], [0xfe], [0xc3]];
  for (let i = 0; i < 4; i++) {
    const base = Buffer.from(gbkNote(r, pick(r, sizes)), 'utf8');
    const nBad = pick(r, [1, 1, 2, 5, 30]);
    const parts = [];
    let at = 0;
    const cuts = Array.from({ length: nBad }, () => int(r, 0, base.length)).sort((a, b) => a - b);
    for (const c of cuts) { parts.push(base.subarray(at, c), Buffer.from(pick(r, BAD))); at = c; }
    parts.push(base.subarray(at));
    items.push({ name: `utf8-bad${nBad}-${seed}-${i}`, fam: 'utf8-bad', buf: Buffer.concat(parts) });
  }
  // UTF-16
  for (const le of [true, false]) for (const bom of [true, false]) {
    const t = pick(r, [gbkNote(r, 100), prose(r, JA, 50), 'plain ascii notes\nline two\n']);
    let b = Buffer.from(t, 'utf16le');
    if (!le) b = Buffer.from(b).swap16();
    if (bom) b = Buffer.concat([Buffer.from(le ? [0xff, 0xfe] : [0xfe, 0xff]), b]);
    if (r() < 0.2) b = b.subarray(0, b.length - 1);
    items.push({ name: `utf16${le ? 'le' : 'be'}${bom ? '-bom' : ''}-${seed}`, fam: 'utf16', buf: b });
  }
  // NULs and control characters
  {
    const u = Buffer.from(pick(r, ZH_SENT) + '\n', 'utf8');
    const ctl = [0, 7, 8, 11, 12, 27, 0x7f];
    const withCtl = (b, n) => { const a = [...b]; for (let k = 0; k < n; k++) a.splice(int(r, 0, a.length), 0, pick(r, ctl)); return Buffer.from(a); };
    items.push({ name: `utf8-ctl-${seed}`, fam: 'ctl', buf: withCtl(u, int(r, 1, 6)) });
    const g = iconvMany([pick(r, ZH_SENT) + '\n'], 'CP936')[0];
    items.push({ name: `gbk-ctl-${seed}`, fam: 'ctl', buf: withCtl(g, int(r, 1, 3)) });
    items.push({ name: `gbk-nulpad-${seed}`, fam: 'ctl', buf: Buffer.concat([g, Buffer.alloc(int(r, 1, 64))]) });
    items.push({ name: `gbk-c1-${seed}`, fam: 'ctl', buf: Buffer.concat([g, Buffer.from([0x81, 0x8d, 0x90])]) });
    items.push({ name: `ctl-only-${seed}`, fam: 'ctl', buf: Buffer.from(Array.from({ length: int(r, 1, 40) }, () => int(r, 0, 31))) });
  }
  // BOM variants
  {
    const t = pick(r, ZH_SENT);
    const v = [
      ['utf8bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(eolVariant(t + '\n' + t + '\n', r), 'utf8')])],
      ['utf8bom-gbkbody', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), iconvMany([t], 'CP936')[0]])],
      ['utf8bom-only', Buffer.from([0xef, 0xbb, 0xbf])],
      ['utf8bom-double', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), Buffer.from(t, 'utf8')])],
      ['utf16le-bom-odd', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le'), Buffer.from([0x41])])],
      ['utf32le-bom', Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), Buffer.from([...Buffer.from('ab\n', 'latin1')].flatMap((c) => [c, 0, 0, 0]))])],
      ['fffe-gbk', Buffer.concat([Buffer.from([0xff, 0xfe]), iconvMany([t], 'CP936')[0]])],
      ['febb', Buffer.from([0xef, 0xbb])],
    ];
    for (const [n, b] of v) items.push({ name: `${n}-${seed}`, fam: 'bom', buf: b });
  }
  if (opts.big) {
    // sizes around the sampling threshold (4 x 24 KiB = 98 304) and large files
    const base = iconvMany([gbkNote(r, 4000)], 'CP936')[0];
    const u8 = Buffer.from(gbkNote(r, 4000), 'utf8');
    const b5 = iconvMany([prose(r, ZH_TW, 3000)], 'CP950')[0];
    const grow = (b, n) => { const out = Buffer.alloc(n); for (let k = 0; k < n; k += b.length) b.copy(out, k, 0, Math.min(b.length, n - k)); return out; };
    for (const n of [0, 1, 2, 3, 98303, 98304, 98305, 102400, 94208, 1 << 20, 3 << 20]) {
      items.push({ name: `size-gbk-${n}`, fam: 'size', buf: grow(base, n) });
      if (n >= 98303) {
        items.push({ name: `size-u8-${n}`, fam: 'size', buf: grow(u8, n) });
        items.push({ name: `size-big5-${n}`, fam: 'size', buf: grow(b5, n) });
        const bad = Buffer.from(grow(u8, n));
        bad[Math.floor(n * 0.3)] = 0xff; // outside every sample chunk of the dormant code
        items.push({ name: `size-u8-bad-${n}`, fam: 'size', buf: bad });
      }
    }
  }
  return items;
}
