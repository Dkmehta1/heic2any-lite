import type { DecodeOptions, RgbaImage } from './decodeHeic';

export { default } from './heic2any';
export type { Heic2AnyOptions } from './heic2any';
export { ERROR_CODES } from './errors';
export type { Heic2AnyError } from './errors';
export type { DecodeOptions, RgbaImage } from './decodeHeic';

/**
 * Decodes every top-level image of a HEIC/HEIF file to RGBA pixels, without any canvas or DOM
 * (works in Web Workers and Node too). Rejects with heic2any's ERR_LIBHEIF message strings.
 *
 * The decoder is loaded on first call, so importing this package stays cheap.
 */
export async function decodeHeicToRgba(buffer: ArrayBuffer | Uint8Array, options?: DecodeOptions): Promise<RgbaImage[]> {
  const decoder = await import('./decodeHeic');
  return decoder.decodeHeicToRgba(buffer, options);
}
