/**
 * Constant tables from ITU-T H.265 (HEVC), written from the specification.
 * Only what an intra-only (still picture) decoder needs.
 */

/** rangeTabLps[pStateIdx][qRangeIdx], flattened as pStateIdx * 4 + qRangeIdx (H.265 Table 9-52). */
export const RANGE_TAB_LPS = new Uint8Array([
  128, 176, 208, 240, 128, 167, 197, 227, 128, 158, 187, 216, 123, 150, 178, 205,
  116, 142, 169, 195, 111, 135, 160, 185, 105, 128, 152, 175, 100, 122, 144, 166,
  95, 116, 137, 158, 90, 110, 130, 150, 85, 104, 123, 142, 81, 99, 117, 135,
  77, 94, 111, 128, 73, 89, 105, 122, 69, 85, 100, 116, 66, 80, 95, 110,
  62, 76, 90, 104, 59, 72, 86, 99, 56, 69, 81, 94, 53, 65, 77, 89,
  51, 62, 73, 85, 48, 59, 69, 80, 46, 56, 66, 76, 43, 53, 63, 72,
  41, 50, 59, 69, 39, 48, 56, 65, 37, 45, 54, 62, 35, 43, 51, 59,
  33, 41, 48, 56, 32, 39, 46, 53, 30, 37, 43, 50, 29, 35, 41, 48,
  27, 33, 39, 45, 26, 31, 37, 43, 24, 30, 35, 41, 23, 28, 33, 39,
  22, 27, 32, 37, 21, 26, 30, 35, 20, 24, 29, 33, 19, 23, 27, 31,
  18, 22, 26, 30, 17, 21, 25, 28, 16, 20, 23, 27, 15, 19, 22, 25,
  14, 18, 21, 24, 14, 17, 20, 23, 13, 16, 19, 22, 12, 15, 18, 21,
  12, 14, 17, 20, 11, 14, 16, 19, 11, 13, 15, 18, 10, 12, 15, 17,
  10, 12, 14, 16, 9, 11, 13, 15, 9, 11, 12, 14, 8, 10, 12, 14,
  8, 9, 11, 13, 7, 9, 11, 12, 7, 9, 10, 12, 7, 8, 10, 11,
  6, 8, 9, 11, 6, 7, 9, 10, 6, 7, 8, 9, 2, 2, 2, 2,
]);

/** transIdxLps (H.265 Table 9-53). */
export const TRANS_IDX_LPS = new Uint8Array([
  0, 0, 1, 2, 2, 4, 4, 5, 6, 7, 8, 9, 9, 11, 11, 12,
  13, 13, 15, 15, 16, 16, 18, 18, 19, 19, 21, 21, 22, 22, 23, 24,
  24, 25, 26, 26, 27, 27, 28, 29, 29, 30, 30, 30, 31, 32, 32, 33,
  33, 33, 34, 34, 35, 35, 35, 36, 36, 36, 37, 37, 37, 38, 38, 63,
]);

/** transIdxMps: min(state + 1, 62), state 62/63 unchanged. */
export const TRANS_IDX_MPS = new Uint8Array(64).map((_, s) => (s < 62 ? s + 1 : s));

/** Number of left shifts that bring an LPS range back to >= 256, indexed by (lpsRange >> 3). */
export const RENORM_TABLE = new Uint8Array([
  6, 5, 4, 4, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
]);

/**
 * Scan orders (H.265 6.5.3 - 6.5.5) as interleaved (x, y) pairs.
 * SCAN_ORDER[log2BlockSize][scanIdx], scanIdx 0 = up-right diagonal, 1 = horizontal, 2 = vertical.
 */
function buildScan(log2Size: number, scanIdx: number): Uint8Array {
  const size = 1 << log2Size;
  const out = new Uint8Array(size * size * 2);
  let i = 0;
  if (scanIdx === 0) {
    let x = 0;
    let y = 0;
    while (i < size * size) {
      while (y >= 0) {
        if (x < size && y < size) {
          out[i * 2] = x;
          out[i * 2 + 1] = y;
          i++;
        }
        y--;
        x++;
      }
      y = x;
      x = 0;
    }
  } else {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b < size; b++) {
        // horizontal: rows top to bottom; vertical: columns left to right
        out[i * 2] = scanIdx === 1 ? b : a;
        out[i * 2 + 1] = scanIdx === 1 ? a : b;
        i++;
      }
    }
  }
  return out;
}

export const SCAN_ORDER: Uint8Array[][] = [0, 1, 2, 3].map((log2) =>
  [0, 1, 2].map((scanIdx) => buildScan(log2, scanIdx)),
);

/** ctxIdxMap for sig_coeff_flag in 4x4 transform blocks (H.265 Table 9-50). */
export const CTX_IDX_MAP_4X4 = new Uint8Array([0, 1, 4, 5, 2, 3, 4, 5, 6, 6, 8, 8, 7, 7, 8, 8]);

/** intraPredAngle per intra prediction mode (H.265 Table 8-4); modes 0/1 unused. */
export const INTRA_PRED_ANGLE = new Int8Array([
  0, 0, 32, 26, 21, 17, 13, 9, 5, 2, 0, -2, -5, -9, -13, -17, -21, -26,
  -32, -26, -21, -17, -13, -9, -5, -2, 0, 2, 5, 9, 13, 17, 21, 26, 32,
]);

/** invAngle for modes 11..25 (H.265 Table 8-5); other modes unused. */
export const INV_ANGLE = new Int16Array(35);
[-4096, -1638, -910, -630, -482, -390, -315, -256, -315, -390, -482, -630, -910, -1638, -4096].forEach(
  (v, i) => {
    INV_ANGLE[11 + i] = v;
  },
);

/**
 * 32x32 inverse transform matrix (H.265 8.6.4.2), row = basis index, column = sample position.
 * Every entry depends only on the cosine angle ((2n + 1) * k mod 128) * pi / 64, so the
 * matrix is generated from the 32 distinct coefficient magnitudes defined by the standard.
 */
const COS_COEFF = [
  64, 90, 90, 90, 89, 88, 87, 85, 83, 82, 80, 78, 75, 73, 70, 67,
  64, 61, 57, 54, 50, 46, 43, 38, 36, 31, 25, 22, 18, 13, 9, 4,
];
export const DCT_MATRIX = new Int16Array(32 * 32);
for (let k = 0; k < 32; k++) {
  for (let n = 0; n < 32; n++) {
    if (k === 0) {
      DCT_MATRIX[n] = 64;
      continue;
    }
    let t = ((2 * n + 1) * k) % 128;
    if (t > 64) t = 128 - t;
    let sign = 1;
    if (t > 32) {
      t = 64 - t;
      sign = -1;
    }
    DCT_MATRIX[k * 32 + n] = sign * COS_COEFF[t];
  }
}

/** 4x4 inverse DST matrix for intra luma 4x4 blocks (H.265 8.6.4.2), row = basis index. */
export const DST_MATRIX = new Int16Array([29, 55, 74, 84, 74, 74, 0, -74, 84, -29, -74, 55, 55, -84, 74, -29]);

export const LEVEL_SCALE = new Int32Array([40, 45, 51, 57, 64, 72]);

/** Deblocking beta' (H.265 Table 8-12), Q = 0..51. */
export const BETA_TABLE = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24,
  26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62, 64,
]);

/** Deblocking tC' (H.265 Table 8-12), Q = 0..53. */
export const TC_TABLE = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3,
  3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 9, 10, 11, 13, 14, 16, 18, 20, 22, 24,
]);

/** QpC as a function of qPi for ChromaArrayType == 1 (H.265 Table 8-10). */
export function chromaQpMapping(qPi: number): number {
  if (qPi < 30) return qPi;
  if (qPi > 43) return qPi - 6;
  return CHROMA_QP_MID[qPi - 30];
}
const CHROMA_QP_MID = [29, 30, 31, 32, 33, 33, 34, 34, 35, 35, 36, 36, 37, 37];

/** Default 8x8 scaling lists (H.265 Table 7-6), in up-right diagonal order. */
export const DEFAULT_SCALING_INTRA = new Uint8Array([
  16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 17, 16, 17, 16, 17, 18, 17, 18, 18, 17, 18, 21, 19, 20,
  21, 20, 19, 21, 24, 22, 22, 24, 24, 22, 22, 24, 25, 25, 27, 30, 27, 25, 25, 29, 31, 35, 35, 31,
  29, 36, 41, 44, 41, 36, 47, 54, 54, 47, 65, 70, 65, 88, 88, 115,
]);
export const DEFAULT_SCALING_INTER = new Uint8Array([
  16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 17, 17, 17, 17, 17, 18, 18, 18, 18, 18, 18, 20, 20, 20,
  20, 20, 20, 20, 24, 24, 24, 24, 24, 24, 24, 24, 25, 25, 25, 25, 25, 25, 25, 28, 28, 28, 28, 28,
  28, 33, 33, 33, 33, 33, 41, 41, 41, 41, 54, 54, 54, 71, 71, 91,
]);
