// Self-test of bench/electron/_electron.mjs: a launch without a profile argument must NOT use the real profile.
import os from 'node:os';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { electron, isolatedProfile } from './_electron.mjs';

const EXE = process.env.MDR_EXE || '/Applications/MDReader.app/Contents/MacOS/MDReader';
const REAL = path.join(os.homedir(), 'Library', 'Application Support', 'MDReader');
const realBefore = existsSync(REAL) ? statSync(REAL).mtimeMs : 0;
const timer = setTimeout(() => { console.log('FAIL timeout'); process.exit(2); }, 60000);
let app;
let ok = false;
try {
  app = await electron.launch({ executablePath: EXE, args: [], timeout: 30000 });
  const info = await app.evaluate(({ app: a }) => ({ userData: a.getPath('userData'), stub: String(a.addRecentDocument) }));
  const usesTemp = info.userData === isolatedProfile() || info.userData.startsWith(os.tmpdir()) || info.userData.includes('mdr-iso-');
  console.log(JSON.stringify({ userData: info.userData.replace(os.tmpdir(), '<tmp>'), usesTemp, notRealProfile: info.userData !== REAL, stubbed: info.stub.replace(/\s+/g, ' ') }));
  ok = usesTemp && info.userData !== REAL && /=>\s*\{\s*\}/.test(info.stub);
} finally {
  try { if (app) await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {}); } catch { /* gone */ }
  clearTimeout(timer);
}
const realAfter = existsSync(REAL) ? statSync(REAL).mtimeMs : 0;
console.log(ok && realBefore === realAfter ? 'PASS isolated launch, real profile untouched' : 'FAIL');
process.exit(ok && realBefore === realAfter ? 0 : 1);
