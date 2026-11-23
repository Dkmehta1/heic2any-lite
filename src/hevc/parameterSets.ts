import { HeicDecodeError } from '../errors';
import { BitReader, unescapeRbsp } from './bitReader';
import { DEFAULT_SCALING_INTER, DEFAULT_SCALING_INTRA, SCAN_ORDER } from './tables';

export interface ShortTermRps {
  numNegative: number;
  numPositive: number;
  deltaPocS0: number[];
  deltaPocS1: number[];
}

/**
 * Scaling factors per sizeId (0..3 => 4x4..32x32) and matrixId (0..5),
 * each stored row-major as m[y * size + x].
 */
export type ScalingFactors = Uint8Array[][];

export interface Sps {
  id: number;
  chromaFormatIdc: number;
  width: number;
  height: number;
  confWin: { left: number; right: number; top: number; bottom: number };
  bitDepthY: number;
  bitDepthC: number;
  log2MaxPocLsb: number;
  log2MinCbSize: number;
  log2CtbSize: number;
  log2MinTbSize: number;
  log2MaxTbSize: number;
  maxTransformHierarchyDepthIntra: number;
  scalingListEnabled: boolean;
  scalingFactors: ScalingFactors | null;
  saoEnabled: boolean;
  pcmEnabled: boolean;
  pcmBitDepthY: number;
  pcmBitDepthC: number;
  log2MinPcmCbSize: number;
  log2MaxPcmCbSize: number;
  pcmLoopFilterDisabled: boolean;
  numShortTermRefPicSets: number;
  stRps: ShortTermRps[];
  longTermRefPicsPresent: boolean;
  numLongTermRefPicsSps: number;
  temporalMvpEnabled: boolean;
  strongIntraSmoothing: boolean;
  /** Derived sizes. */
  picWidthInCtbs: number;
  picHeightInCtbs: number;
}

export interface Pps {
  id: number;
  spsId: number;
  dependentSliceSegmentsEnabled: boolean;
  outputFlagPresent: boolean;
  numExtraSliceHeaderBits: number;
  signDataHidingEnabled: boolean;
  cabacInitPresent: boolean;
  initQp: number;
  constrainedIntraPred: boolean;
  transformSkipEnabled: boolean;
  cuQpDeltaEnabled: boolean;
  diffCuQpDeltaDepth: number;
  cbQpOffset: number;
  crQpOffset: number;
  sliceChromaQpOffsetsPresent: boolean;
  transquantBypassEnabled: boolean;
  tilesEnabled: boolean;
  entropyCodingSyncEnabled: boolean;
  numTileColumns: number;
  numTileRows: number;
  uniformSpacing: boolean;
  columnWidths: number[];
  rowHeights: number[];
  loopFilterAcrossTiles: boolean;
  loopFilterAcrossSlices: boolean;
  deblockingOverrideEnabled: boolean;
  deblockingDisabled: boolean;
  betaOffsetDiv2: number;
  tcOffsetDiv2: number;
  scalingFactors: ScalingFactors | null;
  listsModificationPresent: boolean;
  sliceHeaderExtensionPresent: boolean;
}

function unsupported(feature: string): never {
  throw new HeicDecodeError(`unsupported HEVC feature: ${feature}`);
}

function profileTierLevel(r: BitReader, maxSubLayersMinus1: number): void {
  r.skip(96); // general profile/tier/level: 2+1+5+32+4+43+1+8 bits
  const profilePresent: number[] = [];
  const levelPresent: number[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profilePresent.push(r.u1());
    levelPresent.push(r.u1());
  }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.skip(2);
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (profilePresent[i]) r.skip(88);
    if (levelPresent[i]) r.skip(8);
  }
}

function parseScalingListData(r: BitReader): ScalingFactors {
  // ScalingList[sizeId][matrixId][i] and DC coefficients for sizeId 2/3.
  const lists: Uint8Array[][] = [];
  const dc: number[][] = [];
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    lists.push([]);
    dc.push([]);
    const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)));
    for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
      const list = new Uint8Array(coefNum);
      const predModeFlag = r.u1();
      if (!predModeFlag) {
        const delta = r.ue();
        if (delta === 0) {
          if (sizeId === 0) list.fill(16);
          else list.set(matrixId < 3 ? DEFAULT_SCALING_INTRA : DEFAULT_SCALING_INTER);
          dc[sizeId][matrixId] = 16;
        } else {
          const refMatrixId = matrixId - delta * (sizeId === 3 ? 3 : 1);
          list.set(lists[sizeId][refMatrixId]);
          dc[sizeId][matrixId] = dc[sizeId][refMatrixId];
        }
      } else {
        let nextCoef = 8;
        if (sizeId > 1) {
          nextCoef = r.se() + 8;
          dc[sizeId][matrixId] = nextCoef;
        }
        for (let i = 0; i < coefNum; i++) {
          nextCoef = (nextCoef + r.se() + 256) % 256;
          list[i] = nextCoef;
        }
        if (sizeId <= 1) dc[sizeId][matrixId] = list[0];
      }
      lists[sizeId][matrixId] = list;
    }
  }
  return buildScalingFactors(lists, dc);
}

export function defaultScalingFactors(): ScalingFactors {
  const lists: Uint8Array[][] = [];
  const dc: number[][] = [];
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    lists.push([]);
    dc.push([]);
    for (let matrixId = 0; matrixId < 6; matrixId++) {
      if (sizeId === 0) lists[sizeId][matrixId] = new Uint8Array(16).fill(16);
      else lists[sizeId][matrixId] = (matrixId < 3 ? DEFAULT_SCALING_INTRA : DEFAULT_SCALING_INTER).slice();
      dc[sizeId][matrixId] = 16;
    }
  }
  return buildScalingFactors(lists, dc);
}

/** H.265 7.4.5: expand coded scaling lists into per-position factors. */
function buildScalingFactors(lists: Uint8Array[][], dc: number[][]): ScalingFactors {
  const out: ScalingFactors = [];
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    out.push([]);
    const size = 4 << sizeId;
    for (let matrixId = 0; matrixId < 6; matrixId++) {
      // 32x32 chroma matrices are not coded in 4:2:0; reuse the luma one of the same pred mode.
      const src = lists[sizeId][matrixId] ?? lists[sizeId][matrixId < 3 ? 0 : 3];
      const m = new Uint8Array(size * size);
      if (sizeId === 0) {
        const scan = SCAN_ORDER[2][0];
        for (let i = 0; i < 16; i++) m[scan[i * 2 + 1] * 4 + scan[i * 2]] = src[i];
      } else {
        const scan = SCAN_ORDER[3][0];
        const rep = size >> 3;
        for (let i = 0; i < 64; i++) {
          const x = scan[i * 2];
          const y = scan[i * 2 + 1];
          for (let j = 0; j < rep; j++) {
            for (let k = 0; k < rep; k++) m[(y * rep + j) * size + x * rep + k] = src[i];
          }
        }
        if (sizeId > 1) m[0] = dc[sizeId][matrixId] ?? dc[sizeId][matrixId < 3 ? 0 : 3];
      }
      out[sizeId][matrixId] = m;
    }
  }
  return out;
}

function parseStRps(r: BitReader, idx: number, num: number, sets: ShortTermRps[]): ShortTermRps {
  const interPred = idx !== 0 ? r.u1() : 0;
  if (interPred) {
    const deltaIdxMinus1 = idx === num ? r.ue() : 0;
    const sign = r.u1();
    const absDelta = r.ue() + 1;
    const deltaRps = (1 - 2 * sign) * absDelta;
    const ref = sets[idx - (deltaIdxMinus1 + 1)];
    if (!ref) throw new HeicDecodeError('invalid short-term RPS reference');
    const numDelta = ref.numNegative + ref.numPositive;
    const used: number[] = [];
    const useDelta: number[] = [];
    for (let j = 0; j <= numDelta; j++) {
      used[j] = r.u1();
      useDelta[j] = used[j] ? 1 : r.u1();
    }
    const s0: number[] = [];
    const s1: number[] = [];
    for (let j = ref.numPositive - 1; j >= 0; j--) {
      const d = ref.deltaPocS1[j] + deltaRps;
      if (d < 0 && useDelta[ref.numNegative + j]) s0.push(d);
    }
    if (deltaRps < 0 && useDelta[numDelta]) s0.push(deltaRps);
    for (let j = 0; j < ref.numNegative; j++) {
      const d = ref.deltaPocS0[j] + deltaRps;
      if (d < 0 && useDelta[j]) s0.push(d);
    }
    for (let j = ref.numNegative - 1; j >= 0; j--) {
      const d = ref.deltaPocS0[j] + deltaRps;
      if (d > 0 && useDelta[j]) s1.push(d);
    }
    if (deltaRps > 0 && useDelta[numDelta]) s1.push(deltaRps);
    for (let j = 0; j < ref.numPositive; j++) {
      const d = ref.deltaPocS1[j] + deltaRps;
      if (d > 0 && useDelta[ref.numNegative + j]) s1.push(d);
    }
    return { numNegative: s0.length, numPositive: s1.length, deltaPocS0: s0, deltaPocS1: s1 };
  }
  const numNegative = r.ue();
  const numPositive = r.ue();
  if (numNegative > 16 || numPositive > 16) throw new HeicDecodeError('invalid short-term RPS');
  const s0: number[] = [];
  const s1: number[] = [];
  let poc = 0;
  for (let i = 0; i < numNegative; i++) {
    poc -= r.ue() + 1;
    r.u1();
    s0.push(poc);
  }
  poc = 0;
  for (let i = 0; i < numPositive; i++) {
    poc += r.ue() + 1;
    r.u1();
    s1.push(poc);
  }
  return { numNegative, numPositive, deltaPocS0: s0, deltaPocS1: s1 };
}

function subLayerHrd(r: BitReader, cpbCnt: number, subPicParams: number): void {
  for (let i = 0; i <= cpbCnt; i++) {
    r.ue();
    r.ue();
    if (subPicParams) {
      r.ue();
      r.ue();
    }
    r.u1();
  }
}

function hrdParameters(r: BitReader, commonInf: boolean, maxSubLayersMinus1: number): void {
  let nal = 0;
  let vcl = 0;
  let subPic = 0;
  if (commonInf) {
    nal = r.u1();
    vcl = r.u1();
    if (nal || vcl) {
      subPic = r.u1();
      if (subPic) r.skip(8 + 5 + 1 + 5);
      r.skip(4 + 4);
      if (subPic) r.skip(4);
      r.skip(5 + 5 + 5);
    }
  }
  for (let i = 0; i <= maxSubLayersMinus1; i++) {
    const fixedGeneral = r.u1();
    const fixedWithinCvs = fixedGeneral ? 1 : r.u1();
    let lowDelay = 0;
    if (fixedWithinCvs) r.ue();
    else lowDelay = r.u1();
    const cpbCnt = lowDelay ? 0 : r.ue();
    if (nal) subLayerHrd(r, cpbCnt, subPic);
    if (vcl) subLayerHrd(r, cpbCnt, subPic);
  }
}

function vuiParameters(r: BitReader, maxSubLayersMinus1: number): void {
  if (r.u1()) {
    if (r.u(8) === 255) r.skip(32);
  }
  if (r.u1()) r.u1();
  if (r.u1()) {
    r.skip(3 + 1);
    if (r.u1()) r.skip(24);
  }
  if (r.u1()) {
    r.ue();
    r.ue();
  }
  r.skip(3); // neutral_chroma_indication, field_seq, frame_field_info_present
  if (r.u1()) {
    r.ue();
    r.ue();
    r.ue();
    r.ue();
  }
  if (r.u1()) {
    r.skip(64);
    if (r.u1()) r.ue();
    if (r.u1()) hrdParameters(r, true, maxSubLayersMinus1);
  }
  if (r.u1()) {
    r.skip(3);
    r.ue();
    r.ue();
    r.ue();
    r.ue();
    r.ue();
  }
}

/** Parses a seq_parameter_set_rbsp. `nal` is the complete NAL unit including its 2-byte header. */
export function parseSps(nal: Uint8Array): Sps {
  const r = new BitReader(unescapeRbsp(nal), 2);
  r.skip(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.u(3);
  r.u1();
  profileTierLevel(r, maxSubLayersMinus1);
  const id = r.ue();
  const chromaFormatIdc = r.ue();
  if (chromaFormatIdc === 3 && r.u1()) unsupported('separate colour planes');
  if (chromaFormatIdc !== 0 && chromaFormatIdc !== 1) unsupported(`chroma format ${chromaFormatIdc}`);
  const width = r.ue();
  const height = r.ue();
  const confWin = { left: 0, right: 0, top: 0, bottom: 0 };
  if (r.u1()) {
    confWin.left = r.ue();
    confWin.right = r.ue();
    confWin.top = r.ue();
    confWin.bottom = r.ue();
  }
  const bitDepthY = r.ue() + 8;
  const bitDepthC = r.ue() + 8;
  if (bitDepthY > 12 || bitDepthC > 12) unsupported('bit depth above 12');
  const log2MaxPocLsb = r.ue() + 4;
  const subLayerOrderingInfo = r.u1();
  for (let i = subLayerOrderingInfo ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
    r.ue();
    r.ue();
    r.ue();
  }
  const log2MinCbSize = r.ue() + 3;
  const log2CtbSize = log2MinCbSize + r.ue();
  const log2MinTbSize = r.ue() + 2;
  const log2MaxTbSize = log2MinTbSize + r.ue();
  r.ue(); // max_transform_hierarchy_depth_inter
  const maxTransformHierarchyDepthIntra = r.ue();
  if (log2CtbSize > 6 || log2CtbSize < 4 || log2MaxTbSize > 5 || log2MinTbSize >= log2MinCbSize) {
    throw new HeicDecodeError('invalid block sizes in SPS');
  }
  const scalingListEnabled = !!r.u1();
  let scalingFactors: ScalingFactors | null = null;
  if (scalingListEnabled) {
    scalingFactors = r.u1() ? parseScalingListData(r) : defaultScalingFactors();
  }
  r.u1(); // amp_enabled_flag
  const saoEnabled = !!r.u1();
  const pcmEnabled = !!r.u1();
  let pcmBitDepthY = 8;
  let pcmBitDepthC = 8;
  let log2MinPcmCbSize = 0;
  let log2MaxPcmCbSize = 0;
  let pcmLoopFilterDisabled = false;
  if (pcmEnabled) {
    pcmBitDepthY = r.u(4) + 1;
    pcmBitDepthC = r.u(4) + 1;
    log2MinPcmCbSize = r.ue() + 3;
    log2MaxPcmCbSize = log2MinPcmCbSize + r.ue();
    pcmLoopFilterDisabled = !!r.u1();
  }
  const numShortTermRefPicSets = r.ue();
  if (numShortTermRefPicSets > 64) throw new HeicDecodeError('invalid RPS count');
  const stRps: ShortTermRps[] = [];
  for (let i = 0; i < numShortTermRefPicSets; i++) {
    stRps.push(parseStRps(r, i, numShortTermRefPicSets, stRps));
  }
  const longTermRefPicsPresent = !!r.u1();
  let numLongTermRefPicsSps = 0;
  if (longTermRefPicsPresent) {
    numLongTermRefPicsSps = r.ue();
    for (let i = 0; i < numLongTermRefPicsSps; i++) {
      r.skip(log2MaxPocLsb);
      r.u1();
    }
  }
  const temporalMvpEnabled = !!r.u1();
  const strongIntraSmoothing = !!r.u1();
  if (r.u1()) vuiParameters(r, maxSubLayersMinus1);
  if (r.u1()) {
    const rangeExt = r.u1();
    r.skip(7); // multilayer, 3d, scc, 4bits
    if (rangeExt) {
      // transform_skip_rotation, transform_skip_context, implicit_rdpcm, explicit_rdpcm,
      // extended_precision, intra_smoothing_disabled, high_precision_offsets,
      // persistent_rice_adaptation, cabac_bypass_alignment
      for (let i = 0; i < 9; i++) if (r.u1()) unsupported('range extension coding tools');
    }
  }
  const ctb = 1 << log2CtbSize;
  return {
    id,
    chromaFormatIdc,
    width,
    height,
    confWin,
    bitDepthY,
    bitDepthC,
    log2MaxPocLsb,
    log2MinCbSize,
    log2CtbSize,
    log2MinTbSize,
    log2MaxTbSize,
    maxTransformHierarchyDepthIntra,
    scalingListEnabled,
    scalingFactors,
    saoEnabled,
    pcmEnabled,
    pcmBitDepthY,
    pcmBitDepthC,
    log2MinPcmCbSize,
    log2MaxPcmCbSize,
    pcmLoopFilterDisabled,
    numShortTermRefPicSets,
    stRps,
    longTermRefPicsPresent,
    numLongTermRefPicsSps,
    temporalMvpEnabled,
    strongIntraSmoothing,
    picWidthInCtbs: Math.ceil(width / ctb),
    picHeightInCtbs: Math.ceil(height / ctb),
  };
}

/** Parses a pic_parameter_set_rbsp. `nal` is the complete NAL unit including its 2-byte header. */
export function parsePps(nal: Uint8Array): Pps {
  const r = new BitReader(unescapeRbsp(nal), 2);
  const id = r.ue();
  const spsId = r.ue();
  const dependentSliceSegmentsEnabled = !!r.u1();
  const outputFlagPresent = !!r.u1();
  const numExtraSliceHeaderBits = r.u(3);
  const signDataHidingEnabled = !!r.u1();
  const cabacInitPresent = !!r.u1();
  r.ue();
  r.ue();
  const initQp = 26 + r.se();
  const constrainedIntraPred = !!r.u1();
  const transformSkipEnabled = !!r.u1();
  const cuQpDeltaEnabled = !!r.u1();
  const diffCuQpDeltaDepth = cuQpDeltaEnabled ? r.ue() : 0;
  const cbQpOffset = r.se();
  const crQpOffset = r.se();
  const sliceChromaQpOffsetsPresent = !!r.u1();
  r.u1(); // weighted_pred_flag
  r.u1(); // weighted_bipred_flag
  const transquantBypassEnabled = !!r.u1();
  const tilesEnabled = !!r.u1();
  const entropyCodingSyncEnabled = !!r.u1();
  let numTileColumns = 1;
  let numTileRows = 1;
  let uniformSpacing = true;
  const columnWidths: number[] = [];
  const rowHeights: number[] = [];
  let loopFilterAcrossTiles = true;
  if (tilesEnabled) {
    numTileColumns = r.ue() + 1;
    numTileRows = r.ue() + 1;
    uniformSpacing = !!r.u1();
    if (!uniformSpacing) {
      for (let i = 0; i < numTileColumns - 1; i++) columnWidths.push(r.ue() + 1);
      for (let i = 0; i < numTileRows - 1; i++) rowHeights.push(r.ue() + 1);
    }
    loopFilterAcrossTiles = !!r.u1();
  }
  const loopFilterAcrossSlices = !!r.u1();
  let deblockingOverrideEnabled = false;
  let deblockingDisabled = false;
  let betaOffsetDiv2 = 0;
  let tcOffsetDiv2 = 0;
  if (r.u1()) {
    deblockingOverrideEnabled = !!r.u1();
    deblockingDisabled = !!r.u1();
    if (!deblockingDisabled) {
      betaOffsetDiv2 = r.se();
      tcOffsetDiv2 = r.se();
    }
  }
  const scalingFactors = r.u1() ? parseScalingListData(r) : null;
  const listsModificationPresent = !!r.u1();
  r.ue(); // log2_parallel_merge_level_minus2
  const sliceHeaderExtensionPresent = !!r.u1();
  if (r.u1()) {
    const rangeExt = r.u1();
    r.skip(7);
    if (rangeExt) {
      if (transformSkipEnabled && r.ue() !== 0) unsupported('transform skip above 4x4');
      if (r.u1()) unsupported('cross-component prediction');
      if (r.u1()) unsupported('chroma QP offset lists');
      if (r.ue() !== 0 || r.ue() !== 0) unsupported('SAO offset scaling');
    }
  }
  return {
    id,
    spsId,
    dependentSliceSegmentsEnabled,
    outputFlagPresent,
    numExtraSliceHeaderBits,
    signDataHidingEnabled,
    cabacInitPresent,
    initQp,
    constrainedIntraPred,
    transformSkipEnabled,
    cuQpDeltaEnabled,
    diffCuQpDeltaDepth,
    cbQpOffset,
    crQpOffset,
    sliceChromaQpOffsetsPresent,
    transquantBypassEnabled,
    tilesEnabled,
    entropyCodingSyncEnabled,
    numTileColumns,
    numTileRows,
    uniformSpacing,
    columnWidths,
    rowHeights,
    loopFilterAcrossTiles,
    loopFilterAcrossSlices,
    deblockingOverrideEnabled,
    deblockingDisabled,
    betaOffsetDiv2,
    tcOffsetDiv2,
    scalingFactors,
    listsModificationPresent,
    sliceHeaderExtensionPresent,
  };
}

/** HEVCDecoderConfigurationRecord ('hvcC'): NAL unit length size and parameter-set NAL units. */
export interface HvcConfig {
  lengthSize: number;
  nalUnits: Uint8Array[];
}

export function parseHvcC(data: Uint8Array): HvcConfig {
  if (data.length < 23) throw new HeicDecodeError('truncated hvcC');
  const lengthSize = (data[21] & 3) + 1;
  const numArrays = data[22];
  const nalUnits: Uint8Array[] = [];
  let p = 23;
  for (let i = 0; i < numArrays; i++) {
    if (p + 3 > data.length) throw new HeicDecodeError('truncated hvcC');
    const numNalus = (data[p + 1] << 8) | data[p + 2];
    p += 3;
    for (let j = 0; j < numNalus; j++) {
      const len = (data[p] << 8) | data[p + 1];
      p += 2;
      if (p + len > data.length) throw new HeicDecodeError('truncated hvcC');
      nalUnits.push(data.subarray(p, p + len));
      p += len;
    }
  }
  return { lengthSize, nalUnits };
}
