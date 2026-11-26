import type { RgbaImage } from '../decodeHeic';
import { makeJoinable } from './deflateJoin';

/**
 * Lossless PNG encoder, used instead of `canvas.toBlob('image/png')`.
 *
 * Browsers' canvas encoders favour speed: they always write RGBA (even for opaque photos)
 * and compress lightly. For decoded photos this encoder writes byte-for-byte the same pixels
 * in a file that is typically ~35% smaller, because it
 *   - drops the alpha channel when every pixel is opaque (HEIC photos always are), and
 *   - picks the best PNG filter for every row (libpng's minimum-sum-of-absolute-differences
 *     heuristic) so the deflate stage sees small, repetitive residuals.
 * Deflate is the browser's native `CompressionStream('deflate')`, so no compression code ships
 * with the library. Without CompressionStream, `encodePng` resolves with null and the caller
 * uses the canvas instead.
 *
 * Speed: the image is cut into horizontal strips that are filtered and compressed
 * independently (`encodePngStrip`), so they can run on several Web Workers at once. Each strip's
 * DEFLATE data is made joinable (see deflateJoin.ts) and becomes its own IDAT chunk; together
 * they form the single zlib stream PNG requires. The strips depend only on the image size, so
 * the file is byte-identical however many workers (or none) did the work.
 */

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Target size of one strip's filtered data. Smaller strips spread better; each costs ~0.002% in size. */
const STRIP_BYTES = 1 << 20;
const ADLER_BASE = 65521;

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  const table = crcTable;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

/** One PNG chunk: length, type, data, CRC of type + data. */
function chunk(type: string, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(12 + length);
  const view = new DataView(out.buffer);
  view.setUint32(0, length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  view.setUint32(8 + length, (crc32(out.subarray(4, 8 + length)) ^ 0xffffffff) >>> 0);
  return out;
}

/** Adler-32 of A followed by B, from adler(A), adler(B) and B's length (zlib's adler32_combine). */
function adler32Combine(adler1: number, adler2: number, len2: number): number {
  const rem = len2 % ADLER_BASE;
  let sum1 = adler1 & 0xffff;
  let sum2 = (rem * sum1) % ADLER_BASE;
  sum1 += (adler2 & 0xffff) + ADLER_BASE - 1;
  sum2 += (adler1 >>> 16) + (adler2 >>> 16) + ADLER_BASE - rem;
  if (sum1 >= ADLER_BASE) sum1 -= ADLER_BASE;
  if (sum1 >= ADLER_BASE) sum1 -= ADLER_BASE;
  if (sum2 >= ADLER_BASE * 2) sum2 -= ADLER_BASE * 2;
  if (sum2 >= ADLER_BASE) sum2 -= ADLER_BASE;
  return ((sum2 << 16) | sum1) >>> 0;
}

function isOpaque(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
  return true;
}

/** Copies one RGBA row into `row` as RGB (bpp 3) or RGBA (bpp 4). */
function packRow(rgba: Uint8ClampedArray, at: number, row: Uint8Array, bpp: number): void {
  if (bpp === 4) {
    row.set(rgba.subarray(at, at + row.length));
    return;
  }
  for (let i = 0; i < row.length; i += 3, at += 4) {
    row[i] = rgba[at];
    row[i + 1] = rgba[at + 1];
    row[i + 2] = rgba[at + 2];
  }
}

/**
 * Writes one filtered scanline (filter-type byte + residuals) to `out` at `at`.
 * `cur` and `prev` are unfiltered rows of `stride` bytes (`prev` is all zero for the first row).
 * All five filters are computed in one pass; the one with the smallest sum of absolute
 * residuals (as signed bytes) is kept.
 */
function filterRow(
  cur: Uint8Array,
  prev: Uint8Array,
  stride: number,
  bpp: number,
  scratch: Uint8Array[],
  out: Uint8Array,
  at: number,
): void {
  const [f0, f1, f2, f3, f4] = scratch;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  for (let i = 0; i < stride; i++) {
    const x = cur[i];
    const b = prev[i];
    let a = 0;
    let c = 0;
    if (i >= bpp) {
      a = cur[i - bpp];
      c = prev[i - bpp];
    }
    // Paeth predictor
    const p = a + b - c;
    const pa = p > a ? p - a : a - p;
    const pb = p > b ? p - b : b - p;
    const pc = p > c ? p - c : c - p;
    const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;

    const r0 = x;
    const r1 = (x - a) & 0xff;
    const r2 = (x - b) & 0xff;
    const r3 = (x - ((a + b) >> 1)) & 0xff;
    const r4 = (x - paeth) & 0xff;
    f0[i] = r0;
    f1[i] = r1;
    f2[i] = r2;
    f3[i] = r3;
    f4[i] = r4;
    s0 += r0 < 128 ? r0 : 256 - r0;
    s1 += r1 < 128 ? r1 : 256 - r1;
    s2 += r2 < 128 ? r2 : 256 - r2;
    s3 += r3 < 128 ? r3 : 256 - r3;
    s4 += r4 < 128 ? r4 : 256 - r4;
  }
  let best = 0;
  let min = s0;
  if (s1 < min) (best = 1), (min = s1);
  if (s2 < min) (best = 2), (min = s2);
  if (s3 < min) (best = 3), (min = s3);
  if (s4 < min) best = 4;
  out[at] = best;
  out.set(scratch[best], at + 1);
}

/** zlib-compresses `bytes` with the browser's CompressionStream. */
async function zlibCompress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const pieces: Uint8Array[] = [];
  let total = 0;
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pieces.push(value);
      total += value.length;
    }
  })();
  try {
    await writer.write(bytes as Uint8Array<ArrayBuffer>);
    await writer.close();
  } catch (e) {
    reader.cancel().catch(() => undefined);
    throw e;
  }
  await reading;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One horizontal strip of an image, to be encoded on its own (possibly in a worker). */
export interface PngStripJob {
  width: number;
  /** 3 for RGB, 4 for RGBA output. */
  bpp: 3 | 4;
  /** RGBA rows of the strip; unless `first`, preceded by the row above it (needed for filtering). */
  rgba: Uint8ClampedArray<ArrayBuffer>;
  /** Strip starts at the image's first row; its IDAT also carries the zlib header. */
  first: boolean;
  /** Strip ends at the image's last row; its DEFLATE data keeps the final block. */
  last: boolean;
}

export interface PngStripResult {
  /** A complete IDAT chunk. */
  chunk: Uint8Array<ArrayBuffer>;
  /** Adler-32 of the strip's filtered bytes, and their count. */
  adler: number;
  length: number;
}

/** Filters and compresses one strip. Needs CompressionStream; no DOM. */
export async function encodePngStrip(job: PngStripJob): Promise<PngStripResult> {
  const { width, bpp, rgba, first, last } = job;
  const stride = width * bpp;
  const rgbaRow = width * 4;
  const rows = rgba.length / rgbaRow - (first ? 0 : 1);
  const filtered = new Uint8Array(rows * (stride + 1));
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  const scratch = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  let src = 0;
  if (!first) {
    packRow(rgba, 0, prev, bpp);
    src = rgbaRow;
  }
  for (let r = 0; r < rows; r++, src += rgbaRow) {
    packRow(rgba, src, cur, bpp);
    filterRow(cur, prev, stride, bpp, scratch, filtered, r * (stride + 1));
    const t = prev;
    prev = cur;
    cur = t;
  }

  // zlib format: 2-byte header, raw DEFLATE data, Adler-32 (big-endian)
  const z = await zlibCompress(filtered);
  const n = z.length;
  const adler = ((z[n - 4] << 24) | (z[n - 3] << 16) | (z[n - 2] << 8) | z[n - 1]) >>> 0;
  let deflate = z.subarray(2, n - 4);
  if (!last) deflate = makeJoinable(deflate);
  const idat = first ? chunk('IDAT', z.subarray(0, 2), deflate) : chunk('IDAT', deflate);
  return { chunk: idat, adler, length: filtered.length };
}

export interface EncodePngOptions {
  /** Runs one strip; defaults to `encodePngStrip` in this thread. */
  runStrip?: (job: PngStripJob) => Promise<PngStripResult>;
  /** How many strips may run at once (default 1). */
  concurrency?: number;
}

/** True when this environment can run `encodePng` (it needs CompressionStream). */
export function canEncodePng(): boolean {
  return typeof CompressionStream !== 'undefined';
}

/**
 * Encodes an RGBA image as a PNG Blob with exactly the same pixel values.
 * Resolves with null when CompressionStream is not available.
 */
export async function encodePng(image: RgbaImage, options: EncodePngOptions = {}): Promise<Blob | null> {
  if (!canEncodePng()) return null;
  const { width, height, data } = image;
  const bpp = isOpaque(data) ? 3 : 4;
  const rowsPerStrip = Math.max(1, Math.floor(STRIP_BYTES / (width * bpp + 1)));
  const strips: [number, number][] = [];
  for (let y = 0; y < height; y += rowsPerStrip) strips.push([y, Math.min(height, y + rowsPerStrip)]);

  const runStrip = options.runStrip ?? encodePngStrip;
  const results: PngStripResult[] = new Array(strips.length);
  let next = 0;
  // each lane takes the next strip when its previous one is done; strips are copied out only
  // when started, so at most `concurrency` copies exist at a time
  const lane = async (): Promise<void> => {
    while (next < strips.length) {
      const i = next++;
      const [y0, y1] = strips[i];
      const rgba = data.slice((y0 === 0 ? 0 : y0 - 1) * width * 4, y1 * width * 4);
      results[i] = await runStrip({ width, bpp, rgba, first: i === 0, last: i === strips.length - 1 });
    }
  };
  const lanes = Math.max(1, Math.min(options.concurrency ?? 1, strips.length));
  await Promise.all(Array.from({ length: lanes }, lane));

  let adler = 1;
  for (const r of results) adler = adler32Combine(adler, r.adler, r.length);
  const adlerBytes = new Uint8Array(4);
  new DataView(adlerBytes.buffer).setUint32(0, adler);

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = bpp === 4 ? 6 : 2; // colour type: RGBA or RGB
  // compression, filter and interlace methods are all 0

  const parts: BlobPart[] = [new Uint8Array(PNG_SIGNATURE), chunk('IHDR', ihdr)];
  for (const r of results) parts.push(r.chunk);
  parts.push(chunk('IDAT', adlerBytes), chunk('IEND'));
  return new Blob(parts, { type: 'image/png' });
}
