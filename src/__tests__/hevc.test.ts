import { createHash } from 'crypto';
import { getItemData, getItemProperties, parseHeif } from '../heif/heifFile';
import { BitReader, unescapeRbsp } from '../hevc/bitReader';
import { decodeHevcPicture } from '../hevc/decoder';
import { parseHvcC, parsePps, parseSps } from '../hevc/parameterSets';
import { DCT_MATRIX, DST_MATRIX, SCAN_ORDER, chromaQpMapping } from '../hevc/tables';
import { addResidual } from '../hevc/transform';
import { loadSample } from '../__fixtures__/heifBuilder';

const sha256 = (data: ArrayLike<number>): string =>
  createHash('sha256').update(Buffer.from(data as Uint8Array)).digest('hex');

function sampleNals(): Uint8Array[] {
  const file = parseHeif(loadSample());
  const id = file.items[0].id;
  const hvcC = getItemProperties(file, id).find((p) => p.type === 'hvcC')!;
  const config = parseHvcC(file.data.subarray(hvcC.start, hvcC.end));
  const data = getItemData(file, id);
  const nals = [...config.nalUnits];
  for (let p = 0; p < data.length; ) {
    let len = 0;
    for (let i = 0; i < config.lengthSize; i++) len = len * 256 + data[p + i];
    p += config.lengthSize;
    nals.push(data.subarray(p, p + len));
    p += len;
  }
  return nals;
}

describe('BitReader', () => {
  it('reads fixed-length and Exp-Golomb codes', () => {
    // 1 | 010 | 011 | 00100 | 00101 | 1  -> u1=1, ue=1, ue=2, ue=3, se(ue=4) = -2, u1 = 1
    const r = new BitReader(Uint8Array.from([0b10100110, 0b01000010, 0b11000000]));
    expect(r.u1()).toBe(1);
    expect(r.ue()).toBe(1);
    expect(r.ue()).toBe(2);
    expect(r.ue()).toBe(3);
    expect(r.se()).toBe(-2);
    expect(r.u1()).toBe(1);
  });

  it('throws on overrun instead of reading garbage', () => {
    const r = new BitReader(Uint8Array.from([0xff]));
    r.u(8);
    expect(() => r.u1()).toThrow('bitstream overrun');
  });

  it('removes emulation prevention bytes', () => {
    expect([...unescapeRbsp(Uint8Array.from([1, 0, 0, 3, 1, 0, 0, 3, 0, 0, 3]))]).toEqual([1, 0, 0, 1, 0, 0, 0, 0]);
    const clean = Uint8Array.from([1, 2, 3]);
    expect(unescapeRbsp(clean)).toBe(clean);
  });
});

describe('spec tables', () => {
  it('generates the HEVC 4-point and 8-point DCT bases from the 32-point matrix', () => {
    const row = (k: number, n: number): number[] =>
      Array.from({ length: n }, (_, i) => DCT_MATRIX[k * (32 / n) * 32 + i]);
    expect(row(0, 4)).toEqual([64, 64, 64, 64]);
    expect(row(1, 4)).toEqual([83, 36, -36, -83]);
    expect(row(2, 4)).toEqual([64, -64, -64, 64]);
    expect(row(3, 4)).toEqual([36, -83, 83, -36]);
    expect(row(1, 8)).toEqual([89, 75, 50, 18, -18, -50, -75, -89]);
    expect(row(3, 8)).toEqual([75, -18, -89, -50, 50, 89, 18, -75]);
    expect(Array.from({ length: 16 }, (_, i) => DCT_MATRIX[32 + i])).toEqual([
      90, 90, 88, 85, 82, 78, 73, 67, 61, 54, 46, 38, 31, 22, 13, 4,
    ]);
    expect([...DST_MATRIX.subarray(0, 4)]).toEqual([29, 55, 74, 84]);
  });

  it('has nearly orthogonal 32-point basis rows (property of the HEVC core transform)', () => {
    let worstDiagonal = 0;
    let worstOffDiagonal = 0;
    for (let a = 0; a < 32; a++) {
      for (let b = 0; b < 32; b++) {
        let dot = 0;
        for (let i = 0; i < 32; i++) dot += DCT_MATRIX[a * 32 + i] * DCT_MATRIX[b * 32 + i];
        if (a === b) worstDiagonal = Math.max(worstDiagonal, Math.abs(dot - 32 * 4096));
        else worstOffDiagonal = Math.max(worstOffDiagonal, Math.abs(dot));
      }
    }
    expect(worstDiagonal).toBeLessThan(32 * 4096 * 0.01);
    expect(worstOffDiagonal).toBeLessThan(400);
  });

  it('builds the up-right diagonal, horizontal and vertical scans', () => {
    const pairs = (a: Uint8Array): string => Array.from({ length: a.length / 2 }, (_, i) => `${a[2 * i]}${a[2 * i + 1]}`).join(' ');
    expect(pairs(SCAN_ORDER[2][0])).toBe('00 01 10 02 11 20 03 12 21 30 13 22 31 23 32 33');
    expect(pairs(SCAN_ORDER[1][1])).toBe('00 10 01 11');
    expect(pairs(SCAN_ORDER[1][2])).toBe('00 01 10 11');
  });

  it('maps chroma QP per table 8-10', () => {
    expect([29, 30, 34, 35, 43, 44, 51].map(chromaQpMapping)).toEqual([29, 29, 33, 33, 37, 38, 45]);
  });
});

describe('inverse transform (8.6.2 - 8.6.4)', () => {
  /** Straight-from-the-spec reference: scaling, full matrix product, intermediate clipping. */
  function reference(coeffs: Int32Array, log2: number, qp: number, bitDepth: number, useDst: boolean, pred: Uint8Array): Uint8Array {
    const n = 1 << log2;
    const bdShift = bitDepth + log2 - 5;
    const ls = [40, 45, 51, 57, 64, 72][qp % 6] * 2 ** Math.floor(qp / 6);
    const clip16 = (v: number): number => Math.min(32767, Math.max(-32768, v));
    const d = Array.from(coeffs.subarray(0, n * n), (c) => clip16(Math.floor((c * 16 * ls + 2 ** (bdShift - 1)) / 2 ** bdShift)));
    const basis = (k: number, i: number): number => (useDst ? DST_MATRIX[k * 4 + i] : DCT_MATRIX[k * (32 / n) * 32 + i]);
    const g = new Array(n * n).fill(0);
    for (let x = 0; x < n; x++)
      for (let y = 0; y < n; y++) {
        let s = 0;
        for (let k = 0; k < n; k++) s += basis(k, y) * d[k * n + x];
        g[y * n + x] = clip16(Math.floor((s + 64) / 128));
      }
    const out = new Uint8Array(n * n);
    const shift = 20 - bitDepth;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        let s = 0;
        for (let k = 0; k < n; k++) s += basis(k, x) * g[y * n + k];
        out[y * n + x] = Math.min(255, Math.max(0, pred[y * n + x] + Math.floor((s + 2 ** (shift - 1)) / 2 ** shift)));
      }
    return out;
  }

  let seed = 12345;
  const rand = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  it.each([
    [2, true],
    [2, false],
    [3, false],
    [4, false],
    [5, false],
  ])('matches the reference for log2 size %i (DST: %s) with sparse, dense and DC-only blocks', (log2, useDst) => {
    const n = 1 << log2;
    for (let trial = 0; trial < 40; trial++) {
      const coeffs = new Int32Array(1024);
      const density = trial % 4 === 0 ? 0 : trial % 4 === 1 ? 0.05 : trial % 4 === 2 ? 0.3 : 1;
      let maxX = 0;
      let maxY = 0;
      for (let i = 0; i < n * n; i++) {
        if (i === 0 || rand() < density) {
          coeffs[i] = Math.round((rand() - 0.5) * (trial % 3 === 0 ? 4000 : 60));
          if (coeffs[i]) {
            maxX = Math.max(maxX, i % n);
            maxY = Math.max(maxY, Math.floor(i / n));
          }
        }
      }
      const pred = Uint8Array.from({ length: n * n }, () => Math.floor(rand() * 256));
      const qp = 4 + Math.floor(rand() * 45);
      const expected = reference(coeffs, log2, qp, 8, useDst, pred);
      const dst = pred.slice();
      addResidual(dst, n, 0, 0, coeffs.slice(), new Int32Array(1024), {
        log2Size: log2,
        qp,
        bitDepth: 8,
        transformSkip: false,
        transquantBypass: false,
        useDst,
        scaling: null,
        maxX: useDst ? 3 : maxX,
        maxY: useDst ? 3 : maxY,
      });
      expect([...dst]).toEqual([...expected]);
    }
  });

  it('adds coefficients directly for transquant bypass', () => {
    const dst = new Uint8Array(16).fill(100);
    const coeffs = new Int32Array(16).map((_, i) => i - 8);
    addResidual(dst, 4, 0, 0, coeffs, new Int32Array(16), {
      log2Size: 2, qp: 30, bitDepth: 8, transformSkip: false, transquantBypass: true, useDst: true, scaling: null, maxX: 3, maxY: 3,
    });
    expect([...dst]).toEqual(Array.from({ length: 16 }, (_, i) => 100 + i - 8));
  });
});

describe('HEVC picture decoding', () => {
  it('parses the fixture parameter sets', () => {
    const nals = sampleNals();
    const sps = parseSps(nals.find((n) => ((n[0] >> 1) & 63) === 33)!);
    const pps = parsePps(nals.find((n) => ((n[0] >> 1) & 63) === 34)!);
    expect([sps.width, sps.height, sps.chromaFormatIdc, sps.bitDepthY, 1 << sps.log2CtbSize]).toEqual([800, 600, 1, 8, 64]);
    expect(sps.saoEnabled).toBe(true);
    expect(pps.entropyCodingSyncEnabled).toBe(true);
    expect(pps.signDataHidingEnabled).toBe(true);
  });

  it('decodes bit-exactly (same planes as libde265 and a hardware HEVC decoder)', () => {
    const pic = decodeHevcPicture(sampleNals());
    expect([pic.width, pic.height, pic.chromaWidth, pic.chromaHeight]).toEqual([800, 600, 400, 300]);
    // Reference hashes were produced by libde265 1.0 (WASM) and cross-checked against
    // Chrome's WebCodecs hardware HEVC decoder; all three decoders agree sample-for-sample.
    expect(pic.planes.map(sha256)).toEqual([
      '305b6f236520bb99e24c7f22bb8c4039c732046f2a50dfd48a0a434d1ae4ebd4',
      '48a82695782a1b44d09df2af1a5786286f27625878127072f5034799ad0453b1',
      'd2ee27f75306ce3d5544640d7c421b5985ed59fe86f173b37d59f850b6af4cd4',
    ]);
  });

  it('rejects truncated slice data', () => {
    const nals = sampleNals();
    const last = nals[nals.length - 1];
    nals[nals.length - 1] = last.subarray(0, last.length >> 1);
    expect(() => decodeHevcPicture(nals)).toThrow();
  });

  it('rejects streams without parameter sets or picture data', () => {
    const nals = sampleNals();
    expect(() => decodeHevcPicture(nals.slice(0, 3))).toThrow('no picture data');
    expect(() => decodeHevcPicture([nals[0], nals[3]])).toThrow('missing PPS');
  });
});
