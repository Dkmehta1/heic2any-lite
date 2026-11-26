/**
 * @jest-environment node
 */
import { crc32, inflateSync } from 'zlib';
import { decodeHeicToRgba, type RgbaImage } from '../decodeHeic';
import { constants, deflateRawSync, inflateRawSync } from 'zlib';
import { DeflateFormatError, makeJoinable } from '../png/deflateJoin';
import { canEncodePng, encodePng, encodePngStrip, type PngStripJob } from '../png/encodePng';
import { loadSample } from '../__fixtures__/heifBuilder';

/** Independent PNG reader (8-bit RGB/RGBA, no interlace) used to check the encoder's output. */
function readPng(file: Uint8Array): { width: number; height: number; colorType: number; rgba: Uint8Array; idatCount: number } {
  expect([...file.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const types: string[] = [];
  const idat: Uint8Array[] = [];
  let ihdr: Uint8Array | null = null;
  for (let at = 8; at < file.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
    const data = file.subarray(at + 8, at + 8 + length);
    expect(view.getUint32(at + 8 + length)).toBe(crc32(file.subarray(at + 4, at + 8 + length)));
    types.push(type);
    if (type === 'IHDR') ihdr = data;
    if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  expect(types[0]).toBe('IHDR');
  expect(types[types.length - 1]).toBe('IEND');
  const h = new DataView(ihdr!.buffer, ihdr!.byteOffset, 13);
  const width = h.getUint32(0);
  const height = h.getUint32(4);
  const colorType = ihdr![9];
  expect([ihdr![8], ihdr![10], ihdr![11], ihdr![12]]).toEqual([8, 0, 0, 0]);
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  expect(raw.length).toBe((stride + 1) * height);

  const rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error(`bad filter type ${filter} on row ${y}`);
    const row = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = (row[i] + predictor) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      for (let ch = 0; ch < 4; ch++) rgba[(y * width + x) * 4 + ch] = ch < bpp ? row[x * bpp + ch] : 255;
    }
    prev = row;
  }
  return { width, height, colorType, rgba, idatCount: idat.length };
}

const bytesOf = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());

/** Deterministic pseudo-random bytes (incompressible content). */
function noise(n: number, seed = 1): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

describe('encodePng', () => {
  it('writes an opaque photo as RGB with exactly the same pixels', async () => {
    const [image] = await decodeHeicToRgba(loadSample(), { yieldBetweenTiles: false });
    const blob = await encodePng(image);
    expect(blob!.type).toBe('image/png');
    const png = readPng(await bytesOf(blob!));
    expect([png.width, png.height, png.colorType]).toEqual([800, 600, 2]);
    expect(Buffer.from(png.rgba).equals(Buffer.from(image.data))).toBe(true);
  });

  it('keeps the alpha channel, unpremultiplied, when any pixel is not opaque', async () => {
    const data = noise(37 * 23 * 4, 7);
    data[3] = 0; // fully transparent pixel whose colour must survive (a canvas would zero it)
    const image: RgbaImage = { width: 37, height: 23, data };
    const png = readPng(await bytesOf((await encodePng(image))!));
    expect(png.colorType).toBe(6);
    expect(Buffer.from(png.rgba).equals(Buffer.from(data))).toBe(true);
  });

  it('handles images spanning several row batches and IDAT chunks', async () => {
    const width = 700;
    const height = 520; // > 1 MiB of RGBA noise: several 1 MiB batches and IDAT chunks
    const image: RgbaImage = { width, height, data: noise(width * height * 4, 3) };
    const png = readPng(await bytesOf((await encodePng(image))!));
    expect(png.idatCount).toBeGreaterThan(1);
    expect(Buffer.from(png.rgba).equals(Buffer.from(image.data))).toBe(true);
  });

  it('handles 1x1 images', async () => {
    const image: RgbaImage = { width: 1, height: 1, data: Uint8ClampedArray.from([10, 20, 30, 255]) };
    const png = readPng(await bytesOf((await encodePng(image))!));
    expect([...png.rgba]).toEqual([10, 20, 30, 255]);
  });

  it('gives the same file whatever the concurrency, and a valid Adler-32 over all strips', async () => {
    const [photo] = await decodeHeicToRgba(loadSample(), { yieldBetweenTiles: false });
    // 2400 rows of 200 px: 601 bytes per row, 1744 rows per 1 MiB strip -> 2 strips; 6 strips at 800 px
    for (const width of [200, 800]) {
      const height = 2400;
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        const src = (y % 600) * 800 * 4;
        data.set(photo.data.subarray(src, src + width * 4), y * width * 4);
      }
      const image: RgbaImage = { width, height, data };
      const strips: number[] = [];
      const runStrip = (job: PngStripJob) => {
        strips.push(job.rgba.length);
        return encodePngStrip(job);
      };
      const serial = await bytesOf((await encodePng(image, { runStrip }))!);
      const parallel = await bytesOf((await encodePng(image, { concurrency: 4 }))!);
      expect(strips.length).toBeGreaterThan(1);
      expect(Buffer.from(parallel).equals(Buffer.from(serial))).toBe(true);
      // inflateSync checks the Adler-32 combined from the strips
      const png = readPng(serial);
      expect(Buffer.from(png.rgba).equals(Buffer.from(data))).toBe(true);
    }
  });

  it('resolves with null when CompressionStream is unavailable', async () => {
    const g = globalThis as { CompressionStream?: unknown };
    const saved = g.CompressionStream;
    delete g.CompressionStream;
    try {
      expect(canEncodePng()).toBe(false);
      expect(await encodePng({ width: 1, height: 1, data: new Uint8ClampedArray(4) })).toBeNull();
    } finally {
      g.CompressionStream = saved;
    }
  });
});

describe('makeJoinable', () => {
  const text = Buffer.from('heic2any-lite joins DEFLATE streams. '.repeat(500));
  const cases: [string, Buffer][] = [
    ['stored blocks', deflateRawSync(text, { level: 0 })],
    ['fixed Huffman blocks', deflateRawSync(text, { strategy: constants.Z_FIXED })],
    ['dynamic Huffman blocks', deflateRawSync(Buffer.from(noise(200_000, 5)).map((b) => b & 0x1f), { level: 6 })],
    ['an empty stream', deflateRawSync(Buffer.alloc(0))],
  ];

  it.each(cases)('makes %s joinable without changing their data', (_name, stream) => {
    const joined = Buffer.concat([makeJoinable(stream), makeJoinable(stream), stream]);
    const original = inflateRawSync(stream);
    expect(inflateRawSync(joined).equals(Buffer.concat([original, original, original]))).toBe(true);
  });

  it('ends on a byte boundary with an empty stored block', () => {
    const out = makeJoinable(cases[2][1]);
    expect([...out.subarray(out.length - 4)]).toEqual([0, 0, 0xff, 0xff]);
  });

  it('rejects data that is not a complete DEFLATE stream', () => {
    const stream = cases[2][1];
    expect(() => makeJoinable(stream.subarray(0, stream.length >> 1))).toThrow(DeflateFormatError);
    expect(() => makeJoinable(Uint8Array.from([0x07]))).toThrow(DeflateFormatError); // block type 3
  });
});
