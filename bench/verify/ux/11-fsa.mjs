// bench/verify/ux/11-fsa.mjs — File System Access flows with a faked picker/handle layer: open via
// Mod-o, save in place (no download), permission denied, save-as, untitled save, cancel, recent menu,
// reopen from recent (same docId → draft offered), NotFoundError / NotAllowedError on reopen, drop with
// getAsFileSystemHandle.  Run: node bench/verify/ux/11-fsa.mjs
import { launch, open, getText, step, expect, check, finish, sleep, statusText, getFailures, BASE } from './lib.mjs';

const { browser, context, page, errors } = await launch();
await context.addInitScript(() => {
  const load = () => { try { return JSON.parse(sessionStorage.getItem('__fsaReg') || '{"seq":0,"reg":{}}'); } catch { return { seq: 0, reg: {} }; } };
  const st = load();
  const persist = () => sessionStorage.setItem('__fsaReg', JSON.stringify(st));
  const F = (window.__fsa = { calls: [], writes: [], nextPick: null, nextSave: null, dropHandle: null, st });
  const rec = (id) => st.reg[id];
  // Methods live on Object.prototype so handles that were structured-cloned into IndexedDB still respond.
  const def = (n, fn) => Object.defineProperty(Object.prototype, n, { value: fn, enumerable: false, configurable: true, writable: true });
  def('queryPermission', async function (d) { F.calls.push(['query', this.__fsaId, d?.mode]); return rec(this.__fsaId).perm === 'granted' ? 'granted' : 'prompt'; });
  def('requestPermission', async function (d) { F.calls.push(['request', this.__fsaId, d?.mode]); return rec(this.__fsaId).perm; });
  def('getFile', async function () { const r = rec(this.__fsaId); F.calls.push(['getFile', this.__fsaId]); if (r.missing) throw new DOMException('gone', 'NotFoundError'); return new File([r.text], r.name, { type: 'text/markdown', lastModified: r.mtime }); });
  def('createWritable', async function () {
    const id = this.__fsaId; const r = rec(id); F.calls.push(['createWritable', id]);
    if (r.perm !== 'granted') throw new DOMException('no', 'NotAllowedError');
    let buf = '';
    return { async write(d) { buf += typeof d === 'string' ? d : await new Response(d).text(); }, async close() { r.text = buf; r.mtime = Date.now(); persist(); F.writes.push({ id, name: r.name, text: buf }); } };
  });
  def('isSameEntry', async function (o) { return !!o && o.__fsaId === this.__fsaId; });
  const mk = (id) => ({ __fsaId: id, kind: 'file', name: rec(id).name });
  F.add = (name, text, perm = 'granted') => { const id = ++st.seq; st.reg[id] = { name, text, perm, mtime: Date.now() - 100000, missing: false }; persist(); return id; };
  F.set = (id, patch) => { Object.assign(st.reg[id], patch); persist(); };
  F.handle = mk;
  window.showOpenFilePicker = async (opts) => { F.calls.push(['open', opts]); const id = F.nextPick; if (id == null) throw new DOMException('cancel', 'AbortError'); return [mk(id)]; };
  window.showSaveFilePicker = async (opts) => { F.calls.push(['saveAs', opts]); const s = F.nextSave; if (!s) throw new DOMException('cancel', 'AbortError'); return mk(F.add(s, '')); };
  DataTransferItem.prototype.getAsFileSystemHandle = async function () { return F.dropHandle ? mk(F.dropHandle) : null; };
});
await open(page, '?mode=split');
const fsa = (fn, arg) => page.evaluate(fn, arg);
const toasts = () => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent));
const clearToasts = () => page.evaluate(() => document.querySelectorAll('.mdr-toast').forEach((t) => t.remove()));
let downloads = 0;
page.on('download', () => downloads++);

await step('FSA available: save button is 保存 (not 下载)', async () => {
  const title = await page.evaluate(() => document.querySelector('[data-cmd="file.save"]').title);
  expect(title.startsWith('保存'), `title "${title}"`);
});
const idA = await fsa(() => window.__fsa.add('alpha.md', '# Alpha\n\nalpha body\n'));
await step('Mod-o → picker → file opens with name/title/status 已保存', async () => {
  await fsa((id) => { window.__fsa.nextPick = id; }, idA);
  await page.click('.cm-content');
  await page.keyboard.press('Meta+o');
  await page.waitForFunction(() => window.__mdr.app.getText().includes('alpha body'), null, { timeout: 4000 });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(80);
  const s = await statusText(page);
  expect(s.file === 'alpha.md · 已保存', `status "${s.file}"`);
  expect((await page.title()) === 'alpha.md', `title "${await page.title()}"`);
  const opts = await fsa(() => window.__fsa.calls.find((c) => c[0] === 'open')?.[1]);
  expect(opts?.types?.[0]?.accept?.['text/markdown']?.includes('.md'), `picker options ${JSON.stringify(opts)}`);
});
await step('Mod-s saves in place through the handle (no download), clears dirty, toast', async () => {
  await page.click('.cm-content');
  await page.keyboard.press('Meta+End');
  await page.keyboard.type('追加一行');
  await sleep(100);
  expect((await page.title()).startsWith('●'), 'not dirty');
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => window.__fsa.writes.length > 0, null, { timeout: 4000 });
  await sleep(200);
  const w = await fsa(() => window.__fsa.writes.at(-1));
  expect(w.name === 'alpha.md' && w.text === (await getText(page)), `written ${JSON.stringify(w)}`);
  expect(downloads === 0, `download happened (${downloads})`);
  expect((await page.title()) === 'alpha.md', `title "${await page.title()}"`);
  expect((await statusText(page)).file === 'alpha.md · 已保存', `status "${(await statusText(page)).file}"`);
  const q = await fsa(() => window.__fsa.calls.filter((c) => c[0] === 'query' || c[0] === 'request').map((c) => c.join(':')));
  expect(q.some((c) => c.startsWith('query') && c.endsWith('readwrite')), `permission calls ${q}`);
  return `toasts: ${(await toasts()).join('|')}`;
});
await step('Permission denied on save → zh-CN error toast, document stays dirty', async () => {
  await clearToasts();
  await fsa((id) => window.__fsa.set(id, { perm: 'denied' }), idA);
  await page.keyboard.type('x');
  await sleep(50);
  await page.keyboard.press('Meta+s');
  await sleep(400);
  const t = await toasts();
  expect(t.some((x) => x.includes('需要重新授权')), `toasts ${t.join('|')}`);
  expect((await page.title()).startsWith('●'), 'dirty flag lost although save failed');
  await fsa((id) => window.__fsa.set(id, { perm: 'granted' }), idA);
});
await step('Mod-Shift-s → save picker with suggestedName, new name shown, status 已保存', async () => {
  await clearToasts();
  await fsa(() => { window.__fsa.nextSave = 'beta.md'; });
  await page.keyboard.press('Meta+Shift+s');
  await page.waitForFunction(() => window.__fsa.writes.some((w) => w.name === 'beta.md'), null, { timeout: 4000 });
  await sleep(200);
  const opts = await fsa(() => window.__fsa.calls.filter((c) => c[0] === 'saveAs').at(-1)[1]);
  expect(opts.suggestedName === 'alpha.md', `suggestedName ${opts.suggestedName}`);
  const name = await page.evaluate(() => document.querySelector('.mdr-toolbar__name').textContent);
  expect(name === 'beta.md', `toolbar name "${name}"`);
  expect((await page.title()) === 'beta.md', `title "${await page.title()}"`);
  expect((await statusText(page)).file === 'beta.md · 已保存', `status "${(await statusText(page)).file}"`);
});
await step('Save-as cancelled (AbortError): no error toast, state unchanged', async () => {
  await clearToasts();
  await fsa(() => { window.__fsa.nextSave = null; });
  await page.keyboard.press('Meta+Shift+s');
  await sleep(300);
  const t = await toasts();
  expect(t.length === 0, `unexpected toasts ${t.join('|')}`);
  expect((await statusText(page)).file === 'beta.md · 已保存', `status "${(await statusText(page)).file}"`);
});
await step('New file when clean: no dialog; Mod-s on untitled → save picker suggests 未命名.md', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="file.new"]');
  await sleep(150);
  expect(!(await page.$('.mdr-dialog')), 'dialog shown although document was clean');
  expect((await getText(page)) === '', 'not empty');
  await page.click('.cm-content');
  await page.keyboard.type('未命名内容');
  await fsa(() => { window.__fsa.nextSave = 'fresh.md'; });
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => window.__fsa.writes.some((w) => w.name === 'fresh.md'), null, { timeout: 4000 });
  await sleep(200);
  const opts = await fsa(() => window.__fsa.calls.filter((c) => c[0] === 'saveAs').at(-1)[1]);
  expect(opts.suggestedName === '未命名.md', `suggestedName ${opts.suggestedName}`);
  expect((await statusText(page)).file === 'fresh.md · 已保存', `status "${(await statusText(page)).file}"`);
  expect((await page.title()) === 'fresh.md', `title ${await page.title()}`);
});
await step('Recent menu opens on click, lists 打开文件… + recent handles, is visible on screen', async () => {
  await page.click('.mdr-toolbar__file');
  await page.waitForSelector('.mdr-recent', { timeout: 2000 });
  await sleep(100);
  const info = await page.evaluate(() => {
    const ul = document.querySelector('.mdr-recent');
    const r = ul.getBoundingClientRect();
    return { items: [...ul.querySelectorAll('li')].map((l) => l.textContent), box: [r.x, r.y, r.width, r.height], inView: r.right <= innerWidth && r.bottom <= innerHeight && r.width > 50 && r.height > 20 };
  });
  await page.screenshot({ path: '/Users/zyx/LocalDocuments/MDReader/bench/verify/ux/shots/recent-menu-fsa.png' });
  expect(info.items[0] === '打开文件…', `items ${info.items}`);
  expect(info.items.includes('fresh.md') && info.items.includes('alpha.md'), `items ${info.items}`);
  expect(info.inView, `menu box ${info.box}`);
  return info.items.join(' | ');
});
await step('Click a recent entry → reopens the file (getFile), status 已保存, menu closes', async () => {
  await page.click('.mdr-recent__item:has-text("alpha.md")');
  await page.waitForFunction(() => window.__mdr.app.getText().includes('alpha body'), null, { timeout: 4000 });
  await sleep(150);
  expect(!(await page.$('.mdr-recent')), 'menu still open');
  const s = await statusText(page);
  expect(s.file === 'alpha.md · 已保存', `status "${s.file}"`);
  const txt = await getText(page);
  expect(txt.endsWith('追加一行x') || txt.endsWith('追加一行'), `text end: ${JSON.stringify(txt.slice(-12))}`);
});
await step('Draft for an FSA file is offered after reload + reopen from recent (docId reused via isSameEntry)', async () => {
  await page.click('.cm-content');
  await page.keyboard.press('Meta+End');
  await page.keyboard.type(' 草稿编辑');
  await page.waitForFunction(() => document.querySelector('[data-stat="file"]').textContent.includes('草稿已存'), null, { timeout: 4000 });
  page.once('dialog', (d) => d.accept());
  await page.goto(`${BASE}/?mode=split`);
  await page.waitForFunction(() => !!window.__mdr);
  await sleep(300);
  await page.click('.mdr-toolbar__file');
  await page.waitForSelector('.mdr-recent');
  const items = await page.evaluate(() => [...document.querySelectorAll('.mdr-recent li')].map((l) => l.textContent));
  expect(items.includes('alpha.md'), `recent after reload: ${items}`);
  await page.click('.mdr-recent__item:has-text("alpha.md")');
  await page.waitForFunction(() => window.__mdr.app.getText().includes('alpha body'), null, { timeout: 4000 });
  const found = await page.waitForSelector('.mdr-toast', { timeout: 3000 }).then(() => true).catch(() => false);
  const t = await toasts();
  expect(found && t.some((x) => x.includes('发现未保存的草稿')), `toasts ${t.join('|')}`);
  await page.click('.mdr-toast__btn:has-text("恢复")');
  await sleep(200);
  expect((await getText(page)).includes('草稿编辑'), 'draft not restored');
  expect((await page.title()).startsWith('●'), 'restored draft should be dirty');
});
await step('Reopen from recent while dirty asks for confirmation; 取消 keeps text', async () => {
  await page.click('.mdr-toolbar__file');
  await page.waitForSelector('.mdr-recent');
  await page.click('.mdr-recent__item:has-text("fresh.md")');
  await page.waitForSelector('.mdr-dialog', { timeout: 2000 });
  await page.click('.mdr-dialog__btn:has-text("取消")');
  await sleep(100);
  expect((await getText(page)).includes('草稿编辑'), 'text lost');
});
await step('Recent entry whose file vanished (NotFoundError): toast + removed from the list', async () => {
  await clearToasts();
  const idFresh = await fsa(() => Object.entries(window.__fsa.st.reg).find(([, r]) => r.name === 'fresh.md')[0]);
  await fsa((id) => window.__fsa.set(id, { missing: true }), idFresh);
  await page.click('.mdr-toolbar__file');
  await page.waitForSelector('.mdr-recent');
  await page.click('.mdr-recent__item:has-text("fresh.md")');
  await page.waitForSelector('.mdr-dialog', { timeout: 2000 });
  await page.click('.mdr-dialog__btn:has-text("丢弃")');
  await sleep(400);
  const t = await toasts();
  expect(t.some((x) => x.includes('文件已不存在')), `toasts ${t.join('|')}`);
  await page.click('.mdr-toolbar__file');
  await page.waitForSelector('.mdr-recent');
  const items = await page.evaluate(() => [...document.querySelectorAll('.mdr-recent li')].map((l) => l.textContent));
  await page.keyboard.press('Escape');
  expect(!items.includes('fresh.md'), `fresh.md still listed: ${items}`);
  check('After 丢弃 + failed reopen the previous document is still shown (not blanked)', (await getText(page)).includes('alpha body'), `text now "${(await getText(page)).slice(0, 30)}"`);
});
/** Answers the SPEC §8 dirty guard if it is on screen (the document is dirty by this point in the run,
 *  so every open/drop legitimately asks before discarding). */
async function answerGuard() {
  const dlg = page.locator('.mdr-dialog__btn:has-text("丢弃")');
  try {
    await dlg.first().waitFor({ state: 'visible', timeout: 1500 });
    await dlg.first().click();
    await sleep(200);
  } catch { /* no guard: the document was clean */ }
}

await step('Recent entry with permission denied on reopen: 需要重新授权 toast', async () => {
  await clearToasts();
  const idB = await fsa(() => Object.entries(window.__fsa.st.reg).find(([, r]) => r.name === 'beta.md')[0]);
  await fsa((id) => window.__fsa.set(id, { perm: 'denied' }), idB);
  await page.click('.mdr-toolbar__file');
  await page.waitForSelector('.mdr-recent');
  const items = await page.evaluate(() => [...document.querySelectorAll('.mdr-recent li')].map((l) => l.textContent));
  expect(items.includes('beta.md'), `beta.md not in recent: ${items}`);
  await page.click('.mdr-recent__item:has-text("beta.md")');
  await answerGuard();
  await sleep(400);
  const t = await toasts();
  expect(t.some((x) => x.includes('需要重新授权')), `toasts ${t.join('|')}`);
});
await step('Drop with getAsFileSystemHandle → file opens with a handle; Mod-s writes in place (no download)', async () => {
  await clearToasts();
  const idD = await fsa(() => window.__fsa.add('dropped-fsa.md', '# Dropped\n\nvia handle\n'));
  await fsa((id) => { window.__fsa.dropHandle = id; }, idD);
  await page.evaluate(() => {
    const app = document.querySelector('.mdr-app');
    const dt = new DataTransfer();
    dt.items.add(new File(['ignored'], 'dropped-fsa.md', { type: 'text/markdown' }));
    app.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await answerGuard();
  await page.waitForFunction(() => window.__mdr.app.getText().includes('via handle'), null, { timeout: 4000 });
  await page.click('.cm-content');
  await page.keyboard.press('Meta+End');
  await page.keyboard.type('!');
  await sleep(50);
  const before = downloads;
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => window.__fsa.writes.some((w) => w.name === 'dropped-fsa.md'), null, { timeout: 4000 });
  expect(downloads === before, 'download fallback used despite handle');
  expect((await statusText(page)).file === 'dropped-fsa.md · 已保存', `status "${(await statusText(page)).file}"`);
});

finish('11-fsa', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
