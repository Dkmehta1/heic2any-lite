import { MSG_DECODE_FAILED, MSG_FORMAT_NOT_SUPPORTED, MSG_NO_VALID_IMAGES, decodeHeicToRgba } from '../decodeHeic';
import { decodeImageItem, type YuvImage } from '../heif/decodeImage';
import { getTopLevelImageIds, parseHeif } from '../heif/heifFile';
import {
  buildHeif,
  clapBox,
  gridData,
  hvcCBox,
  imirBox,
  irotBox,
  ispeBox,
  loadSample,
  overlayData,
  sampleCodedImage,
  u8,
} from '../__fixtures__/heifBuilder';

const noYield = async (): Promise<void> => undefined;

async function decodePrimary(file: Uint8Array): Promise<YuvImage> {
  const heif = parseHeif(file);
  return decodeImageItem(heif, getTopLevelImageIds(heif)[0], noYield);
}

/** Independent plane helpers used to state the expected results. */
const plane = (img: YuvImage, c: 0 | 1 | 2): { d: Uint8Array; w: number; h: number } =>
  c === 0
    ? { d: img.y, w: img.width, h: img.height }
    : { d: c === 1 ? img.cb : img.cr, w: (img.width + 1) >> 1, h: (img.height + 1) >> 1 };
const at = (p: { d: Uint8Array; w: number }, x: number, y: number): number => p.d[y * p.w + x];

describe('HEIF container', () => {
  const coded = sampleCodedImage();
  const hvc = (id: number, extra: Uint8Array[] = [], hidden = false) => ({
    id,
    type: 'hvc1',
    hidden,
    data: coded.data,
    props: [hvcCBox(coded.hvcC), ispeBox(800, 600), ...extra],
  });
  let base: YuvImage;
  beforeAll(async () => {
    base = await decodePrimary(loadSample());
  });

  it('reads the fixture: one visible hvc1 image', () => {
    const heif = parseHeif(loadSample());
    expect(heif.brands).toContain('heic');
    expect(getTopLevelImageIds(heif)).toEqual([heif.primaryId]);
  });

  it('round-trips a file built by the test builder', async () => {
    const img = await decodePrimary(buildHeif({ items: [hvc(1)], primary: 1 }));
    expect(img.y).toEqual(base.y);
    expect(img.cb).toEqual(base.cb);
  });

  it.each([1, 2, 3])('applies irot angle %i (counter-clockwise, per plane)', async (angle) => {
    const img = await decodePrimary(buildHeif({ items: [hvc(1, [irotBox(angle)])], primary: 1 }));
    const swap = angle !== 2;
    expect([img.width, img.height]).toEqual(swap ? [600, 800] : [800, 600]);
    for (const c of [0, 1, 2] as const) {
      const src = plane(base, c);
      const out = plane(img, c);
      for (const [x, y] of [[0, 0], [5, 9], [src.w - 1, 3], [7, src.h - 1]]) {
        let ox: number;
        let oy: number;
        if (angle === 1) [ox, oy] = [y, src.w - 1 - x];
        else if (angle === 2) [ox, oy] = [src.w - 1 - x, src.h - 1 - y];
        else [ox, oy] = [src.h - 1 - y, x];
        expect(at(out, ox, oy)).toBe(at(src, x, y));
      }
    }
  });

  it.each([
    [1, 'left/right'],
    [0, 'top/bottom'],
  ])('applies imir axis %i (%s, libheif semantics)', async (axis) => {
    const img = await decodePrimary(buildHeif({ items: [hvc(1, [imirBox(axis)])], primary: 1 }));
    const src = plane(base, 0);
    const out = plane(img, 0);
    for (const [x, y] of [[0, 0], [10, 20], [799, 599]]) {
      expect(at(out, axis ? 799 - x : x, axis ? y : 599 - y)).toBe(at(src, x, y));
    }
  });

  it('applies transforms in property order (rotate, then mirror)', async () => {
    const img = await decodePrimary(buildHeif({ items: [hvc(1, [irotBox(1), imirBox(1)])], primary: 1 }));
    const src = plane(base, 0);
    // rotate 90 ccw: (x, y) -> (y, 799 - x) in a 600x800 image; then mirror left/right: x' -> 599 - x'
    expect(at(plane(img, 0), 599 - 20, 799 - 10)).toBe(at(src, 10, 20));
  });

  it('crops with a clean aperture (clap)', async () => {
    const img = await decodePrimary(buildHeif({ items: [hvc(1, [clapBox(400, 300, 0, 0)])], primary: 1 }));
    expect([img.width, img.height]).toEqual([400, 300]);
    // centred crop: left = round(399.5 - 199.5) = 200, top = round(299.5 - 149.5) = 150
    expect(at(plane(img, 0), 0, 0)).toBe(at(plane(base, 0), 200, 150));
    expect(at(plane(img, 1), 10, 10)).toBe(at(plane(base, 1), 110, 85));
  });

  it('assembles grid images (tiles left-to-right, cropped to the output size) from idat descriptors', async () => {
    const file = buildHeif({
      items: [
        hvc(1, [], true),
        hvc(2, [], true),
        { id: 3, type: 'grid', data: gridData(1, 2, 1500, 600), inIdat: true, props: [ispeBox(1500, 600)] },
      ],
      primary: 3,
      refs: [{ type: 'dimg', from: 3, to: [1, 2] }],
    });
    expect(getTopLevelImageIds(parseHeif(file))).toEqual([3]);
    const img = await decodePrimary(file);
    expect([img.width, img.height]).toEqual([1500, 600]);
    const y = plane(img, 0);
    const b = plane(base, 0);
    expect(at(y, 0, 0)).toBe(at(b, 0, 0));
    expect(at(y, 799, 300)).toBe(at(b, 799, 300));
    expect(at(y, 800, 300)).toBe(at(b, 0, 300));
    expect(at(y, 1499, 599)).toBe(at(b, 699, 599));
    expect(at(plane(img, 2), 400 + 5, 7)).toBe(at(plane(base, 2), 5, 7));
  });

  it('excludes hidden, thumbnail and auxiliary items from the top-level list, keeping item order', () => {
    const file = buildHeif({
      items: [hvc(1), hvc(2), hvc(3), hvc(4, [], true), hvc(5)],
      primary: 5,
      refs: [
        { type: 'thmb', from: 2, to: [5] },
        { type: 'auxl', from: 3, to: [5] },
      ],
    });
    expect(getTopLevelImageIds(parseHeif(file))).toEqual([1, 5]);
  });

  it('decodes every top-level image to RGBA', async () => {
    const images = await decodeHeicToRgba(buildHeif({ items: [hvc(1), hvc(2, [irotBox(2)])], primary: 1 }));
    expect(images.map((i) => [i.width, i.height])).toEqual([[800, 600], [800, 600]]);
    expect(images[0].data.length).toBe(800 * 600 * 4);
  });

  it('reports non-HEIF input with heic2any\'s message', async () => {
    await expect(decodeHeicToRgba(u8(0, 0, 0, 8, 0x66, 0x6f, 0x6f, 0x21))).rejects.toBe(MSG_FORMAT_NOT_SUPPORTED);
    await expect(decodeHeicToRgba(new Uint8Array(0))).rejects.toBe(MSG_FORMAT_NOT_SUPPORTED);
    await expect(decodeHeicToRgba(buildHeif({ items: [hvc(1)], primary: 1, brands: ['avif', 'avif'] }))).rejects.toBe(
      MSG_FORMAT_NOT_SUPPORTED,
    );
    await expect(decodeHeicToRgba(buildHeif({ items: [hvc(1, [], true)], primary: 1 }))).rejects.toBe(MSG_FORMAT_NOT_SUPPORTED);
  });

  it('reports undecodable image data with heic2any\'s message', async () => {
    const broken = { ...hvc(1), data: coded.data.slice(0, 200) };
    await expect(decodeHeicToRgba(buildHeif({ items: [broken], primary: 1 }))).rejects.toBe(MSG_DECODE_FAILED);
  });

  it('skips unusable images like heic2any and reports a file with none left', async () => {
    const noConfig = { id: 1, type: 'hvc1', data: coded.data, props: [ispeBox(800, 600)] };
    await expect(decodeHeicToRgba(buildHeif({ items: [noConfig], primary: 1 }))).rejects.toBe(MSG_NO_VALID_IMAGES);
    const images = await decodeHeicToRgba(buildHeif({ items: [noConfig, hvc(2)], primary: 2 }));
    expect(images).toHaveLength(1);
  });

  describe('overlay images (iovl)', () => {
    const overlayFile = (w: number, h: number, offsets: [number, number][], fill: [number, number, number, number]) =>
      buildHeif({
        items: [
          hvc(1, [], true),
          hvc(2, [irotBox(1)], true),
          { id: 3, type: 'iovl', data: overlayData(fill, w, h, offsets), inIdat: true, props: [ispeBox(w, h)] },
        ],
        primary: 3,
        refs: [{ type: 'dimg', from: 3, to: [1, 2] }],
      });

    it('draws layers in order at their offsets over the fill colour', async () => {
      const img = await decodePrimary(overlayFile(1400, 1000, [[0, 0], [800, 100]], [65535, 0, 0, 65535]));
      expect([img.width, img.height]).toEqual([1400, 1000]);
      const y = plane(img, 0);
      const b = plane(base, 0);
      const rotated = plane(await decodePrimary(buildHeif({ items: [hvc(1, [irotBox(1)])], primary: 1 })), 0);
      expect(at(y, 10, 20)).toBe(at(b, 10, 20)); // first layer
      expect(at(y, 800 + 5, 100 + 7)).toBe(at(rotated, 5, 7)); // second layer (600x800, rotated)
      // uncovered area keeps the fill colour: pure red -> Y 81, Cb 90, Cr 240 (BT.601 limited range)
      expect(at(y, 1399, 0)).toBe(81);
      expect(at(plane(img, 1), 699, 0)).toBe(90);
      expect(at(plane(img, 2), 699, 0)).toBe(240);
    });

    it('clips layers placed partly outside the canvas (negative offsets)', async () => {
      const img = await decodePrimary(overlayFile(400, 300, [[-100, -50], [5000, 5000]], [0, 0, 0, 65535]));
      expect(at(plane(img, 0), 0, 0)).toBe(at(plane(base, 0), 100, 50));
      expect(at(plane(img, 0), 399, 299)).toBe(at(plane(base, 0), 499, 349));
    });

    it('converts overlays end to end', async () => {
      const [rgba] = await decodeHeicToRgba(overlayFile(900, 700, [[0, 0], [100, 0]], [0, 0, 65535, 65535]));
      expect([rgba.width, rgba.height]).toEqual([900, 700]);
    });
  });
});
