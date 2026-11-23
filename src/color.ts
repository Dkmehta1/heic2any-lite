import type { YuvImage } from './heif/decodeImage';

// Per-sample terms of heic2any's conversion. Each entry is the same double the original
// computes inline (one multiplication), so table lookups give bit-identical results.
const Y_TERM = new Float64Array(256);
const R_CR = new Float64Array(256);
const G_CR = new Float64Array(256);
const G_CB = new Float64Array(256);
const B_CB = new Float64Array(256);
for (let v = 0; v < 256; v++) {
  Y_TERM[v] = 1.164 * (v - 16);
  R_CR[v] = 1.596 * (v - 128);
  G_CR[v] = 0.813 * (v - 128);
  G_CB[v] = 0.391 * (v - 128);
  B_CB[v] = 2.018 * (v - 128);
}

/**
 * YCbCr 4:2:0 -> RGBA, reproducing heic2any's conversion exactly (same coefficients, same
 * evaluation order, nearest chroma sample, opaque alpha, Uint8ClampedArray rounding), so the
 * pixels handed to the canvas are identical to the original package's for the same samples.
 */
export function yuvToRgba(img: YuvImage): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, y: Y, cb: Cb, cr: Cr } = img;
  const out = new Uint8ClampedArray(width * height * 4);
  const cStride = (width + 1) >> 1;
  let o = 0;
  for (let row = 0; row < height; row++) {
    const yRow = row * width;
    const cRow = (row >> 1) * cStride;
    for (let x = 0; x < width; x++) {
      const A = Y_TERM[Y[yRow + x]];
      const e = Cb[cRow + (x >> 1)];
      const r = Cr[cRow + (x >> 1)];
      out[o] = A + R_CR[r];
      out[o + 1] = A - G_CR[r] - G_CB[e];
      out[o + 2] = A + B_CB[e];
      out[o + 3] = 255;
      o += 4;
    }
  }
  return out;
}
