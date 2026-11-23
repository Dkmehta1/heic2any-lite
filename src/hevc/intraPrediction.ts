import { INTRA_PRED_ANGLE, INV_ANGLE } from './tables';

export type Plane = Uint8Array | Uint16Array;

/**
 * Intra sample prediction (H.265 8.4.4.2.3 - 8.4.4.2.6).
 *
 * `ref` holds the 4n+1 substituted reference samples in one line:
 *   ref[2n - 1 - y] = p[-1][y]  (y = 0..2n-1, bottom-left first)
 *   ref[2n]         = p[-1][-1]
 *   ref[2n + 1 + x] = p[x][-1]  (x = 0..2n-1)
 * which makes the [1 2 1] reference smoothing a plain 1-D filter.
 */
export function predictIntra(
  dst: Plane,
  stride: number,
  x0: number,
  y0: number,
  log2Size: number,
  mode: number,
  isLuma: boolean,
  ref: Int32Array,
  filtered: Int32Array,
  angularRef: Int32Array,
  bitDepth: number,
  strongIntraSmoothing: boolean,
): void {
  const n = 1 << log2Size;
  const n2 = n << 1;
  const last = n2 << 1;
  let p = ref;

  // 8.4.4.2.3 filtering of neighbouring samples (luma only for 4:2:0)
  if (isLuma && mode !== 1 && n !== 4) {
    const minDistVerHor = Math.min(Math.abs(mode - 26), Math.abs(mode - 10));
    const threshold = n === 8 ? 7 : n === 16 ? 1 : 0;
    if (minDistVerHor > threshold) {
      const corner = ref[n2];
      const bottom = ref[0];
      const right = ref[last];
      const limit = 1 << (bitDepth - 5);
      if (
        strongIntraSmoothing &&
        n === 32 &&
        Math.abs(corner + right - 2 * ref[n2 + n]) < limit &&
        Math.abs(corner + bottom - 2 * ref[n2 - n]) < limit
      ) {
        filtered[n2] = corner;
        filtered[0] = bottom;
        filtered[last] = right;
        for (let i = 0; i < 63; i++) {
          filtered[n2 - 1 - i] = ((63 - i) * corner + (i + 1) * bottom + 32) >> 6;
          filtered[n2 + 1 + i] = ((63 - i) * corner + (i + 1) * right + 32) >> 6;
        }
      } else {
        filtered[0] = ref[0];
        filtered[last] = ref[last];
        for (let i = 1; i < last; i++) filtered[i] = (ref[i - 1] + 2 * ref[i] + ref[i + 1] + 2) >> 2;
      }
      p = filtered;
    }
  }

  const corner = p[n2];
  // left(y) = p[n2 - 1 - y], top(x) = p[n2 + 1 + x]
  if (mode === 0) {
    // planar
    const topRight = p[n2 + 1 + n];
    const bottomLeft = p[n2 - 1 - n];
    const shift = log2Size + 1;
    for (let y = 0; y < n; y++) {
      const left = p[n2 - 1 - y];
      let o = (y0 + y) * stride + x0;
      for (let x = 0; x < n; x++) {
        dst[o++] = ((n - 1 - x) * left + (x + 1) * topRight + (n - 1 - y) * p[n2 + 1 + x] + (y + 1) * bottomLeft + n) >> shift;
      }
    }
    return;
  }

  if (mode === 1) {
    // DC
    let sum = n;
    for (let i = 0; i < n; i++) sum += p[n2 + 1 + i] + p[n2 - 1 - i];
    const dc = sum >> (log2Size + 1);
    for (let y = 0; y < n; y++) {
      const o = (y0 + y) * stride + x0;
      for (let x = 0; x < n; x++) dst[o + x] = dc;
    }
    if (isLuma && n < 32) {
      dst[y0 * stride + x0] = (p[n2 - 1] + 2 * dc + p[n2 + 1] + 2) >> 2;
      for (let x = 1; x < n; x++) dst[y0 * stride + x0 + x] = (p[n2 + 1 + x] + 3 * dc + 2) >> 2;
      for (let y = 1; y < n; y++) dst[(y0 + y) * stride + x0] = (p[n2 - 1 - y] + 3 * dc + 2) >> 2;
    }
    return;
  }

  // angular (8.4.4.2.6)
  const angle = INTRA_PRED_ANGLE[mode];
  const r = angularRef;
  const off = n; // r[off + i] holds ref[i], i in -n..2n
  const maxVal = (1 << bitDepth) - 1;
  if (mode >= 18) {
    for (let x = 0; x <= n; x++) r[off + x] = p[n2 + x]; // top(x - 1)
    if (angle < 0) {
      const lastIdx = (n * angle) >> 5;
      if (lastIdx < -1) {
        const inv = INV_ANGLE[mode];
        for (let x = lastIdx; x <= -1; x++) r[off + x] = p[n2 - ((x * inv + 128) >> 8)]; // left(-1 + ...)
      }
    } else {
      for (let x = n + 1; x <= n2; x++) r[off + x] = p[n2 + x];
    }
    for (let y = 0; y < n; y++) {
      const pos = (y + 1) * angle;
      const iIdx = pos >> 5;
      const iFact = pos & 31;
      const o = (y0 + y) * stride + x0;
      const base = off + iIdx + 1;
      if (iFact) {
        for (let x = 0; x < n; x++) dst[o + x] = ((32 - iFact) * r[base + x] + iFact * r[base + x + 1] + 16) >> 5;
      } else {
        for (let x = 0; x < n; x++) dst[o + x] = r[base + x];
      }
    }
    if (mode === 26 && isLuma && n < 32) {
      const top0 = p[n2 + 1];
      for (let y = 0; y < n; y++) {
        const v = top0 + ((p[n2 - 1 - y] - corner) >> 1);
        dst[(y0 + y) * stride + x0] = v < 0 ? 0 : v > maxVal ? maxVal : v;
      }
    }
  } else {
    for (let x = 0; x <= n; x++) r[off + x] = p[n2 - x]; // left(x - 1)
    if (angle < 0) {
      const lastIdx = (n * angle) >> 5;
      if (lastIdx < -1) {
        const inv = INV_ANGLE[mode];
        for (let x = lastIdx; x <= -1; x++) r[off + x] = p[n2 + ((x * inv + 128) >> 8)]; // top(-1 + ...)
      }
    } else {
      for (let x = n + 1; x <= n2; x++) r[off + x] = p[n2 - x];
    }
    for (let x = 0; x < n; x++) {
      const pos = (x + 1) * angle;
      const iIdx = pos >> 5;
      const iFact = pos & 31;
      const base = off + iIdx + 1;
      let o = y0 * stride + x0 + x;
      if (iFact) {
        for (let y = 0; y < n; y++, o += stride) dst[o] = ((32 - iFact) * r[base + y] + iFact * r[base + y + 1] + 16) >> 5;
      } else {
        for (let y = 0; y < n; y++, o += stride) dst[o] = r[base + y];
      }
    }
    if (mode === 10 && isLuma && n < 32) {
      const left0 = p[n2 - 1];
      for (let x = 0; x < n; x++) {
        const v = left0 + ((p[n2 + 1 + x] - corner) >> 1);
        dst[y0 * stride + x0 + x] = v < 0 ? 0 : v > maxVal ? maxVal : v;
      }
    }
  }
}
