// bench/verify/v4-sesa-probe.mjs — verify-session-a: print-only probes (step by step: source, session DOM, caret,
// focus) for the cases the v4-sesa scripts flag. Run: MDR_PORT=5431 node bench/verify/v4-sesa-probe.mjs <probe>
import { openB, sleep, globalTimeout, J, view, shownText, clickText, waitSession, load, caretCtx } from './v4-sesa-lib.mjs';

const which = process.argv[2] || 'math-nospace';
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 100_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
const dump = async (label) => {
  const v = await view(page);
  const c = await caretCtx(page);
  const html = v.editing ? v.editing.html.replace(/<span class="katex[\s\S]*?<\/span><\/span><\/span>/g, '[K]').slice(0, 300) : null;
  const res = await page.evaluate(() => !!document.querySelector('.mdr-preview__edit-capture') && document.activeElement?.classList?.contains('mdr-preview__edit-capture'));
  console.log(`${label}: src=${J(v.src)} editing=${J(v.editing && v.editing.text.slice(0, 40))} caret=${J(c)} active=${v.active} cap=${res} toast=${J(v.toast)}\n    html=${J(html)}`);
};
const PROBES = {
  async 'math-nospace'() {
    await load(B, 'abc$x$ y\n\nz\n');
    await clickText(page, 'abc', 1, { side: 'right' }); await waitSession(page);
    await B.joined('abc', 'after'); await sleep(100); await dump('caret');
    await page.keyboard.press('Enter'); await sleep(30); await dump('enter+30ms');
    await settle(); await dump('enter+settle');
    await page.keyboard.type('Z'); await settle(500); await dump('Z');
    await page.keyboard.type('W'); await settle(500); await dump('W');
  },
  async 'math-nospace-li'() {
    await load(B, '- abc$x$ y\n- e\n');
    await clickText(page, 'abc', 1, { side: 'right' }); await waitSession(page);
    await B.joined('abc', 'after'); await sleep(100); await dump('caret');
    await page.keyboard.press('Enter'); await settle(); await dump('enter');
    await page.keyboard.type('Z'); await settle(500); await dump('Z');
  },
  async 'math-nospace-type'() {
    await load(B, 'abc$x$ y\n\nz\n');
    await clickText(page, 'abc', 1, { side: 'right' }); await waitSession(page);
    await B.joined('abc', 'after'); await sleep(100); await dump('caret');
    await page.keyboard.type('Z'); await settle(500); await dump('Z typed without Enter');
  },
  async 'tight-nonl'() {
    await load(B, 'aaa\n## xx');
    console.log('blocks', J(await B.blocks()));
    await clickText(page, 'xx', 1, { side: 'right' }); await waitSession(page); await dump('session');
    await page.keyboard.press('Meta+a'); await sleep(50); await dump('meta-a');
    await page.keyboard.press('Backspace'); await settle(); await dump('emptied');
    console.log('blocks', J(await B.blocks()));
    await page.keyboard.type('N'); await settle(500); await dump('N');
    console.log('blocks', J(await B.blocks()));
  },
  async 'tight-nl'() {
    await load(B, 'aaa\n## xx\n');
    console.log('blocks', J(await B.blocks()));
    await clickText(page, 'xx', 1, { side: 'right' }); await waitSession(page); await dump('session');
    await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace'); await settle(); await dump('emptied');
    await page.keyboard.type('N'); await settle(500); await dump('N');
  },
  async 'task-list'() {
    await load(B, '- a1\n\n- [ ] t1\n\n- z1\n');
    console.log('blocks', J(await B.blocks()));
    await clickText(page, 't1', 1, { side: 'right' }); await waitSession(page); await dump('session');
    await page.keyboard.press('Meta+a'); await sleep(50); await dump('meta-a');
    await page.keyboard.press('Backspace'); await settle(); await dump('emptied');
    await page.keyboard.type('N'); await settle(500); await dump('N');
  },
  async 'meta-a-control'() {
    for (const [label, empty] of [['plain', false], ['emptied', true]]) {
      await load(B, 'aaa\n\nxx para\n\nzz\n');
      await clickText(page, 'xx para', 1, { side: 'right' }); await waitSession(page);
      if (empty) { await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace'); await settle(); }
      await page.keyboard.press('Meta+a'); await sleep(50);
      if (!empty) await page.keyboard.press('Meta+a');
      await settle(); await dump(label + ' after select-all');
      for (let i = 0; i < 3; i++) {
        await clickText(page, 'zz', 1, { side: 'right' }); await settle(); await dump(label + ' click zz #' + (i + 1));
      }
      await page.keyboard.type('Y'); await settle(500); await dump(label + ' Y');
    }
  },
  async 'loose-list'() {
    await load(B, 'aaa\n\n- a1\n\n- b1\n\n- c1\n\nzz\n');
    await clickText(page, 'b1', 1, { side: 'right' }); await waitSession(page);
    await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace'); await settle(); await dump('emptied');
    await page.keyboard.type('N'); await settle(500); await dump('N');
  },
  async 'seed102'() {
    // fuzz seed 102 fast: heading split, type, empty the new paragraph, Backspace (to the heading's end), Backspace, Esc
    for (const fast of [false, true]) {
      await load(B, '# Title ab\n\npara one\n\nend zz\n');
      await clickText(page, 'Title', 1, { side: 'right' }); await waitSession(page);
      await page.evaluate(() => { const h = document.querySelector('.mdr-preview .is-editing h1').firstChild; const r = document.createRange(); r.setStart(h, 3); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); });
      const keys = ['n', 'b', 'Enter', 'z', 'h', 'Meta+a', 'Backspace', 'Backspace', 'Backspace', 'Escape'];
      for (const k of keys) {
        if (k.length === 1) await page.keyboard.type(k); else await page.keyboard.press(k);
        if (!fast) await settle();
      }
      await settle(800); await dump(fast ? 'fast' : 'slow');
    }
  },
  async 'gone-paste'() {
    // a paste into the emptied element (U18 c: written at the deleted block's own place), loose and tight
    const paste = (t) => page.evaluate((t) => { const el = document.querySelector('.mdr-preview .is-editing'); const dt = new DataTransfer(); dt.setData('text/plain', t); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, t);
    for (const [doc, needle, text, want] of [
      ['aaa\n\nxx para\n\nzz\n', 'para', 'P1', 'aaa\n\nP1\n\nzz\n'],
      ['aaa\n\nxx para\n\nzz\n', 'para', 'P1\n\nP2', 'aaa\n\nP1\n\nP2\n\nzz\n'],
      ['aaa\n## xx\n\nzz\n', 'xx', 'P1', 'aaa\n\n## P1\n\nzz\n'],
      ['aaa\n## xx\n\nzz\n', 'xx', 'P1\n\nP2', 'aaa\n\n## P1\n\nP2\n\nzz\n'],
      ['xx para\n\nzz\n', 'para', 'P1\n\nP2', 'P1\n\nP2\n\nzz\n'],
    ]) {
      for (const fast of [false, true]) {
        await load(B, doc);
        await clickText(page, needle, 1, { side: 'right' }); await waitSession(page);
        await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace');
        if (!fast) await settle(500);
        await paste(text); await settle(700);
        await page.keyboard.type('Q'); await settle(600);
        const s = await B.source();
        const wantQ = want.replace(/(P[12])(\n\nzz\n)$/, '$1Q$2');
        console.log(`${s === wantQ ? 'OK  ' : 'BAD '} ${J(doc)} paste ${J(text)}${fast ? ' (same frame)' : ''}: ${J(s)}${s === wantQ ? '' : ' want ' + J(wantQ)}`);
        await page.keyboard.press('Escape'); await settle(200);
        let n = 0; for (; n < 10 && (await B.source()) !== doc; n++) { await page.keyboard.press('Meta+z'); await settle(250); }
        if ((await B.source()) !== doc) console.log('   undo FAILED', J(await B.source()));
      }
    }
  },
  async 'undo-math-end'() {
    for (const [doc, needle] of [['a1 b1 $x^2$\n\nzz\n', 'a1'], ['- a1 $x$\n- b1\n', 'a1'], ['## Hd $x$\n\nzz\n', 'Hd'], ['a1 $x$ b1 $y$\n\nzz\n', 'b1'], ['| h |\n| --- |\n| c1 $x$ |\n', 'c1']]) {
      await load(B, doc);
      await clickText(page, needle, 1, { side: 'right' }); await waitSession(page);
      await page.keyboard.press('Meta+ArrowRight'); await sleep(100);
      await page.keyboard.type('QR'); await settle(700); await dump('typed QR');
      await page.keyboard.press('Meta+z'); await settle(700); await dump('undo');
      const where = await page.evaluate(() => { const s = getSelection(); const n = s.focusNode; return n ? { node: n.nodeType === 3 ? J2(n.data) : n.nodeName, off: s.focusOffset, inMath: !!(n.nodeType === 3 ? n.parentElement : n).closest('.md-math'), ce: (n.nodeType === 3 ? n.parentElement : n).isContentEditable } : null; function J2(x) { return JSON.stringify(x.slice(0, 10)); } });
      console.log('    caret after undo:', J(where));
      for (const ch of 'WXY') { await page.keyboard.type(ch); await sleep(150); }
      await page.keyboard.press('Enter'); await page.keyboard.type('Z');
      await settle(700); await dump('typed WXY Enter Z');
      await page.keyboard.press('Escape'); await settle(200);
    }
  },
  async 'slow-queue'() {
    // a slow structure (300 ms, as bench/verify/v3-ses-preview.mjs simulates) holds the resume after an Enter; the
    // user goes on at human speed (gap ms): z ⌘A ⌫ ⌫ Q are queued and then replayed in one go
    const slow = async (on) => page.evaluate((on) => {
      const pv = window.__mdr.app.preview;
      if (!window.__origDelta) { window.__origDelta = pv.applyStructureDelta.bind(pv); window.__origHtml = pv.applyHtml.bind(pv); }
      pv.applyStructureDelta = (m) => { if (window.__delay) { setTimeout(() => window.__origDelta(m), 300); return true; } return window.__origDelta(m); };
      pv.applyHtml = (m) => { if (window.__delay) setTimeout(() => window.__origHtml(m), 300); else window.__origHtml(m); };
      window.__delay = on;
    }, on);
    for (const [label, doc, needle, caret, want] of [
      ['heading above', '# Title ab\n\npara one\n', 'Title', 'Title', '# TitleQ\n\npara one\n'],
      ['list item split', '- li one ab\n\npara one\n', 'li one', 'li one', '- li oneQ\n\npara one\n'],
      ['formula para above', 'a1 $x^2$ tail\n\npara one\n', 'tail', 'a1 x2', 'a1 $x^2$Q\n\npara one\n'],
    ]) {
      for (const gap of [100, 150]) {
        for (let run = 1; run <= 3; run++) {
          await slow(false);
          await load(B, doc);
          await clickText(page, needle, 1, { side: 'right' }); await waitSession(page);
          if (caret === 'a1 x2') await page.evaluate(() => { const m = document.querySelector('.mdr-preview .is-editing .md-math'); const r = document.createRange(); r.setStartAfter(m); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); });
          else await page.evaluate((n) => { const el = document.querySelector('.mdr-preview .is-editing'); const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); for (let t = w.nextNode(); t; t = w.nextNode()) { const i = t.data.indexOf(n); if (i >= 0) { const r = document.createRange(); r.setStart(t, i + n.length); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); return; } } }, caret);
          await slow(true);
          for (const k of ['Enter', 'z', 'Meta+a', 'Backspace', 'Backspace', 'Q']) { if (k.length === 1) await page.keyboard.type(k); else await page.keyboard.press(k); await sleep(gap); }
          await sleep(1500); await slow(false); await settle(600);
          const src = await B.source();
          console.log(`${src === want ? 'OK  ' : 'BAD '} ${label} gap ${gap} run ${run}: ${J(src)}${src === want ? '' : ' want ' + J(want)}`);
          await page.keyboard.press('Escape'); await settle(200);
        }
      }
    }
    await slow(false);
  },
  async 'reclick'() {
    // Esc (or an edit + Esc), then at once a click on the same block and typing: H4 (U19) made the released block
    // "not fresh" until its re-render mounts; the click waits for that (CLICK_WAIT_MS) — are keys lost?
    const { readFileSync } = await import('node:fs');
    const large = process.env.SMALL !== '1';
    let PRE = '', POST = '';
    if (large) {
      const lines = readFileSync(new URL('../../test-data/large.md', import.meta.url), 'utf8').split('\n');
      const fence = /^ {0,3}(`{3,}|~{3,})/;
      let open = false, a = -1;
      for (let k = 0; k < lines.length - 1; k++) { if (fence.test(lines[k])) open = !open; if (k >= 50_000 && !open && lines[k].trim() === '' && /^[A-Za-z\u4e00-\u9fff]/u.test(lines[k - 1]) && /^## /.test(lines[k + 1])) { a = k; break; } }
      PRE = lines.slice(0, a + 1).join('\n') + '\n'; POST = '\n\n' + lines.slice(a + 1).join('\n');
    }
    const preLines = PRE === '' ? 0 : PRE.split('\n').length - 1;
    for (const [label, edit, gap] of [['no-edit', false, 40], ['edit', true, 40], ['no-edit-0', false, 0], ['edit-0', true, 0]]) {
      for (let run = 1; run <= 3; run++) {
        const mid = 'alpha beta gamma\n\nsecond para here';
        await load(B, PRE + mid + POST); await sleep(large ? 1200 : 300);
        const pt0 = await B.textPoint(preLines + 1, 'first'); await sleep(700);
        const pt = await B.textPoint(preLines + 1, 'first');
        await page.mouse.click(pt.x + 20, pt.y); await waitSession(page);
        if (edit) { await page.keyboard.type('X'); await sleep(80); }
        await page.keyboard.press('Escape');
        await sleep(gap);
        await page.mouse.click(pt.x + 2, pt.y);
        for (const ch of 'QRS') { await page.keyboard.type(ch); await sleep(60); }
        await settle(1200);
        const src = await B.source();
        const got = src.slice(PRE.length, PRE.length + 40);
        const ok = /Q/.test(got) && /R/.test(got) && /S/.test(got) && /QRS/.test(got);
        console.log(`${ok ? 'OK  ' : 'BAD '} ${label} run ${run}: ${J(got)}`);
        await page.keyboard.press('Escape'); await settle(200);
      }
    }
  },
  async 'large-queue'() {
    // the emptied-element keys arriving in a resume window at human speed (gap ms) deep inside test-data/large.md
    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(new URL('../../test-data/large.md', import.meta.url), 'utf8').split('\n');
    const fence = /^ {0,3}(`{3,}|~{3,})/;
    let open = false, a = -1;
    for (let k = 0; k < lines.length - 1; k++) { if (fence.test(lines[k])) open = !open; if (k >= 50_000 && !open && lines[k].trim() === '' && /^[A-Za-z\u4e00-\u9fff]/u.test(lines[k - 1]) && /^## /.test(lines[k + 1])) { a = k; break; } }
    const PRE = lines.slice(0, a + 1).join('\n') + '\n', POST = lines.slice(a + 1).join('\n');
    const preLines = PRE.split('\n').length - 1;
    for (const [label, mid, keys, gap, want] of [
      ['heading-split 70ms', '# Title ab\n\npara one', ['Enter', 'z', 'Meta+a', 'Backspace', 'Backspace', 'Q'], 70, '# TitleQ\n\npara one'],
      ['heading-split 120ms', '# Title ab\n\npara one', ['Enter', 'z', 'Meta+a', 'Backspace', 'Backspace', 'Q'], 120, '# TitleQ\n\npara one'],
      ['list-above 70ms', '- li one\n\nxx ab\n\npara one', ['Enter', 'z', 'Meta+a', 'Backspace', 'Backspace', 'Q'], 70, '- li oneQ\n\nxx\n\npara one'],
      ['para-split-enter-type 70ms', 'xx ab cd\n\npara one', ['Enter', 'Q', 'R', 'Enter', 'S'], 70, 'xx\n\nQRab\n\nScd\n\npara one'],
    ]) {
      const doc = PRE + mid + '\n\n' + POST;
      await load(B, doc);
      await sleep(1000);
      const pt = await B.textPoint(preLines + 1 + (label.startsWith('list') ? 2 : 0), 'first');
      await sleep(700);
      const pt2 = await B.textPoint(preLines + 1 + (label.startsWith('list') ? 2 : 0), 'first');
      await page.mouse.click(pt2.x, pt2.y); await waitSession(page);
      // caret after the first word of the block
      await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const t = w.nextNode(); const i = t.data.indexOf(' '); const r = document.createRange(); r.setStart(t, i < 0 ? t.data.length : i); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); });
      const t0 = Date.now();
      for (const k of keys) { if (k.length === 1) await page.keyboard.type(k); else await page.keyboard.press(k); await sleep(gap); }
      await settle(1500);
      const src = await B.source();
      const got = src.slice(PRE.length, src.length - POST.length - 2);
      console.log(`${got === want ? 'OK  ' : 'BAD '} ${label}: got=${J(got)} want=${J(want)} (${Date.now() - t0} ms)`);
      await page.keyboard.press('Escape'); await settle(300);
    }
  },
  async 'seed102c'() {
    for (const run of [1, 2, 3]) {
      await load(B, '# Title ab\n\npara one\n\nend zz\n');
      await clickText(page, 'Title', 1, { side: 'right' }); await waitSession(page);
      await page.evaluate(() => { const h = document.querySelector('.mdr-preview .is-editing h1').firstChild; const r = document.createRange(); r.setStart(h, 3); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); });
      await settle(500);
      for (const k of ['Enter', 'z', 'Meta+a', 'Backspace', 'Backspace', 'Backspace']) { if (k.length === 1) await page.keyboard.type(k); else await page.keyboard.press(k); }
      await settle(900); await dump('run ' + run + ' after keys');
      const info = await page.evaluate(() => { const e = document.querySelector('.mdr-preview .is-editing'); return e ? { id: e.dataset.id, html: e.outerHTML.slice(0, 200), blocks: Array.from(document.querySelectorAll('.mdr-preview section.md-block')).map((s) => s.dataset.id + ':' + JSON.stringify(s.textContent.slice(0, 20))) } : null; });
      console.log('   ', J(info));
      await page.keyboard.type('Q'); await settle(600); await dump('run ' + run + ' Q');
      await page.keyboard.press('Escape'); await settle(300); await dump('run ' + run + ' esc');
      console.log('   ', J(await shownText(page)));
    }
  },
  async 'seed102b'() {
    // which pause makes the difference: '|' in the key list = settle there
    const seqs = [
      ['n', 'b', 'Enter', 'z', 'h', 'Meta+a', 'Backspace', '|', 'Backspace', 'Backspace', 'Escape'],
      ['n', 'b', 'Enter', '|', 'z', 'h', 'Meta+a', 'Backspace', 'Backspace', 'Backspace', 'Escape'],
      ['n', 'b', 'Enter', 'z', 'h', '|', 'Meta+a', 'Backspace', 'Backspace', 'Backspace', 'Escape'],
      ['|', 'Enter', 'z', 'h', 'Meta+a', 'Backspace', 'Backspace', 'Backspace', 'Escape'],
      ['|', 'Enter', 'z', 'h', 'Meta+a', 'Backspace', 'Backspace', 'Backspace'],
      ['|', 'Enter', 'z', 'Meta+a', 'Backspace', 'Backspace', 'Backspace'],
      ['|', 'Enter', 'z', 'Backspace', 'Backspace', 'Backspace'],
    ];
    for (const keys of seqs) {
      await load(B, '# Title ab\n\npara one\n\nend zz\n');
      await clickText(page, 'Title', 1, { side: 'right' }); await waitSession(page);
      await page.evaluate(() => { const h = document.querySelector('.mdr-preview .is-editing h1').firstChild; const r = document.createRange(); r.setStart(h, 3); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); });
      for (const k of keys) {
        if (k === '|') await settle(500); else if (k.length === 1) await page.keyboard.type(k); else await page.keyboard.press(k);
      }
      await settle(900); await dump(keys.join(' '));
      await page.keyboard.press('Escape'); await settle(200);
    }
  },
  async 'gone-bs-bs'() {
    // the emptied element (deletion written, settled), then Backspace Backspace [Esc] at machine speed / 60 ms apart
    const variants = [
      ['para-above fast bs,bs', 'aaa bb\n\nxx para\n\nzz\n', ['Backspace', 'Backspace'], 0],
      ['para-above fast bs,bs,esc', 'aaa bb\n\nxx para\n\nzz\n', ['Backspace', 'Backspace', 'Escape'], 0],
      ['para-above 60ms bs,bs', 'aaa bb\n\nxx para\n\nzz\n', ['Backspace', 'Backspace'], 60],
      ['para-above fast bs,Q', 'aaa bb\n\nxx para\n\nzz\n', ['Backspace', 'Q'], 0],
      ['heading-above fast bs,bs', '# Hd bb\n\nxx para\n\nzz\n', ['Backspace', 'Backspace'], 0],
      ['heading-above fast bs,bs,esc', '# Hd bb\n\nxx para\n\nzz\n', ['Backspace', 'Backspace', 'Escape'], 0],
      ['heading-above 60ms bs,bs', '# Hd bb\n\nxx para\n\nzz\n', ['Backspace', 'Backspace'], 60],
      ['list-above fast bs,bs', '- li bb\n\nxx para\n\nzz\n', ['Backspace', 'Backspace'], 0],
      ['list-above fast bs,Q', '- li bb\n\nxx para\n\nzz\n', ['Backspace', 'Q'], 0],
      ['tight-heading fast bs,bs', 'aaa bb\n## xx\n\nzz\n', ['Backspace', 'Backspace'], 0],
      ['tight-heading fast bs,Q', 'aaa bb\n## xx\n\nzz\n', ['Backspace', 'Q'], 0],
      ['tight-heading 60ms bs,Q', 'aaa bb\n## xx\n\nzz\n', ['Backspace', 'Q'], 60],
    ];
    for (const [label, doc, keys, gap] of variants) {
      await load(B, doc);
      await clickText(page, 'xx', 1, { side: 'right' }); await waitSession(page);
      await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace'); await settle(600);
      for (const k of keys) { if (k.length === 1) await page.keyboard.type(k); else await page.keyboard.press(k); if (gap) await sleep(gap); }
      await settle(900); await dump(label);
      await page.keyboard.press('Escape'); await settle(200);
    }
  },
  async 'meta-a-gone'() {
    await load(B, 'aaa\n\nxx para\n\nzz\n');
    await clickText(page, 'xx para', 1, { side: 'right' }); await waitSession(page);
    await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace'); await settle(); await dump('emptied');
    await page.keyboard.press('Meta+a'); await settle(); await dump('meta-a');
    await page.keyboard.type('Q'); await settle(); await dump('Q');
    await page.keyboard.press('Escape'); await settle(); await dump('esc');
    await clickText(page, 'zz', 1, { side: 'right' }); await settle(); await dump('click zz');
    await page.keyboard.type('Y'); await settle(500); await dump('Y');
    await clickText(page, 'aaa', 1, { side: 'right' }); await settle(); await dump('click aaa');
    await page.keyboard.type('Y'); await settle(500); await dump('Y2');
  },
};
try {
  await B.boot('mode=split');
  await PROBES[which]();
  console.log('pageErrors', J(B.pageErrors.slice(0, 3)), 'console', J(B.consoleErrors.slice(0, 5)));
} finally { stop(); await B.close(); }
