import { launch, step, expect, finish, sleep, getFailures, focusEditor, getText } from '../ux/lib.mjs';
const BASE = 'http://localhost:5203/';
const { browser, page, errors } = await launch();
page.setDefaultTimeout(12000);

const boot = async (q = '?mode=split') => {
  await page.goto(BASE + q);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 30000 });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(400);
};
await boot();
// start from a clean slate
await page.evaluate(async () => { const dbs = await indexedDB.databases?.() ?? []; for (const d of dbs) indexedDB.deleteDatabase(d.name); });
await boot();

const MARK = '草稿内容 DRAFT-' + Date.now();

await step('editing an untitled document writes a draft to IndexedDB', async () => {
  await focusEditor(page);
  await page.keyboard.type(MARK);
  await sleep(2200);
  const keys = await page.evaluate(async () => {
    const names = (await indexedDB.databases?.()) ?? [];
    const out = {};
    for (const n of names) {
      const db = await new Promise((res, rej) => { const r = indexedDB.open(n.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      for (const store of [...db.objectStoreNames]) {
        const tx = db.transaction(store, 'readonly');
        const all = await new Promise((res) => { const r = tx.objectStore(store).getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => res(['<err>']); });
        out[`${n.name}/${store}`] = all.map(String);
      }
      db.close();
    }
    return out;
  });
  const flat = JSON.stringify(keys);
  expect(/mdr\.draft:/.test(flat), `no mdr.draft:* key in IndexedDB: ${flat}`);
  return flat;
});
await step('status bar reports the draft state', async () => {
  const s = await page.evaluate(() => document.querySelector('.mdr-statusbar__item[data-stat=file]')?.textContent);
  return JSON.stringify(s);
});

await step('after reload the restore prompt appears with 恢复 / 丢弃', async () => {
  await boot();
  await sleep(1500);
  const t = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map(e => ({ text: e.textContent, buttons: [...e.querySelectorAll('button')].map(b => b.textContent.trim()) })));
  expect(t.length > 0, 'no restore toast after reload');
  const j = JSON.stringify(t);
  expect(/草稿/.test(j), j);
  expect(/恢复/.test(j) && /丢弃/.test(j), `restore toast lacks 恢复/丢弃 actions: ${j}`);
  return j;
});
await step('clicking 恢复 restores the draft text', async () => {
  const before = await getText(page);
  expect(!before.includes(MARK), `draft text was already in the editor before restoring: ${JSON.stringify(before.slice(0,60))}`);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.mdr-toast button')].find(b => /恢复/.test(b.textContent));
    b.click();
  });
  await sleep(1200);
  const after = await getText(page);
  expect(after.includes(MARK), `after 恢复 the text is ${JSON.stringify(after.slice(0,80))}, want to contain ${MARK}`);
  return JSON.stringify(after.slice(0, 60));
});
await step('丢弃 removes the draft so the prompt does not return', async () => {
  // make a fresh draft, reload, discard, reload again
  await page.evaluate(() => window.__mdr.loadText('', '未命名.md'));
  await focusEditor(page);
  await page.keyboard.type('临时草稿 TEMP');
  await sleep(2200);
  await boot();
  await sleep(1500);
  const shown = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map(e => e.textContent));
  expect(shown.some(s => /草稿/.test(s)), `no prompt on the second round: ${JSON.stringify(shown)}`);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.mdr-toast button')].find(b => /丢弃/.test(b.textContent));
    b.click();
  });
  await sleep(800);
  await boot();
  await sleep(1800);
  const again = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map(e => e.textContent));
  expect(!again.some(s => /草稿/.test(s)), `prompt returned after 丢弃: ${JSON.stringify(again)}`);
  return JSON.stringify(again);
});

finish('10-drafts', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
