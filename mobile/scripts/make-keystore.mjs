#!/usr/bin/env node
// Creates the release keystore, once, and the keystore.properties file Gradle reads.
//   mobile/android/release.keystore      the signing key (PKCS12). Secret.
//   mobile/android/keystore.properties   its passwords. Secret. Both are git-ignored and must never be committed.
//
// BACK THEM UP (both files, somewhere safe and offline, e.g. a USB key and a password manager).
// Android only installs an update over an installed app when it is signed with the SAME key. If this key is
// lost, every customer has to uninstall the app (losing the pairing) before a new build can be installed.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const android = resolve(dirname(fileURLToPath(import.meta.url)), '../android');
const keystore = join(android, 'release.keystore');
const properties = join(android, 'keystore.properties');

if (existsSync(keystore) || existsSync(properties)) {
  console.error(`A release keystore already exists:\n  ${keystore}\nApps already installed on customers' phones depend on it. Delete it yourself only if you are sure.`);
  process.exit(1);
}

const config = readFileSync(resolve(android, '../../src/shared/app.config.ts'), 'utf8');
const product = /name:\s*'([^']+)'/.exec(config)?.[1] ?? 'Phone Store Manager';
const alias = 'release';
const password = randomBytes(24).toString('base64url');
const dname = `CN=${product}, O=${product}, C=DZ`;

function haveKeytool() {
  try {
    execFileSync('keytool', ['-help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let tool;
if (haveKeytool()) {
  tool = 'keytool';
  execFileSync(
    'keytool',
    ['-genkeypair', '-storetype', 'PKCS12', '-keystore', keystore, '-alias', alias, '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-storepass', password, '-keypass', password, '-dname', dname],
    { stdio: 'inherit' },
  );
} else {
  // No JDK on this machine: openssl makes the same PKCS12 keystore, which Gradle and Android accept.
  tool = 'openssl (keytool was not found)';
  const dir = mkdtempSync(join(tmpdir(), 'psm-key-'));
  try {
    const key = join(dir, 'key.pem');
    const cert = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '10000', '-subj', `/CN=${product}/O=${product}/C=DZ`], { stdio: 'ignore' });
    execFileSync('openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-name', alias, '-out', keystore, '-passout', `pass:${password}`], { stdio: 'ignore' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

writeFileSync(properties, `storeFile=release.keystore\nstoreType=pkcs12\nstorePassword=${password}\nkeyAlias=${alias}\nkeyPassword=${password}\n`, { mode: 0o600 });

console.log(`Release keystore created with ${tool}:`);
console.log(`  keystore   ${keystore}`);
console.log(`  passwords  ${properties}`);
console.log('\nBACK UP BOTH FILES NOW, offline. Updates must be signed with this same keystore forever.');
console.log('Neither file is committed (.gitignore). For GitHub Actions, put them in repository secrets (see docs/mobile-install.md).');
