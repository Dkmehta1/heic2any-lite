import { HeicDecodeError } from '../errors';

/** MSB-first bit reader over an RBSP (emulation prevention bytes already removed). */
export class BitReader {
  private bitPos: number;

  constructor(
    private readonly buf: Uint8Array,
    byteOffset = 0,
  ) {
    this.bitPos = byteOffset * 8;
  }

  get position(): number {
    return this.bitPos;
  }

  u1(): number {
    const p = this.bitPos++;
    const byte = p >> 3;
    if (byte >= this.buf.length) throw new HeicDecodeError('bitstream overrun');
    return (this.buf[byte] >> (7 - (p & 7))) & 1;
  }

  /** Fixed-length unsigned read; safe up to 53 bits. */
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.u1();
    return v;
  }

  /** Exp-Golomb ue(v). */
  ue(): number {
    let zeros = 0;
    while (this.u1() === 0) {
      if (++zeros > 32) throw new HeicDecodeError('invalid Exp-Golomb code');
    }
    return zeros === 0 ? 0 : 2 ** zeros - 1 + this.u(zeros);
  }

  /** Exp-Golomb se(v). */
  se(): number {
    const k = this.ue();
    return k % 2 === 1 ? (k + 1) / 2 : -(k / 2);
  }

  skip(n: number): void {
    this.bitPos += n;
  }

  /** byte_alignment(): one bit equal to 1 followed by zero bits up to the byte boundary. */
  byteAlignment(): void {
    this.u1();
    this.bitPos = (this.bitPos + 7) & ~7;
  }

  get bytePosition(): number {
    return (this.bitPos + 7) >> 3;
  }
}

/** Strips emulation_prevention_three_byte (0x000003 -> 0x0000) from a NAL unit payload. */
export function unescapeRbsp(nal: Uint8Array): Uint8Array {
  let zeros = 0;
  let needed = false;
  for (let i = 0; i < nal.length; i++) {
    if (zeros >= 2 && nal[i] === 3) {
      needed = true;
      break;
    }
    zeros = nal[i] === 0 ? zeros + 1 : 0;
  }
  if (!needed) return nal;
  const out = new Uint8Array(nal.length);
  let o = 0;
  zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}
