import { createYielder } from './yielder';
import { yuvToRgba } from './color';
import { decodeImageItem } from './heif/decodeImage';
import { getItemProperties, getReferences, getTopLevelImageIds, parseHeif, type HeifFile } from './heif/heifFile';

/** An image item has what it needs to be decoded (coded config, data or source images). */
function isUsableImage(file: HeifFile, id: number): boolean {
  const item = file.items.find((i) => i.id === id);
  if (!item) return false;
  try {
    switch (item.type) {
      case 'hvc1':
        return file.locations.has(id) && getItemProperties(file, id).some((p) => p.type === 'hvcC');
      case 'grid':
      case 'iovl':
        return file.locations.has(id) && getReferences(file, id, 'dimg').length > 0;
      case 'iden':
        return getReferences(file, id, 'dimg').length === 1;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** A decoded image as RGBA bytes (what heic2any puts on its canvas). */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** Messages used by heic2any's bundled libheif worker; kept verbatim for compatibility. */
export const MSG_FORMAT_NOT_SUPPORTED = 'ERR_LIBHEIF format not supported';
export const MSG_DECODE_FAILED =
  'ERR_LIBHEIF Error while processing single image and generating image data, could not ensure image';
export const MSG_NO_VALID_IMAGES = "ERR_LIBHEIF Heic doesn't contain valid images";

export interface DecodeOptions {
  /**
   * Pause between tiles so the page stays responsive when decoding on the main thread
   * (default true). Not needed inside a Web Worker.
   */
  yieldBetweenTiles?: boolean;
}

/**
 * Decodes every top-level image of a HEIC/HEIF file to RGBA.
 * Rejects with the same message strings as heic2any's decoder.
 */
export async function decodeHeicToRgba(buffer: ArrayBuffer | Uint8Array, options: DecodeOptions = {}): Promise<RgbaImage[]> {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let file: HeifFile;
  let ids: number[];
  try {
    file = parseHeif(data);
    ids = getTopLevelImageIds(file);
  } catch {
    throw MSG_FORMAT_NOT_SUPPORTED;
  }
  if (!ids.length) throw MSG_FORMAT_NOT_SUPPORTED;
  // Like heic2any, images whose description is unusable are skipped; if none is left the
  // file is reported as containing no valid images.
  ids = ids.filter((id) => isUsableImage(file, id));
  if (!ids.length) throw MSG_NO_VALID_IMAGES;

  const { yieldNow, dispose } = createYielder(options.yieldBetweenTiles !== false);
  try {
    const images: RgbaImage[] = [];
    for (const id of ids) {
      let yuv;
      try {
        yuv = await decodeImageItem(file, id, yieldNow);
      } catch {
        throw MSG_DECODE_FAILED;
      }
      images.push({ width: yuv.width, height: yuv.height, data: yuvToRgba(yuv) });
      await yieldNow();
    }
    return images;
  } finally {
    dispose();
  }
}
