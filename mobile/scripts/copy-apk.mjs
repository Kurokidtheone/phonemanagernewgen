#!/usr/bin/env node
// Copies a built APK to
//   dist/<product>-mobile-<version>.apk   to hand out or attach to a release
//   build/mobile/app.apk + app.json       what the desktop installer packs and the PC serves at /app.apk
// Usage: node scripts/copy-apk.mjs [path-to-apk] [versionCode]
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(mobile, '..');

/** Seconds since 2026-01-01: the same formula as android/app/build.gradle, so every build has a higher version code. */
export const versionCodeNow = () => Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 1000);

export function copyApk(apk, versionCode) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const slug = /slug:\s*'([^']+)'/.exec(readFileSync(join(root, 'src/shared/app.config.ts'), 'utf8'))?.[1] ?? 'app';
  const name = `${slug}-mobile-${version}.apk`;
  const dist = join(root, 'dist', name);
  const staged = join(root, 'build/mobile/app.apk');
  mkdirSync(dirname(dist), { recursive: true });
  mkdirSync(dirname(staged), { recursive: true });
  copyFileSync(apk, dist);
  copyFileSync(apk, staged);
  writeFileSync(
    join(root, 'build/mobile/app.json'),
    JSON.stringify({ versionName: version, versionCode: Number(versionCode), file: name, size: statSync(apk).size, sha256: createHash('sha256').update(readFileSync(apk)).digest('hex') }, null, 2),
  );
  return { dist, staged };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const apk = process.argv[2] ?? join(mobile, 'android/app/build/outputs/apk/release/app-release.apk');
  const out = copyApk(apk, process.argv[3] ?? versionCodeNow());
  console.log(`Copied to ${out.dist}`);
}
