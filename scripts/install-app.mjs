// scripts/install-app.mjs — installs the packaged app into /Applications and re-registers it with
// LaunchServices. Before the installed copy is removed it is backed up to
// release/backup/MDReader-<installed version>-<date>.zip (the install stops if that fails), and it
// refuses to run while the installed application is running. The default handler for the Markdown
// UTI is changed only with --set-default; without it the current handler is printed (--show).
//   npm run app:install                     (run `npm run app:build` first)
//   npm run app:install -- --set-default    (also make MDReader the default for .md)
// Nothing here needs sudo: /Applications is user-writable on this machine.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'release', 'mac-arm64', 'MDReader.app');
const TARGET = '/Applications/MDReader.app';
const BACKUP_DIR = path.join(ROOT, 'release', 'backup');
const SET_DEFAULT = process.argv.slice(2).includes('--set-default');
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

/** lsregister, tolerating a non-zero exit (unregistering something it never knew is fine). */
function lsregister(args) {
  try {
    run(LSREGISTER, args);
  } catch {
    console.log(`  （lsregister ${args[0]} 返回非 0，忽略）`);
  }
}

/** Every bundle LaunchServices currently knows under our appId. */
function registeredBundles() {
  try {
    const dump = execFileSync(LSREGISTER, ['-dump'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const paths = new Set();
    let current = null;
    for (const line of dump.split('\n')) {
      const p = /^\s*path:\s+(.*MDReader\.app)\s*$/.exec(line);
      if (p) current = p[1];
      // The helper bundles carry com.zyx.mdreader.helper… — only an EXACT id counts.
      else if (current && /CFBundleIdentifier\s*=\s*"?com\.zyx\.mdreader(?![\w.])/.test(line)) {
        paths.add(current);
        current = null;
      }
    }
    return [...paths];
  } catch {
    return [];
  }
}

if (process.platform !== 'darwin') {
  console.error('app:install 目前只支持 macOS。');
  process.exit(1);
}
if (!fs.existsSync(SOURCE)) {
  console.error(`找不到 ${SOURCE}\n请先运行：npm run app:build`);
  process.exit(1);
}

// 0. never replace an application that is running (its main process or any helper)
try {
  const pids = execFileSync('pgrep', ['-f', `${TARGET}/Contents/`], { encoding: 'utf8' }).trim();
  if (pids) {
    console.error(`MDReader 正在运行（进程 ${pids.split('\n').join(', ')}），请先退出它再安装。`);
    process.exit(1);
  }
} catch (e) {
  // pgrep exits 1 when nothing matches; anything else means we cannot tell, so stop.
  if (e.status !== 1) {
    console.error(`无法检查 MDReader 是否在运行：${e.message}`);
    process.exit(1);
  }
}

// 1. back up the installed copy, then replace it
if (fs.existsSync(TARGET)) {
  let version = 'unknown';
  try {
    version = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-',
      path.join(TARGET, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim() || 'unknown';
  } catch { /* keep 'unknown' */ }
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  let zip = path.join(BACKUP_DIR, `MDReader-${version}-${date}.zip`);
  for (let n = 2; fs.existsSync(zip); n++) zip = path.join(BACKUP_DIR, `MDReader-${version}-${date}-${n}.zip`);
  try {
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', TARGET, zip]);
    if (!fs.existsSync(zip) || fs.statSync(zip).size === 0) throw new Error('备份文件不存在或为空');
  } catch (e) {
    console.error(`备份 ${TARGET} 失败，安装已停止，旧版本没有动：${e.message}`);
    process.exit(1);
  }
  console.log(`已备份旧版本 ${version} 到 ${zip}`);
  console.log(`移除旧版本 ${TARGET}`);
  fs.rmSync(TARGET, { recursive: true, force: true });
}

// 2. copy (ditto preserves the bundle's extended attributes and the ad-hoc signature)
run('ditto', [SOURCE, TARGET]);

// 3. LaunchServices must know exactly ONE bundle with appId com.zyx.mdreader, or `open note.md`
//    can resolve to the build directory — which `npm run app:build` deletes and recreates, so a
//    double-click would hit a vanished or half-written bundle. Unregister the build artefact first
//    and then remove it: macOS re-registers bundles it stumbles over, and the only durable way to
//    keep it from claiming the id is for it not to be there. `npm run app:build` recreates it.
lsregister(['-u', SOURCE]);
fs.rmSync(SOURCE, { recursive: true, force: true });
console.log(`已移除构建产物 ${SOURCE}（重新构建即可再次生成）`);

// -R (recursive) matters: with a plain -f the imported type declarations for the secondary
// extensions (.mdown/.mkd/.mkdn, which macOS gives dynamic UTIs) did not take, and those files
// resolved to whatever other editor claimed them.
run(LSREGISTER, ['-f', '-R', TARGET]);

// 4. default handler for net.daringfireball.markdown (public.plain-text is untouched): changed only
//    with --set-default; otherwise only the current handler is printed.
if (SET_DEFAULT) run('swift', [path.join(ROOT, 'scripts', 'set-default-md.swift')]);
else run('swift', [path.join(ROOT, 'scripts', 'set-default-md.swift'), '--show']);

// 5. verify the id is unambiguous again
const bundles = registeredBundles();
if (bundles.length > 1) {
  console.warn('');
  console.warn('警告：LaunchServices 里仍有多个 com.zyx.mdreader 包：');
  for (const b of bundles) console.warn(`  ${b}`);
  console.warn(`请手动执行：${LSREGISTER} -u <多余的路径>`);
} else {
  console.log(`LaunchServices 中 com.zyx.mdreader 只有一个包：${bundles[0] || TARGET}`);
}

console.log('');
console.log('已安装到 /Applications/MDReader.app。');
if (SET_DEFAULT) {
  console.log('已设为 .md 的默认打开方式。如需还原，请按上面 set-default-md.swift 打印的命令执行，例如：');
  console.log('  swift scripts/set-default-md.swift com.apple.TextEdit');
} else {
  console.log('默认打开方式没有改动（见上面打印的当前设置）。要设为默认：npm run app:install -- --set-default');
}
