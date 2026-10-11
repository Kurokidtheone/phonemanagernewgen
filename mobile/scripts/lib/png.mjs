// Just enough PNG for the launcher icons and the splash: read an 8-bit RGB/RGBA PNG, resize it, draw on a canvas, write it.
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};

/** { width, height, data: RGBA bytes } from an 8-bit RGB or RGBA, non-interlaced PNG. */
export function decodePng(file) {
  if (!file.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file');
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  for (let at = 8; at < file.length; ) {
    const length = file.readUInt32BE(at);
    const type = file.toString('latin1', at + 4, at + 8);
    const data = file.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, color, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) throw new Error('Use an 8-bit RGB or RGBA PNG without interlacing for build/icon.png');
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i] + add) & 255;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const o = (y * width + x) * 4;
      out[o] = line[s];
      out[o + 1] = line[s + 1];
      out[o + 2] = line[s + 2];
      out[o + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

export function encodePng({ width, height, data }, { opaque = false } = {}) {
  const channels = opaque ? 3 : 4;
  const stride = width * channels + 1;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const o = y * stride + 1 + x * channels;
      rows[o] = data[s];
      rows[o + 1] = data[s + 1];
      rows[o + 2] = data[s + 2];
      if (!opaque) rows[o + 3] = data[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, opaque ? 2 : 6, 0, 0, 0], 8);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Area-average resize (good for shrinking), with premultiplied alpha so soft edges stay clean. */
export function resize(img, width, height) {
  const out = Buffer.alloc(width * height * 4);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const x0 = x * sx;
      const x1 = (x + 1) * sx;
      const y0 = y * sy;
      const y1 = (y + 1) * sy;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;
      for (let j = Math.floor(y0); j < Math.min(img.height, Math.ceil(y1)); j++) {
        const wy = Math.min(j + 1, y1) - Math.max(j, y0);
        for (let i = Math.floor(x0); i < Math.min(img.width, Math.ceil(x1)); i++) {
          const w = wy * (Math.min(i + 1, x1) - Math.max(i, x0));
          const s = (j * img.width + i) * 4;
          const alpha = img.data[s + 3] / 255;
          r += img.data[s] * alpha * w;
          g += img.data[s + 1] * alpha * w;
          b += img.data[s + 2] * alpha * w;
          a += alpha * w;
          weight += w;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / weight) * 255);
    }
  }
  return { width, height, data: out };
}

export function canvas(width, height, rgba = [0, 0, 0, 0]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, data };
}

/** Draws `img` over `base` (alpha blended) with its top-left corner at (left, top). */
export function blit(base, img, left, top) {
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const bx = x + left;
      const by = y + top;
      if (bx < 0 || by < 0 || bx >= base.width || by >= base.height) continue;
      const s = (y * img.width + x) * 4;
      const d = (by * base.width + bx) * 4;
      const a = img.data[s + 3] / 255;
      const da = base.data[d + 3] / 255;
      const oa = a + da * (1 - a);
      for (let k = 0; k < 3; k++) base.data[d + k] = oa === 0 ? 0 : Math.round((img.data[s + k] * a + base.data[d + k] * da * (1 - a)) / oa);
      base.data[d + 3] = Math.round(oa * 255);
    }
  }
}

/** The same picture, cut to a circle. */
export function circleMask(img) {
  const out = { ...img, data: Buffer.from(img.data) };
  const r = img.width / 2;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
      const cover = Math.min(1, Math.max(0, r - d + 0.5));
      const o = (y * img.width + x) * 4 + 3;
      out.data[o] = Math.round(out.data[o] * cover);
    }
  }
  return out;
}
