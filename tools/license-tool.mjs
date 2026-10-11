#!/usr/bin/env node
// License tool for every app built from this kit. No dependencies, Node 18+.
//
//   node license-tool.mjs init                              create the key pair (once)
//   node license-tool.mjs sign --product KIT --device XXXX-XXXX-XXXX-XXXX --name "Customer" [--edition shop|phone]
//   node license-tool.mjs decode <LICENSE-KEY> [--device XXXX-XXXX-XXXX-XXXX]
//
// Key format: base32( signature[64 bytes] + payload JSON ), in groups of 5.
// Payload: { p: product code, d: device id, n: customer name, e: edition, i: issued date }
// Use one key pair per product: set LICENSE_PRIVATE_KEY / LICENSE_PUBLIC_KEY to that product's files.
// decode needs only license-public.pem. sign needs license-private.pem,
// which must never be committed or shipped inside the app.

import { generateKeyPairSync, sign, verify, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRIVATE_FILE = process.env.LICENSE_PRIVATE_KEY || 'license-keys/license-private.pem';
const PUBLIC_FILE = process.env.LICENSE_PUBLIC_KEY || 'license-keys/license-public.pem';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SIG_LEN = 64;

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid character "${ch}" in license key`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const normalizeDevice = (d) => String(d).toUpperCase().replace(/[^0-9A-F]/g, '');
const group = (s, n) => s.match(new RegExp(`.{1,${n}}`, 'g')).join('-');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else args._.push(argv[i]);
  }
  return args;
}

export function decodeLicense(licenseKey, publicKeyPem) {
  const raw = base32Decode(licenseKey.toUpperCase().replace(/[^A-Z2-7]/g, ''));
  if (raw.length <= SIG_LEN) throw new Error('License key is too short');
  const signature = raw.subarray(0, SIG_LEN);
  const payloadBytes = raw.subarray(SIG_LEN);
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw new Error('License key is corrupted (payload is not readable)');
  }
  const signatureValid = publicKeyPem
    ? verify(null, payloadBytes, createPublicKey(publicKeyPem), signature)
    : null; // null = not checked
  return {
    product: payload.p,
    deviceId: payload.d,
    customer: payload.n,
    edition: payload.e,
    issued: payload.i,
    signatureValid,
  };
}

function cmdInit() {
  mkdirSync(dirname(PRIVATE_FILE), { recursive: true });
  if (existsSync(PRIVATE_FILE)) {
    console.error(`${PRIVATE_FILE} already exists. Refusing to overwrite it.`);
    process.exit(1);
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(PRIVATE_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(PUBLIC_FILE, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`Created ${PRIVATE_FILE} (keep secret, back it up offline)`);
  console.log(`Created ${PUBLIC_FILE} (embed this one in the app)`);
}

function cmdSign(args) {
  if (!args.product || !args.device || !args.name) {
    console.error('Usage: sign --product CODE --device XXXX-XXXX-XXXX-XXXX --name "Customer" [--edition shop|phone]');
    process.exit(1);
  }
  if (args.edition && !['shop', 'phone'].includes(args.edition)) {
    console.error('Edition must be "shop" (the PC with up to 3 phones) or "phone" (the Android app on its own).');
    process.exit(1);
  }
  const device = normalizeDevice(args.device);
  if (device.length !== 16) {
    console.error('Device ID must be 16 hex characters (XXXX-XXXX-XXXX-XXXX).');
    process.exit(1);
  }
  const payload = {
    p: String(args.product).toUpperCase(),
    d: group(device, 4),
    n: args.name,
    e: args.edition || 'shop',
    i: new Date().toISOString().slice(0, 10),
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, payloadBytes, createPrivateKey(readFileSync(PRIVATE_FILE)));
  console.log(group(base32Encode(Buffer.concat([signature, payloadBytes])), 5));
}

function cmdDecode(args) {
  const key = args._.slice(1).join('');
  if (!key) {
    console.error('Usage: decode <LICENSE-KEY> [--device XXXX-XXXX-XXXX-XXXX]');
    process.exit(1);
  }
  const publicPem = existsSync(PUBLIC_FILE) ? readFileSync(PUBLIC_FILE) : null;
  const lic = decodeLicense(key, publicPem);

  console.log(`Product   : ${lic.product ?? '(none)'}`);
  console.log(`Device ID : ${lic.deviceId}`);
  console.log(`Customer  : ${lic.customer}`);
  console.log(`Edition   : ${lic.edition}`);
  console.log(`Issued    : ${lic.issued}`);
  console.log(
    `Signature : ${
      lic.signatureValid === null ? `not checked (${PUBLIC_FILE} not found)`
      : lic.signatureValid ? 'VALID' : 'INVALID (not signed by your private key, or altered)'
    }`
  );
  let ok = lic.signatureValid !== false;
  if (args.device) {
    const match = normalizeDevice(args.device) === normalizeDevice(lic.deviceId);
    console.log(`Device    : ${match ? 'MATCHES' : 'DOES NOT MATCH'} ${args.device}`);
    ok = ok && match;
  }
  process.exit(ok ? 0 : 2);
}

// Compared as paths, not URLs: a folder name with a space ("PhoneStore Manger") breaks the URL comparison.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args._[0] === 'init') cmdInit();
    else if (args._[0] === 'sign') cmdSign(args);
    else if (args._[0] === 'decode') cmdDecode(args);
    else console.log('Commands: init | sign --product CODE --device ID --name "Customer" | decode <KEY> [--device ID]');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
