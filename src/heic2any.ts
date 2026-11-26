import type { RgbaImage } from './decodeHeic';
import { toHeic2AnyError } from './errors';
import type { GifFrame } from './gif/encodeGif';

/** Options accepted by heic2any — identical to the original package. */
export interface Heic2AnyOptions {
  blob: Blob;
  /** Return every image of a multi-image file (as an array) instead of the first one. */
  multiple?: true;
  /** 'image/png' (default), 'image/jpeg' or 'image/gif'. Anything else falls back to PNG. */
  toType?: string;
  /** Encoder quality 0..1 for JPEG (default 0.92; out-of-range values fall back to 0.92). */
  quality?: number;
  /** Seconds between frames for GIF output (default 0.4). */
  gifInterval?: number;
}

const SUPPORTED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif'];

type WorkerModule = typeof import('./worker/workerDecoder');

/** The worker module, or null without Worker support or if its chunk fails to load. */
async function loadWorkerModule(): Promise<WorkerModule | null> {
  if (typeof Worker === 'undefined') return null;
  try {
    return await import('./worker/workerDecoder');
  } catch {
    return null;
  }
}

/**
 * Decodes off the main thread when the browser supports Web Workers (like heic2any), and on
 * the main thread otherwise or if the worker cannot start (e.g. a restrictive CSP).
 * The worker code is only downloaded on the first conversion.
 */
async function decode(buffer: ArrayBuffer): Promise<RgbaImage[]> {
  const workerModule = await loadWorkerModule();
  if (workerModule) {
    try {
      return await workerModule.decodeInWorker(buffer);
    } catch (e) {
      if (!(e instanceof workerModule.WorkerUnavailableError)) throw e;
    }
  }
  // main-thread fallback: the decoder is only downloaded here when no worker could be used
  const { decodeHeicToRgba } = await import('./decodeHeic');
  return decodeHeicToRgba(buffer);
}

/**
 * Encodes with the library's own PNG encoder (src/png): the same pixels as the canvas would
 * write, in a much smaller file. Strips of the image are compressed on several workers at once;
 * without workers they run here, pausing between strips so the page stays responsive.
 * Resolves with null when this browser cannot run the encoder (no CompressionStream).
 */
async function encodePngFile(image: RgbaImage): Promise<Blob | null> {
  const [{ canEncodePng, encodePng, encodePngStrip }, { createYielder }, workerModule] = await Promise.all([
    import('./png/encodePng'),
    import('./yielder'),
    loadWorkerModule(),
  ]);
  if (!canEncodePng()) return null;
  const { yieldNow, dispose } = createYielder(true);
  const here = (job: Parameters<typeof encodePngStrip>[0]) => yieldNow().then(() => encodePngStrip(job));
  try {
    if (!workerModule) return await encodePng(image, { runStrip: here });
    return await encodePng(image, {
      concurrency: workerModule.poolSize(),
      runStrip: (job) =>
        workerModule.encodePngStripInWorker(job).catch((e: unknown) => {
          if (e instanceof workerModule.WorkerUnavailableError) return here(job);
          throw e;
        }),
    });
  } finally {
    dispose();
  }
}

/** Detects files that browsers can already display (same signatures as heic2any). */
function browserReadableType(buffer: ArrayBuffer): string | false {
  const arr = new Uint8Array(buffer).subarray(0, 4);
  let header = '';
  for (let i = 0; i < arr.length; i++) header += arr[i].toString(16);
  switch (header) {
    case '89504e47':
      return 'image/png';
    case '47494638':
      return 'image/gif';
    case 'ffd8ffe0':
    case 'ffd8ffe1':
    case 'ffd8ffe2':
    case 'ffd8ffe3':
    case 'ffd8ffe8':
      return 'image/jpeg';
    default:
      return false;
  }
}

/** The type heic2any produces for a `toType` option: unsupported types give PNG. */
function outputType(toType: string): string {
  return SUPPORTED_MIME_TYPES.indexOf(toType) === -1 ? 'image/png' : toType;
}

async function imageToBlob(image: RgbaImage, toType: string, quality: number): Promise<Blob> {
  toType = outputType(toType);
  if (toType === 'image/png') {
    let png: Blob | null = null;
    try {
      png = await encodePngFile(image);
    } catch {
      png = null; // unexpected encoder failure: let the canvas encode this one
    }
    if (png) return png;
  }
  return canvasToBlob(image, toType, quality);
}

function canvasToBlob(image: RgbaImage, toType: string, quality: number): Promise<Blob> {
  if (quality > 1 || quality < 0) quality = 0.92;
  return new Promise((resolve, reject) => {
    let canvas: HTMLCanvasElement | null = null;
    try {
      canvas = document.createElement('canvas');
    } catch {
      /* handled below */
    }
    if (!canvas) {
      reject('ERR_CANVAS Error on converting imagedata to blob: Could not create canvas element');
      return;
    }
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject('ERR_CANVAS Error on converting imagedata to blob: Could not get canvas context');
      return;
    }
    ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject('ERR_CANVAS Error on converting imagedata to blob: Could not get blob from canvas');
          return;
        }
        resolve(blob);
      },
      toType,
      quality,
    );
  });
}

/**
 * Frames for the GIF encoder at the first image's size. Like gifshot, images of a different
 * size are drawn scaled onto a canvas of that size. Returns null if no canvas is available.
 */
function gifFrames(images: RgbaImage[]): GifFrame[] | null {
  const { width, height } = images[0];
  if (images.every((img) => img.width === width && img.height === height)) return images;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return images.map((img) => {
    if (img.width === width && img.height === height) return img;
    const src = document.createElement('canvas');
    src.width = img.width;
    src.height = img.height;
    src.getContext('2d')?.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    ctx.drawImage(src, 0, 0, width, height);
    return { data: ctx.getImageData(0, 0, width, height).data, width, height };
  });
}

/**
 * Converts HEIC/HEIF images to PNG, JPEG or GIF in the browser.
 *
 * Drop-in replacement for the `heic2any` npm package: same options, same defaults, same
 * resolved values and the same `{ code, message }` rejections — with no dependencies and
 * nothing executed until it is called (safe to import during SSR).
 */
function heic2any({
  blob,
  toType = 'image/png',
  quality = 0.92,
  gifInterval = 0.4,
  multiple = undefined,
}: Heic2AnyOptions): Promise<Blob | Blob[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const buffer = reader.result as ArrayBuffer;
      const readableType = browserReadableType(buffer);
      if (readableType) {
        reject(toHeic2AnyError(`ERR_USER Image is already browser readable: ${readableType}`));
        return;
      }
      decode(buffer)
        .then((images) => Promise.all(images.map((image) => imageToBlob(image, toType, quality))).then((blobs) => ({ images, blobs })))
        .then(async ({ images, blobs }) => {
          if (toType === 'image/gif') {
            const { width, height } = images[0];
            const frames = gifFrames(images);
            if (!frames) {
              // same text heic2any produces for gifshot's canvas check (it reads an undefined field)
              reject(toHeic2AnyError('ERR_GIF canvas undefined'));
              return;
            }
            // The GIF encoder is only downloaded when GIF output is requested.
            const { encodeGif } = await import('./gif/encodeGif');
            const gif = encodeGif(frames, width, height, gifInterval);
            resolve(new Blob([gif as BlobPart], { type: 'image/gif' }));
          } else if (multiple) {
            resolve(blobs);
          } else {
            resolve(blobs[0]);
          }
        })
        .catch((e: unknown) => reject(toHeic2AnyError(e)));
    };
    // Like the original, a non-Blob argument makes readAsArrayBuffer throw synchronously,
    // which rejects this promise with the browser's TypeError.
    reader.readAsArrayBuffer(blob);
  });
}

export default heic2any;
