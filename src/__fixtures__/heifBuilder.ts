/**
 * Test helper: builds HEIF files around a real HEVC bitstream so container features
 * (grids, transforms, idat, thumbnails, hidden items...) can be tested without extra fixtures.
 */
import fs from 'fs';
import path from 'path';
import { getItemData, getItemProperties, parseHeif } from '../heif/heifFile';

export const SAMPLE_PATH = path.join(__dirname, 'sample.heic');
export const loadSample = (): Uint8Array => new Uint8Array(fs.readFileSync(SAMPLE_PATH));

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
export const u8 = (...v: number[]): Uint8Array => Uint8Array.from(v);
export const u16 = (v: number): Uint8Array => u8((v >> 8) & 255, v & 255);
export const u32 = (v: number): Uint8Array => u8((v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255);
export const str = (s: string): Uint8Array => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

export function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  return concat([u32(body.length + 8), str(type), body]);
}

export function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);
}

/** hvcC payload and coded data of the fixture's single image. */
export function sampleCodedImage(): { hvcC: Uint8Array; data: Uint8Array; width: number; height: number } {
  const file = parseHeif(loadSample());
  const id = file.items.find((i) => i.type === 'hvc1')!.id;
  const props = getItemProperties(file, id);
  const hvcC = props.find((p) => p.type === 'hvcC')!;
  return { hvcC: file.data.slice(hvcC.start, hvcC.end), data: getItemData(file, id).slice(), width: 800, height: 600 };
}

export interface TestItem {
  id: number;
  type: string;
  hidden?: boolean;
  /** Item payload; stored in mdat (or idat when inIdat). */
  data?: Uint8Array;
  inIdat?: boolean;
  /** Property boxes, in association order. */
  props?: Uint8Array[];
}

export interface TestFile {
  items: TestItem[];
  primary: number;
  refs?: { type: string; from: number; to: number[] }[];
  brands?: string[];
}

/** Serialises a HEIF file (ftyp + meta + mdat) with 32-bit iloc offsets. */
export function buildHeif(spec: TestFile): Uint8Array {
  const brands = spec.brands ?? ['heic', 'mif1', 'heic'];
  const ftyp = box('ftyp', str(brands[0]), u32(0), ...brands.slice(1).map(str));

  // property table: every distinct property box gets an index (1-based)
  const props: Uint8Array[] = [];
  const assoc = spec.items.map((item) =>
    (item.props ?? []).map((p) => {
      props.push(p);
      return props.length;
    }),
  );

  const idatParts: Uint8Array[] = [];
  let idatLen = 0;
  const idatOffsets = new Map<number, number>();
  for (const item of spec.items) {
    if (item.inIdat && item.data) {
      idatOffsets.set(item.id, idatLen);
      idatParts.push(item.data);
      idatLen += item.data.length;
    }
  }

  const build = (mdatStart: number): Uint8Array => {
    let mdatOff = mdatStart;
    const ilocEntries: Uint8Array[] = [];
    let ilocCount = 0;
    for (const item of spec.items) {
      if (!item.data) continue;
      ilocCount++;
      const method = item.inIdat ? 1 : 0;
      const offset = item.inIdat ? (idatOffsets.get(item.id) as number) : mdatOff;
      if (!item.inIdat) mdatOff += item.data.length;
      ilocEntries.push(concat([u16(item.id), u16(method), u16(0), u16(1), u32(offset), u32(item.data.length)]));
    }
    const iloc = fullBox('iloc', 1, 0, u8(0x44, 0x00), u16(ilocCount), ...ilocEntries);
    const iinf = fullBox(
      'iinf',
      0,
      0,
      u16(spec.items.length),
      ...spec.items.map((item) => fullBox('infe', 2, item.hidden ? 1 : 0, u16(item.id), u16(0), str(item.type), u8(0))),
    );
    const iref = spec.refs?.length
      ? [fullBox('iref', 0, 0, ...spec.refs.map((r) => box(r.type, u16(r.from), u16(r.to.length), ...r.to.map(u16))))]
      : [];
    const ipma = fullBox(
      'ipma',
      0,
      0,
      u32(spec.items.length),
      ...spec.items.map((item, i) => concat([u16(item.id), u8(assoc[i].length), ...assoc[i].map((idx) => u8(idx))])),
    );
    const iprp = box('iprp', box('ipco', ...props), ipma);
    const meta = fullBox(
      'meta',
      0,
      0,
      fullBox('hdlr', 0, 0, u32(0), str('pict'), u32(0), u32(0), u32(0), u8(0)),
      fullBox('pitm', 0, 0, u16(spec.primary)),
      iinf,
      iloc,
      ...iref,
      iprp,
      ...(idatParts.length ? [box('idat', ...idatParts)] : []),
    );
    const mdat = box('mdat', ...spec.items.filter((i) => i.data && !i.inIdat).map((i) => i.data as Uint8Array));
    return concat([ftyp, meta, mdat]);
  };

  // two passes: sizes do not depend on offsets (fixed 32-bit fields)
  const draft = build(0);
  const mdatPayloadStart = draft.length - (spec.items.filter((i) => i.data && !i.inIdat).reduce((n, i) => n + (i.data as Uint8Array).length, 0));
  return build(mdatPayloadStart);
}

export const hvcCBox = (payload: Uint8Array): Uint8Array => box('hvcC', payload);
export const ispeBox = (w: number, h: number): Uint8Array => fullBox('ispe', 0, 0, u32(w), u32(h));
export const irotBox = (angle: number): Uint8Array => box('irot', u8(angle));
export const imirBox = (axis: number): Uint8Array => box('imir', u8(axis));
export const clapBox = (w: number, h: number, hOff: number, vOff: number): Uint8Array =>
  box('clap', u32(w), u32(1), u32(h), u32(1), u32(hOff >>> 0), u32(1), u32(vOff >>> 0), u32(1));
/** iovl payload with 16-bit fields: version, flags, RGBA fill (16-bit), size, per-layer offsets. */
export const overlayData = (
  fill: [number, number, number, number],
  w: number,
  h: number,
  offsets: [number, number][],
): Uint8Array =>
  Uint8Array.from([
    0,
    0,
    ...fill.flatMap((v) => [...u16(v)]),
    ...u16(w),
    ...u16(h),
    ...offsets.flatMap(([x, y]) => [...u16(x & 0xffff), ...u16(y & 0xffff)]),
  ]);
export const gridData =(rows: number, cols: number, w: number, h: number): Uint8Array =>
  u8(0, 0, rows - 1, cols - 1, (w >> 8) & 255, w & 255, (h >> 8) & 255, h & 255);
