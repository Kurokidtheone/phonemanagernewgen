#!/usr/bin/env node
// Turns a fresh copy of the kit into a named product.
//   npm run new-product -- --name "Phone Store Manager" --code PSM
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];

const name = args.name;
const code = (args.code || '').toUpperCase();
if (!name || !/^[A-Z0-9]{2,5}$/.test(code)) {
  console.error('Usage: npm run new-product -- --name "Product Name" --code ABC   (code: 2-5 letters or digits)');
  process.exit(1);
}
const slug = args.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const appId = args.id || `dz.nextleveldevlabs.${slug.replace(/-/g, '')}`;

function edit(file, replacements) {
  const path = resolve(root, file);
  let text = readFileSync(path, 'utf8');
  for (const [pattern, value] of replacements) {
    if (!pattern.test(text)) throw new Error(`Could not find ${pattern} in ${file}`);
    text = text.replace(pattern, value);
  }
  writeFileSync(path, text);
}
const q = (s) => `'${s.replace(/'/g, "\\'")}'`;

edit('src/shared/app.config.ts', [
  [/name: '[^']*',/, `name: ${q(name)},`],
  [/productCode: '[^']*',/, `productCode: ${q(code)},`],
  [/slug: '[^']*',/, `slug: ${q(slug)},`],
]);
edit('package.json', [
  [/"name": "[^"]*"/, `"name": ${JSON.stringify(slug)}`],
  [/"productName": "[^"]*"/, `"productName": ${JSON.stringify(name)}`],
]);
edit('src-tauri/tauri.conf.json', [
  [/"productName": "[^"]*"/, `"productName": ${JSON.stringify(name)}`],
  [/"identifier": "[^"]*"/, `"identifier": ${JSON.stringify(appId)}`],
  [/"copyright": "[^"]*"/, `"copyright": ${JSON.stringify(name)}`],
]);
// The Rust core keeps its own copy of the code and the data folder (a test checks they match app.config.ts).
edit('core/src/services/license.rs', [[/pub const PRODUCT_CODE: &str = "[^"]*";/, `pub const PRODUCT_CODE: &str = ${JSON.stringify(code)};`]]);
edit('core/src/services/backup.rs', [[/pub const SLUG: &str = "[^"]*";/, `pub const SLUG: &str = ${JSON.stringify(slug)};`]]);
edit('src/renderer/index.html', [[/<title>[^<]*<\/title>/, `<title>${name}</title>`]]);
edit('CLAUDE.md', [[/^# .*$/m, `# ${name}`]]);

console.log(`Product set to "${name}" (code ${code}, data folder ${slug}, app id ${appId}).`);
if (existsSync(resolve(root, 'license-keys/license-private.pem'))) {
  console.log('\nWARNING: license-keys/ already holds a signing key from another product.');
  console.log('Move that folder somewhere safe, then run: npm run license:init');
} else {
  console.log('\nNext: npm run license:init   (creates this product\'s own signing key)');
}
