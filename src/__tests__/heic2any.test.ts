import heic2any from '..';
import { buildHeif, hvcCBox, irotBox, ispeBox, loadSample, sampleCodedImage } from '../__fixtures__/heifBuilder';

/**
 * jsdom has no canvas/ImageData, so a minimal canvas double records what heic2any asks the
 * browser to encode. Real-browser output is covered by the Playwright parity suite.
 */
class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

interface Encoded {
  type: string;
  quality: number;
  width: number;
  height: number;
  firstPixel: number[];
}

let encoded: Encoded[] = [];
let failContext = false;
let failBlob = false;
const realCreateElement = document.createElement.bind(document);

beforeAll(() => {
  (globalThis as unknown as { ImageData: unknown }).ImageData = FakeImageData;
});

beforeEach(() => {
  encoded = [];
  failContext = false;
  failBlob = false;
  jest.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'canvas') return realCreateElement(tag);
    let image: FakeImageData | null = null;
    const canvas = {
      width: 0,
      height: 0,
      getContext: () =>
        failContext
          ? null
          : {
              putImageData: (img: FakeImageData) => {
                image = img;
              },
            },
      toBlob: (cb: (b: Blob | null) => void, type: string, quality: number) => {
        encoded.push({
          type,
          quality,
          width: canvas.width,
          height: canvas.height,
          firstPixel: image ? [...image.data.subarray(0, 4)] : [],
        });
        cb(failBlob ? null : new Blob([`encoded:${type}`], { type }));
      },
    };
    return canvas as unknown as HTMLElement;
  }) as typeof document.createElement);
});

afterEach(() => jest.restoreAllMocks());

const sampleBlob = (): Blob => new Blob([loadSample() as BlobPart], { type: 'image/heic' });

describe('heic2any (drop-in API)', () => {
  it('converts to PNG by default with quality 0.92', async () => {
    const out = (await heic2any({ blob: sampleBlob() })) as Blob;
    expect(out).toBeInstanceOf(Blob);
    expect(out.type).toBe('image/png');
    expect(encoded).toEqual([expect.objectContaining({ type: 'image/png', quality: 0.92, width: 800, height: 600 })]);
    expect(encoded[0].firstPixel[3]).toBe(255);
  });

  it('encodes PNG with its own lossless encoder, not the canvas, when CompressionStream exists', async () => {
    const g = globalThis as { CompressionStream?: unknown };
    g.CompressionStream = (await import('stream/web')).CompressionStream;
    try {
      for (const toType of ['image/png', 'image/webp']) {
        const out = (await heic2any({ blob: sampleBlob(), toType })) as Blob;
        expect(out.type).toBe('image/png');
        const bytes = await new Promise<Uint8Array>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
          reader.readAsArrayBuffer(out);
        });
        expect([...bytes.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
        expect(bytes[8 + 8 + 9]).toBe(2); // IHDR colour type: RGB (opaque photo, no alpha channel)
      }
      expect(encoded).toEqual([]);
    } finally {
      delete g.CompressionStream;
    }
  });

  it('passes JPEG type and quality to the canvas encoder', async () => {
    const out = (await heic2any({ blob: sampleBlob(), toType: 'image/jpeg', quality: 0.8 })) as Blob;
    expect(out.type).toBe('image/jpeg');
    expect(encoded[0]).toMatchObject({ type: 'image/jpeg', quality: 0.8 });
  });

  it.each([5, -1])('falls back to quality 0.92 when quality is %p (same as heic2any)', async (quality) => {
    await heic2any({ blob: sampleBlob(), toType: 'image/jpeg', quality });
    expect(encoded[0].quality).toBe(0.92);
  });

  it('falls back to PNG for unsupported target types', async () => {
    const out = (await heic2any({ blob: sampleBlob(), toType: 'image/webp' })) as Blob;
    expect(out.type).toBe('image/png');
  });

  it('accepts File objects (as produced by <input type="file">)', async () => {
    const file = new File([loadSample() as BlobPart], 'IMG_0001.HEIC', { type: 'image/heic' });
    expect(((await heic2any({ blob: file, toType: 'image/jpeg' })) as Blob).type).toBe('image/jpeg');
  });

  it('returns only the first image unless multiple is set', async () => {
    const coded = sampleCodedImage();
    const item = (id: number, extra: Uint8Array[] = []) => ({
      id,
      type: 'hvc1',
      data: coded.data,
      props: [hvcCBox(coded.hvcC), ispeBox(800, 600), ...extra],
    });
    const twoImages = new Blob([buildHeif({ items: [item(1), item(2, [irotBox(1)])], primary: 1 }) as BlobPart]);

    const single = await heic2any({ blob: twoImages });
    expect(single).toBeInstanceOf(Blob);

    encoded = [];
    const many = await heic2any({ blob: twoImages, multiple: true });
    expect(Array.isArray(many)).toBe(true);
    expect((many as Blob[]).length).toBe(2);
    expect(encoded.map((e) => [e.width, e.height])).toEqual([
      [800, 600],
      [600, 800],
    ]);
  });

  it('produces an animated GIF blob for image/gif', async () => {
    const out = (await heic2any({ blob: sampleBlob(), toType: 'image/gif', gifInterval: 0.5 })) as Blob;
    expect(out.type).toBe('image/gif');
    const bytes = await new Promise<Uint8Array>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(out);
    });
    expect(String.fromCharCode(...bytes.subarray(0, 6))).toBe('GIF89a');
    // graphic control extension carries delay = 0.5 * 100 = 50 centiseconds
    const gce = bytes.findIndex((b, i) => b === 0x21 && bytes[i + 1] === 0xf9);
    expect(bytes[gce + 4] | (bytes[gce + 5] << 8)).toBe(50);
  });

  it.each([
    [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
    [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
    [[0xff, 0xd8, 0xff, 0xe0], 'image/jpeg'],
    [[0xff, 0xd8, 0xff, 0xe1], 'image/jpeg'],
  ])('rejects files that are already browser readable (%p)', async (magic, type) => {
    await expect(heic2any({ blob: new Blob([Uint8Array.from([...magic, 0, 0, 0, 0])]) })).rejects.toEqual({
      code: 1,
      message: `ERR_USER Image is already browser readable: ${type}`,
    });
  });

  it('rejects non-HEIF data with code 2', async () => {
    await expect(heic2any({ blob: new Blob(['not an image at all']) })).rejects.toEqual({
      code: 2,
      message: 'ERR_LIBHEIF format not supported',
    });
  });

  it('rejects corrupt HEVC data with code 2', async () => {
    const coded = sampleCodedImage();
    const broken = buildHeif({
      items: [{ id: 1, type: 'hvc1', data: coded.data.slice(0, 100), props: [hvcCBox(coded.hvcC)] }],
      primary: 1,
    });
    await expect(heic2any({ blob: new Blob([broken as BlobPart]) })).rejects.toEqual({
      code: 2,
      message: 'ERR_LIBHEIF Error while processing single image and generating image data, could not ensure image',
    });
  });

  it('rejects with code 5 when no 2D context is available', async () => {
    failContext = true;
    await expect(heic2any({ blob: sampleBlob() })).rejects.toEqual({
      code: 5,
      message: 'ERR_CANVAS Error on converting imagedata to blob: Could not get canvas context',
    });
  });

  it('rejects with code 5 when the canvas cannot produce a blob', async () => {
    failBlob = true;
    await expect(heic2any({ blob: sampleBlob() })).rejects.toEqual({
      code: 5,
      message: 'ERR_CANVAS Error on converting imagedata to blob: Could not get blob from canvas',
    });
  });

  it('rejects with the browser TypeError when given something that is not a Blob', async () => {
    await expect(heic2any({ blob: 'nope' as unknown as Blob })).rejects.toBeInstanceOf(TypeError);
  });
});
