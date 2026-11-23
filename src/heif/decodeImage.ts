import { HeicDecodeError } from '../errors';
import { decodeHevcPicture, type DecodedPicture } from '../hevc/decoder';
import { parseHvcC } from '../hevc/parameterSets';
import {
  ByteReader,
  getItemData,
  getItemProperties,
  getReferences,
  type BoxRef,
  type HeifFile,
} from './heifFile';

/**
 * 8-bit YCbCr 4:2:0 image, chroma planes ceil(w/2) x ceil(h/2), tightly packed —
 * the exact layout heic2any's bundled libheif hands to its RGBA conversion.
 */
export interface YuvImage {
  width: number;
  height: number;
  y: Uint8Array;
  cb: Uint8Array;
  cr: Uint8Array;
}

const chromaSize = (v: number): number => (v + 1) >> 1;

/** Decodes an image item (hvc1, grid or iden) and applies its transformative properties. */
export async function decodeImageItem(
  file: HeifFile,
  id: number,
  yieldToEventLoop: () => Promise<void>,
): Promise<YuvImage> {
  const item = file.items.find((i) => i.id === id);
  if (!item) throw new HeicDecodeError(`missing item ${id}`);
  const props = getItemProperties(file, id);
  let image: YuvImage;
  if (item.type === 'hvc1') {
    image = decodeCodedItem(file, id, props);
  } else if (item.type === 'grid') {
    image = await decodeGrid(file, id, yieldToEventLoop);
  } else if (item.type === 'iovl') {
    image = await decodeOverlay(file, id, yieldToEventLoop);
  } else if (item.type === 'iden') {
    const [src] = getReferences(file, id, 'dimg');
    if (src === undefined) throw new HeicDecodeError('iden item without a source');
    image = await decodeImageItem(file, src, yieldToEventLoop);
  } else {
    throw new HeicDecodeError(`unsupported image item type ${item.type}`);
  }
  return applyTransforms(file, image, props);
}

function decodeCodedItem(file: HeifFile, id: number, props: BoxRef[]): YuvImage {
  const hvcC = props.find((p) => p.type === 'hvcC');
  if (!hvcC) throw new HeicDecodeError('missing hvcC');
  const config = parseHvcC(file.data.subarray(hvcC.start, hvcC.end));
  const data = getItemData(file, id);
  const nalUnits = [...config.nalUnits];
  let p = 0;
  while (p + config.lengthSize <= data.length) {
    let len = 0;
    for (let i = 0; i < config.lengthSize; i++) len = len * 256 + data[p + i];
    p += config.lengthSize;
    if (p + len > data.length) throw new HeicDecodeError('truncated NAL unit');
    nalUnits.push(data.subarray(p, p + len));
    p += len;
  }
  return toYuv420(decodeHevcPicture(nalUnits));
}

/** Converts a decoded picture to 8-bit 4:2:0 (monochrome gets neutral chroma). */
export function toYuv420(pic: DecodedPicture): YuvImage {
  const to8 = (plane: Uint8Array | Uint16Array, bitDepth: number): Uint8Array => {
    if (bitDepth === 8 && plane instanceof Uint8Array) return plane;
    const shift = bitDepth - 8;
    const out = new Uint8Array(plane.length);
    for (let i = 0; i < plane.length; i++) {
      const v = (plane[i] + (1 << (shift - 1))) >> shift;
      out[i] = v > 255 ? 255 : v;
    }
    return out;
  };
  const y = to8(pic.planes[0], pic.bitDepthY);
  if (pic.chromaFormatIdc === 0) {
    const n = chromaSize(pic.width) * chromaSize(pic.height);
    return { width: pic.width, height: pic.height, y, cb: new Uint8Array(n).fill(128), cr: new Uint8Array(n).fill(128) };
  }
  return { width: pic.width, height: pic.height, y, cb: to8(pic.planes[1], pic.bitDepthC), cr: to8(pic.planes[2], pic.bitDepthC) };
}

async function decodeGrid(file: HeifFile, id: number, yieldToEventLoop: () => Promise<void>): Promise<YuvImage> {
  const d = getItemData(file, id);
  const r = new ByteReader(d, 0, d.length);
  r.u8(); // version
  const flags = r.u8();
  const rows = r.u8() + 1;
  const cols = r.u8() + 1;
  const width = flags & 1 ? r.u32() : r.u16();
  const height = flags & 1 ? r.u32() : r.u16();
  const tiles = getReferences(file, id, 'dimg');
  if (tiles.length !== rows * cols) throw new HeicDecodeError('grid tile count mismatch');
  if (width === 0 || height === 0) throw new HeicDecodeError('invalid grid size');
  const cw = chromaSize(width);
  const ch = chromaSize(height);
  const out: YuvImage = {
    width,
    height,
    y: new Uint8Array(width * height),
    cb: new Uint8Array(cw * ch),
    cr: new Uint8Array(cw * ch),
  };
  let tileW = 0;
  let tileH = 0;
  for (let t = 0; t < tiles.length; t++) {
    const tile = decodeCodedItem(file, tiles[t], getItemProperties(file, tiles[t]));
    if (t === 0) {
      tileW = tile.width;
      tileH = tile.height;
    }
    const x0 = (t % cols) * tileW;
    const y0 = Math.floor(t / cols) * tileH;
    blit(tile.y, tile.width, tile.height, out.y, width, height, x0, y0);
    const tcw = chromaSize(tile.width);
    const tch = chromaSize(tile.height);
    blit(tile.cb, tcw, tch, out.cb, cw, ch, x0 >> 1, y0 >> 1);
    blit(tile.cr, tcw, tch, out.cr, cw, ch, x0 >> 1, y0 >> 1);
    await yieldToEventLoop();
  }
  return out;
}

/** Copies src into dst at (x0, y0); offsets may be negative, anything outside dst is clipped. */
function blit(src: Uint8Array, sw: number, sh: number, dst: Uint8Array, dw: number, dh: number, x0: number, y0: number): void {
  const sx = Math.max(0, -x0);
  const sy = Math.max(0, -y0);
  const w = Math.min(sw, dw - x0) - sx;
  const h = Math.min(sh, dh - y0) - sy;
  if (w <= 0 || h <= 0) return;
  for (let y = 0; y < h; y++) {
    const s = (sy + y) * sw + sx;
    dst.set(src.subarray(s, s + w), (y0 + sy + y) * dw + x0 + sx);
  }
}

/**
 * Overlay derived image ('iovl', ISO/IEC 23008-12 6.6.2.3): referenced images are drawn in
 * reference order onto a canvas filled with the background colour.
 */
async function decodeOverlay(file: HeifFile, id: number, yieldToEventLoop: () => Promise<void>): Promise<YuvImage> {
  const d = getItemData(file, id);
  const r = new ByteReader(d, 0, d.length);
  r.u8(); // version
  const large = (r.u8() & 1) === 1;
  const fill = [r.u16(), r.u16(), r.u16(), r.u16()].map((v) => v >> 8);
  const readField = (): number => (large ? r.u32() : r.u16());
  const readOffset = (): number => {
    const v = readField();
    return large ? (v > 0x7fffffff ? v - 0x100000000 : v) : v > 0x7fff ? v - 0x10000 : v;
  };
  const width = readField();
  const height = readField();
  if (width === 0 || height === 0) throw new HeicDecodeError('invalid overlay size');
  const refs = getReferences(file, id, 'dimg');
  const offsets = refs.map(() => [readOffset(), readOffset()]);

  // background colour as BT.601 limited-range YCbCr (the range heic2any's conversion expects)
  const [R, G, B] = fill;
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  const cw = chromaSize(width);
  const ch = chromaSize(height);
  const out: YuvImage = {
    width,
    height,
    y: new Uint8Array(width * height).fill(clamp(16 + (65.481 * R + 128.553 * G + 24.966 * B) / 255)),
    cb: new Uint8Array(cw * ch).fill(clamp(128 + (-37.797 * R - 74.203 * G + 112 * B) / 255)),
    cr: new Uint8Array(cw * ch).fill(clamp(128 + (112 * R - 93.786 * G - 18.214 * B) / 255)),
  };
  for (let i = 0; i < refs.length; i++) {
    const layer = await decodeImageItem(file, refs[i], yieldToEventLoop);
    const [dx, dy] = offsets[i];
    blit(layer.y, layer.width, layer.height, out.y, width, height, dx, dy);
    const lcw = chromaSize(layer.width);
    const lch = chromaSize(layer.height);
    blit(layer.cb, lcw, lch, out.cb, cw, ch, dx >> 1, dy >> 1);
    blit(layer.cr, lcw, lch, out.cr, cw, ch, dx >> 1, dy >> 1);
    await yieldToEventLoop();
  }
  return out;
}

// ------------------------------------------------------------------ transformative properties

/** Rational helper mirroring libheif's Fraction for clean-aperture rounding. */
class Fraction {
  constructor(
    readonly num: number,
    readonly den: number,
  ) {}

  add(o: Fraction): Fraction {
    return this.den === o.den ? new Fraction(this.num + o.num, this.den) : new Fraction(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  sub(o: Fraction): Fraction {
    return this.add(new Fraction(-o.num, o.den));
  }

  half(): Fraction {
    return new Fraction(this.num, this.den * 2);
  }

  round(): number {
    return Math.trunc((this.num + Math.trunc(this.den / 2)) / this.den);
  }
}

function applyTransforms(file: HeifFile, img: YuvImage, props: BoxRef[]): YuvImage {
  let out = img;
  for (const prop of props) {
    const r = new ByteReader(file.data, prop.start, prop.end);
    if (prop.type === 'irot') {
      const angle = r.u8() & 3;
      if (angle) out = rotateCcw(out, angle * 90);
    } else if (prop.type === 'imir') {
      const axis = r.u8() & 1;
      out = mirror(out, axis === 1);
    } else if (prop.type === 'clap') {
      const wN = r.u32();
      const wD = r.u32();
      const hN = r.u32();
      const hD = r.u32();
      const hoN = r.i32();
      const hoD = r.u32();
      const voN = r.i32();
      const voD = r.u32();
      if (!wD || !hD || !hoD || !voD) continue;
      const clapW = new Fraction(wN, wD);
      const clapH = new Fraction(hN, hD);
      const pcX = new Fraction(hoN, hoD).add(new Fraction(out.width - 1, 2));
      const pcY = new Fraction(voN, voD).add(new Fraction(out.height - 1, 2));
      const one = new Fraction(1, 1);
      const left = pcX.sub(clapW.sub(one).half()).round();
      const right = pcX.add(clapW.sub(one).half()).round();
      const top = pcY.sub(clapH.sub(one).half()).round();
      const bottom = pcY.add(clapH.sub(one).half()).round();
      out = crop(out, Math.max(0, left), Math.min(out.width - 1, right), Math.max(0, top), Math.min(out.height - 1, bottom));
    }
  }
  return out;
}

type PlaneOp = (src: Uint8Array, w: number, h: number) => Uint8Array;

function mapPlanes(img: YuvImage, outW: number, outH: number, op: PlaneOp): YuvImage {
  const cw = chromaSize(img.width);
  const ch = chromaSize(img.height);
  return { width: outW, height: outH, y: op(img.y, img.width, img.height), cb: op(img.cb, cw, ch), cr: op(img.cr, cw, ch) };
}

/** Counter-clockwise rotation, each plane rotated on its own (as libheif does). */
function rotateCcw(img: YuvImage, angle: number): YuvImage {
  const swap = angle !== 180;
  return mapPlanes(img, swap ? img.height : img.width, swap ? img.width : img.height, (src, w, h) => {
    const out = new Uint8Array(w * h);
    if (angle === 180) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(h - 1 - y) * w + (w - 1 - x)] = src[y * w + x];
    } else if (angle === 90) {
      // (x, y) -> (y, w - 1 - x), output width = h
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(w - 1 - x) * h + y] = src[y * w + x];
    } else {
      // 270 ccw: (x, y) -> (h - 1 - y, x)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + (h - 1 - y)] = src[y * w + x];
    }
    return out;
  });
}

/** libheif semantics: axis 1 mirrors left/right, axis 0 mirrors top/bottom. */
function mirror(img: YuvImage, leftRight: boolean): YuvImage {
  return mapPlanes(img, img.width, img.height, (src, w, h) => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        out[leftRight ? y * w + (w - 1 - x) : (h - 1 - y) * w + x] = src[y * w + x];
      }
    }
    return out;
  });
}

function crop(img: YuvImage, left: number, right: number, top: number, bottom: number): YuvImage {
  if (right < left || bottom < top) throw new HeicDecodeError('invalid clean aperture');
  const cropPlane = (src: Uint8Array, w: number, l: number, r: number, t: number, b: number): Uint8Array => {
    const cw = r - l + 1;
    const out = new Uint8Array(cw * (b - t + 1));
    for (let y = t; y <= b; y++) out.set(src.subarray(y * w + l, y * w + l + cw), (y - t) * cw);
    return out;
  };
  const cw = chromaSize(img.width);
  return {
    width: right - left + 1,
    height: bottom - top + 1,
    y: cropPlane(img.y, img.width, left, right, top, bottom),
    cb: cropPlane(img.cb, cw, left >> 1, right >> 1, top >> 1, bottom >> 1),
    cr: cropPlane(img.cr, cw, left >> 1, right >> 1, top >> 1, bottom >> 1),
  };
}
