import type { Plane } from './intraPrediction';
import { DCT_MATRIX, DST_MATRIX, LEVEL_SCALE } from './tables';

export interface ResidualParams {
  log2Size: number;
  /** Qp' (QP including the bit-depth offset). */
  qp: number;
  bitDepth: number;
  transformSkip: boolean;
  transquantBypass: boolean;
  /** 4x4 intra luma uses the DST instead of the DCT. */
  useDst: boolean;
  /** Scaling factors m[y * n + x], or null for flat 16. */
  scaling: Uint8Array | null;
  /** Largest column / row holding a non-zero coefficient (limits the work). */
  maxX: number;
  maxY: number;
}

const clip16 = (v: number): number => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);

/** N-point inverse transform matrices, M[k * n + i] = basis k at sample i. */
const MATRICES: Int32Array[] = [];
for (let log2 = 2; log2 <= 5; log2++) {
  const n = 1 << log2;
  const m = new Int32Array(n * n);
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) m[k * n + i] = DCT_MATRIX[(k << (5 - log2)) * 32 + i];
  MATRICES[log2] = m;
}
const DST4 = Int32Array.from(DST_MATRIX);

/** Odd-basis halves for the even/odd (partial butterfly) decomposition: ODD[log2][j * half + i] = M[2j + 1][i]. */
const ODD: Int32Array[] = [];
const EVEN: Int32Array[] = [];
for (let log2 = 3; log2 <= 5; log2++) {
  const n = 1 << log2;
  const half = n >> 1;
  const m = new Int32Array(half * half);
  for (let j = 0; j < half; j++) for (let i = 0; i < half; i++) m[j * half + i] = MATRICES[log2][(2 * j + 1) * n + i];
  ODD[log2] = m;
  EVEN[log2] = new Int32Array(half);
}

// scratch buffers
const nzK = new Int32Array(32);
const nzC = new Int32Array(32);
const lineOut = new Int32Array(32);

/**
 * 1-D inverse DCT of src[off + k * stride] (k = 0..n-1, zero beyond `last`) into out[outOff + i].
 * Even/odd decomposition of the standard matrix product: identical integer sums, fewer multiplies.
 */
function idct1d(src: Int32Array, off: number, stride: number, log2: number, last: number, out: Int32Array, outOff: number): void {
  if (log2 === 2) {
    const c0 = src[off];
    const c1 = last >= 1 ? src[off + stride] : 0;
    const c2 = last >= 2 ? src[off + 2 * stride] : 0;
    const c3 = last >= 3 ? src[off + 3 * stride] : 0;
    const e0 = 64 * (c0 + c2);
    const e1 = 64 * (c0 - c2);
    const o0 = 83 * c1 + 36 * c3;
    const o1 = 36 * c1 - 83 * c3;
    out[outOff] = e0 + o0;
    out[outOff + 1] = e1 + o1;
    out[outOff + 2] = e1 - o1;
    out[outOff + 3] = e0 - o0;
    return;
  }
  const n = 1 << log2;
  const half = n >> 1;
  const even = EVEN[log2];
  idct1d(src, off, stride * 2, log2 - 1, last >> 1, even, 0);
  const odd = ODD[log2];
  let cnt = 0;
  for (let k = 1; k <= last; k += 2) {
    const c = src[off + k * stride];
    if (c !== 0) {
      nzC[cnt] = c;
      nzK[cnt++] = (k >> 1) * half;
    }
  }
  for (let i = 0; i < half; i++) {
    let o = 0;
    for (let t = 0; t < cnt; t++) o += nzC[t] * odd[nzK[t] + i];
    out[outOff + i] = even[i] + o;
    out[outOff + n - 1 - i] = even[i] - o;
  }
}

/**
 * Scaling (8.6.2 / 8.6.3), inverse transform (8.6.4) and reconstruction: adds the residual of
 * `coeffs` (TransCoeffLevel, row-major) to the predicted samples already in `dst`.
 */
export function addResidual(
  dst: Plane,
  stride: number,
  x0: number,
  y0: number,
  coeffs: Int32Array,
  tmp: Int32Array,
  prm: ResidualParams,
): void {
  const log2 = prm.log2Size;
  const n = 1 << log2;
  const maxVal = (1 << prm.bitDepth) - 1;

  if (prm.transquantBypass) {
    for (let y = 0; y < n; y++) {
      const o = (y0 + y) * stride + x0;
      for (let x = 0; x < n; x++) {
        const v = dst[o + x] + coeffs[y * n + x];
        dst[o + x] = v < 0 ? 0 : v > maxVal ? maxVal : v;
      }
    }
    return;
  }

  // scaling process for transform coefficients
  const bdShift = prm.bitDepth + log2 - 5;
  const divisor = 2 ** bdShift;
  const half = 2 ** (bdShift - 1);
  const levelScale = LEVEL_SCALE[prm.qp % 6] * 2 ** Math.floor(prm.qp / 6);
  const scaling = !prm.scaling || (prm.transformSkip && n > 4) ? null : prm.scaling;
  const { maxX, maxY } = prm;
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x <= maxX; x++) {
      const i = y * n + x;
      const c = coeffs[i];
      if (c !== 0) {
        const v = c * (scaling ? scaling[i] : 16) * levelScale + half;
        coeffs[i] = clip16(v >= -2147483648 && v <= 2147483647 ? v >> bdShift : Math.floor(v / divisor));
      }
    }
  }

  const bdShift2 = 20 - prm.bitDepth;
  const rnd2 = 1 << (bdShift2 - 1);

  if (prm.transformSkip) {
    for (let y = 0; y < n; y++) {
      const o = (y0 + y) * stride + x0;
      for (let x = 0; x < n; x++) {
        const v = dst[o + x] + (((coeffs[y * n + x] << 7) + rnd2) >> bdShift2);
        dst[o + x] = v < 0 ? 0 : v > maxVal ? maxVal : v;
      }
    }
    return;
  }

  // DC-only DCT block: the residual is a constant
  if (!prm.useDst && maxX === 0 && maxY === 0) {
    const t = clip16((coeffs[0] * 64 + 64) >> 7);
    const r = (t * 64 + rnd2) >> bdShift2;
    if (r === 0) return;
    for (let y = 0; y < n; y++) {
      const o = (y0 + y) * stride + x0;
      for (let x = 0; x < n; x++) {
        const v = dst[o + x] + r;
        dst[o + x] = v < 0 ? 0 : v > maxVal ? maxVal : v;
      }
    }
    return;
  }

  if (prm.useDst) {
    inverseDst4(dst, stride, x0, y0, coeffs, tmp, rnd2, bdShift2, maxVal);
    return;
  }

  // first stage: vertical 1-D transform of each column holding coefficients
  for (let x = 0; x <= maxX; x++) {
    let any = false;
    for (let k = 0; k <= maxY; k++) {
      if (coeffs[k * n + x] !== 0) {
        any = true;
        break;
      }
    }
    if (!any) {
      for (let y = 0; y < n; y++) tmp[y * n + x] = 0;
      continue;
    }
    idct1d(coeffs, x, n, log2, maxY, lineOut, 0);
    for (let y = 0; y < n; y++) tmp[y * n + x] = clip16((lineOut[y] + 64) >> 7);
  }

  // second stage: horizontal 1-D transform of each row, then add to the prediction
  for (let y = 0; y < n; y++) {
    idct1d(tmp, y * n, 1, log2, maxX, lineOut, 0);
    const o = (y0 + y) * stride + x0;
    for (let x = 0; x < n; x++) {
      const v = dst[o + x] + ((lineOut[x] + rnd2) >> bdShift2);
      dst[o + x] = v < 0 ? 0 : v > maxVal ? maxVal : v;
    }
  }
}

/** 4x4 inverse DST (intra luma 4x4), plain matrix product. */
function inverseDst4(
  dst: Plane,
  stride: number,
  x0: number,
  y0: number,
  coeffs: Int32Array,
  tmp: Int32Array,
  rnd2: number,
  bdShift2: number,
  maxVal: number,
): void {
  const M = DST4;
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 4; y++) {
      const s = coeffs[x] * M[y] + coeffs[4 + x] * M[4 + y] + coeffs[8 + x] * M[8 + y] + coeffs[12 + x] * M[12 + y];
      tmp[y * 4 + x] = clip16((s + 64) >> 7);
    }
  }
  for (let y = 0; y < 4; y++) {
    const t = y * 4;
    const o = (y0 + y) * stride + x0;
    for (let x = 0; x < 4; x++) {
      const s = tmp[t] * M[x] + tmp[t + 1] * M[4 + x] + tmp[t + 2] * M[8 + x] + tmp[t + 3] * M[12 + x];
      const v = dst[o + x] + ((s + rnd2) >> bdShift2);
      dst[o + x] = v < 0 ? 0 : v > maxVal ? maxVal : v;
    }
  }
}
