// v3-dec-corpus.mjs — seeded generators of real-looking text for the decoder differential
// (verify-decoder, 0.2.0 stage 2c). Library only (imported by v3-dec-diff.mjs and others); writes nothing.
// All text below was written for this verifier (classical passages are public-domain classics).
// Encoders: macOS iconv (real encoders) through a per-label character table built in ONE iconv call per
// label, plus the WHATWG tables of electron/fileIO.mjs for comparison.
import { execFileSync } from 'node:child_process';

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
const words = (s) => s.split(/\s+/).filter(Boolean);

// ------------------------------------------------------------------ pools (Simplified Chinese)
export const ZH_WORDS = words(`
会议 纪要 项目 进度 本周 下周 计划 目标 负责人 截止 日期 完成 待办 问题 风险 方案 讨论 结论 备注
数据库 接口 服务器 部署 测试 上线 回滚 版本 发布 文档 需求 设计 评审 代码 合并 分支 提交 修复
用户 登录 注册 密码 权限 角色 管理员 配置 参数 默认 选项 设置 缓存 日志 错误 警告 信息 调试
北京 上海 广州 深圳 杭州 成都 武汉 南京 西安 重庆 天津 苏州 长沙 郑州 青岛 沈阳 大连 厦门 昆明
今天 明天 昨天 上午 下午 晚上 星期一 星期二 星期三 星期四 星期五 周末 小时 分钟 秒 月份 年度
价格 数量 单价 合计 总计 金额 元 件 个 箱 公斤 斤 米 厘米 订单 发票 客户 供应商 仓库 库存 采购
学习 笔记 读书 摘要 第一章 第二章 概述 背景 方法 结果 分析 总结 参考 文献 例子 练习 答案 思考
天气 晴 多云 小雨 大雨 雷阵雨 温度 湿度 风力 东风 西北风 空气 质量 良好 轻度 污染 出行 建议
我们 你们 他们 这个 那个 什么 怎么 为什么 因为 所以 但是 如果 虽然 而且 或者 已经 正在 可以 需要
`);
export const ZH_SENT = [
  '今天的会议讨论了下一个版本的发布计划，大家一致同意先修复已知问题。',
  '数据库迁移需要在周末完成，负责人请提前准备回滚方案。',
  '这篇笔记记录了读书时的一些想法，以后有空再整理。',
  '注意：配置文件里的路径必须使用绝对路径，否则服务无法启动。',
  '客户反馈登录页面加载太慢，初步怀疑是图片没有压缩。',
  '本周完成了接口设计和单元测试，下周开始联调。',
  '如果遇到“权限不足”的错误，请先检查当前用户的角色设置。',
  '实验结果表明，新方法在大多数情况下比旧方法快百分之三十左右。',
  '下午三点在三楼会议室开评审会，请准时参加。',
  '我们需要一个更简单的部署流程，最好一条命令就能完成。',
  '他说明天可能会下雨，所以出行前最好带上雨伞。',
  '第一章主要介绍背景和动机，第二章给出具体的方法。',
];
export const CLASSICAL = [
  '学而时习之，不亦说乎？有朋自远方来，不亦乐乎？人不知而不愠，不亦君子乎？',
  '温故而知新，可以为师矣。',
  '知之为知之，不知为不知，是知也。',
  '三人行，必有我师焉。择其善者而从之，其不善者而改之。',
  '道可道，非常道；名可名，非常名。无名天地之始，有名万物之母。',
  '上善若水。水善利万物而不争，处众人之所恶，故几于道。',
  '天下难事，必作于易；天下大事，必作于细。',
  '千里之行，始于足下。',
  '天时不如地利，地利不如人和。',
  '鱼，我所欲也；熊掌，亦我所欲也。二者不可得兼，舍鱼而取熊掌者也。',
  '己所不欲，勿施于人。',
  '逝者如斯夫，不舍昼夜。',
  '岁寒，然后知松柏之后凋也。',
  '吾日三省吾身：为人谋而不忠乎？与朋友交而不信乎？传不习乎？',
];
export const SURNAMES = words('王 李 张 刘 陈 杨 黄 赵 吴 周 徐 孙 马 朱 胡 郭 何 高 林 罗 郑 梁 谢 宋 唐 许 韩 冯 邓 曹 彭 曾 肖 田 董 袁 潘 于 蒋 蔡 余 杜 叶 程 苏 魏 吕 丁 任 沈 姚 卢 姜 崔 钟 谭 陆 汪 范 金 石 廖 贾 夏 韦 付 方 白 邹 孟 熊 秦 邱 江 尹 薛 闫 段 雷 侯 龙 史 陶 黎 贺 顾 毛 郝 龚 邵 万 钱 严 覃 武 戴 莫 孔 向 汤');
export const GIVEN = words('伟 芳 娜 敏 静 丽 强 磊 军 洋 勇 艳 杰 娟 涛 明 超 秀 霞 平 刚 桂 英 华 玉 萍 红 鹏 辉 建 文 婷 宇 浩 凯 欣 怡 婧 琳 晨 宁 欢 雪 斌 波 慧 玲 晶 颖 倩 帆 鑫 琪 瑶 璐 昊 轩 泽 睿 博 涵 梓 萱 诗 雨 思 子 一 嘉 佳');
export const STREETS = words('人民路 解放路 中山路 建设路 和平路 胜利路 文化路 新华路 长江路 黄河路 光明街 幸福里 朝阳区 海淀区 浦东新区 天河区 南山区 西湖区 武侯区 江汉区 鼓楼区 雁塔区');
export const SONG = words('晚风 星河 远方 故乡 夏天 小城 回忆 微光 海边 山丘 月亮 灯火 旅途 时光 青春 雨夜 清晨 花开 归来 少年');

// Traditional Chinese (to be written in GBK and in Big5)
export const HANT_SENT = [
  '這份報告說明了專案目前的進度，以及下個階段需要處理的問題。',
  '請在會議開始前閱讀附件中的資料，並準備好你的意見。',
  '臺灣的氣候屬於亞熱帶，夏天炎熱潮濕，冬天溫和。',
  '圖書館週末開放時間為上午九點到下午五點。',
  '這個軟體的使用說明寫得很清楚，連第一次接觸的人也看得懂。',
  '經過長時間的討論，委員會終於決定延後實施新規定。',
  '學習語言最重要的是持之以恆，每天練習一點點。',
  '颱風來襲前，政府呼籲民眾做好防颱準備。',
  '飲食均衡、規律運動，是維持健康的不二法門。',
  '舊書店裡藏著許多絕版的好書，值得慢慢尋找。',
];

// Japanese
export const JA_KANJI = [
  '本規約は当社が提供する全ての役務の利用条件を定める。',
  '第一条　本契約の目的は甲乙間の業務委託に関する基本的事項を定めることにある。',
  '国土交通省は来年度予算案に道路整備費を計上した。',
  '東京都千代田区丸の内一丁目一番一号',
  '株式会社山田製作所　代表取締役社長　山田太郎',
  '平成三十一年四月一日施行、令和五年改正。',
  '経済産業省発表、前年同期比三割増加。',
  '大阪府大阪市北区梅田三丁目',
  '会議室予約管理表（第二四半期）',
  '品質管理部門責任者会議議事録',
];
export const JA_KANA = [
  'これはテストです。今日はいい天気ですね。',
  'ファイルを保存してから、もう一度開いてください。',
  'メモ：明日の会議は午後二時からです。資料を忘れないように。',
  'この機能はまだ実験的なものなので、ご注意ください。',
  'すみません、駅はどこですか。まっすぐ行って右です。',
];
export const JA_KATA = words('コーヒー ミルク パン チーズ バター ジャム トマト レタス キャベツ オレンジ バナナ リンゴ メロン ブドウ イチゴ サーバー データベース ネットワーク セキュリティ アカウント パスワード ログイン ダウンロード アップデート インストール ファイル フォルダ プリンタ キーボード マウス モニター');
// Half-width katakana (Shift_JIS single bytes A1–DF): receipts, old CSV exports, bank statements.
export const JA_HW = words('ﾃﾞｰﾀ ｶﾞｲﾄﾞ ｺｰﾋｰ ﾐﾙｸ ﾊﾟﾝ ﾁｰｽﾞ ｻｰﾊﾞｰ ﾌｧｲﾙ ﾌｫﾙﾀﾞ ﾌﾘｺﾐ ｶ)ﾔﾏﾀﾞｾｲｻｸｼﾖ ｹﾞﾝｷﾝ ｶｰﾄﾞ ﾃｽﾄ ｱｲｳｴｵ ｶｷｸｹｺ ﾔﾏﾀﾞ ﾀﾛｳ ｽｽﾞｷ ｻﾄｳ ﾀﾅｶ ﾜﾀﾅﾍﾞ ｲﾄｳ ｺﾊﾞﾔｼ ﾄｳｷﾖｳ ｵｵｻｶ ｷﾖｳﾄ ｶﾌﾞｼｷｶﾞｲｼﾔ ｿﾌﾄｳｪｱ ｼｽﾃﾑ');

// Korean, with and without Hanja
export const KO_SENT = [
  '오늘 회의에서는 다음 버전의 출시 일정을 논의했습니다.',
  '데이터베이스 마이그레이션은 주말에 진행할 예정입니다.',
  '이 문서는 사용자 설명서의 초안입니다. 의견을 보내 주세요.',
  '서울특별시 종로구 세종대로 이백구',
  '내일은 비가 올 수도 있으니 우산을 챙기세요.',
];
export const KO_HANJA = [
  '大韓民國은 民主共和國이다. 大韓民國의 主權은 國民에게 있고, 모든 權力은 國民으로부터 나온다.',
  '本 契約은 甲과 乙 사이의 業務 委託에 關한 基本 事項을 定함을 目的으로 한다.',
  '韓國 經濟는 輸出 中心의 成長 戰略으로 急速히 發展하였다.',
  '學而時習之 不亦說乎',
  '金氏 李氏 朴氏 崔氏 鄭氏 姜氏 趙氏 尹氏 張氏 林氏',
];

// Single-byte code pages nobody used yet
export const VI = ['Tiếng Việt là ngôn ngữ chính thức của Việt Nam.', 'Hôm nay trời đẹp, chúng ta đi dạo nhé.', 'Cuộc họp sẽ bắt đầu lúc ba giờ chiều.', 'Xin vui lòng lưu tệp trước khi đóng chương trình.', 'Đường Nguyễn Huệ, Quận 1, Thành phố Hồ Chí Minh'];
export const TH = ['ภาษาไทยเป็นภาษาราชการของประเทศไทย', 'วันนี้อากาศดีมาก เราไปเดินเล่นกันไหม', 'การประชุมจะเริ่มเวลาบ่ายสามโมง', 'กรุณาบันทึกไฟล์ก่อนปิดโปรแกรม', 'กรุงเทพมหานคร ประเทศไทย'];
export const HE = ['עברית היא השפה הרשמית של מדינת ישראל.', 'היום מזג האוויר יפה, בואו נצא לטייל.', 'הפגישה תתחיל בשעה שלוש אחר הצהריים.', 'נא לשמור את הקובץ לפני סגירת התוכנית.', 'רחוב הרצל, תל אביב'];
export const AR = ['اللغة العربية هي اللغة الرسمية في كثير من الدول.', 'الطقس جميل اليوم، هيا نتمشى قليلا.', 'سيبدأ الاجتماع في الساعة الثالثة بعد الظهر.', 'يرجى حفظ الملف قبل إغلاق البرنامج.', 'شارع الملك فهد، الرياض'];
export const LATIN_MD = ['Résumé des tâches', 'Größe und Maße', 'Año nuevo, señor', 'Ação e atenção', 'Ærø og Øresund', 'Þórsmörk ferð', 'Café crème brûlée', 'naïve façade', '“quoted” – dash … ellipsis € 12,50'];

// ------------------------------------------------------------------ generators
const ASCII_WORDS = words('the server config user login error warning release version build test data file path http https api json yaml todo note see also and or not for with from into');

function zhPhrase(r, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += pick(r, ZH_WORDS);
  return s;
}
function name(r) {
  return pick(r, SURNAMES) + pick(r, GIVEN) + (r() < 0.6 ? pick(r, GIVEN) : '');
}

/** Markdown notes: headings, lists, tables, code with CJK comments, URLs, numbers, mixed text. */
export function zhMarkdown(r) {
  const out = [];
  out.push(`# ${zhPhrase(r, int(r, 1, 3))}`);
  const blocks = int(r, 2, 8);
  for (let b = 0; b < blocks; b++) {
    const k = int(r, 0, 7);
    if (k === 0) out.push('', `## ${zhPhrase(r, 2)}`, '');
    else if (k === 1) {
      out.push('');
      for (let i = 0, n = int(r, 2, 6); i < n; i++) out.push(`${r() < 0.5 ? '-' : `${i + 1}.`} ${zhPhrase(r, int(r, 1, 4))}${r() < 0.3 ? `（${int(r, 1, 99)}%）` : ''}`);
    } else if (k === 2) {
      out.push('', `| ${zhPhrase(r, 1)} | ${zhPhrase(r, 1)} | ${zhPhrase(r, 1)} |`, '|---|---|---|');
      for (let i = 0, n = int(r, 1, 8); i < n; i++) out.push(`| ${name(r)} | ${int(r, 1, 9999)} ${pick(r, ['元', '件', '个', '小时', '分钟', '公斤'])} | ${pick(r, ZH_WORDS)} |`);
    } else if (k === 3) {
      out.push('', '```js', `// ${zhPhrase(r, 2)}`, `const ${pick(r, ['a', 'b', 'cfg', 'user'])} = load('${pick(r, ASCII_WORDS)}.json'); // ${zhPhrase(r, 1)}`, '```');
    } else if (k === 4) out.push('', `参考：https://example.com/${pick(r, ASCII_WORDS)}/${int(r, 1, 999)} ，${pick(r, ZH_SENT)}`);
    else if (k === 5) out.push('', `${pick(r, ZH_SENT)} ${pick(r, ASCII_WORDS)} ${pick(r, ZH_SENT)}`);
    else if (k === 6) out.push('', `> ${pick(r, CLASSICAL)}`);
    else out.push('', `- [${r() < 0.5 ? 'x' : ' '}] ${zhPhrase(r, 2)} @${name(r)} ${int(r, 1, 12)}月${int(r, 1, 28)}日`);
  }
  return out.join('\n') + '\n';
}
export function zhClassical(r) {
  let s = '';
  for (let i = 0, n = int(r, 1, 6); i < n; i++) s += pick(r, CLASSICAL);
  return s + (r() < 0.8 ? '\n' : '');
}
export function zhNamesCsv(r) {
  const out = ['姓名,电话,地址'];
  for (let i = 0, n = int(r, 1, 30); i < n; i++) out.push(`${name(r)},1${int(r, 3, 9)}${String(int(r, 0, 999999999)).padStart(9, '0')},${pick(r, ['北京市', '上海市', '广东省广州市', '浙江省杭州市', '四川省成都市'])}${pick(r, STREETS)}${int(r, 1, 300)}号`);
  return out.join('\n') + '\n';
}
export function zhSongs(r) {
  const out = [];
  for (let i = 0, n = int(r, 1, 25); i < n; i++) out.push(`${String(i + 1).padStart(2, '0')}. ${pick(r, SONG)}${r() < 0.4 ? pick(r, SONG) : ''} - ${name(r)}`);
  return out.join('\n') + '\n';
}
export function zhSubtitles(r) {
  const out = [];
  let t = int(r, 0, 3000);
  for (let i = 0, n = int(r, 1, 15); i < n; i++) {
    const a = t, b = t + int(r, 1, 6);
    const ts = (s) => `00:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},${String(int(r, 0, 999)).padStart(3, '0')}`;
    out.push(String(i + 1), `${ts(a)} --> ${ts(b)}`, pick(r, ZH_SENT).slice(0, int(r, 4, 30)), '');
    t = b + 1;
  }
  return out.join('\n');
}
export function zhLog(r) {
  const out = [];
  for (let i = 0, n = int(r, 1, 30); i < n; i++) out.push(`2026-11-${String(int(r, 1, 28)).padStart(2, '0')} ${String(int(r, 0, 23)).padStart(2, '0')}:${String(int(r, 0, 59)).padStart(2, '0')}:${String(int(r, 0, 59)).padStart(2, '0')} [${pick(r, ['INFO', 'WARN', 'ERROR', 'DEBUG'])}] ${pick(r, ['用户登录成功', '连接数据库失败，重试中', '缓存已清空', '订单已创建', '权限不足', '配置已加载', '任务完成，耗时', '请求超时'])} uid=${int(r, 1, 99999)} ${r() < 0.3 ? `${int(r, 1, 999)}毫秒` : ''}`);
  return out.join('\n') + '\n';
}
/** Short structured sheets with a small repeated vocabulary (timesheets, price lists, check lists). */
export function zhSheet(r) {
  const unit = pick(r, ['小时', '元', '件', '个', '次', '天', '小时', '分', '斤', '人']);
  const head = pick(r, ['工时', '价格', '日期', '记录', '统计', '清单', '明细', '数量']);
  const out = [r() < 0.5 ? `# ${head}` : `${head}`];
  if (r() < 0.5) out.push('', `| ${pick(r, ['日期', '项目', '名称'])} | ${pick(r, ['时长', '金额', '数量'])} |`, '|---|---|');
  for (let i = 0, n = int(r, 3, 60); i < n; i++) out.push(r() < 0.5 ? `| 11-${String(i % 28 + 1).padStart(2, '0')} | ${int(r, 1, 99)}${unit} |` : `${i + 1},${int(r, 1, 99)}${unit}`);
  if (r() < 0.6) out.push('', `${pick(r, ['合计', '总计', '小计'])} ${int(r, 100, 999)} ${unit}`);
  return out.join('\n') + '\n';
}
export function hantText(r) {
  let s = '';
  for (let i = 0, n = int(r, 1, 6); i < n; i++) s += pick(r, HANT_SENT) + (r() < 0.3 ? '\n\n' : '');
  return (r() < 0.5 ? `# ${pick(r, ['報告', '說明', '筆記', '會議紀錄'])}\n\n` : '') + s + '\n';
}
export function jaKanji(r) {
  let s = '';
  for (let i = 0, n = int(r, 1, 6); i < n; i++) s += pick(r, JA_KANJI) + '\n';
  return s;
}
export function jaMixed(r) {
  let s = '';
  for (let i = 0, n = int(r, 1, 6); i < n; i++) s += pick(r, r() < 0.5 ? JA_KANA : JA_KANJI) + '\n';
  return s;
}
export function jaKata(r) {
  const out = [];
  for (let i = 0, n = int(r, 1, 30); i < n; i++) out.push(`- ${pick(r, JA_KATA)}${r() < 0.3 ? ` ${int(r, 1, 999)}` : ''}`);
  return out.join('\n') + '\n';
}
export function jaHalfwidth(r) {
  const out = [];
  for (let i = 0, n = int(r, 1, 30); i < n; i++) {
    const k = int(r, 0, 2);
    if (k === 0) out.push(`${int(r, 1, 9999)},${pick(r, JA_HW)},${int(r, 100, 99999)}`);
    else if (k === 1) out.push(`${pick(r, JA_HW)} ${pick(r, JA_HW)}`);
    else out.push(`${pick(r, JA_HW)}${pick(r, JA_HW)}`);
  }
  return out.join(pick(r, ['\n', '\r\n'])) + (r() < 0.7 ? '\n' : '');
}
export function koText(r, hanjaShare) {
  let s = '';
  for (let i = 0, n = int(r, 1, 6); i < n; i++) s += pick(r, r() < hanjaShare ? KO_HANJA : KO_SENT) + '\n';
  return s;
}
export function sbText(r, pool) {
  let s = '';
  for (let i = 0, n = int(r, 1, 8); i < n; i++) s += pick(r, pool) + (r() < 0.5 ? '\n' : ' ');
  return s;
}

// ------------------------------------------------------------------ encoders
const iconvTables = new Map();
/** char → Buffer for an iconv target (one iconv call per label for the given characters; LF is never
 *  part of a multi-byte sequence in these encodings, so the lines stay aligned). */
export function iconvTable(label, chars) {
  let t = iconvTables.get(label);
  if (!t) { t = new Map(); iconvTables.set(label, t); }
  const todo = [...new Set(chars)].filter((c) => !t.has(c) && c !== '\n');
  if (todo.length) {
    const input = Buffer.from(todo.join('\n') + '\n', 'utf8');
    let out;
    try {
      out = execFileSync('iconv', ['-c', '-f', 'UTF-8', '-t', label], { input, maxBuffer: 1 << 26, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
      out = e.stdout || Buffer.alloc(0);
    }
    const parts = [];
    let s = 0;
    for (let i = 0; i < out.length; i++) if (out[i] === 0x0a) { parts.push(out.subarray(s, i)); s = i + 1; }
    for (let i = 0; i < todo.length; i++) t.set(todo[i], parts[i] && parts[i].length ? Buffer.from(parts[i]) : null);
  }
  return t;
}
/** text → bytes through iconv's table for `label`, or null when a character is not representable. */
export function iconvEncode(text, label) {
  const chars = Array.from(text);
  const t = iconvTable(label, chars);
  const out = [];
  for (const c of chars) {
    if (c === '\n') { out.push(Buffer.from([0x0a])); continue; }
    const b = t.get(c);
    if (!b) return null;
    out.push(b);
  }
  return Buffer.concat(out);
}
/** text → bytes through a fileIO-style Map table (char → [bytes]), or null. */
export function tableEncode(text, table) {
  const out = [];
  for (const c of text) {
    const b = table.get(c);
    if (!b) return null;
    for (const x of b) out.push(x);
  }
  return Buffer.from(out);
}
export function withEol(text, eol) {
  if (eol === 'crlf') return text.replace(/\n/g, '\r\n');
  if (eol === 'cr') return text.replace(/\n/g, '\r');
  if (eol === 'mixed') { let i = 0; return text.replace(/\n/g, () => (i++ % 2 ? '\r\n' : '\n')); }
  return text;
}
