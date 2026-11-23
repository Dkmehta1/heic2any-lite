import { RANGE_TAB_LPS, RENORM_TABLE, TRANS_IDX_LPS, TRANS_IDX_MPS } from './tables';

/** Context index offsets. Only syntax elements that occur in intra (I) slices are needed. */
export const CTX = {
  SAO_MERGE: 0,
  SAO_TYPE: 1,
  SPLIT_CU: 2, // 3
  TRANSQUANT_BYPASS: 5,
  PART_MODE: 6,
  PREV_INTRA_LUMA: 7,
  INTRA_CHROMA: 8,
  SPLIT_TRANSFORM: 9, // 3
  CBF_LUMA: 12, // 2
  CBF_CHROMA: 14, // 5
  CU_QP_DELTA: 19, // 2
  TRANSFORM_SKIP: 21, // 2 (luma, chroma)
  LAST_X: 23, // 18
  LAST_Y: 41, // 18
  CODED_SUB_BLOCK: 59, // 4
  SIG_COEFF: 63, // 44
  GREATER1: 107, // 24
  GREATER2: 131, // 6
  COUNT: 137,
} as const;

/** initValue for initType 0 (I slices), in CTX order (H.265 Tables 9-5 .. 9-37). */
const INIT_VALUES_I = new Uint8Array([
  153, // sao_merge_left/up_flag
  200, // sao_type_idx
  139, 141, 157, // split_cu_flag
  154, // cu_transquant_bypass_flag
  184, // part_mode
  184, // prev_intra_luma_pred_flag
  63, // intra_chroma_pred_mode
  153, 138, 138, // split_transform_flag
  111, 141, // cbf_luma
  94, 138, 182, 154, 154, // cbf_cb / cbf_cr
  154, 154, // cu_qp_delta_abs
  139, 139, // transform_skip_flag
  110, 110, 124, 125, 140, 153, 125, 127, 140, 109, 111, 143, 127, 111, 79, 108, 123, 63, // last_x_prefix
  110, 110, 124, 125, 140, 153, 125, 127, 140, 109, 111, 143, 127, 111, 79, 108, 123, 63, // last_y_prefix
  91, 171, 134, 141, // coded_sub_block_flag
  111, 111, 125, 110, 110, 94, 124, 108, 124, 107, 125, 141, 179, 153, 125, 107, // sig_coeff_flag
  125, 141, 179, 153, 125, 107, 125, 141, 179, 153, 125, 140, 139, 182, 182, 152,
  136, 152, 136, 153, 136, 139, 111, 136, 139, 111, 141, 111,
  140, 92, 137, 138, 140, 152, 138, 139, 153, 74, 149, 92, 139, 107, 122, 152, // greater1
  140, 179, 166, 182, 140, 227, 122, 197,
  138, 153, 136, 167, 152, 152, // greater2
]);

/** CABAC arithmetic decoding engine (H.265 9.3.4.3), byte-wise with up to 7 look-ahead bits. */
export class CabacDecoder {
  /** Context state per context: (pStateIdx << 1) | valMps. */
  readonly ctx = new Uint8Array(CTX.COUNT);
  data: Uint8Array = new Uint8Array(0);
  pos = 0;
  end = 0;
  private range = 510;
  private value = 0;
  private bitsNeeded = -8;

  /** 9.3.2.2: initialise all context variables for the given SliceQpY. */
  initContexts(sliceQpY: number): void {
    const qp = Math.min(Math.max(sliceQpY, 0), 51);
    for (let i = 0; i < CTX.COUNT; i++) {
      const initValue = INIT_VALUES_I[i];
      const m = (initValue >> 4) * 5 - 45;
      const n = ((initValue & 15) << 3) - 16;
      const pre = Math.min(Math.max(((m * qp) >> 4) + n, 1), 126);
      const mps = pre <= 63 ? 0 : 1;
      this.ctx[i] = ((mps ? pre - 64 : 63 - pre) << 1) | mps;
    }
  }

  setData(data: Uint8Array, start: number, end: number): void {
    this.data = data;
    this.pos = start;
    this.end = end;
    this.initEngine();
  }

  /** 9.3.2.5: (re)initialise the arithmetic decoding engine at the current byte position. */
  initEngine(): void {
    this.range = 510;
    this.bitsNeeded = 8;
    this.value = 0;
    if (this.pos < this.end) {
      this.value = this.data[this.pos++] << 8;
      this.bitsNeeded -= 8;
    }
    if (this.pos < this.end) {
      this.value |= this.data[this.pos++];
      this.bitsNeeded -= 8;
    }
  }

  decodeBin(ctxIdx: number): number {
    const s = this.ctx[ctxIdx];
    const state = s >> 1;
    const mps = s & 1;
    const lps = RANGE_TAB_LPS[(state << 2) + ((this.range >> 6) & 3)];
    this.range -= lps;
    const scaledRange = this.range << 7;
    if (this.value < scaledRange) {
      this.ctx[ctxIdx] = (TRANS_IDX_MPS[state] << 1) | mps;
      if (scaledRange < 256 << 7) {
        this.range = scaledRange >> 6;
        this.value <<= 1;
        if (++this.bitsNeeded === 0) {
          this.bitsNeeded = -8;
          if (this.pos < this.end) this.value |= this.data[this.pos++];
        }
      }
      return mps;
    }
    this.value -= scaledRange;
    const numBits = RENORM_TABLE[lps >> 3];
    this.value <<= numBits;
    this.range = lps << numBits;
    this.ctx[ctxIdx] = (TRANS_IDX_LPS[state] << 1) | (state === 0 ? 1 - mps : mps);
    this.bitsNeeded += numBits;
    if (this.bitsNeeded >= 0) {
      if (this.pos < this.end) this.value |= this.data[this.pos++] << this.bitsNeeded;
      this.bitsNeeded -= 8;
    }
    return 1 - mps;
  }

  decodeBypass(): number {
    this.value <<= 1;
    if (++this.bitsNeeded >= 0) {
      this.bitsNeeded = -8;
      if (this.pos < this.end) this.value |= this.data[this.pos++];
    }
    const scaledRange = this.range << 7;
    if (this.value >= scaledRange) {
      this.value -= scaledRange;
      return 1;
    }
    return 0;
  }

  decodeBypassBits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.decodeBypass();
    return v;
  }

  /** decode_terminate (end_of_slice_segment_flag, end_of_subset_one_bit, pcm_flag). */
  decodeTerminate(): number {
    this.range -= 2;
    const scaledRange = this.range << 7;
    if (this.value >= scaledRange) return 1;
    if (scaledRange < 256 << 7) {
      this.range = scaledRange >> 6;
      this.value <<= 1;
      if (++this.bitsNeeded === 0) {
        this.bitsNeeded = -8;
        if (this.pos < this.end) this.value |= this.data[this.pos++];
      }
    }
    return 0;
  }
}
