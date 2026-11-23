import { HeicDecodeError } from '../errors';
import { BitReader, unescapeRbsp } from './bitReader';
import { CabacDecoder, CTX } from './cabac';
import { predictIntra, type Plane } from './intraPrediction';
import { applyDeblocking, applySao, type LoopFilterState, type SliceFilterParams } from './loopFilter';
import { parsePps, parseSps, type Pps, type Sps } from './parameterSets';
import { CTX_IDX_MAP_4X4, SCAN_ORDER, chromaQpMapping } from './tables';
import { addResidual } from './transform';

/** A decoded picture, cropped to its conformance window. Planes are tightly packed. */
export interface DecodedPicture {
  width: number;
  height: number;
  /** 0 = monochrome, 1 = 4:2:0 */
  chromaFormatIdc: number;
  bitDepthY: number;
  bitDepthC: number;
  /** [Y, Cb, Cr]; Cb/Cr are empty for monochrome. */
  planes: [Plane, Plane, Plane];
  chromaWidth: number;
  chromaHeight: number;
}

interface SliceHeader {
  dependent: boolean;
  segmentAddress: number;
  saoLuma: boolean;
  saoChroma: boolean;
  sliceQpY: number;
  cbQpOffset: number;
  crQpOffset: number;
  filter: SliceFilterParams;
  dataOffset: number;
}

const ceilLog2 = (v: number): number => {
  let n = 0;
  while (1 << n < v) n++;
  return n;
};

// block flags (per 4x4 luma block)
const FLAG_PCM = 1;
const FLAG_BYPASS = 2;
export const FLAG_NO_FILTER = 4;

/**
 * Decodes one intra-coded HEVC picture from a list of NAL units
 * (parameter sets + slice segments), as found in a HEIF image item.
 */
export function decodeHevcPicture(nalUnits: Uint8Array[]): DecodedPicture {
  const spsMap = new Map<number, Sps>();
  const ppsMap = new Map<number, Pps>();
  let pic: PictureDecoder | null = null;
  for (const nal of nalUnits) {
    if (nal.length < 2) continue;
    const type = (nal[0] >> 1) & 63;
    const layerId = ((nal[0] & 1) << 5) | (nal[1] >> 3);
    if (layerId !== 0) continue;
    if (type === 33) {
      const sps = parseSps(nal);
      spsMap.set(sps.id, sps);
    } else if (type === 34) {
      const pps = parsePps(nal);
      ppsMap.set(pps.id, pps);
    } else if (type <= 21 && !(type >= 10 && type <= 15)) {
      const rbsp = unescapeRbsp(nal);
      const firstSliceInPic = rbsp[2] >> 7;
      if (firstSliceInPic && pic) break; // only the first picture of the item is decoded
      const pps = ppsMap.get(peekPpsId(rbsp, type));
      if (!pps) throw new HeicDecodeError('missing PPS');
      const sps = spsMap.get(pps.spsId);
      if (!sps) throw new HeicDecodeError('missing SPS');
      if (!pic) {
        if (!firstSliceInPic) throw new HeicDecodeError('picture does not start with its first slice');
        pic = new PictureDecoder(sps, pps);
      }
      pic.decodeSliceSegment(rbsp, type, pps);
    }
  }
  if (!pic) throw new HeicDecodeError('no picture data');
  return pic.finish();
}

function peekPpsId(rbsp: Uint8Array, nalType: number): number {
  const r = new BitReader(rbsp, 2);
  r.u1();
  if (nalType >= 16 && nalType <= 23) r.u1();
  return r.ue();
}

class PictureDecoder implements LoopFilterState {
  readonly sps: Sps;
  pps: Pps;
  readonly width: number;
  readonly height: number;
  readonly chromaArrayType: number;
  readonly planes: [Plane, Plane, Plane];
  readonly stride: number;
  readonly cStride: number;
  readonly w4: number;
  readonly h4: number;
  readonly log2Ctb: number;
  readonly ctbSize: number;
  readonly wCtb: number;
  readonly hCtb: number;
  readonly numCtbs: number;

  // per 4x4 luma block
  readonly zscan: Int32Array;
  readonly predModeY: Uint8Array;
  readonly ctDepth: Uint8Array;
  readonly qpMap: Int8Array;
  readonly blkFlags: Uint8Array;
  readonly edges: Uint8Array;

  // per CTB
  readonly rsToTs: Int32Array;
  readonly tsToRs: Int32Array;
  readonly tileIdRs: Int32Array;
  readonly ctbSliceAddr: Int32Array;
  readonly ctbSliceIdx: Int32Array;
  readonly saoType: Uint8Array;
  readonly saoClass: Uint8Array;
  readonly saoOffsets: Int16Array;
  readonly slices: SliceFilterParams[] = [];
  private decodedCtbs = 0;
  anySao = false;

  // CABAC + slice state
  private readonly cabac = new CabacDecoder();
  private wppStore: Uint8Array | null = null;
  private dsStore: Uint8Array | null = null;
  private sh!: SliceHeader;
  private sliceAddrRs = 0;
  private prevIndependent: SliceHeader | null = null;

  // QP state
  private readonly qpBdOffsetY: number;
  private readonly qpBdOffsetC: number;
  private log2MinCuQpDeltaSize = 0;
  private qgX = 0;
  private qgY = 0;
  private qpYPrevQg = 0;
  private lastQpY = 0;
  private qpY = 0;
  private isCuQpDeltaCoded = false;
  private cuQpDeltaVal = 0;

  // CU state
  private cuBypass = 0;
  private intraSplit = 0;
  private maxTrafoDepth = 0;
  private chromaMode = 0;

  // scratch buffers
  private readonly coeffs = new Int32Array(32 * 32);
  private readonly tmp = new Int32Array(32 * 32);
  private readonly ref = new Int32Array(4 * 64 + 1);
  private readonly refFiltered = new Int32Array(4 * 64 + 1);
  private readonly refAvail = new Uint8Array(4 * 64 + 1);
  private readonly angularRef = new Int32Array(3 * 64 + 2);
  private readonly csbf = new Uint8Array(64);
  private readonly sigList = new Int32Array(16);
  private readonly g1 = new Uint8Array(8);

  constructor(sps: Sps, pps: Pps) {
    this.sps = sps;
    this.pps = pps;
    this.width = sps.width;
    this.height = sps.height;
    this.chromaArrayType = sps.chromaFormatIdc;
    if (this.width % (1 << sps.log2MinCbSize) || this.height % (1 << sps.log2MinCbSize)) {
      throw new HeicDecodeError('picture size is not a multiple of the minimum CB size');
    }
    const make = (bitDepth: number, size: number): Plane =>
      bitDepth > 8 ? new Uint16Array(size) : new Uint8Array(size);
    this.stride = this.width;
    this.cStride = this.chromaArrayType ? this.width >> 1 : 0;
    const cSize = this.chromaArrayType ? (this.width >> 1) * (this.height >> 1) : 0;
    this.planes = [make(sps.bitDepthY, this.width * this.height), make(sps.bitDepthC, cSize), make(sps.bitDepthC, cSize)];
    this.w4 = this.width >> 2;
    this.h4 = this.height >> 2;
    this.log2Ctb = sps.log2CtbSize;
    this.ctbSize = 1 << sps.log2CtbSize;
    this.wCtb = sps.picWidthInCtbs;
    this.hCtb = sps.picHeightInCtbs;
    this.numCtbs = this.wCtb * this.hCtb;
    const n4 = this.w4 * this.h4;
    this.zscan = new Int32Array(n4);
    this.predModeY = new Uint8Array(n4);
    this.ctDepth = new Uint8Array(n4);
    this.qpMap = new Int8Array(n4);
    this.blkFlags = new Uint8Array(n4);
    this.edges = new Uint8Array(n4);
    this.rsToTs = new Int32Array(this.numCtbs);
    this.tsToRs = new Int32Array(this.numCtbs);
    this.tileIdRs = new Int32Array(this.numCtbs);
    this.ctbSliceAddr = new Int32Array(this.numCtbs).fill(-1);
    this.ctbSliceIdx = new Int32Array(this.numCtbs);
    this.saoType = new Uint8Array(this.numCtbs * 3);
    this.saoClass = new Uint8Array(this.numCtbs * 3);
    this.saoOffsets = new Int16Array(this.numCtbs * 12);
    this.qpBdOffsetY = 6 * (sps.bitDepthY - 8);
    this.qpBdOffsetC = 6 * (sps.bitDepthC - 8);
    this.buildScanTables(pps);
  }

  /** 6.5.1 / 6.5.2: CTB raster <-> tile scan conversion, tile ids and the z-scan order. */
  private buildScanTables(pps: Pps): void {
    const { wCtb, hCtb } = this;
    const colWidths: number[] = [];
    const rowHeights: number[] = [];
    if (!pps.tilesEnabled) {
      colWidths.push(wCtb);
      rowHeights.push(hCtb);
    } else if (pps.uniformSpacing) {
      for (let i = 0; i < pps.numTileColumns; i++) {
        colWidths.push(Math.floor(((i + 1) * wCtb) / pps.numTileColumns) - Math.floor((i * wCtb) / pps.numTileColumns));
      }
      for (let j = 0; j < pps.numTileRows; j++) {
        rowHeights.push(Math.floor(((j + 1) * hCtb) / pps.numTileRows) - Math.floor((j * hCtb) / pps.numTileRows));
      }
    } else {
      colWidths.push(...pps.columnWidths);
      colWidths.push(wCtb - pps.columnWidths.reduce((a, b) => a + b, 0));
      rowHeights.push(...pps.rowHeights);
      rowHeights.push(hCtb - pps.rowHeights.reduce((a, b) => a + b, 0));
    }
    if (colWidths.some((w) => w <= 0) || rowHeights.some((h) => h <= 0)) throw new HeicDecodeError('invalid tiles');
    const colBd = [0];
    colWidths.forEach((w, i) => colBd.push(colBd[i] + w));
    const rowBd = [0];
    rowHeights.forEach((h, i) => rowBd.push(rowBd[i] + h));
    for (let rs = 0; rs < this.numCtbs; rs++) {
      const tbX = rs % wCtb;
      const tbY = (rs / wCtb) | 0;
      let tileX = 0;
      let tileY = 0;
      for (let i = 0; i < colWidths.length; i++) if (tbX >= colBd[i]) tileX = i;
      for (let j = 0; j < rowHeights.length; j++) if (tbY >= rowBd[j]) tileY = j;
      let v = 0;
      for (let i = 0; i < tileX; i++) v += rowHeights[tileY] * colWidths[i];
      for (let j = 0; j < tileY; j++) v += wCtb * rowHeights[j];
      v += (tbY - rowBd[tileY]) * colWidths[tileX] + tbX - colBd[tileX];
      this.rsToTs[rs] = v;
      this.tsToRs[v] = rs;
      this.tileIdRs[rs] = tileY * colWidths.length + tileX;
    }
    // z-scan order at 4x4 granularity (refines MinTbAddrZs, same ordering)
    const levels = this.log2Ctb - 2;
    for (let y = 0; y < this.h4; y++) {
      for (let x = 0; x < this.w4; x++) {
        const ctbRs = (y >> levels) * wCtb + (x >> levels);
        let p = 0;
        for (let i = 0; i < levels; i++) {
          const m = 1 << i;
          p += (m & x ? m * m : 0) + (m & y ? 2 * m * m : 0);
        }
        this.zscan[y * this.w4 + x] = (this.rsToTs[ctbRs] << (levels * 2)) + p;
      }
    }
  }

  /** 6.4.1: availability of a neighbouring luma location in z-scan order. */
  private available(xCurr: number, yCurr: number, xNb: number, yNb: number): boolean {
    if (xNb < 0 || yNb < 0 || xNb >= this.width || yNb >= this.height) return false;
    if (this.zscan[(yNb >> 2) * this.w4 + (xNb >> 2)] > this.zscan[(yCurr >> 2) * this.w4 + (xCurr >> 2)]) return false;
    const ctbNb = (yNb >> this.log2Ctb) * this.wCtb + (xNb >> this.log2Ctb);
    const ctbCur = (yCurr >> this.log2Ctb) * this.wCtb + (xCurr >> this.log2Ctb);
    if (ctbNb !== ctbCur) {
      if (this.ctbSliceAddr[ctbNb] !== this.ctbSliceAddr[ctbCur]) return false;
      if (this.tileIdRs[ctbNb] !== this.tileIdRs[ctbCur]) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- slice header

  private parseSliceHeader(rbsp: Uint8Array, nalType: number): SliceHeader {
    const { sps } = this;
    const pps = this.pps;
    const r = new BitReader(rbsp, 2);
    const first = r.u1();
    if (nalType >= 16 && nalType <= 23) r.u1();
    r.ue(); // slice_pic_parameter_set_id
    let dependent = false;
    let segmentAddress = 0;
    if (!first) {
      if (pps.dependentSliceSegmentsEnabled) dependent = !!r.u1();
      segmentAddress = r.u(ceilLog2(this.numCtbs));
      if (segmentAddress >= this.numCtbs) throw new HeicDecodeError('invalid slice address');
    }
    let header: SliceHeader;
    if (dependent) {
      if (!this.prevIndependent) throw new HeicDecodeError('dependent slice without a preceding slice');
      header = { ...this.prevIndependent, dependent: true, segmentAddress };
    } else {
      r.skip(pps.numExtraSliceHeaderBits);
      const sliceType = r.ue();
      if (pps.outputFlagPresent) r.u1();
      if (nalType !== 19 && nalType !== 20) {
        r.skip(sps.log2MaxPocLsb);
        const stFromSps = r.u1();
        if (!stFromSps) {
          skipStRps(r, sps);
        } else if (sps.numShortTermRefPicSets > 1) {
          r.skip(ceilLog2(sps.numShortTermRefPicSets));
        }
        if (sps.longTermRefPicsPresent) {
          const numLtSps = sps.numLongTermRefPicsSps > 0 ? r.ue() : 0;
          const numLtPics = r.ue();
          for (let i = 0; i < numLtSps + numLtPics; i++) {
            if (i < numLtSps) {
              if (sps.numLongTermRefPicsSps > 1) r.skip(ceilLog2(sps.numLongTermRefPicsSps));
            } else {
              r.skip(sps.log2MaxPocLsb + 1);
            }
            if (r.u1()) r.ue();
          }
        }
        if (sps.temporalMvpEnabled) r.u1();
      }
      let saoLuma = false;
      let saoChroma = false;
      if (sps.saoEnabled) {
        saoLuma = !!r.u1();
        if (this.chromaArrayType !== 0) saoChroma = !!r.u1();
      }
      if (sliceType !== 2) throw new HeicDecodeError('unsupported HEVC feature: inter-coded slices');
      const sliceQpY = pps.initQp + r.se();
      let cbQpOffset = 0;
      let crQpOffset = 0;
      if (pps.sliceChromaQpOffsetsPresent) {
        cbQpOffset = r.se();
        crQpOffset = r.se();
      }
      let deblockingDisabled = pps.deblockingDisabled;
      let betaOffsetDiv2 = pps.betaOffsetDiv2;
      let tcOffsetDiv2 = pps.tcOffsetDiv2;
      if (pps.deblockingOverrideEnabled && r.u1()) {
        deblockingDisabled = !!r.u1();
        if (!deblockingDisabled) {
          betaOffsetDiv2 = r.se();
          tcOffsetDiv2 = r.se();
        }
      }
      let loopFilterAcrossSlices = pps.loopFilterAcrossSlices;
      if (pps.loopFilterAcrossSlices && (saoLuma || saoChroma || !deblockingDisabled)) {
        loopFilterAcrossSlices = !!r.u1();
      }
      header = {
        dependent: false,
        segmentAddress,
        saoLuma,
        saoChroma,
        sliceQpY,
        cbQpOffset,
        crQpOffset,
        filter: { deblockingDisabled, betaOffsetDiv2, tcOffsetDiv2, loopFilterAcrossSlices },
        dataOffset: 0,
      };
    }
    if (pps.tilesEnabled || pps.entropyCodingSyncEnabled) {
      const numEntryPoints = r.ue();
      if (numEntryPoints > 0) {
        const len = r.ue() + 1;
        r.skip(numEntryPoints * len);
      }
    }
    if (pps.sliceHeaderExtensionPresent) r.skip(r.ue() * 8);
    r.byteAlignment();
    header.dataOffset = r.position >> 3;
    return header;
  }

  // ---------------------------------------------------------------- slice data

  decodeSliceSegment(rbsp: Uint8Array, nalType: number, pps: Pps): void {
    if (pps.id !== this.pps.id) {
      if (pps.tilesEnabled !== this.pps.tilesEnabled || pps.spsId !== this.sps.id) {
        throw new HeicDecodeError('PPS change inside a picture is not supported');
      }
      this.pps = pps;
    }
    const sh = this.parseSliceHeader(rbsp, nalType);
    this.sh = sh;
    if (!sh.dependent) {
      this.prevIndependent = sh;
      this.sliceAddrRs = sh.segmentAddress;
      this.slices.push(sh.filter);
      this.lastQpY = sh.sliceQpY;
    }
    if (sh.saoLuma || sh.saoChroma) this.anySao = true;
    const sliceIdx = this.slices.length - 1;
    this.log2MinCuQpDeltaSize = this.log2Ctb - this.pps.diffCuQpDeltaDepth;
    const cabac = this.cabac;
    cabac.setData(rbsp, sh.dataOffset, rbsp.length);

    let ctbAddrTs = this.rsToTs[sh.segmentAddress];
    let ctbAddrRs = sh.segmentAddress;
    this.ctbSliceAddr[ctbAddrRs] = this.sliceAddrRs;
    this.initContextsAtStart(ctbAddrTs, ctbAddrRs, sh);

    for (;;) {
      ctbAddrRs = this.tsToRs[ctbAddrTs];
      this.ctbSliceAddr[ctbAddrRs] = this.sliceAddrRs;
      this.ctbSliceIdx[ctbAddrRs] = sliceIdx;
      const xCtb = (ctbAddrRs % this.wCtb) << this.log2Ctb;
      const yCtb = ((ctbAddrRs / this.wCtb) | 0) << this.log2Ctb;
      if (sh.saoLuma || sh.saoChroma) this.parseSao(ctbAddrRs);
      this.codingQuadtree(xCtb, yCtb, this.log2Ctb, 0);
      this.decodedCtbs++;
      const endOfSlice = cabac.decodeTerminate();
      if (this.pps.entropyCodingSyncEnabled && this.isSecondCtbInTileRow(ctbAddrRs)) {
        this.wppStore = cabac.ctx.slice();
      }
      ctbAddrTs++;
      if (endOfSlice) {
        if (this.pps.dependentSliceSegmentsEnabled) this.dsStore = cabac.ctx.slice();
        break;
      }
      if (ctbAddrTs >= this.numCtbs) throw new HeicDecodeError('slice data overrun');
      const nextRs = this.tsToRs[ctbAddrTs];
      const tileStart = this.pps.tilesEnabled && this.tileIdRs[nextRs] !== this.tileIdRs[ctbAddrRs];
      const rowStart =
        this.pps.entropyCodingSyncEnabled &&
        (nextRs % this.wCtb === 0 || this.tileIdRs[nextRs] !== this.tileIdRs[nextRs - 1]);
      if (tileStart || rowStart) {
        cabac.decodeTerminate(); // end_of_subset_one_bit
        cabac.initEngine(); // the engine already stopped at the byte-aligned start of the next substream
        this.ctbSliceAddr[nextRs] = this.sliceAddrRs;
        if (tileStart) cabac.initContexts(sh.sliceQpY);
        else this.wppSync(nextRs, sh);
        this.lastQpY = sh.sliceQpY;
      }
    }
  }

  /** 9.3.2.2: WPP context storage happens after the 2nd CTB of a CTB row (within a tile). */
  private isSecondCtbInTileRow(ctbAddrRs: number): boolean {
    if (ctbAddrRs % this.wCtb === 1) return true;
    return ctbAddrRs > 1 && this.tileIdRs[ctbAddrRs] !== this.tileIdRs[ctbAddrRs - 2];
  }

  private wppSync(ctbAddrRs: number, sh: SliceHeader): void {
    const x = (ctbAddrRs % this.wCtb) << this.log2Ctb;
    const y = ((ctbAddrRs / this.wCtb) | 0) << this.log2Ctb;
    if (this.wppStore && this.available(x, y, x + this.ctbSize, y - this.ctbSize)) this.cabac.ctx.set(this.wppStore);
    else this.cabac.initContexts(sh.sliceQpY);
  }

  /** 9.3.1: context initialisation at the start of a slice segment. */
  private initContextsAtStart(ctbAddrTs: number, ctbAddrRs: number, sh: SliceHeader): void {
    const firstInTile = ctbAddrTs === 0 || this.tileIdRs[ctbAddrRs] !== this.tileIdRs[this.tsToRs[ctbAddrTs - 1]];
    if (firstInTile) {
      this.cabac.initContexts(sh.sliceQpY);
    } else if (this.pps.entropyCodingSyncEnabled && ctbAddrRs % this.wCtb === 0) {
      this.wppSync(ctbAddrRs, sh);
    } else if (sh.dependent && this.dsStore) {
      this.cabac.ctx.set(this.dsStore);
    } else {
      this.cabac.initContexts(sh.sliceQpY);
    }
    if (firstInTile || (this.pps.entropyCodingSyncEnabled && ctbAddrRs % this.wCtb === 0)) {
      this.lastQpY = sh.sliceQpY;
    }
  }

  // ---------------------------------------------------------------- SAO syntax

  private parseSao(ctbAddrRs: number): void {
    const { cabac, sh } = this;
    const rx = ctbAddrRs % this.wCtb;
    const ry = (ctbAddrRs / this.wCtb) | 0;
    let mergeLeft = 0;
    let mergeUp = 0;
    if (rx > 0) {
      const leftInSlice = ctbAddrRs > this.sliceAddrRs;
      const leftInTile = this.tileIdRs[ctbAddrRs] === this.tileIdRs[ctbAddrRs - 1];
      if (leftInSlice && leftInTile) mergeLeft = cabac.decodeBin(CTX.SAO_MERGE);
    }
    if (ry > 0 && !mergeLeft) {
      const upInSlice = ctbAddrRs - this.wCtb >= this.sliceAddrRs;
      const upInTile = this.tileIdRs[ctbAddrRs] === this.tileIdRs[ctbAddrRs - this.wCtb];
      if (upInSlice && upInTile) mergeUp = cabac.decodeBin(CTX.SAO_MERGE);
    }
    const base = ctbAddrRs * 3;
    if (mergeLeft || mergeUp) {
      const src = (mergeLeft ? ctbAddrRs - 1 : ctbAddrRs - this.wCtb) * 3;
      for (let c = 0; c < 3; c++) {
        this.saoType[base + c] = this.saoType[src + c];
        this.saoClass[base + c] = this.saoClass[src + c];
        for (let i = 0; i < 4; i++) this.saoOffsets[(base + c) * 4 + i] = this.saoOffsets[(src + c) * 4 + i];
      }
      return;
    }
    const numComps = this.chromaArrayType !== 0 ? 3 : 1;
    for (let cIdx = 0; cIdx < numComps; cIdx++) {
      const k = base + cIdx;
      if ((cIdx === 0 && !sh.saoLuma) || (cIdx > 0 && !sh.saoChroma)) {
        this.saoType[k] = 0;
        continue;
      }
      if (cIdx === 2) {
        this.saoType[k] = this.saoType[k - 1];
        this.saoClass[k] = this.saoClass[k - 1];
      } else {
        this.saoType[k] = cabac.decodeBin(CTX.SAO_TYPE) ? (cabac.decodeBypass() ? 2 : 1) : 0;
      }
      if (this.saoType[k] === 0) continue;
      const bitDepth = cIdx ? this.sps.bitDepthC : this.sps.bitDepthY;
      const cMax = (1 << (Math.min(bitDepth, 10) - 5)) - 1;
      const shift = bitDepth - Math.min(bitDepth, 10);
      const abs = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        while (abs[i] < cMax && cabac.decodeBypass()) abs[i]++;
      }
      const o = k * 4;
      if (this.saoType[k] === 1) {
        for (let i = 0; i < 4; i++) {
          const neg = abs[i] !== 0 && cabac.decodeBypass();
          this.saoOffsets[o + i] = (neg ? -abs[i] : abs[i]) << shift;
        }
        this.saoClass[k] = cabac.decodeBypassBits(5); // band position
      } else {
        this.saoOffsets[o] = abs[0] << shift;
        this.saoOffsets[o + 1] = abs[1] << shift;
        this.saoOffsets[o + 2] = -(abs[2] << shift);
        this.saoOffsets[o + 3] = -(abs[3] << shift);
        if (cIdx === 0 || cIdx === 1) this.saoClass[k] = cabac.decodeBypassBits(2);
      }
    }
  }

  // ---------------------------------------------------------------- coding tree

  private codingQuadtree(x0: number, y0: number, log2Size: number, depth: number): void {
    const size = 1 << log2Size;
    const { sps } = this;
    let split: number;
    if (x0 + size <= this.width && y0 + size <= this.height && log2Size > sps.log2MinCbSize) {
      let ctxInc = 0;
      if (this.available(x0, y0, x0 - 1, y0) && this.ctDepth[(y0 >> 2) * this.w4 + ((x0 - 1) >> 2)] > depth) ctxInc++;
      if (this.available(x0, y0, x0, y0 - 1) && this.ctDepth[((y0 - 1) >> 2) * this.w4 + (x0 >> 2)] > depth) ctxInc++;
      split = this.cabac.decodeBin(CTX.SPLIT_CU + ctxInc);
    } else {
      split = log2Size > sps.log2MinCbSize ? 1 : 0;
    }
    if (log2Size >= this.log2MinCuQpDeltaSize) {
      this.isCuQpDeltaCoded = false;
      this.cuQpDeltaVal = 0;
      this.qgX = x0;
      this.qgY = y0;
      this.qpYPrevQg = this.lastQpY;
    }
    if (split) {
      const half = size >> 1;
      const x1 = x0 + half;
      const y1 = y0 + half;
      this.codingQuadtree(x0, y0, log2Size - 1, depth + 1);
      if (x1 < this.width) this.codingQuadtree(x1, y0, log2Size - 1, depth + 1);
      if (y1 < this.height) this.codingQuadtree(x0, y1, log2Size - 1, depth + 1);
      if (x1 < this.width && y1 < this.height) this.codingQuadtree(x1, y1, log2Size - 1, depth + 1);
    } else {
      this.codingUnit(x0, y0, log2Size, depth);
    }
  }

  /** 8.6.1: luma QP of the current CU. */
  private updateQpY(): void {
    const mask = this.ctbSize - 1;
    const { qgX, qgY, w4 } = this;
    const qpA = qgX & mask ? this.qpMap[(qgY >> 2) * w4 + ((qgX - 1) >> 2)] : this.qpYPrevQg;
    const qpB = qgY & mask ? this.qpMap[((qgY - 1) >> 2) * w4 + (qgX >> 2)] : this.qpYPrevQg;
    const pred = (qpA + qpB + 1) >> 1;
    const off = this.qpBdOffsetY;
    this.qpY = ((pred + this.cuQpDeltaVal + 52 + 2 * off) % (52 + off)) - off;
  }

  private fillBlocks(arr: Uint8Array | Int8Array, x0: number, y0: number, size: number, value: number): void {
    const n = size >> 2;
    const bx = x0 >> 2;
    for (let y = (y0 >> 2), ye = y + n; y < ye; y++) arr.fill(value, y * this.w4 + bx, y * this.w4 + bx + n);
  }

  private codingUnit(x0: number, y0: number, log2Size: number, depth: number): void {
    const { cabac, sps, pps } = this;
    const nCbS = 1 << log2Size;
    this.cuBypass = pps.transquantBypassEnabled ? cabac.decodeBin(CTX.TRANSQUANT_BYPASS) : 0;
    const partNxN = log2Size === sps.log2MinCbSize ? 1 - cabac.decodeBin(CTX.PART_MODE) : 0;
    let pcm = 0;
    if (!partNxN && sps.pcmEnabled && log2Size >= sps.log2MinPcmCbSize && log2Size <= sps.log2MaxPcmCbSize) {
      pcm = cabac.decodeTerminate();
    }
    this.fillBlocks(this.ctDepth, x0, y0, nCbS, depth);
    let flags = 0;
    if (pcm) flags |= FLAG_PCM | (sps.pcmLoopFilterDisabled ? FLAG_NO_FILTER : 0);
    if (this.cuBypass) flags |= FLAG_BYPASS | FLAG_NO_FILTER;
    this.fillBlocks(this.blkFlags, x0, y0, nCbS, flags);
    this.updateQpY();

    if (pcm) {
      this.fillBlocks(this.predModeY, x0, y0, nCbS, 1);
      this.decodePcm(x0, y0, log2Size);
      this.markTransformEdges(x0, y0, nCbS);
    } else {
      const nParts = partNxN ? 4 : 1;
      const pb = partNxN ? nCbS >> 1 : nCbS;
      const prev = [0, 0, 0, 0];
      const val = [0, 0, 0, 0];
      for (let i = 0; i < nParts; i++) prev[i] = cabac.decodeBin(CTX.PREV_INTRA_LUMA);
      for (let i = 0; i < nParts; i++) {
        if (prev[i]) val[i] = cabac.decodeBypass() ? 1 + cabac.decodeBypass() : 0;
        else val[i] = cabac.decodeBypassBits(5);
      }
      for (let i = 0; i < nParts; i++) {
        const xPb = x0 + (i & 1) * pb;
        const yPb = y0 + (i >> 1) * pb;
        const mode = this.deriveLumaMode(xPb, yPb, prev[i], val[i]);
        this.fillBlocks(this.predModeY, xPb, yPb, pb, mode);
      }
      if (this.chromaArrayType !== 0) {
        const icpm = cabac.decodeBin(CTX.INTRA_CHROMA) ? cabac.decodeBypassBits(2) : 4;
        const lumaMode = this.predModeY[(y0 >> 2) * this.w4 + (x0 >> 2)];
        if (icpm === 4) {
          this.chromaMode = lumaMode;
        } else {
          const m = [0, 26, 10, 1][icpm];
          this.chromaMode = m === lumaMode ? 34 : m;
        }
      }
      this.intraSplit = partNxN;
      this.maxTrafoDepth = sps.maxTransformHierarchyDepthIntra + partNxN;
      this.transformTree(x0, y0, x0, y0, log2Size, 0, 0, 0, 0);
    }
    this.fillBlocks(this.qpMap, x0, y0, nCbS, this.qpY);
    this.lastQpY = this.qpY;
  }

  /** 8.4.2: derivation of the luma intra prediction mode. */
  private deriveLumaMode(xPb: number, yPb: number, prevFlag: number, val: number): number {
    const w4 = this.w4;
    let a = 1;
    if (this.available(xPb, yPb, xPb - 1, yPb)) {
      const i = (yPb >> 2) * w4 + ((xPb - 1) >> 2);
      if (!(this.blkFlags[i] & FLAG_PCM)) a = this.predModeY[i];
    }
    let b = 1;
    if (this.available(xPb, yPb, xPb, yPb - 1) && yPb - 1 >= (yPb >> this.log2Ctb) << this.log2Ctb) {
      const i = ((yPb - 1) >> 2) * w4 + (xPb >> 2);
      if (!(this.blkFlags[i] & FLAG_PCM)) b = this.predModeY[i];
    }
    let c0: number;
    let c1: number;
    let c2: number;
    if (a === b) {
      if (a < 2) {
        c0 = 0;
        c1 = 1;
        c2 = 26;
      } else {
        c0 = a;
        c1 = 2 + ((a + 29) % 32);
        c2 = 2 + ((a - 2 + 1) % 32);
      }
    } else {
      c0 = a;
      c1 = b;
      c2 = a !== 0 && b !== 0 ? 0 : a !== 1 && b !== 1 ? 1 : 26;
    }
    if (prevFlag) return val === 0 ? c0 : val === 1 ? c1 : c2;
    // sort ascending
    if (c0 > c1) [c0, c1] = [c1, c0];
    if (c0 > c2) [c0, c2] = [c2, c0];
    if (c1 > c2) [c1, c2] = [c2, c1];
    let mode = val;
    if (mode >= c0) mode++;
    if (mode >= c1) mode++;
    if (mode >= c2) mode++;
    return mode;
  }

  private decodePcm(x0: number, y0: number, log2Size: number): void {
    const { sps, cabac } = this;
    const r = new BitReader(cabac.data, cabac.pos);
    const n = 1 << log2Size;
    const shY = sps.bitDepthY - sps.pcmBitDepthY;
    const Y = this.planes[0];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) Y[(y0 + y) * this.stride + x0 + x] = r.u(sps.pcmBitDepthY) << shY;
    }
    if (this.chromaArrayType !== 0) {
      const nc = n >> 1;
      const shC = sps.bitDepthC - sps.pcmBitDepthC;
      for (let c = 1; c <= 2; c++) {
        const P = this.planes[c];
        for (let y = 0; y < nc; y++) {
          for (let x = 0; x < nc; x++) P[((y0 >> 1) + y) * this.cStride + (x0 >> 1) + x] = r.u(sps.pcmBitDepthC) << shC;
        }
      }
    }
    cabac.pos = r.bytePosition;
    cabac.initEngine();
  }

  // ---------------------------------------------------------------- transform tree

  private transformTree(
    x0: number,
    y0: number,
    xBase: number,
    yBase: number,
    log2Size: number,
    depth: number,
    blkIdx: number,
    parentCbfCb: number,
    parentCbfCr: number,
  ): void {
    const { cabac, sps } = this;
    let split: number;
    if (
      log2Size <= sps.log2MaxTbSize &&
      log2Size > sps.log2MinTbSize &&
      depth < this.maxTrafoDepth &&
      !(this.intraSplit && depth === 0)
    ) {
      split = cabac.decodeBin(CTX.SPLIT_TRANSFORM + 5 - log2Size);
    } else {
      split = log2Size > sps.log2MaxTbSize || (this.intraSplit && depth === 0) ? 1 : 0;
    }
    let cbfCb = 0;
    let cbfCr = 0;
    if (this.chromaArrayType !== 0) {
      if (log2Size > 2) {
        if (depth === 0 || parentCbfCb) cbfCb = cabac.decodeBin(CTX.CBF_CHROMA + depth);
        if (depth === 0 || parentCbfCr) cbfCr = cabac.decodeBin(CTX.CBF_CHROMA + depth);
      } else {
        cbfCb = parentCbfCb;
        cbfCr = parentCbfCr;
      }
    }
    if (split) {
      const half = 1 << (log2Size - 1);
      this.transformTree(x0, y0, x0, y0, log2Size - 1, depth + 1, 0, cbfCb, cbfCr);
      this.transformTree(x0 + half, y0, x0, y0, log2Size - 1, depth + 1, 1, cbfCb, cbfCr);
      this.transformTree(x0, y0 + half, x0, y0, log2Size - 1, depth + 1, 2, cbfCb, cbfCr);
      this.transformTree(x0 + half, y0 + half, x0, y0, log2Size - 1, depth + 1, 3, cbfCb, cbfCr);
      return;
    }
    const cbfLuma = cabac.decodeBin(CTX.CBF_LUMA + (depth === 0 ? 1 : 0));
    this.transformUnit(x0, y0, xBase, yBase, log2Size, blkIdx, cbfLuma, cbfCb, cbfCr);
  }

  private transformUnit(
    x0: number,
    y0: number,
    xBase: number,
    yBase: number,
    log2Size: number,
    blkIdx: number,
    cbfLuma: number,
    cbfCb: number,
    cbfCr: number,
  ): void {
    const { cabac, pps } = this;
    const n = 1 << log2Size;
    if ((cbfLuma || cbfCb || cbfCr) && pps.cuQpDeltaEnabled && !this.isCuQpDeltaCoded) {
      let abs = 0;
      while (abs < 5 && cabac.decodeBin(CTX.CU_QP_DELTA + (abs > 0 ? 1 : 0))) abs++;
      if (abs === 5) {
        let k = 0;
        let suffix = 0;
        while (cabac.decodeBypass()) {
          suffix += 1 << k;
          if (++k > 30) throw new HeicDecodeError('invalid cu_qp_delta');
        }
        abs += suffix + cabac.decodeBypassBits(k);
      }
      const negative = abs > 0 && cabac.decodeBypass();
      this.isCuQpDeltaCoded = true;
      this.cuQpDeltaVal = negative ? -abs : abs;
      this.updateQpY();
    }

    const lumaMode = this.predModeY[(y0 >> 2) * this.w4 + (x0 >> 2)];
    this.predictBlock(0, x0, y0, log2Size, lumaMode);
    if (cbfLuma) this.residual(0, x0, y0, log2Size, lumaMode);
    this.markTransformEdges(x0, y0, n);

    if (this.chromaArrayType === 0) return;
    if (log2Size > 2) {
      const xc = x0 >> 1;
      const yc = y0 >> 1;
      this.predictBlock(1, xc, yc, log2Size - 1, this.chromaMode);
      if (cbfCb) this.residual(1, xc, yc, log2Size - 1, this.chromaMode);
      this.predictBlock(2, xc, yc, log2Size - 1, this.chromaMode);
      if (cbfCr) this.residual(2, xc, yc, log2Size - 1, this.chromaMode);
    } else if (blkIdx === 3) {
      const xc = xBase >> 1;
      const yc = yBase >> 1;
      this.predictBlock(1, xc, yc, 2, this.chromaMode);
      if (cbfCb) this.residual(1, xc, yc, 2, this.chromaMode);
      this.predictBlock(2, xc, yc, 2, this.chromaMode);
      if (cbfCr) this.residual(2, xc, yc, 2, this.chromaMode);
    }
  }

  /** Marks transform-block edges on the 8x8 grid for deblocking (bS = 2 for intra). */
  private markTransformEdges(x0: number, y0: number, n: number): void {
    const filter = this.sh.filter;
    if (filter.deblockingDisabled) return;
    const w4 = this.w4;
    if ((x0 & 7) === 0 && x0 > 0 && this.edgeAllowed(x0, y0, x0 - 1, y0)) {
      for (let y = y0 >> 2, ye = (y0 + n) >> 2; y < ye; y++) this.edges[y * w4 + (x0 >> 2)] |= 1;
    }
    if ((y0 & 7) === 0 && y0 > 0 && this.edgeAllowed(x0, y0, x0, y0 - 1)) {
      for (let x = x0 >> 2, xe = (x0 + n) >> 2; x < xe; x++) this.edges[(y0 >> 2) * w4 + x] |= 2;
    }
  }

  private edgeAllowed(x: number, y: number, xNb: number, yNb: number): boolean {
    const ctbCur = (y >> this.log2Ctb) * this.wCtb + (x >> this.log2Ctb);
    const ctbNb = (yNb >> this.log2Ctb) * this.wCtb + (xNb >> this.log2Ctb);
    if (ctbCur === ctbNb) return true;
    if (this.tileIdRs[ctbCur] !== this.tileIdRs[ctbNb] && !this.pps.loopFilterAcrossTiles) return false;
    if (this.ctbSliceAddr[ctbCur] !== this.ctbSliceAddr[ctbNb] && !this.sh.filter.loopFilterAcrossSlices) return false;
    return true;
  }

  // ---------------------------------------------------------------- prediction

  private predictBlock(cIdx: number, xTb: number, yTb: number, log2Size: number, mode: number): void {
    const n = 1 << log2Size;
    const n2 = n << 1;
    const total = 4 * n + 1;
    const sh = cIdx ? 1 : 0;
    const unit = 4 >> sh;
    const plane = this.planes[cIdx];
    const stride = cIdx ? this.cStride : this.stride;
    const ref = this.ref;
    const av = this.refAvail;
    const xY = xTb << sh;
    const yY = yTb << sh;
    let any = false;
    // left column, bottom to top in the line (ref[n2 - 1 - y] = p[-1][y])
    for (let y = 0; y < n2; y += unit) {
      const a = this.available(xY, yY, xY - 1, (yTb + y) << sh);
      for (let k = 0; k < unit; k++) {
        const idx = n2 - 1 - (y + k);
        av[idx] = a ? 1 : 0;
        if (a) ref[idx] = plane[(yTb + y + k) * stride + xTb - 1];
      }
      if (a) any = true;
    }
    const corner = this.available(xY, yY, xY - 1, yY - 1);
    av[n2] = corner ? 1 : 0;
    if (corner) {
      ref[n2] = plane[(yTb - 1) * stride + xTb - 1];
      any = true;
    }
    for (let x = 0; x < n2; x += unit) {
      const a = this.available(xY, yY, (xTb + x) << sh, yY - 1);
      for (let k = 0; k < unit; k++) {
        const idx = n2 + 1 + x + k;
        av[idx] = a ? 1 : 0;
        if (a) ref[idx] = plane[(yTb - 1) * stride + xTb + x + k];
      }
      if (a) any = true;
    }
    const bitDepth = cIdx ? this.sps.bitDepthC : this.sps.bitDepthY;
    if (!any) {
      ref.fill(1 << (bitDepth - 1), 0, total);
    } else {
      if (!av[0]) {
        let i = 1;
        while (!av[i]) i++;
        ref[0] = ref[i];
      }
      for (let i = 1; i < total; i++) if (!av[i]) ref[i] = ref[i - 1];
    }
    predictIntra(plane, stride, xTb, yTb, log2Size, mode, cIdx === 0, ref, this.refFiltered, this.angularRef, bitDepth, this.sps.strongIntraSmoothing);
  }

  // ---------------------------------------------------------------- residual coding (7.3.8.11)

  private residual(cIdx: number, x0: number, y0: number, log2Size: number, predMode: number): void {
    const { cabac, pps } = this;
    const n = 1 << log2Size;
    const coeffs = this.coeffs;
    coeffs.fill(0, 0, n * n);

    const transformSkip =
      pps.transformSkipEnabled && !this.cuBypass && log2Size <= 2
        ? cabac.decodeBin(CTX.TRANSFORM_SKIP + (cIdx ? 1 : 0))
        : 0;

    // last significant coefficient position
    let ctxOffset: number;
    let ctxShift: number;
    if (cIdx === 0) {
      ctxOffset = 3 * (log2Size - 2) + ((log2Size - 1) >> 2);
      ctxShift = (log2Size + 1) >> 2;
    } else {
      ctxOffset = 15;
      ctxShift = log2Size - 2;
    }
    const cMax = (log2Size << 1) - 1;
    let xPrefix = 0;
    while (xPrefix < cMax && cabac.decodeBin(CTX.LAST_X + ctxOffset + (xPrefix >> ctxShift))) xPrefix++;
    let yPrefix = 0;
    while (yPrefix < cMax && cabac.decodeBin(CTX.LAST_Y + ctxOffset + (yPrefix >> ctxShift))) yPrefix++;
    let lastX = xPrefix;
    let lastY = yPrefix;
    if (xPrefix > 3) {
      const nb = (xPrefix >> 1) - 1;
      lastX = (1 << nb) * (2 + (xPrefix & 1)) + cabac.decodeBypassBits(nb);
    }
    if (yPrefix > 3) {
      const nb = (yPrefix >> 1) - 1;
      lastY = (1 << nb) * (2 + (yPrefix & 1)) + cabac.decodeBypassBits(nb);
    }

    let scanIdx = 0;
    if (log2Size === 2 || (log2Size === 3 && cIdx === 0)) {
      if (predMode >= 6 && predMode <= 14) scanIdx = 2;
      else if (predMode >= 22 && predMode <= 30) scanIdx = 1;
    }
    if (scanIdx === 2) [lastX, lastY] = [lastY, lastX];

    const log2Sb = log2Size - 2;
    const sbWidth = 1 << log2Sb;
    const scanSb = SCAN_ORDER[log2Sb][scanIdx];
    const scanPos = SCAN_ORDER[2][scanIdx];

    // locate the last sub-block / scan position
    let lastSubBlock = (1 << (2 * log2Sb)) - 1;
    let lastScanPos = 16;
    for (;;) {
      if (lastScanPos === 0) {
        lastScanPos = 16;
        lastSubBlock--;
        if (lastSubBlock < 0) throw new HeicDecodeError('invalid last coefficient position');
      }
      lastScanPos--;
      const xC = (scanSb[lastSubBlock * 2] << 2) + scanPos[lastScanPos * 2];
      const yC = (scanSb[lastSubBlock * 2 + 1] << 2) + scanPos[lastScanPos * 2 + 1];
      if (xC === lastX && yC === lastY) break;
    }

    const csbf = this.csbf;
    csbf.fill(0);
    const sigList = this.sigList;
    const g1 = this.g1;
    const ctxSig = CTX.SIG_COEFF + (cIdx ? 27 : 0);
    const signHidingAllowed = pps.signDataHidingEnabled && !this.cuBypass;
    let greater1Ctx = 1;
    let maxX = 0;
    let maxY = 0;

    for (let i = lastSubBlock; i >= 0; i--) {
      const xS = scanSb[i * 2];
      const yS = scanSb[i * 2 + 1];
      let inferSbDc = 0;
      let coded = 1;
      if (i < lastSubBlock && i > 0) {
        let ctx = 0;
        if (xS < sbWidth - 1) ctx += csbf[yS * 8 + xS + 1];
        if (yS < sbWidth - 1) ctx += csbf[(yS + 1) * 8 + xS];
        coded = cabac.decodeBin(CTX.CODED_SUB_BLOCK + (ctx > 0 ? 1 : 0) + (cIdx ? 2 : 0));
        inferSbDc = 1;
      }
      csbf[yS * 8 + xS] = coded;

      let nSig = 0;
      let nStart = 15;
      if (i === lastSubBlock) {
        nStart = lastScanPos - 1;
        sigList[nSig++] = lastScanPos;
      }
      if (coded) {
        let prevCsbf = 0;
        if (xS < sbWidth - 1) prevCsbf += csbf[yS * 8 + xS + 1];
        if (yS < sbWidth - 1) prevCsbf += csbf[(yS + 1) * 8 + xS] << 1;
        for (let p = nStart; p >= 0; p--) {
          const xP = scanPos[p * 2];
          const yP = scanPos[p * 2 + 1];
          if (p > 0 || !inferSbDc) {
            let sigCtx: number;
            if (log2Size === 2) {
              sigCtx = CTX_IDX_MAP_4X4[(yP << 2) + xP];
            } else if (xS === 0 && yS === 0 && xP === 0 && yP === 0) {
              sigCtx = 0;
            } else {
              if (prevCsbf === 0) sigCtx = xP + yP === 0 ? 2 : xP + yP < 3 ? 1 : 0;
              else if (prevCsbf === 1) sigCtx = yP === 0 ? 2 : yP === 1 ? 1 : 0;
              else if (prevCsbf === 2) sigCtx = xP === 0 ? 2 : xP === 1 ? 1 : 0;
              else sigCtx = 2;
              if (cIdx === 0) {
                if (xS > 0 || yS > 0) sigCtx += 3;
                sigCtx += log2Size === 3 ? (scanIdx === 0 ? 9 : 15) : 21;
              } else {
                sigCtx += log2Size === 3 ? 9 : 12;
              }
            }
            if (cabac.decodeBin(ctxSig + sigCtx)) {
              sigList[nSig++] = p;
              inferSbDc = 0;
            }
          } else {
            sigList[nSig++] = 0; // inferred DC
          }
        }
      }
      if (nSig === 0) continue;

      // greater1 / greater2 flags
      let ctxSet = i === 0 || cIdx > 0 ? 0 : 2;
      if (greater1Ctx === 0) ctxSet++;
      greater1Ctx = 1;
      let firstG1 = -1;
      const numG1 = nSig < 8 ? nSig : 8;
      const g1Base = CTX.GREATER1 + (cIdx ? 16 : 0) + ctxSet * 4;
      for (let m = 0; m < numG1; m++) {
        const flag = cabac.decodeBin(g1Base + greater1Ctx);
        g1[m] = flag;
        if (flag) {
          greater1Ctx = 0;
          if (firstG1 < 0) firstG1 = m;
        } else if (greater1Ctx > 0 && greater1Ctx < 3) {
          greater1Ctx++;
        }
      }
      let g2 = 0;
      if (firstG1 >= 0) g2 = cabac.decodeBin(CTX.GREATER2 + (cIdx ? 4 : 0) + ctxSet);

      const signHidden = signHidingAllowed && sigList[0] - sigList[nSig - 1] > 3;
      const nSigns = signHidden ? nSig - 1 : nSig;
      const signs = cabac.decodeBypassBits(nSigns) << (32 - nSigns);

      let sumAbs = 0;
      let rice = 0;
      for (let m = 0; m < nSig; m++) {
        const base = 1 + (m < 8 ? g1[m] + (m === firstG1 ? g2 : 0) : 0);
        let absLevel = base;
        if (base === (m < 8 ? (m === firstG1 ? 3 : 2) : 1)) {
          absLevel = base + this.decodeAbsLevelRemaining(rice);
          if (absLevel > 3 * (1 << rice) && rice < 4) rice++;
        }
        let level = (signs << m) < 0 && m < nSigns ? -absLevel : absLevel;
        if (signHidden) {
          sumAbs += absLevel;
          if (m === nSig - 1 && sumAbs & 1) level = -level;
        }
        const p = sigList[m];
        const xC = (xS << 2) + scanPos[p * 2];
        const yC = (yS << 2) + scanPos[p * 2 + 1];
        coeffs[yC * n + xC] = level;
        if (xC > maxX) maxX = xC;
        if (yC > maxY) maxY = yC;
      }
    }

    // reconstruction
    const isLumaComp = cIdx === 0;
    const bitDepth = isLumaComp ? this.sps.bitDepthY : this.sps.bitDepthC;
    let qp: number;
    if (isLumaComp) {
      qp = this.qpY + this.qpBdOffsetY;
    } else {
      const offset = cIdx === 1 ? pps.cbQpOffset + this.sh.cbQpOffset : pps.crQpOffset + this.sh.crQpOffset;
      const qPi = Math.min(Math.max(this.qpY + offset, -this.qpBdOffsetC), 57);
      qp = chromaQpMapping(qPi) + this.qpBdOffsetC;
    }
    const factors = pps.scalingFactors ?? this.sps.scalingFactors;
    addResidual(this.planes[cIdx], cIdx ? this.cStride : this.stride, x0, y0, coeffs, this.tmp, {
      log2Size,
      qp,
      bitDepth,
      transformSkip: !!transformSkip,
      transquantBypass: !!this.cuBypass,
      useDst: isLumaComp && log2Size === 2,
      scaling: this.sps.scalingListEnabled && factors ? factors[log2Size - 2][cIdx] : null,
      maxX: transformSkip || this.cuBypass ? n - 1 : maxX,
      maxY: transformSkip || this.cuBypass ? n - 1 : maxY,
    });
  }

  /** coeff_abs_level_remaining (9.3.3.11). */
  private decodeAbsLevelRemaining(rice: number): number {
    const cabac = this.cabac;
    let prefix = 0;
    while (prefix < 32 && cabac.decodeBypass()) prefix++;
    if (prefix <= 3) return (prefix << rice) + cabac.decodeBypassBits(rice);
    const extra = prefix - 3;
    // value = ((2^extra + 2) << rice) + suffix, kept in float range for long prefixes
    return ((2 ** extra) + 2) * (1 << rice) + cabac.decodeBypassBits(extra + rice);
  }

  // ---------------------------------------------------------------- picture output

  finish(): DecodedPicture {
    if (this.decodedCtbs < this.numCtbs) throw new HeicDecodeError('incomplete picture');
    applyDeblocking(this);
    if (this.anySao && this.sps.saoEnabled) applySao(this);
    return this.crop();
  }

  private crop(): DecodedPicture {
    const { sps } = this;
    const sub = this.chromaArrayType === 1 ? 2 : 1;
    const left = sps.confWin.left * sub;
    const top = sps.confWin.top * sub;
    const width = this.width - (sps.confWin.left + sps.confWin.right) * sub;
    const height = this.height - (sps.confWin.top + sps.confWin.bottom) * sub;
    if (width <= 0 || height <= 0) throw new HeicDecodeError('invalid conformance window');
    const cropPlane = (src: Plane, srcStride: number, x: number, y: number, w: number, h: number): Plane => {
      if (x === 0 && y === 0 && w === srcStride && src.length === w * h) return src;
      const out = src instanceof Uint16Array ? new Uint16Array(w * h) : new Uint8Array(w * h);
      for (let r = 0; r < h; r++) out.set(src.subarray((y + r) * srcStride + x, (y + r) * srcStride + x + w), r * w);
      return out;
    };
    const Y = cropPlane(this.planes[0], this.stride, left, top, width, height);
    let cw = 0;
    let ch = 0;
    let Cb: Plane = new Uint8Array(0);
    let Cr: Plane = new Uint8Array(0);
    if (this.chromaArrayType === 1) {
      cw = width >> 1;
      ch = height >> 1;
      Cb = cropPlane(this.planes[1], this.cStride, left >> 1, top >> 1, cw, ch);
      Cr = cropPlane(this.planes[2], this.cStride, left >> 1, top >> 1, cw, ch);
    }
    return {
      width,
      height,
      chromaFormatIdc: this.chromaArrayType,
      bitDepthY: sps.bitDepthY,
      bitDepthC: sps.bitDepthC,
      planes: [Y, Cb, Cr],
      chromaWidth: cw,
      chromaHeight: ch,
    };
  }
}

function skipStRps(r: BitReader, sps: Sps): void {
  // st_ref_pic_set(num_short_term_ref_pic_sets) inside a slice header
  const idx = sps.numShortTermRefPicSets;
  const interPred = idx !== 0 ? r.u1() : 0;
  if (interPred) {
    const deltaIdx = r.ue() + 1;
    r.u1();
    r.ue();
    const ref = sps.stRps[idx - deltaIdx];
    if (!ref) throw new HeicDecodeError('invalid short-term RPS reference');
    for (let j = 0; j <= ref.numNegative + ref.numPositive; j++) {
      if (!r.u1()) r.u1();
    }
    return;
  }
  const neg = r.ue();
  const pos = r.ue();
  for (let i = 0; i < neg + pos; i++) {
    r.ue();
    r.u1();
  }
}
