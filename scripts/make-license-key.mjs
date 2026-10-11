#!/usr/bin/env node
// Creates this product's signing key pair, once.
//   license-keys/license-private.pem  -> load it in tools/license-desk.html. Secret. Never commit it.
//   license-keys/license-public.pem   -> embedded in the app when it is built (core/src/services/license.rs)
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(root, 'license-keys');
const privateFile = resolve(dir, 'license-private.pem');
const publicFile = resolve(dir, 'license-public.pem');

if (existsSync(privateFile)) {
  console.error(`A signing key already exists:\n  ${privateFile}\nKeys you already sold depend on it. Delete it yourself only if you are sure.`);
  process.exit(1);
}

mkdirSync(dir, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
writeFileSync(privateFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(publicFile, publicPem);

console.log('Signing key created. The public key is embedded in the app at the next build.\n');
console.log('Load this file in tools/license-desk.html and back it up offline:');
console.log(`  ${privateFile}`);
