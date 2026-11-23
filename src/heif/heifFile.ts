import { HeicDecodeError } from '../errors';

/** ISOBMFF / HEIF (ISO/IEC 14496-12, 23008-12) container parsing — only what image decoding needs. */

export interface BoxRef {
  type: string;
  /** Payload start (after the box header). */
  start: number;
  end: number;
}

export interface HeifItem {
  id: number;
  type: string;
  hidden: boolean;
}

interface Extent {
  offset: number;
  length: number;
}

interface ItemLocation {
  constructionMethod: number;
  baseOffset: number;
  extents: Extent[];
}

export interface ItemReference {
  type: string;
  from: number;
  to: number[];
}

export interface PropertyAssociation {
  index: number;
  essential: boolean;
}

export interface HeifFile {
  data: Uint8Array;
  brands: string[];
  items: HeifItem[];
  primaryId: number;
  references: ItemReference[];
  /** ipco children; property index N in ipma refers to properties[N - 1]. */
  properties: BoxRef[];
  associations: Map<number, PropertyAssociation[]>;
  locations: Map<number, ItemLocation>;
  idat: BoxRef | null;
}

const fourcc = (d: Uint8Array, p: number): string => String.fromCharCode(d[p], d[p + 1], d[p + 2], d[p + 3]);

export class ByteReader {
  constructor(
    readonly d: Uint8Array,
    public p: number,
    readonly end: number,
  ) {}

  private need(n: number): void {
    if (this.p + n > this.end) throw new HeicDecodeError('truncated box');
  }

  u8(): number {
    this.need(1);
    return this.d[this.p++];
  }

  u16(): number {
    this.need(2);
    const v = (this.d[this.p] << 8) | this.d[this.p + 1];
    this.p += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.d[this.p] * 0x1000000 + ((this.d[this.p + 1] << 16) | (this.d[this.p + 2] << 8) | this.d[this.p + 3]);
    this.p += 4;
    return v;
  }

  i32(): number {
    const v = this.u32();
    return v > 0x7fffffff ? v - 0x100000000 : v;
  }

  /** Unsigned integer of 0, 4 or 8 bytes (iloc field sizes). */
  uN(bytes: number): number {
    if (bytes === 0) return 0;
    if (bytes === 4) return this.u32();
    if (bytes === 8) return this.u32() * 0x100000000 + this.u32();
    if (bytes === 2) return this.u16();
    if (bytes === 1) return this.u8();
    throw new HeicDecodeError('invalid field size');
  }

  fourcc(): string {
    this.need(4);
    const v = fourcc(this.d, this.p);
    this.p += 4;
    return v;
  }

  cstring(): string {
    let s = '';
    while (this.p < this.end) {
      const c = this.d[this.p++];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
}

export function readBoxes(d: Uint8Array, start: number, end: number): BoxRef[] {
  const out: BoxRef[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = d[p] * 0x1000000 + ((d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]);
    const type = fourcc(d, p + 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) throw new HeicDecodeError('truncated box');
      size = new ByteReader(d, p + 8, end).uN(8);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) throw new HeicDecodeError(`invalid box size (${type})`);
    out.push({ type, start: p + header, end: p + size });
    p += size;
  }
  return out;
}

const HEIF_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1', 'miaf'];

export function parseHeif(data: Uint8Array): HeifFile {
  const top = readBoxes(data, 0, data.length);
  const ftyp = top.find((b) => b.type === 'ftyp');
  const meta = top.find((b) => b.type === 'meta');
  if (!ftyp || !meta) throw new HeicDecodeError('not a HEIF file');
  const brands: string[] = [fourcc(data, ftyp.start)];
  for (let p = ftyp.start + 8; p + 4 <= ftyp.end; p += 4) brands.push(fourcc(data, p));
  if (!brands.some((b) => HEIF_BRANDS.includes(b))) throw new HeicDecodeError('not a HEIF file');

  const file: HeifFile = {
    data,
    brands,
    items: [],
    primaryId: 0,
    references: [],
    properties: [],
    associations: new Map(),
    locations: new Map(),
    idat: null,
  };
  const metaChildren = readBoxes(data, meta.start + 4, meta.end);
  const hdlr = metaChildren.find((b) => b.type === 'hdlr');
  if (!hdlr || fourcc(data, hdlr.start + 8) !== 'pict') throw new HeicDecodeError('not an image HEIF file');

  for (const box of metaChildren) {
    const r = new ByteReader(data, box.start, box.end);
    switch (box.type) {
      case 'pitm': {
        const version = r.u8();
        r.p += 3;
        file.primaryId = version === 0 ? r.u16() : r.u32();
        break;
      }
      case 'iinf':
        parseIinf(file, r, box);
        break;
      case 'iloc':
        parseIloc(file, r);
        break;
      case 'iref': {
        const version = r.u8();
        r.p += 3;
        for (const ref of readBoxes(data, r.p, box.end)) {
          const rr = new ByteReader(data, ref.start, ref.end);
          const from = version === 0 ? rr.u16() : rr.u32();
          const count = rr.u16();
          const to: number[] = [];
          for (let i = 0; i < count; i++) to.push(version === 0 ? rr.u16() : rr.u32());
          file.references.push({ type: ref.type, from, to });
        }
        break;
      }
      case 'iprp':
        parseIprp(file, box);
        break;
      case 'idat':
        file.idat = box;
        break;
      default:
        break;
    }
  }
  return file;
}

function parseIinf(file: HeifFile, r: ByteReader, box: BoxRef): void {
  const version = r.u8();
  r.p += 3;
  r.p += version === 0 ? 2 : 4; // entry_count (we read all infe children instead)
  for (const infe of readBoxes(file.data, r.p, box.end)) {
    if (infe.type !== 'infe') continue;
    const ir = new ByteReader(file.data, infe.start, infe.end);
    const v = ir.u8();
    const flags = (ir.u8() << 16) | ir.u16();
    if (v < 2) {
      // legacy item info entries carry no item type; they are never images
      const id = ir.u16();
      file.items.push({ id, type: '', hidden: (flags & 1) === 1 });
      continue;
    }
    const id = v === 2 ? ir.u16() : ir.u32();
    ir.u16(); // item_protection_index
    const type = ir.fourcc();
    file.items.push({ id, type, hidden: (flags & 1) === 1 });
  }
}

function parseIloc(file: HeifFile, r: ByteReader): void {
  const version = r.u8();
  r.p += 3;
  const a = r.u8();
  const b = r.u8();
  const offsetSize = a >> 4;
  const lengthSize = a & 15;
  const baseOffsetSize = b >> 4;
  const indexSize = version === 1 || version === 2 ? b & 15 : 0;
  const count = version < 2 ? r.u16() : r.u32();
  for (let i = 0; i < count; i++) {
    const id = version < 2 ? r.u16() : r.u32();
    let constructionMethod = 0;
    if (version === 1 || version === 2) constructionMethod = r.u16() & 15;
    r.u16(); // data_reference_index
    const baseOffset = r.uN(baseOffsetSize);
    const extentCount = r.u16();
    const extents: Extent[] = [];
    for (let e = 0; e < extentCount; e++) {
      if (indexSize > 0) r.uN(indexSize);
      const offset = r.uN(offsetSize);
      const length = r.uN(lengthSize);
      extents.push({ offset, length });
    }
    file.locations.set(id, { constructionMethod, baseOffset, extents });
  }
}

function parseIprp(file: HeifFile, box: BoxRef): void {
  for (const child of readBoxes(file.data, box.start, box.end)) {
    if (child.type === 'ipco') {
      file.properties.push(...readBoxes(file.data, child.start, child.end));
    } else if (child.type === 'ipma') {
      const r = new ByteReader(file.data, child.start, child.end);
      const version = r.u8();
      const flags = (r.u8() << 16) | r.u16();
      const count = r.u32();
      for (let i = 0; i < count; i++) {
        const id = version < 1 ? r.u16() : r.u32();
        const n = r.u8();
        const list = file.associations.get(id) ?? [];
        for (let j = 0; j < n; j++) {
          if (flags & 1) {
            const v = r.u16();
            list.push({ essential: (v & 0x8000) !== 0, index: v & 0x7fff });
          } else {
            const v = r.u8();
            list.push({ essential: (v & 0x80) !== 0, index: v & 0x7f });
          }
        }
        file.associations.set(id, list);
      }
    }
  }
}

/** Concatenated payload of an item (construction methods 0 = file offset, 1 = idat). */
export function getItemData(file: HeifFile, id: number): Uint8Array {
  const loc = file.locations.get(id);
  if (!loc) throw new HeicDecodeError(`missing location for item ${id}`);
  let source: Uint8Array;
  let sourceBase: number;
  if (loc.constructionMethod === 0) {
    source = file.data;
    sourceBase = 0;
  } else if (loc.constructionMethod === 1) {
    if (!file.idat) throw new HeicDecodeError('missing idat');
    source = file.data.subarray(file.idat.start, file.idat.end);
    sourceBase = 0;
  } else {
    throw new HeicDecodeError('unsupported item construction method');
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const ext of loc.extents) {
    const start = sourceBase + loc.baseOffset + ext.offset;
    const end = ext.length === 0 ? source.length : start + ext.length;
    if (start > source.length || end > source.length) throw new HeicDecodeError('item data out of range');
    parts.push(source.subarray(start, end));
    total += end - start;
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

/** Properties associated with an item, in ipma order. */
export function getItemProperties(file: HeifFile, id: number): BoxRef[] {
  const list = file.associations.get(id) ?? [];
  const out: BoxRef[] = [];
  for (const assoc of list) {
    if (assoc.index === 0) continue;
    const prop = file.properties[assoc.index - 1];
    if (!prop) throw new HeicDecodeError('invalid property index');
    out.push(prop);
  }
  return out;
}

export function getReferences(file: HeifFile, from: number, type: string): number[] {
  const out: number[] = [];
  for (const ref of file.references) if (ref.from === from && ref.type === type) out.push(...ref.to);
  return out;
}

const IMAGE_ITEM_TYPES = ['hvc1', 'grid', 'iden', 'iovl'];

/**
 * Top-level images, in item order, using libheif's rules (as bundled in heic2any):
 * visible image items that are neither thumbnails nor auxiliary images.
 */
export function getTopLevelImageIds(file: HeifFile): number[] {
  const excluded = new Set<number>();
  for (const ref of file.references) {
    if (ref.type === 'thmb' || ref.type === 'auxl') excluded.add(ref.from);
  }
  return file.items
    .filter((item) => IMAGE_ITEM_TYPES.includes(item.type) && !item.hidden && !excluded.has(item.id))
    .map((item) => item.id);
}
