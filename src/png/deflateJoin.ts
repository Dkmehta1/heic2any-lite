/**
 * Makes a complete raw DEFLATE stream (RFC 1951) joinable with others.
 *
 * `CompressionStream('deflate-raw')` always ends its output with a final block (BFINAL = 1) that
 * stops at an arbitrary bit. To compress strips of an image in parallel and still produce the
 * single DEFLATE stream PNG requires, every strip but the last must instead end like zlib's
 * Z_SYNC_FLUSH: last block not final, followed by an empty stored block that pads the stream to a
 * byte boundary. Then the strips' bytes can simply be concatenated.
 *
 * Finding the final block means walking every block's Huffman codes up to its end-of-block
 * symbol (no data is written, so this is much cheaper than inflating).
 */

const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export class DeflateFormatError extends Error {}

/**
 * Lookup table for a canonical Huffman code: indexed by the next `bits` input bits (LSB first),
 * each entry is (symbol << 4) | codeLength; 0 means no code.
 */
interface Table {
  entries: Int32Array;
  bits: number;
}

function buildTable(lengths: ArrayLike<number>, count: number): Table {
  let maxLen = 0;
  const lenCount = new Uint16Array(16);
  for (let i = 0; i < count; i++) {
    lenCount[lengths[i]]++;
    if (lengths[i] > maxLen) maxLen = lengths[i];
  }
  const bits = Math.max(maxLen, 1);
  const entries = new Int32Array(1 << bits);
  const next = new Uint16Array(16);
  let code = 0;
  lenCount[0] = 0;
  for (let len = 1; len <= 15; len++) {
    code = (code + lenCount[len - 1]) << 1;
    next[len] = code;
  }
  for (let sym = 0; sym < count; sym++) {
    const len = lengths[sym];
    if (!len) continue;
    // reverse the code: DEFLATE stores Huffman codes MSB first inside an LSB-first bit stream
    let c = next[len]++;
    let rev = 0;
    for (let i = 0; i < len; i++) {
      rev = (rev << 1) | (c & 1);
      c >>= 1;
    }
    const entry = (sym << 4) | len;
    for (let i = rev; i < entries.length; i += 1 << len) entries[i] = entry;
  }
  return { entries, bits };
}

let fixedLit: Table | null = null;
let fixedDist: Table | null = null;

function fixedTables(): [Table, Table] {
  if (!fixedLit || !fixedDist) {
    const lit = new Uint8Array(288);
    lit.fill(8, 0, 144);
    lit.fill(9, 144, 256);
    lit.fill(7, 256, 280);
    lit.fill(8, 280, 288);
    fixedLit = buildTable(lit, 288);
    fixedDist = buildTable(new Uint8Array(30).fill(5), 30);
  }
  return [fixedLit, fixedDist];
}

/**
 * Returns `stream` rewritten to end with a non-final block plus an empty stored block, so that
 * another raw DEFLATE stream can follow it directly. Throws DeflateFormatError on bad input.
 */
export function makeJoinable(stream: Uint8Array): Uint8Array {
  const data = stream;
  const totalBits = data.length * 8;
  let pos = 0; // bit position

  // reads n (<= 24) bits, LSB first
  const read = (n: number): number => {
    const byte = pos >>> 3;
    const v = (data[byte] | (data[byte + 1] << 8) | (data[byte + 2] << 16) | (data[byte + 3] << 24)) >>> (pos & 7);
    pos += n;
    return v & ((1 << n) - 1);
  };
  const decode = (t: Table): number => {
    const byte = pos >>> 3;
    const v = (data[byte] | (data[byte + 1] << 8) | (data[byte + 2] << 16) | (data[byte + 3] << 24)) >>> (pos & 7);
    const e = t.entries[v & ((1 << t.bits) - 1)];
    if (!e) throw new DeflateFormatError('invalid Huffman code');
    pos += e & 15;
    return e >> 4;
  };

  for (;;) {
    if (pos + 3 > totalBits) throw new DeflateFormatError('stream ends without a final block');
    const headerPos = pos;
    const final = read(1);
    const type = read(2);
    if (type === 0) {
      pos = (pos + 7) & ~7;
      const at = pos >>> 3;
      const len = data[at] | (data[at + 1] << 8);
      if (at + 4 + len > data.length) throw new DeflateFormatError('stored block overruns the stream');
      pos += (4 + len) * 8;
    } else if (type === 1 || type === 2) {
      let lit: Table;
      let dist: Table;
      if (type === 1) {
        [lit, dist] = fixedTables();
      } else {
        const hlit = read(5) + 257;
        const hdist = read(5) + 1;
        const hclen = read(4) + 4;
        const clLengths = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clLengths[CODE_LENGTH_ORDER[i]] = read(3);
        const clTable = buildTable(clLengths, 19);
        const lengths = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist; ) {
          const sym = decode(clTable);
          if (sym < 16) lengths[i++] = sym;
          else {
            let repeat: number;
            let value = 0;
            if (sym === 16) {
              if (i === 0) throw new DeflateFormatError('repeat with no previous length');
              value = lengths[i - 1];
              repeat = 3 + read(2);
            } else if (sym === 17) repeat = 3 + read(3);
            else repeat = 11 + read(7);
            if (i + repeat > hlit + hdist) throw new DeflateFormatError('code lengths overrun');
            lengths.fill(value, i, i + repeat);
            i += repeat;
          }
        }
        lit = buildTable(lengths.subarray(0, hlit), hlit);
        dist = buildTable(lengths.subarray(hlit), hdist);
      }
      for (;;) {
        if (pos > totalBits) throw new DeflateFormatError('block overruns the stream');
        const sym = decode(lit);
        if (sym < 256) continue;
        if (sym === 256) break;
        const li = sym - 257;
        if (li >= 29) throw new DeflateFormatError('invalid length symbol');
        pos += LENGTH_EXTRA[li];
        const ds = decode(dist);
        if (ds >= 30) throw new DeflateFormatError('invalid distance symbol');
        pos += DIST_EXTRA[ds];
      }
    } else {
      throw new DeflateFormatError('invalid block type');
    }
    if (pos > totalBits) throw new DeflateFormatError('block overruns the stream');

    if (final) {
      // clear BFINAL, then append an empty non-final stored block: 3 header bits (all 0),
      // padding to the byte boundary, LEN = 0x0000, NLEN = 0xffff
      const endByte = (pos + 3 + 7) >>> 3;
      const out = new Uint8Array(endByte + 4);
      out.set(data.subarray(0, Math.min(data.length, endByte)));
      out[headerPos >>> 3] &= ~(1 << (headerPos & 7));
      // zero everything from bit `pos` up to the byte boundary (the stored block's header + padding)
      const lastByte = pos >>> 3;
      out[lastByte] &= (1 << (pos & 7)) - 1;
      for (let i = lastByte + 1; i < endByte; i++) out[i] = 0;
      out[endByte + 2] = 0xff;
      out[endByte + 3] = 0xff;
      return out;
    }
  }
}
