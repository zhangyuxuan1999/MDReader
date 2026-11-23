// bench/verify/v5-offc-rest.mjs — audit-off-code (0.2.0 stage 2e): the preview AT REST, candidate with the switch
// 预览可编辑 OFF (MDR_PORT, stored "0" before load) against the 0.1.1 baseline (MDR_BASE_PORT, ?perf=1).
//   css          every stylesheet rule of both pages, split per single selector and @media context, diffed per
//                declaration (candidate-only / baseline-only)
//   dom:<doc>    per block, the mounted HTML (data-id, style, the focus tint and data-mdr-x left out) after mountAll
//   style:<doc>  computed style of one element of every kind at rest, under the pointer, and the elements the
//                keyboard focus reaches (Tab from a click in the preview) with their focus style
//   <doc> = small (test-data/small.md) | readme (README.md) | all (DOC_ALL of v5-offc-lib.mjs)
//   MDR_PORT=5511 MDR_BASE_PORT=5512 node bench/verify/v5-offc-rest.mjs css dom:all style:all ...
// Exit 1 when something differs. Writes nothing into the tree; needs both servers listening.
import { readFileSync } from 'node:fs';
import { PORT, BASE_PORT, sleep, DOC_ALL, open, loadDoc, pointOf, clickAt, restBlocks, diffKeys } from './v5-offc-lib.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, Number(process.env.MDR_TIMEOUT || 110_000));
const DOCS = {
  small: () => readFileSync(`${ROOT}test-data/small.md`, 'utf8'),
  readme: () => readFileSync(`${ROOT}README.md`, 'utf8'),
  all: () => DOC_ALL,
};
const PROPS = ['cursor', 'user-select', '-webkit-user-select', '-webkit-user-modify', '-webkit-user-drag', 'outline-style', 'outline-width', 'outline-color', 'outline-offset',
  'caret-color', 'white-space', 'pointer-events', 'min-height', 'margin-top', 'margin-bottom', 'padding-top', 'padding-left', 'color', 'background-color',
  'border-radius', 'display', 'text-decoration-line', 'font-weight', 'box-shadow', 'opacity', 'content-visibility', 'line-height', 'font-size'];
const SAMPLES = ['section.md-block', 'h1', 'h2', 'h3', 'p', 'strong', 'em', 'del', 'a', 'code', 'pre', 'pre code', '.md-codewrap', 'ul', 'ol', 'li', 'li.task-list-item',
  'input[type="checkbox"]', 'blockquote', 'table', 'th', 'td', 'img', '.katex', '.md-math', '.katex-display', '.footnote-ref a', 'section.footnotes', 'hr', 'div.raw'];

async function cssRules(B) {
  return B.page.evaluate(() => {
    const out = {};
    const walk = (rules, ctx) => {
      for (const r of rules) {
        if (r.type === 1) {
          const decls = {};
          for (let i = 0; i < r.style.length; i++) { const p = r.style[i]; decls[p] = r.style.getPropertyValue(p).trim() + (r.style.getPropertyPriority(p) ? ' !important' : ''); }
          for (const sel of r.selectorText.split(/,(?![^(]*\))/).map((x) => x.trim().replace(/\s+/g, ' '))) {
            const key = `${ctx}${sel}`;
            out[key] = Object.assign(out[key] ?? {}, decls);
          }
          if (r.cssRules && r.cssRules.length) walk(r.cssRules, `${ctx}${r.selectorText} & `);
        } else if (r.cssRules) {
          const head = r.cssText.slice(0, r.cssText.indexOf('{')).trim().replace(/\s+/g, ' ');
          walk(r.cssRules, `${ctx}${head} :: `);
        } else if (r.type === 5) {
          out[`@font-face ${r.style.getPropertyValue('font-family')} ${r.style.getPropertyValue('font-weight')} ${r.style.getPropertyValue('font-style')}`] = { present: '1' };
        }
      }
    };
    for (const s of document.styleSheets) { try { walk(s.cssRules, ''); } catch { /* cross-origin */ } }
    return out;
  });
}

async function styleSamples(B) {
  return B.page.evaluate(({ PROPS, SAMPLES }) => {
    const root = document.querySelector('.mdr-preview__body');
    const out = {};
    for (const css of [...SAMPLES, '.mdr-preview', '.mdr-preview__body']) {
      const e = css.startsWith('.mdr-preview') ? document.querySelector(css) : root.querySelector(css);
      if (!e) { out[css] = null; continue; }
      const cs = getComputedStyle(e);
      out[css] = Object.fromEntries(PROPS.map((p) => [p, cs.getPropertyValue(p)]));
    }
    return out;
  }, { PROPS, SAMPLES });
}

async function hoverSamples(B) {
  const out = {};
  for (const css of SAMPLES) {
    const p = await B.page.evaluate((css) => {
      const root = document.querySelector('.mdr-preview');
      const e = root.querySelector('.mdr-preview__body').querySelector(css);
      if (!e) return null;
      let r = e.getBoundingClientRect();
      const box = root.getBoundingClientRect();
      if (r.top < box.top + 4 || r.bottom > box.bottom - 4) { root.scrollTop += r.top - (box.top + box.height / 3); r = e.getBoundingClientRect(); }
      return { x: r.left + Math.min(r.width / 2, 6), y: r.top + Math.min(r.height / 2, 6) };
    }, css);
    if (!p) { out[css] = null; continue; }
    await B.page.mouse.move(p.x, p.y);
    await sleep(60);
    out[css] = await B.page.evaluate(({ css, PROPS, x, y }) => {
      const e = document.querySelector('.mdr-preview__body').querySelector(css);
      const cs = getComputedStyle(e);
      const under = document.elementFromPoint(x, y);
      const ucs = under ? getComputedStyle(under) : null;
      return { ...Object.fromEntries(['cursor', 'outline-style', 'background-color', 'color', 'text-decoration-line', 'opacity'].map((p) => [p, cs.getPropertyValue(p)])), underCursor: ucs ? ucs.cursor : null, underTag: under ? under.tagName.toLowerCase() : null };
    }, { css, PROPS, x: p.x, y: p.y });
  }
  await B.page.mouse.move(2, 2);
  return out;
}

async function focusWalk(B) {
  const p = await pointOf(B.page, 'First paragraph', 2) ?? await pointOf(B.page, ' ', 0);
  if (p) await clickAt(B.page, p);
  await sleep(300);
  const out = [];
  for (let i = 0; i < 6; i++) {
    await B.page.keyboard.press('Tab');
    await sleep(120);
    out.push(await B.page.evaluate(() => {
      const e = document.activeElement;
      const root = document.querySelector('.mdr-preview');
      if (!e || e === document.body) return 'body';
      const cs = getComputedStyle(e);
      const where = root.contains(e) ? 'preview' : e.closest('.cm-editor') ? 'editor' : 'other';
      return `${where}:${e.tagName.toLowerCase()}${e.getAttribute('href') ? '[' + e.getAttribute('href').slice(0, 24) + ']' : ''} outline=${cs.outlineStyle}/${cs.outlineWidth}/${cs.outlineColor} fv=${e.matches(':focus-visible')}`;
    }));
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) { console.log('cases: css dom:<small|readme|all> style:<small|readme|all>'); return 0; }
  const C = await open(PORT);
  const Bb = await open(BASE_PORT, { base: true });
  let bad = 0;
  try {
    for (const a of args) {
      if (a === 'css') {
        const [x, y] = [await cssRules(C), await cssRules(Bb)];
        const lines = [];
        for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
          const dx = x[k] ?? {}, dy = y[k] ?? {};
          for (const p of new Set([...Object.keys(dx), ...Object.keys(dy)])) {
            if (dx[p] === dy[p]) continue;
            lines.push(`${k} { ${p}: cand=${dx[p] === undefined ? '-' : JSON.stringify(dx[p])} base=${dy[p] === undefined ? '-' : JSON.stringify(dy[p])} }`);
          }
        }
        console.log(`CASE css  ${lines.length ? `DIFF ${lines.length} declaration(s)` : 'SAME'}  (rules: cand ${Object.keys(x).length}, base ${Object.keys(y).length})`);
        for (const l of lines) console.log('   ' + l.slice(0, 400));
        if (lines.length) bad = 1;
        continue;
      }
      const [kind, docName] = a.split(':');
      const text = DOCS[docName]?.();
      if (!text) { console.log(`CASE ${a}  ERROR unknown doc`); bad = 1; continue; }
      const res = {};
      for (const B of [C, Bb]) {
        await loadDoc(B, text, `${docName}.md`);
        await B.page.evaluate(() => window.__mdr.app.preview.mountAll?.());
        await sleep(500); await B.idle(200);
        if (kind === 'dom') res[B.name] = await restBlocks(B);
        else if (kind === 'style') res[B.name] = { rest: await styleSamples(B), hover: await hoverSamples(B), focus: await focusWalk(B) };
      }
      if (kind === 'dom') {
        const a1 = res.cand, b1 = res.base;
        const diffs = [];
        for (let i = 0; i < Math.max(a1.length, b1.length); i++) if (JSON.stringify(a1[i]) !== JSON.stringify(b1[i])) diffs.push(i);
        console.log(`CASE ${a}  ${diffs.length ? `DIFF ${diffs.length} of ${Math.max(a1.length, b1.length)} blocks` : `SAME (${a1.length} blocks)`}`);
        for (const i of diffs.slice(0, 8)) {
          console.log(`   block ${i} cand: ${JSON.stringify(a1[i]).slice(0, 700)}`);
          console.log(`   block ${i} base: ${JSON.stringify(b1[i]).slice(0, 700)}`);
        }
        if (diffs.length) bad = 1;
      } else {
        const keys = diffKeys(res.cand, res.base);
        console.log(`CASE ${a}  ${keys.length ? 'DIFF ' + keys.join(',').slice(0, 600) : 'SAME'}`);
        for (const k of keys.slice(0, 30)) {
          const g = (o) => k.split('.').reduce((v, q) => (v == null ? v : v[q]), o);
          console.log(`   cand.${k} = ${JSON.stringify(g(res.cand))}`.slice(0, 500));
          console.log(`   base.${k} = ${JSON.stringify(g(res.base))}`.slice(0, 500));
        }
        if (process.env.MDR_VERBOSE) console.log(JSON.stringify(res.cand.focus), JSON.stringify(res.base.focus));
        if (keys.length) bad = 1;
      }
    }
    for (const B of [C, Bb]) if (B.pageErrors.length) console.log(`PAGEERRORS ${B.name}: ${B.pageErrors.slice(0, 5).join(' || ')}`);
  } finally {
    await C.close(); await Bb.close();
  }
  return bad;
}
main().then((c) => { clearTimeout(KILL); process.exit(c); }, (e) => { console.log('ERROR', e && e.stack ? e.stack : e); clearTimeout(KILL); process.exit(2); });
