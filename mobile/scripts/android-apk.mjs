#!/usr/bin/env node
// Builds the signed release APK and copies it where it is used (see copy-apk.mjs).
//   needs: JDK 21, the Android SDK (platform 36), and the keystore from `npm run android:keystore`.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyApk, versionCodeNow } from './copy-apk.mjs';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const android = join(mobile, 'android');
const win = process.platform === 'win32';
const run = (cmd, args, cwd = mobile) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: win });

if (!existsSync(join(android, 'keystore.properties'))) {
  console.error('There is no release keystore yet. Create it once with:  npm run android:keystore\n(then back it up: updates must always be signed with the same one)');
  process.exit(1);
}
try {
  execFileSync(win ? 'java.exe' : 'java', ['-version'], { stdio: 'ignore' });
} catch {
  console.error('Java was not found. Install JDK 21 and the Android SDK (platform 36), then run this again.');
  process.exit(1);
}

const versionCode = versionCodeNow();
run('node', ['scripts/make-android-assets.mjs']);
run('npm', ['run', 'build']);
run('npx', ['cap', 'sync', 'android']);
run(win ? 'gradlew.bat' : './gradlew', ['assembleRelease', `-PversionCode=${versionCode}`], android);

const apk = join(android, 'app/build/outputs/apk/release/app-release.apk');
if (!existsSync(apk)) {
  console.error(`Gradle finished but ${apk} is missing (an unsigned build is named app-release-unsigned.apk: check keystore.properties).`);
  process.exit(1);
}
const out = copyApk(apk, versionCode);
console.log(`\nSigned APK ready:\n  ${out.dist}\n  (also staged for the desktop installer: ${out.staged})`);
