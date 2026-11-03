#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

const args = process.argv.slice(2);
const valueAfter = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const inputPath = valueAfter('--input');
const wordmarkPath = valueAfter('--wordmark');
const markPath = valueAfter('--mark');

if (!inputPath || !wordmarkPath || !markPath) {
  console.error('Usage: node scripts/extract-dark-logo-alpha.mjs --input source.png --wordmark wordmark.png --mark mark.png');
  process.exit(2);
}

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(file) {
  const png = readFileSync(file);
  if (!png.subarray(0, 8).equals(signature)) throw new Error('Input is not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('Interlaced PNGs are not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12;
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType)) {
    throw new Error(`Expected 8-bit RGB/RGBA PNG, received bitDepth=${bitDepth} colorType=${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const packed = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * channels);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = packed[sourceOffset++];
    const rowOffset = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = packed[sourceOffset++];
      const left = x >= channels ? pixels[rowOffset + x - channels] : 0;
      const up = y > 0 ? pixels[rowOffset + x - stride] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[rowOffset + x - stride - channels] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) value = raw + paeth(left, up, upperLeft);
      else throw new Error(`Unsupported PNG filter ${filter}`);
      pixels[rowOffset + x] = value & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += channels, j += 4) {
    rgba[j] = pixels[i];
    rgba[j + 1] = pixels[i + 1];
    rgba[j + 2] = pixels[i + 2];
    rgba[j + 3] = channels === 4 ? pixels[i + 3] : 255;
  }
  return { width, height, rgba };
}

function extractDarkForeground(image) {
  const output = Buffer.alloc(image.rgba.length);
  for (let i = 0; i < image.rgba.length; i += 4) {
    const luminance = Math.round(image.rgba[i] * 0.2126 + image.rgba[i + 1] * 0.7152 + image.rgba[i + 2] * 0.0722);
    const extracted = luminance >= 230 ? 0 : luminance <= 195 ? 255 : Math.round(((230 - luminance) / 35) * 255);
    const alpha = Math.round((extracted * image.rgba[i + 3]) / 255);
    output[i] = 0;
    output[i + 1] = 0;
    output[i + 2] = 0;
    output[i + 3] = alpha;
  }
  return { ...image, rgba: output };
}

function boundsOf(image, left = 0, right = image.width - 1) {
  let minX = right;
  let maxX = left;
  let minY = image.height - 1;
  let maxY = 0;
  let found = false;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (image.rgba[(y * image.width + x) * 4 + 3] <= 8) continue;
      found = true;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (!found) throw new Error('No dark logo foreground detected');
  return { minX, maxX, minY, maxY };
}

function findMarkBoundary(image, fullBounds) {
  const occupied = new Array(image.width).fill(false);
  for (let x = fullBounds.minX; x <= fullBounds.maxX; x += 1) {
    for (let y = fullBounds.minY; y <= fullBounds.maxY; y += 1) {
      if (image.rgba[(y * image.width + x) * 4 + 3] > 16) {
        occupied[x] = true;
        break;
      }
    }
  }
  const minSearch = fullBounds.minX + Math.round((fullBounds.maxX - fullBounds.minX) * 0.12);
  const maxSearch = fullBounds.minX + Math.round((fullBounds.maxX - fullBounds.minX) * 0.42);
  let best = null;
  let runStart = null;
  for (let x = minSearch; x <= maxSearch + 1; x += 1) {
    if (x <= maxSearch && !occupied[x]) {
      if (runStart === null) runStart = x;
    } else if (runStart !== null) {
      const candidate = { start: runStart, end: x - 1, length: x - runStart };
      if (candidate.length >= 12 && (!best || candidate.length > best.length)) best = candidate;
      runStart = null;
    }
  }
  if (!best) throw new Error('Could not locate the gap between mark and wordmark');
  return best.start - 1;
}

function crop(image, bounds, padding = 16) {
  const minX = Math.max(0, bounds.minX - padding);
  const maxX = Math.min(image.width - 1, bounds.maxX + padding);
  const minY = Math.max(0, bounds.minY - padding);
  const maxY = Math.min(image.height - 1, bounds.maxY + padding);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = ((minY + y) * image.width + minX) * 4;
    image.rgba.copy(rgba, y * width * 4, sourceStart, sourceStart + width * 4);
  }
  return { width, height, rgba };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  typeBuffer.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), data.length + 8);
  return result;
}

function encodePng(image) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc((image.width * 4 + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const rowOffset = y * (image.width * 4 + 1);
    scanlines[rowOffset] = 0;
    image.rgba.copy(scanlines, rowOffset + 1, y * image.width * 4, (y + 1) * image.width * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const extracted = extractDarkForeground(decodePng(inputPath));
const fullBounds = boundsOf(extracted);
const markEnd = findMarkBoundary(extracted, fullBounds);
const wordmark = crop(extracted, fullBounds, 18);
const mark = crop(extracted, boundsOf(extracted, fullBounds.minX, markEnd), 18);
writeFileSync(wordmarkPath, encodePng(wordmark));
writeFileSync(markPath, encodePng(mark));
console.log(`wordmark ${wordmark.width}x${wordmark.height} -> ${wordmarkPath}`);
console.log(`mark ${mark.width}x${mark.height} -> ${markPath}`);
