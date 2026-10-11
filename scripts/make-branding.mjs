#!/usr/bin/env node
// Cuts the two app icons out of the artwork sheet build/branding/icons.png (computer tile on the left, phone tile on
// the right), makes the white outside the rounded corners transparent, and writes:
//   build/icon.png         the desktop icon (computer and cash register)
//   build/icon-mobile.png  the Android icon (phone)
//   mobile/src/assets/app-icon.png  the same phone icon, small, for the app's header
//   mobile/src/assets/next-level.png and src/renderer/src/assets/next-level.png  the Next Level Dev Labs logo, small, for the About cards
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, resize } from '../mobile/scripts/lib/png.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sheet = decodePng(readFileSync(resolve(root, 'build/branding/icons.png')));

/** The rounded tile inside the box: the white outside its corners becomes transparent, then it is trimmed and made square. */
function tile(x0, y0, x1, y1) {
  const w = x1 - x0;
  const h = y1 - y0;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) sheet.data.copy(data, y * w * 4, ((y0 + y) * sheet.width + x0) * 4, ((y0 + y) * sheet.width + x1) * 4);
  // Flood from the border over every pixel that is still white-ish (the yellow has almost no blue).
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h || seen[y * w + x]) return;
    if (data[(y * w + x) * 4 + 2] < 120) return;
    seen[y * w + x] = 1;
    stack.push(x, y);
  };
  for (let x = 0; x < w; x++) (push(x, 0), push(x, h - 1));
  for (let y = 0; y < h; y++) (push(0, y), push(w - 1, y));
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    push(x + 1, y), push(x - 1, y), push(x, y + 1), push(x, y - 1);
  }
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (seen[y * w + x]) data[(y * w + x) * 4 + 3] = 0;
      else (minX = Math.min(minX, x), maxX = Math.max(maxX, x), minY = Math.min(minY, y), maxY = Math.max(maxY, y));
    }
  const side = Math.max(maxX - minX, maxY - minY) + 1;
  const out = Buffer.alloc(side * side * 4);
  const ox = Math.floor((side - (maxX - minX + 1)) / 2);
  const oy = Math.floor((side - (maxY - minY + 1)) / 2);
  for (let y = minY; y <= maxY; y++) data.copy(out, ((y - minY + oy) * side + ox) * 4, (y * w + minX) * 4, (y * w + maxX + 1) * 4);
  return { width: side, height: side, data: out };
}

const computer = tile(60, 45, 850, 835);
const phone = tile(925, 45, 1720, 835);
writeFileSync(resolve(root, 'build/icon.png'), encodePng(resize(computer, 1024, 1024)));
writeFileSync(resolve(root, 'build/icon-mobile.png'), encodePng(resize(phone, 1024, 1024)));

mkdirSync(resolve(root, 'mobile/src/assets'), { recursive: true });
writeFileSync(resolve(root, 'mobile/src/assets/app-icon.png'), encodePng(resize(phone, 96, 96)));

const logo = decodePng(readFileSync(resolve(root, 'build/branding/next-level-dev-labs.png')));
mkdirSync(resolve(root, 'mobile/src/assets'), { recursive: true });
const small = encodePng(resize(logo, 320, 320), { opaque: true });
writeFileSync(resolve(root, 'mobile/src/assets/next-level.png'), small);
mkdirSync(resolve(root, 'src/renderer/src/assets'), { recursive: true });
writeFileSync(resolve(root, 'src/renderer/src/assets/next-level.png'), small);
console.log('Wrote build/icon.png, build/icon-mobile.png and the small logos in mobile/src/assets');
