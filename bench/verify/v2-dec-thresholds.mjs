// v2-dec-thresholds.mjs — attacks the new decoder rules of electron/fileIO.mjs at their thresholds and
// compares with the frozen 0.1.0 decoder (test/fixtures/fileIO-0.1.0.mjs). verify-decoder, 0.2.0 stage 2a.
// Run: PART=gbkpools node bench/verify/v2-dec-thresholds.mjs   (PART = gbkpools | latin | lenient8 | nul | ctrl | all)
// Prints counts only; writes nothing. Global timeout 110 s.
import * as neu from '../../electron/fileIO.mjs';
import * as old from '../../test/fixtures/fileIO-0.1.0.mjs';
import { rng, pick, int, encode, HANT, LATIN, ZH } from './v2-dec-corpus.mjs';

setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000).unref();
const PART = process.env.PART || 'all';
const PER = Number(process.env.PER || 1500);
const dec = (f, b) => { try { return f(b); } catch (e) { return { error: e.message, encoding: 'REFUSED' } } };
const show = (x) => x.error ? 'REFUSED' : x.encoding + (x.replaced ? '+R' + x.replaced : '');

// ---- character pools from the GBK table
const gbkTable = old.legacyEncoderTable('gbk');
const pools = { top: [], l1: [], l2: [], gbk3: [], gbk4: [], hantText: [], rare: [] };
const TOP = new Set([...'的一是不了人我在有他这为之大来以个中上们到说国和地也子时道出而要于就下得可你年生自会那后能对着事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与好看学进种将还分此心前面又定见只主没公从已向关本开文动工实现长内点高正新问通意理明使气物外机等全部力表间性体加被重知及电相但样手头很最美回位度次员西应因话四做感线解系政两期利提百情何资题任社比给原入合活世少五接件九才区放程更名白展变口北山教月车条至林质八再别带结光整近单族制象联反志听记建打报片论元边量深强计今神转平眼每包老受即拉图石色海路张果难华权指六门品运决信农保收特斗书声证改总直取务米金命南连安府须设管七太识复革切亲队委快千格']);
for (const [ch, b] of gbkTable) {
  if (b.length !== 2) continue;
  const code = (b[0] << 8) | b[1];
  const cp = ch.codePointAt(0);
  if (cp < 0x4e00 || cp > 0x9fff) continue;
  if (TOP.has(ch)) pools.top.push(ch);
  else if (code >= 0xb0a1 && code <= 0xd7fe && b[1] >= 0xa1) pools.l1.push(ch);
  else if (code >= 0xd8a1 && code <= 0xf7fe && b[1] >= 0xa1) pools.l2.push(ch);
  else if (b[0] >= 0x81 && b[0] <= 0xa0) pools.gbk3.push(ch);
  else pools.gbk4.push(ch);
}
for (const s of HANT) for (const ch of s) if (gbkTable.has(ch) && /\p{Script=Han}/u.test(ch)) pools.hantText.push(ch);
pools.rare = [...'堃喆昇祎玥赟镕珺琍瑢翀旻甯堉鍪龘曌囧槑燚犇淼鑫焱垚靐罍彧昉昰'].filter((c) => gbkTable.has(c));

function gbkPools() {
  console.log('== GBK text that 0.1.0 reads correctly (always: GBK decodes cleanly), candidate answer by pool / layout / length');
  const seps = { run: () => '', spaced: (r) => pick(r, [' ', ' | ', ', ', '\n- ', '：']) };
  const fwp = ['，', '。', '、', '；'];
  for (const pool of Object.keys(pools)) for (const lay of ['run', 'spaced', 'sentence']) {
    const row = [];
    let worst = null;
    for (const k of [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 19, 20, 21, 25, 30, 40]) {
      const r = rng(k * 131 + pool.length * 17 + lay.length);
      let bad = 0, n = 0;
      for (let i = 0; i < PER; i++) {
        let s = '';
        for (let j = 0; j < k; j++) {
          s += pick(r, pools[pool]);
          if (lay === 'spaced' && j < k - 1) s += seps.spaced(r);
          if (lay === 'sentence' && j < k - 1 && r() < 0.12) s += pick(r, fwp);
        }
        if (lay === 'sentence') s = pick(r, ['', '# ', '- ', '> ']) + s + pick(r, ['。', '', '\n']);
        const b = encode(s, 'gbk');
        if (!b) continue;
        n++;
        const o = dec(old.decodeBuffer, b), c = dec(neu.decodeBuffer, b);
        if (o.text === s && c.text !== s) { bad++; if (!worst || worst.k > k) worst = { k, s, got: show(c), hex: b.toString('hex') }; }
      }
      row.push(`${k}:${bad}`);
    }
    console.log(`${pool.padEnd(9)} ${lay.padEnd(8)} wrong/${PER}: ${row.join(' ')}${worst ? `  first: ${JSON.stringify(worst)}` : ''}`);
  }
}

function latin() {
  console.log('== windows-1252 Latin text, per language: 0.1.0 right & candidate wrong (regressions)');
  const extra = {
    pt: ['INFORMAÇÕES IMPORTANTES', 'Atenção: a instalação não está concluída.', 'ORIENTAÇÕES GERAIS', 'Configurações e opções de exportação.', 'São Paulo, março de 2026.', 'Não há solução.'],
    es: ['¿Ésta es la canción? ¡Ánimo!', 'AÑO NUEVO — ÉXITO', 'Pequeño año, mañana señor.'],
    fr: ['ÉTÉ ÉCOLE ÉLÉMENTAIRE', 'Château, forêt, élève, déjà, où.', '« Ça va ? » — « Très bien. »'],
    de: ['ÄÖÜ GRÖSSE', 'Größe, Maß, Füße, Öl.', 'Schöne Grüße aus Köln.'],
    is: ['Þjóðhátíð í Eyjum.', 'ÍSLENSKA ÞJÓÐIN', 'Ég á æðislegan dag.'],
    da: ['Ærø, Æbelø og Ålborg.', 'Smørrebrød og øl.', 'BLÅBÆRGRØD'],
    ca: ['L’àvia té una cançó.', 'Això és molt bonic.', 'Col·lecció d’art.'],
  };
  for (const lang of Object.keys(extra)) {
    const sents = [...(LATIN[lang] || []), ...extra[lang]];
    let bad = 0, n = 0, ex = null;
    const r = rng(lang.charCodeAt(0) * 7 + lang.charCodeAt(1));
    for (let i = 0; i < PER * 2; i++) {
      const parts = [];
      for (let j = int(r, 1, 6); j > 0; j--) parts.push(pick(r, sents));
      const s = (r() < 0.3 ? '# ' + pick(r, sents) + '\n\n' : '') + parts.join(pick(r, [' ', '\n', '\n\n']));
      const b = encode(s, 'windows-1252');
      if (!b) continue;
      n++;
      const o = dec(old.decodeBuffer, b), c = dec(neu.decodeBuffer, b);
      if (o.text === s && c.text !== s) { bad++; if (!ex || s.length < ex.s.length) ex = { s, got: show(c), text: c.text?.slice(0, 60) }; }
    }
    console.log(`${lang}: ${bad}/${n} regressions${ex ? ' shortest: ' + JSON.stringify(ex) : ''}`);
  }
}

function lenient8() {
  console.log('== UTF-8 Chinese with k stray bytes (0xFF / 0x80 / a cut GBK char): candidate answer by valid-char count');
  for (const stray of [[0xff], [0x80], [0xc4], [0xd6, 0xd0]]) {
    const row = [];
    for (const nValid of [1, 4, 7, 8, 9, 12, 20, 50, 200]) {
      const r = rng(nValid * 31 + stray[0]);
      const tally = {};
      for (let i = 0; i < 300; i++) {
        let s = '';
        while ([...s].filter((c) => c.codePointAt(0) > 127).length < nValid) s += pick(r, ZH);
        s = [...s].reduce((acc, ch) => ([...acc].filter((c) => c.codePointAt(0) > 127).length >= nValid && ch.codePointAt(0) > 127 ? acc : acc + ch), '');
        const u = Buffer.from(s, 'utf8');
        const at = int(r, 0, u.length);
        // insert at a character boundary
        let p = at; while (p < u.length && (u[p] & 0xc0) === 0x80) p++;
        const b = Buffer.concat([u.subarray(0, p), Buffer.from(stray), u.subarray(p)]);
        const c = dec(neu.decodeBuffer, b);
        const key = show(c).replace(/\+R\d+/, '+R');
        tally[key] = (tally[key] || 0) + 1;
      }
      row.push(`${nValid}:${JSON.stringify(tally)}`);
    }
    console.log(`stray ${Buffer.from(stray).toString('hex')}: ${row.join(' ')}`);
  }
}

function nul() {
  console.log('== NUL density: UTF-8 Markdown with NULs on one side of share p of the byte pairs');
  for (const p of [0.02, 0.05, 0.1, 0.2, 0.3, 0.38, 0.39, 0.4, 0.41, 0.45, 0.6]) {
    const tally = {}; const told = {};
    const r = rng(Math.round(p * 1000));
    for (let i = 0; i < 300; i++) {
      // ASCII-only Markdown of even length, NUL placed at an odd position in share p of the pairs
      let s = '# Title\n\nSome text with words and numbers 12345.\n'.repeat(int(r, 1, 4));
      if (s.length % 2) s += '\n';
      const b = Buffer.from(s, 'utf8');
      const pairs = b.length / 2;
      for (let q = 0; q < pairs; q++) if (r() < p) b[2 * q + 1] = 0;
      const o = dec(old.decodeBuffer, b), c = dec(neu.decodeBuffer, b);
      tally[show(c)] = (tally[show(c)] || 0) + 1;
      told[show(o)] = (told[show(o)] || 0) + 1;
    }
    console.log(`p=${p}: candidate ${JSON.stringify(tally)} 0.1.0 ${JSON.stringify(told)}`);
  }
  console.log('== GBK / windows-1252 text with sparse NULs (0.1.0 refuses all: NUL is a control char)');
  for (const p of [0.01, 0.04, 0.05, 0.06, 0.1]) {
    const tally = {}; const r = rng(Math.round(p * 997));
    for (let i = 0; i < 300; i++) {
      let s = pick(r, ZH) + pick(r, ZH) + '\n';
      let b = encode(s, 'gbk'); if (b.length % 2) b = Buffer.concat([b, Buffer.from('\n')]);
      for (let q = 0; q < b.length / 2; q++) if (r() < p) { b[2 * q + 1] = 0; }
      const c = dec(neu.decodeBuffer, b);
      tally[show(c)] = (tally[show(c)] || 0) + 1;
    }
    console.log(`gbk p=${p}: candidate ${JSON.stringify(tally)}`);
  }
}

function ctrl() {
  console.log('== strict UTF-8 with hard control characters at share q (0.1.0 opens all strict UTF-8)');
  for (const q of [0.1, 0.3, 0.45, 0.49, 0.5, 0.51, 0.6]) {
    const tally = {}; const r = rng(Math.round(q * 1009));
    for (let i = 0; i < 300; i++) {
      const s = [...(pick(r, ZH) + 'abc def\n')];
      const out = [];
      for (const ch of s) { out.push(ch); }
      const nCtrl = Math.round((q * out.length) / (1 - q));
      for (let k = 0; k < nCtrl; k++) out.splice(int(r, 0, out.length), 0, String.fromCharCode(pick(r, [1, 2, 3, 0x10, 0x7f])));
      const c = dec(neu.decodeBuffer, Buffer.from(out.join(''), 'utf8'));
      tally[show(c)] = (tally[show(c)] || 0) + 1;
    }
    console.log(`q=${q}: candidate ${JSON.stringify(tally)}`);
  }
}

if (PART === 'gbkpools' || PART === 'all') gbkPools();
if (PART === 'latin' || PART === 'all') latin();
if (PART === 'lenient8' || PART === 'all') lenient8();
if (PART === 'nul' || PART === 'all') nul();
if (PART === 'ctrl' || PART === 'all') ctrl();
console.log('pool sizes', Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length])));
