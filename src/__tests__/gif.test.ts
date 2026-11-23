import { createHash } from 'crypto';
import { decodeHeicToRgba } from '../decodeHeic';
import { encodeGif } from '../gif/encodeGif';
import { NeuQuant } from '../gif/neuQuant';
import { loadSample } from '../__fixtures__/heifBuilder';

/** Minimal GIF reader used to check the encoder's output structurally. */
function readGif(gif: Uint8Array) {
  let p = 0;
  const u16 = (): number => gif[p++] | (gif[p++] << 8);
  const header = String.fromCharCode(...gif.subarray(0, 6));
  p = 6;
  const width = u16();
  const height = u16();
  p += 3;
  const frames: { delay: number; palette: number[]; indices: number[] }[] = [];
  let loop: number | null = null;
  let delay = 0;
  for (;;) {
    if (p >= gif.length) throw new Error('GIF ended without a trailer');
    const b = gif[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = gif[p++];
      if (label === 0xff) {
        p += 12; // block size + "NETSCAPE2.0"
        p += 2; // sub-block size + sub-block id
        loop = u16();
        p++;
      } else if (label === 0xf9) {
        p += 2;
        delay = u16();
        p += 2;
      }
      continue;
    }
    if (b !== 0x2c) throw new Error(`unexpected GIF block 0x${b.toString(16)}`);
    // image descriptor
    p += 8;
    const flags = gif[p++];
    const size = 2 << (flags & 7);
    const palette: number[] = [];
    for (let i = 0; i < size; i++) palette.push((gif[p++] << 16) | (gif[p++] << 8) | gif[p++]);
    const minCode = gif[p++];
    const data: number[] = [];
    for (let len = gif[p++]; len; len = gif[p++]) for (let i = 0; i < len; i++) data.push(gif[p++]);
    frames.push({ delay, palette, indices: lzwDecode(data, minCode, width * height) });
    delay = 0;
  }
  return { header, width, height, loop, frames };
}

function lzwDecode(data: number[], minCode: number, count: number): number[] {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let size = minCode + 1;
  let dict: number[][] = [];
  const reset = (): void => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = [];
    dict[eoi] = [];
    size = minCode + 1;
  };
  reset();
  const out: number[] = [];
  let bitPos = 0;
  let prev: number[] | null = null;
  while (out.length < count) {
    let code = 0;
    for (let i = 0; i < size; i++, bitPos++) code |= ((data[bitPos >> 3] >> (bitPos & 7)) & 1) << i;
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    const entry: number[] = dict[code] ?? (prev ? [...prev, prev[0]] : []);
    out.push(...entry);
    if (prev && dict.length < 4096) dict.push([...prev, entry[0]]);
    if (dict.length === 1 << size && size < 12) size++;
    prev = entry;
  }
  return out;
}

describe('GIF encoding', () => {
  it('produces the same bytes as heic2any/gifshot 0.4.5 for the fixture', async () => {
    const [img] = await decodeHeicToRgba(loadSample());
    const gif = encodeGif([img], img.width, img.height, 0.4);
    // Verified byte-for-byte against gifshot 0.4.5's own NeuQuant + GifWriter code.
    expect(createHash('sha256').update(Buffer.from(gif)).digest('hex')).toBe(
      'dc8f30a46574d6f223eefb1e5fffbcaff8ab1f32c0ffed50718f19813aef5835',
    );
  });

  it('writes a looping GIF89a with one 256-colour local palette and delay per frame', () => {
    const w = 37;
    const h = 23;
    const colours = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255], [30, 30, 30], [220, 220, 220]];
    const frame = (seed: number) => ({
      width: w,
      height: h,
      data: Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => {
        const px = i >> 2;
        const c = colours[(((px % w) >> 2) + ((px / w) >> 2) + seed) % 8];
        return (i & 3) === 3 ? 255 : c[i & 3];
      }),
    });
    const frames = [frame(7), frame(13), frame(29)];
    const gif = readGif(encodeGif(frames, w, h, 0.25));
    expect(gif.header).toBe('GIF89a');
    expect([gif.width, gif.height, gif.loop]).toEqual([w, h, 0]);
    expect(gif.frames).toHaveLength(3);
    gif.frames.forEach((f, i) => {
      expect(f.delay).toBe(25);
      expect(f.palette).toHaveLength(256);
      expect(f.indices).toHaveLength(w * h);
      // the LZW stream decodes back to exactly NeuQuant's palette indices and palette
      const src = frames[i].data;
      const rgb = new Uint8Array(w * h * 3);
      for (let px = 0; px < w * h; px++) rgb.set([src[px * 4], src[px * 4 + 1], src[px * 4 + 2]], px * 3);
      const nq = new NeuQuant(rgb, rgb.length, 10);
      const map = nq.process();
      expect(f.palette).toEqual(Array.from({ length: 256 }, (_, k) => (map[k * 3] << 16) | (map[k * 3 + 1] << 8) | map[k * 3 + 2]));
      expect(f.indices).toEqual(Array.from({ length: w * h }, (_, px) => nq.map(rgb[px * 3], rgb[px * 3 + 1], rgb[px * 3 + 2])));
    });
  });

  it('omits the graphic control extension when the interval is 0 (like omggif)', () => {
    const frame = { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(200) };
    const bytes = encodeGif([frame], 4, 4, 0);
    expect([...bytes].some((b, i) => b === 0x21 && bytes[i + 1] === 0xf9)).toBe(false);
    expect(readGif(bytes).frames[0].indices).toEqual(new Array(16).fill(readGif(bytes).frames[0].indices[0]));
  });

  it('rejects invalid dimensions', () => {
    expect(() => encodeGif([], 0, 10, 0.4)).toThrow('Width/Height invalid.');
  });

  it('NeuQuant maps solid colours back to themselves', () => {
    const rgb = new Uint8Array(3 * 2000);
    for (let i = 0; i < 2000; i++) rgb.set(i < 1000 ? [250, 10, 10] : [10, 10, 250], i * 3);
    const nq = new NeuQuant(rgb, rgb.length, 10);
    const palette = nq.process();
    const colour = (r: number, g: number, b: number): number[] => {
      const i = nq.map(r, g, b);
      return [palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]];
    };
    colour(250, 10, 10).forEach((v, i) => expect(Math.abs(v - [250, 10, 10][i])).toBeLessThan(6));
    colour(10, 10, 250).forEach((v, i) => expect(Math.abs(v - [10, 10, 250][i])).toBeLessThan(6));
  });
});
