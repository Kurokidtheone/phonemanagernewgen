#!/usr/bin/env node
// Builds the Rust core (mobile/core-android) for the Android ABIs and puts the libraries where Gradle packs them.
//   needs: rustup targets aarch64/armv7/x86_64-linux-android, and the Android NDK (sdkmanager "ndk;27.2.12479018").
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const jniLibs = join(root, 'mobile/android/app/src/main/jniLibs');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'Library/Android/sdk');
const ndkRoot = process.env.ANDROID_NDK_HOME || (existsSync(join(sdk, 'ndk')) ? join(sdk, 'ndk', readdirSync(join(sdk, 'ndk')).sort().at(-1)) : '');
if (!ndkRoot || !existsSync(ndkRoot)) {
  console.error('The Android NDK was not found. Install it with:  sdkmanager "ndk;27.2.12479018"  (or set ANDROID_NDK_HOME)');
  process.exit(1);
}
const host = process.platform === 'darwin' ? 'darwin-x86_64' : process.platform === 'win32' ? 'windows-x86_64' : 'linux-x86_64';
const bin = join(ndkRoot, 'toolchains/llvm/prebuilt', host, 'bin');
const ext = process.platform === 'win32' ? '.cmd' : '';
const API = 24;
const ABIS = [
  { abi: 'arm64-v8a', triple: 'aarch64-linux-android', clang: 'aarch64-linux-android' },
  { abi: 'armeabi-v7a', triple: 'armv7-linux-androideabi', clang: 'armv7a-linux-androideabi' },
  { abi: 'x86_64', triple: 'x86_64-linux-android', clang: 'x86_64-linux-android' },
];
const only = process.argv.slice(2);
for (const { abi, triple, clang } of ABIS.filter((a) => only.length === 0 || only.includes(a.abi))) {
  const cc = join(bin, `${clang}${API}-clang${ext}`);
  const env = {
    ...process.env,
    [`CC_${triple.replaceAll('-', '_')}`]: cc,
    [`AR_${triple.replaceAll('-', '_')}`]: join(bin, 'llvm-ar'),
    [`CARGO_TARGET_${triple.toUpperCase().replaceAll('-', '_')}_LINKER`]: cc,
  };
  console.log(`\n== ${abi}`);
  execFileSync('cargo', ['build', '-p', 'psm-android', '--release', '--target', triple], { cwd: root, env, stdio: 'inherit' });
  mkdirSync(join(jniLibs, abi), { recursive: true });
  copyFileSync(join(root, 'target', triple, 'release/libpsm_android.so'), join(jniLibs, abi, 'libpsm_android.so'));
}
console.log(`\nLibraries are in ${jniLibs}`);
