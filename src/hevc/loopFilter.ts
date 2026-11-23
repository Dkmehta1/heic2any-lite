import type { Plane } from './intraPrediction';
import type { Pps, Sps } from './parameterSets';
import { BETA_TABLE, TC_TABLE, chromaQpMapping } from './tables';

export interface SliceFilterParams {
  deblockingDisabled: boolean;
  betaOffsetDiv2: number;
  tcOffsetDiv2: number;
  loopFilterAcrossSlices: boolean;
}

/** The picture state the loop filters need (implemented by the picture decoder). */
export interface LoopFilterState {
  readonly sps: Sps;
  readonly pps: Pps;
  readonly width: number;
  readonly height: number;
  readonly chromaArrayType: number;
  readonly planes: [Plane, Plane, Plane];
  readonly stride: number;
  readonly cStride: number;
  readonly w4: number;
  readonly h4: number;
  readonly log2Ctb: number;
  readonly wCtb: number;
  readonly numCtbs: number;
  readonly edges: Uint8Array;
  readonly qpMap: Int8Array;
  readonly blkFlags: Uint8Array;
  readonly ctbSliceIdx: Int32Array;
  readonly ctbSliceAddr: Int32Array;
  readonly tileIdRs: Int32Array;
  readonly rsToTs: Int32Array;
  readonly slices: SliceFilterParams[];
  readonly saoType: Uint8Array;
  readonly saoClass: Uint8Array;
  readonly saoOffsets: Int16Array;
}

const NO_FILTER = 4;
const clip3 = (lo: number, hi: number, v: number): number => (v < lo ? lo : v > hi ? hi : v);

/** 8.7.2: deblocking. All edges in an intra picture have bS = 2. */
export function applyDeblocking(s: LoopFilterState): void {
  const { w4, h4, edges, qpMap, blkFlags, sps, pps } = s;
  const Y = s.planes[0];
  const maxY = (1 << sps.bitDepthY) - 1;
  const maxC = (1 << sps.bitDepthC) - 1;
  const scaleY = 1 << (sps.bitDepthY - 8);
  const scaleC = 1 << (sps.bitDepthC - 8);
  for (let dir = 0; dir < 2; dir++) {
    const bit = dir === 0 ? 1 : 2;
    const lumaStep = dir === 0 ? 1 : s.stride; // across the edge
    const lumaAlong = dir === 0 ? s.stride : 1; // along the edge
    const chromaStep = dir === 0 ? 1 : s.cStride;
    const chromaAlong = dir === 0 ? s.cStride : 1;
    for (let by = 0; by < h4; by++) {
      for (let bx = 0; bx < w4; bx++) {
        const i = by * w4 + bx;
        if (!(edges[i] & bit)) continue;
        const iP = dir === 0 ? i - 1 : i - w4;
        const x = bx << 2;
        const y = by << 2;
        const slice = s.slices[s.ctbSliceIdx[(y >> s.log2Ctb) * s.wCtb + (x >> s.log2Ctb)]];
        const qpQ = qpMap[i];
        const qpP = qpMap[iP];
        const noP = (blkFlags[iP] & NO_FILTER) !== 0;
        const noQ = (blkFlags[i] & NO_FILTER) !== 0;
        const qPL = (qpQ + qpP + 1) >> 1;
        const beta = BETA_TABLE[clip3(0, 51, qPL + (slice.betaOffsetDiv2 << 1))] * scaleY;
        const tc = TC_TABLE[clip3(0, 53, qPL + 2 + (slice.tcOffsetDiv2 << 1))] * scaleY;
        if (tc > 0 || beta > 0) {
          filterLumaEdge(Y, y * s.stride + x, lumaStep, lumaAlong, beta, tc, noP, noQ, maxY);
        }
        if (s.chromaArrayType === 1 && ((dir === 0 ? x : y) & 15) === 0) {
          for (let c = 1; c <= 2; c++) {
            const qpC = chromaQpMapping(((qpQ + qpP + 1) >> 1) + (c === 1 ? pps.cbQpOffset : pps.crQpOffset));
            const tcC = TC_TABLE[clip3(0, 53, qpC + 2 + (slice.tcOffsetDiv2 << 1))] * scaleC;
            if (tcC === 0) continue;
            filterChromaEdge(s.planes[c], (y >> 1) * s.cStride + (x >> 1), chromaStep, chromaAlong, tcC, noP, noQ, maxC);
          }
        }
      }
    }
  }
}

function filterLumaEdge(
  P: Plane,
  pos: number,
  st: number,
  along: number,
  beta: number,
  tc: number,
  noP: boolean,
  noQ: boolean,
  maxVal: number,
): void {
  const k3 = pos + 3 * along;
  const dp0 = Math.abs(P[pos - 3 * st] - 2 * P[pos - 2 * st] + P[pos - st]);
  const dp3 = Math.abs(P[k3 - 3 * st] - 2 * P[k3 - 2 * st] + P[k3 - st]);
  const dq0 = Math.abs(P[pos + 2 * st] - 2 * P[pos + st] + P[pos]);
  const dq3 = Math.abs(P[k3 + 2 * st] - 2 * P[k3 + st] + P[k3]);
  const dpq0 = dp0 + dq0;
  const dpq3 = dp3 + dq3;
  const dp = dp0 + dp3;
  const dq = dq0 + dq3;
  if (dpq0 + dpq3 >= beta) return;
  const tc5 = (5 * tc + 1) >> 1;
  const dSam = (o: number, dpq: number): boolean =>
    dpq < beta >> 2 &&
    Math.abs(P[o - 4 * st] - P[o - st]) + Math.abs(P[o] - P[o + 3 * st]) < beta >> 3 &&
    Math.abs(P[o - st] - P[o]) < tc5;
  const strong = dSam(pos, 2 * dpq0) && dSam(k3, 2 * dpq3);
  const sideThr = (beta + (beta >> 1)) >> 3;
  const dEp = dp < sideThr;
  const dEq = dq < sideThr;
  const tc2 = 2 * tc;
  const tcHalf = tc >> 1;
  for (let k = 0; k < 4; k++) {
    const o = pos + k * along;
    const p0 = P[o - st];
    const p1 = P[o - 2 * st];
    const p2 = P[o - 3 * st];
    const q0 = P[o];
    const q1 = P[o + st];
    const q2 = P[o + 2 * st];
    if (strong) {
      const p3 = P[o - 4 * st];
      const q3 = P[o + 3 * st];
      if (!noP) {
        P[o - st] = clip3(p0 - tc2, p0 + tc2, (p2 + 2 * p1 + 2 * p0 + 2 * q0 + q1 + 4) >> 3);
        P[o - 2 * st] = clip3(p1 - tc2, p1 + tc2, (p2 + p1 + p0 + q0 + 2) >> 2);
        P[o - 3 * st] = clip3(p2 - tc2, p2 + tc2, (2 * p3 + 3 * p2 + p1 + p0 + q0 + 4) >> 3);
      }
      if (!noQ) {
        P[o] = clip3(q0 - tc2, q0 + tc2, (p1 + 2 * p0 + 2 * q0 + 2 * q1 + q2 + 4) >> 3);
        P[o + st] = clip3(q1 - tc2, q1 + tc2, (p0 + q0 + q1 + q2 + 2) >> 2);
        P[o + 2 * st] = clip3(q2 - tc2, q2 + tc2, (p0 + q0 + q1 + 3 * q2 + 2 * q3 + 4) >> 3);
      }
    } else {
      let delta = (9 * (q0 - p0) - 3 * (q1 - p1) + 8) >> 4;
      if (Math.abs(delta) >= tc * 10) continue;
      delta = clip3(-tc, tc, delta);
      if (!noP) {
        P[o - st] = clip3(0, maxVal, p0 + delta);
        if (dEp) {
          const dP = clip3(-tcHalf, tcHalf, (((p2 + p0 + 1) >> 1) - p1 + delta) >> 1);
          P[o - 2 * st] = clip3(0, maxVal, p1 + dP);
        }
      }
      if (!noQ) {
        P[o] = clip3(0, maxVal, q0 - delta);
        if (dEq) {
          const dQ = clip3(-tcHalf, tcHalf, (((q2 + q0 + 1) >> 1) - q1 - delta) >> 1);
          P[o + st] = clip3(0, maxVal, q1 + dQ);
        }
      }
    }
  }
}

function filterChromaEdge(
  P: Plane,
  pos: number,
  st: number,
  along: number,
  tc: number,
  noP: boolean,
  noQ: boolean,
  maxVal: number,
): void {
  for (let k = 0; k < 2; k++) {
    const o = pos + k * along;
    const p0 = P[o - st];
    const p1 = P[o - 2 * st];
    const q0 = P[o];
    const q1 = P[o + st];
    const delta = clip3(-tc, tc, ((((q0 - p0) << 2) + p1 - q1 + 4) >> 3));
    if (!noP) P[o - st] = clip3(0, maxVal, p0 + delta);
    if (!noQ) P[o] = clip3(0, maxVal, q0 - delta);
  }
}

const EO_DX = [
  [-1, 1],
  [0, 0],
  [-1, 1],
  [1, -1],
];
const EO_DY = [
  [0, 0],
  [-1, 1],
  [-1, 1],
  [-1, 1],
];

/** 8.7.3: sample adaptive offset, applied to the deblocked picture. */
export function applySao(s: LoopFilterState): void {
  const { sps, pps } = s;
  const simple = s.slices.length === 1 && (pps.loopFilterAcrossTiles || !pps.tilesEnabled);
  const crossOk = (cur: number, nb: number): boolean => {
    if (cur === nb || simple) return true;
    if (s.ctbSliceAddr[cur] !== s.ctbSliceAddr[nb]) {
      const nbEarlier = s.rsToTs[nb] < s.rsToTs[cur];
      if (nbEarlier && !s.slices[s.ctbSliceIdx[cur]].loopFilterAcrossSlices) return false;
      if (!nbEarlier && !s.slices[s.ctbSliceIdx[nb]].loopFilterAcrossSlices) return false;
    }
    if (s.tileIdRs[cur] !== s.tileIdRs[nb] && !pps.loopFilterAcrossTiles) return false;
    return true;
  };
  const numComps = s.chromaArrayType ? 3 : 1;
  for (let cIdx = 0; cIdx < numComps; cIdx++) {
    const plane = s.planes[cIdx];
    const sh = cIdx ? 1 : 0;
    const stride = cIdx ? s.cStride : s.stride;
    const w = s.width >> sh;
    const h = s.height >> sh;
    const ctbSize = (1 << s.log2Ctb) >> sh;
    const bitDepth = cIdx ? sps.bitDepthC : sps.bitDepthY;
    const maxVal = (1 << bitDepth) - 1;
    let src: Plane | null = null;
    for (let rs = 0; rs < s.numCtbs; rs++) {
      const k = rs * 3 + cIdx;
      const type = s.saoType[k];
      if (!type) continue;
      if (!src) src = plane.slice();
      const x0 = (rs % s.wCtb) * ctbSize;
      const y0 = ((rs / s.wCtb) | 0) * ctbSize;
      const x1 = Math.min(x0 + ctbSize, w);
      const y1 = Math.min(y0 + ctbSize, h);
      const o0 = s.saoOffsets[k * 4];
      const o1 = s.saoOffsets[k * 4 + 1];
      const o2 = s.saoOffsets[k * 4 + 2];
      const o3 = s.saoOffsets[k * 4 + 3];
      const offs = [0, o0, o1, o2, o3];
      if (type === 1) {
        const bandTable = new Uint8Array(32);
        for (let b = 0; b < 4; b++) bandTable[(b + s.saoClass[k]) & 31] = b + 1;
        const shift = bitDepth - 5;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            if (s.blkFlags[((y << sh) >> 2) * s.w4 + ((x << sh) >> 2)] & NO_FILTER) continue;
            const i = y * stride + x;
            const v = src[i];
            const band = bandTable[v >> shift];
            if (band) plane[i] = clip3(0, maxVal, v + offs[band]);
          }
        }
        continue;
      }
      const cls = s.saoClass[k];
      const dxa = EO_DX[cls][0];
      const dxb = EO_DX[cls][1];
      const dya = EO_DY[cls][0];
      const dyb = EO_DY[cls][1];
      const nbCtb = (x: number, y: number): number =>
        ((y << sh) >> s.log2Ctb) * s.wCtb + ((x << sh) >> s.log2Ctb);
      for (let y = y0; y < y1; y++) {
        const ya = y + dya;
        const yb = y + dyb;
        if (ya < 0 || yb < 0 || ya >= h || yb >= h) continue;
        const edgeRow = y === y0 || y === y1 - 1;
        for (let x = x0; x < x1; x++) {
          const xa = x + dxa;
          const xb = x + dxb;
          if (xa < 0 || xb < 0 || xa >= w || xb >= w) continue;
          if (s.blkFlags[((y << sh) >> 2) * s.w4 + ((x << sh) >> 2)] & NO_FILTER) continue;
          if (!simple && (edgeRow || x === x0 || x === x1 - 1)) {
            if (!crossOk(rs, nbCtb(xa, ya)) || !crossOk(rs, nbCtb(xb, yb))) continue;
          }
          const i = y * stride + x;
          const v = src[i];
          const a = src[ya * stride + xa];
          const b = src[yb * stride + xb];
          let edgeIdx = 2 + (v > a ? 1 : v < a ? -1 : 0) + (v > b ? 1 : v < b ? -1 : 0);
          if (edgeIdx <= 2) edgeIdx = edgeIdx === 2 ? 0 : edgeIdx + 1;
          if (edgeIdx) plane[i] = clip3(0, maxVal, v + offs[edgeIdx]);
        }
      }
    }
  }
}
