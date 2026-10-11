#!/usr/bin/env node
// The phone app's name, launcher icon and splash screen, from the desktop branding:
//   name  <- src/shared/app.config.ts (APP.name)
//   icon  <- build/icon-mobile.png (the phone tile of the artwork sheet; `npm run icon` at the repo root cuts it out)
// Writes into mobile/android/app/src/main/res. Run again whenever the desktop branding changes.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blit, canvas, circleMask, decodePng, encodePng, resize } from './lib/png.mjs';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(mobile, '..');
const res = join(mobile, 'android/app/src/main/res');

const config = readFileSync(join(root, 'src/shared/app.config.ts'), 'utf8');
const name = /name:\s*'([^']+)'/.exec(config)?.[1];
if (!name) throw new Error('APP.name not found in src/shared/app.config.ts');
const iconFile = join(root, 'build/icon-mobile.png');
if (!existsSync(iconFile)) throw new Error('build/icon-mobile.png is missing: run `npm run icon` at the repo root');
const icon = decodePng(readFileSync(iconFile));

const BACKGROUND = [253, 193, 14, 255]; // the yellow of the icon tile
const DENSITY = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

for (const [density, scale] of Object.entries(DENSITY)) {
  const dir = join(res, `mipmap-${density}`);
  const legacy = resize(icon, Math.round(48 * scale), Math.round(48 * scale));
  writeFileSync(join(dir, 'ic_launcher.png'), encodePng(legacy));
  writeFileSync(join(dir, 'ic_launcher_round.png'), encodePng(circleMask(legacy)));
  // Adaptive icon: 108 dp layer, the artwork kept inside the central 66% that every launcher shape shows.
  const layer = Math.round(108 * scale);
  const art = Math.round(layer * 0.78);
  const foreground = canvas(layer, layer, BACKGROUND);
  blit(foreground, resize(icon, art, art), Math.round((layer - art) / 2), Math.round((layer - art) / 2));
  writeFileSync(join(dir, 'ic_launcher_foreground.png'), encodePng(foreground));
}
writeFileSync(join(res, 'values/ic_launcher_background.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#FDC10E</color>\n</resources>\n`);

// Splash: every size already in the project is redrawn, same dimensions, yellow with the icon in the middle.
const splashes = ['drawable', ...readdirSync(res).filter((d) => /^drawable-(port|land)-/.test(d))].map((d) => join(res, d, 'splash.png')).filter(existsSync);
for (const file of splashes) {
  const { width, height } = decodePng(readFileSync(file));
  const base = canvas(width, height, BACKGROUND);
  const side = Math.round(Math.min(width, height) * 0.34);
  blit(base, resize(icon, side, side), Math.round((width - side) / 2), Math.round((height - side) / 2));
  writeFileSync(file, encodePng(base, { opaque: true }));
}

const strings = join(res, 'values/strings.xml');
writeFileSync(strings, readFileSync(strings, 'utf8').replace(/(<string name="(?:app_name|title_activity_main)">)[^<]*(<\/string>)/g, `$1${name}$2`));
console.log(`Android name "${name}", launcher icons and ${splashes.length} splash screens written from build/icon-mobile.png.`);
