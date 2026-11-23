// bench/electron/v5-offk-open.mjs — verify-off-desktop (0.2.0 r4 verification): opening documents by the shell's
// ways, odd files and odd orders, one shell per run:
//   MDR_OFFK_TMP=<scratch> MDR_TARGET=cand|base node bench/electron/v5-offk-open.mjs [case ...] > x.log
//   node bench/electron/v5-offk-menu.mjs --compare cand.log base.log      (same OBS format)
// Production renderer, nothing stored for the switch. Launch only through ./_electron.mjs (one profile per case
// under MDR_OFFK_TMP). No full screen. Global timeout 110 s (the big case: run it alone).
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = process.env.MDR_TARGET === 'base' ? path.join(ROOT, 'release/baseline-0.1.1.noindex') : path.resolve(ROOT, process.env.MDR_STAGING_DIR || 'release/staging-0.2.0.noindex') /* integrate r7: MDR_STAGING_DIR */;
const ONLY = process.argv.slice(2);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_OFFK_TMP || os.tmpdir(), 'offk-open-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app = null, page = null;
async function quit() {
  if (!app) return;
  const a = app; app = null;
  const pid = a.process()?.pid;
  try { await Promise.race([a.evaluate(({ app: x }) => { setTimeout(() => x.exit(0), 20); }), sleep(3000)]); } catch { /* gone */ }
  if (pid) for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch { break; } if (i === 25) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } } await sleep(150); }
  await Promise.race([a.close().catch(() => {}), sleep(3000)]);
}
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await quit(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(3); }, 110_000);
async function launch(name, args = []) {
  app = await electron.launch({ args: [DIR, ...args, `--user-data-dir=${path.join(TMP, 'prof-' + name)}`], timeout: 30000 });
  page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { state: 'attached', timeout: 30000 });
  await sleep(1500);
}
const doc = (n, t) => { const f = path.join(TMP, n); fs.writeFileSync(f, t); return f; };
const emit = (p) => app.evaluate(({ app: a }, f) => { a.emit('open-file', { preventDefault() {} }, f); }, p);
const clickBtn = (l) => page.evaluate((x) => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((y) => y.textContent.trim() === x); if (b) b.click(); return !!b; }, l);
const until = async (fn, ms = 4000) => { const d = Date.now() + ms; while (Date.now() < d) { if (await fn().catch(() => false)) return true; await sleep(80); } return false; };
async function snap() {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent);
    return {
      title: document.title, head: lines.slice(0, 3).join('|').slice(0, 80), nLines: lines.length,
      preview: (document.querySelector('.mdr-preview')?.textContent || '').slice(0, 60),
      toasts: [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.trim().replace(/\/[^\s：]*offk-open-[^/\s]*\//g, '<TMP>/')),
      dialogs: [...document.querySelectorAll('.mdr-dialog')].map((d) => d.textContent.trim().slice(0, 80).replace(/\/[^\s：]*offk-open-[^/\s]*\//g, '<TMP>/')),
      status: (document.querySelector('.mdr-status, .mdr-statusbar, footer')?.textContent || '').trim().slice(0, 80),
    };
  });
}
const out = (k, o) => console.log(`OBS ${k} ${JSON.stringify(o)}`);
const typeEnd = async (s) => { await page.evaluate(() => document.querySelector('.cm-content').focus()); await page.keyboard.press('Meta+End'); await page.keyboard.insertText(s); await sleep(200); };

const CASES = {
  async empty() { await launch('empty'); await emit(doc('empty.md', '')); await sleep(1200); out('empty', await snap()); },
  async 'bom-only'() { await launch('bom'); await emit(doc('bom.md', Buffer.from([0xef, 0xbb, 0xbf]))); await sleep(1200); out('bom-only', await snap()); },
  async vanish() { await launch('vanish'); const f = doc('gone.md', '# gone\n'); fs.rmSync(f); await emit(f); await sleep(1500); out('vanish', await snap()); },
  async directory() { await launch('dir'); const d = path.join(TMP, 'folder.md'); fs.mkdirSync(d); await emit(d); await sleep(1500); out('directory', await snap()); },
  async binary() { await launch('bin'); const f = doc('pic.md', Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 37) & 255))); await emit(f); await sleep(1500); out('binary', await snap()); },
  async 'png-file'() { await launch('png'); const f = doc('pic.png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')); await emit(f); await sleep(1500); out('png-file', await snap()); },
  async 'changed-on-disk'() {
    await launch('chg'); const f = doc('chg.md', '# chg\n'); await emit(f); await sleep(1200);
    await sleep(1100); fs.writeFileSync(f, '# EXTERNAL\n'); await sleep(1200);
    const a = await snap();
    await typeEnd('x'); await page.keyboard.press('Meta+s'); await sleep(1500);
    const b = await snap(); const disk1 = fs.readFileSync(f, 'utf8');
    const btns = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast button')].map((x) => x.textContent.trim()));
    await page.keyboard.press('Meta+s'); await sleep(1500);
    out('changed-on-disk', { a, b, disk1, btns, disk2: fs.readFileSync(f, 'utf8'), c: await snap() });
  },
  async 'deleted-while-open'() {
    await launch('del'); const f = doc('del.md', '# del\n'); await emit(f); await sleep(1200);
    fs.rmSync(f); await sleep(800);
    await typeEnd('x'); await page.keyboard.press('Meta+s'); await sleep(1500);
    out('deleted-while-open', { s: await snap(), exists: fs.existsSync(f), disk: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null });
  },
  async 'during-question'() {
    await launch('q'); const a = doc('qa.md', '# QA\n'), b = doc('qb.md', '# QB\n'), c = doc('qc.md', '# QC\n');
    await emit(a); await sleep(1200); await typeEnd('dirty');
    await emit(b); await until(async () => (await snap()).dialogs.length > 0, 2000);
    await emit(c); await sleep(600);
    const s1 = await snap();
    await clickBtn('丢弃'); await sleep(1200);
    const s2 = await snap();
    if (s2.dialogs.length) await clickBtn('丢弃');
    await sleep(1200);
    out('during-question', { s1, s2, s3: await snap() });
  },
  async 'question-cancel-then-other'() {
    await launch('qc'); const a = doc('ka.md', '# KA\n'), b = doc('kb.md', '# KB\n');
    await emit(a); await sleep(1200); await typeEnd('dirty');
    await emit(b); await until(async () => (await snap()).dialogs.length > 0, 2000);
    const s1 = await snap(); await clickBtn('取消'); await sleep(800);
    await page.keyboard.insertText('Z'); await sleep(400);
    out('question-cancel-then-other', { s1, s2: await snap(), focus: await page.evaluate(() => document.activeElement?.className?.toString().slice(0, 30)) });
  },
  async 'launch-args-two'() { const a = doc('la.md', '# LA\n'), b = doc('lb.md', '# LB\n'); await launch('la', [a, b]); await sleep(1500); out('launch-args-two', await snap()); },
  async 'same-twice'() { await launch('st'); const a = doc('st.md', '# ST\n'); await emit(a); await emit(a); await sleep(1500); const s = await snap(); await typeEnd('y'); await emit(a); await sleep(1000); out('same-twice', { s, after: await snap() }); },
  async 'rapid-three'() { await launch('r3'); const fs3 = ['r1', 'r2', 'r3'].map((n) => doc(`${n}.md`, `# ${n.toUpperCase()}\n`)); for (const f of fs3) await emit(f); await sleep(2000); out('rapid-three', await snap()); },
  async 'big-then-small'() {
    const line = '这是一行很长的测试文字，用来组成一个大文件。'.repeat(4) + '\n';
    const big = path.join(TMP, 'big.md'); const fd = fs.openSync(big, 'w'); const chunk = Buffer.from(line.repeat(2000)); let n = 0; while (n < 50 * 1024 * 1024) { fs.writeSync(fd, chunk); n += chunk.length; } fs.closeSync(fd);
    const small = doc('small.md', '# SMALL\n');
    await launch('big'); await emit(big); await sleep(200); await emit(small);
    const t0 = Date.now(); await until(async () => (await snap()).title.includes('small'), 60000); const t1 = Date.now() - t0;
    await sleep(3000);
    out('big-then-small', { s: await snap(), shownAfterMs: t1 > 5000 ? '>5s' : '<5s' });
  },
};
try {
  for (const [name, fn] of Object.entries(CASES)) {
    if (ONLY.length ? !ONLY.includes(name) : name === 'big-then-small') continue;
    try { await fn(); } catch (e) { out(name, { threw: String(e).split('\n')[0] }); }
    await quit();
  }
} finally {
  clearTimeout(KILL);
  await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
}
