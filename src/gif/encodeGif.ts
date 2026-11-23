import { NeuQuant } from './neuQuant';

/** One RGBA frame (alpha is ignored, as in gifshot). */
export interface GifFrame {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

const SAMPLE_INTERVAL = 10;

class ByteSink {
  buf = new Uint8Array(1 << 16);
  p = 0;

  push(v: number): void {
    if (this.p === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.p++] = v;
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.p);
  }
}

/** Per-frame NeuQuant quantisation (sample factor 10), as gifshot does it. */
function quantize(frame: GifFrame): { pixels: Uint8Array; palette: Uint32Array } {
  const count = frame.width * frame.height;
  const rgb = new Uint8Array(count * 3);
  for (let i = 0, k = 0; i < count; i++) {
    rgb[k++] = frame.data[i * 4];
    rgb[k++] = frame.data[i * 4 + 1];
    rgb[k++] = frame.data[i * 4 + 2];
  }
  const nq = new NeuQuant(rgb, rgb.length, SAMPLE_INTERVAL);
  const map = nq.process();
  const palette = new Uint32Array(map.length / 3);
  for (let i = 0; i < palette.length; i++) palette[i] = (map[i * 3] << 16) | (map[i * 3 + 1] << 8) | map[i * 3 + 2];
  const pixels = new Uint8Array(count);
  for (let i = 0, k = 0; i < count; i++, k += 3) pixels[i] = nq.map(rgb[k], rgb[k + 1], rgb[k + 2]);
  return { pixels, palette };
}

/** LZW image data with 255-byte sub-blocks (GIF89a), same code emission as omggif. */
function writeLzw(out: ByteSink, minCodeSize: number, indices: Uint8Array): void {
  const buf = out;
  buf.push(minCodeSize);
  let curSubblock = buf.p;
  buf.push(0);
  const clearCode = 1 << minCodeSize;
  const codeMask = clearCode - 1;
  const eoiCode = clearCode + 1;
  let nextCode = eoiCode + 1;
  let curCodeSize = minCodeSize + 1;
  let curShift = 0;
  let cur = 0;
  // code table keyed on (prefix code << 8 | k), cleared in O(1) with a generation stamp
  const table = new Int32Array(4096 * 256);
  const stamp = new Uint32Array(4096 * 256);
  let generation = 1;

  const flush = (minBits: number): void => {
    while (curShift >= minBits) {
      buf.push(cur & 0xff);
      cur >>= 8;
      curShift -= 8;
      if (buf.p === curSubblock + 256) {
        buf.buf[curSubblock] = 255;
        curSubblock = buf.p;
        buf.push(0);
      }
    }
  };
  const emit = (c: number): void => {
    cur |= c << curShift;
    curShift += curCodeSize;
    flush(8);
  };

  let ibCode = indices[0] & codeMask;
  emit(clearCode);
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i] & codeMask;
    const key = (ibCode << 8) | k;
    if (stamp[key] !== generation) {
      cur |= ibCode << curShift;
      curShift += curCodeSize;
      flush(8);
      if (nextCode === 4096) {
        emit(clearCode);
        nextCode = eoiCode + 1;
        curCodeSize = minCodeSize + 1;
        generation++;
      } else {
        if (nextCode >= 1 << curCodeSize) curCodeSize++;
        stamp[key] = generation;
        table[key] = nextCode++;
      }
      ibCode = k;
    } else {
      ibCode = table[key];
    }
  }
  emit(ibCode);
  emit(eoiCode);
  flush(1);
  if (curSubblock + 1 === buf.p) {
    buf.buf[curSubblock] = 0;
  } else {
    buf.buf[curSubblock] = buf.p - curSubblock - 1;
    buf.push(0);
  }
}

/**
 * Encodes an animated GIF the way heic2any (via gifshot 0.4.5) does: GIF89a, loop forever,
 * one local 256-colour palette per frame, `delay = interval * 100` centiseconds.
 * All frames must already be `width` x `height`.
 */
export function encodeGif(frames: GifFrame[], width: number, height: number, interval: number): Uint8Array {
  if (width <= 0 || height <= 0 || width > 65535 || height > 65535) throw new Error('Width/Height invalid.');
  const out = new ByteSink();
  const u16 = (v: number): void => {
    out.push(v & 0xff);
    out.push((v >> 8) & 0xff);
  };
  [0x47, 0x49, 0x46, 0x38, 0x39, 0x61].forEach((b) => out.push(b)); // GIF89a
  u16(width);
  u16(height);
  out.push(0); // no global colour table
  out.push(0); // background
  out.push(0); // aspect ratio
  // NETSCAPE2.0 looping extension, loop count 0 (forever)
  [0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03, 0x01].forEach((b) => out.push(b));
  u16(0);
  out.push(0);

  const delay = interval * 100;
  for (const frame of frames) {
    const { pixels, palette } = quantize(frame);
    if (delay !== 0) {
      out.push(0x21);
      out.push(0xf9);
      out.push(4);
      out.push(0);
      out.push(delay & 0xff);
      out.push((delay >> 8) & 0xff);
      out.push(0);
      out.push(0);
    }
    out.push(0x2c);
    u16(0);
    u16(0);
    u16(width);
    u16(height);
    let minCodeSize = 0;
    let n = palette.length;
    while ((n >>= 1)) minCodeSize++;
    out.push(0x80 | (minCodeSize - 1));
    for (let i = 0; i < palette.length; i++) {
      out.push((palette[i] >> 16) & 0xff);
      out.push((palette[i] >> 8) & 0xff);
      out.push(palette[i] & 0xff);
    }
    writeLzw(out, minCodeSize < 2 ? 2 : minCodeSize, pixels);
  }
  out.push(0x3b);
  return out.result();
}
