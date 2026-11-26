import { decodeHeicToRgba, type RgbaImage } from '../decodeHeic';
import { encodePngStrip, type PngStripJob, type PngStripResult } from '../png/encodePng';

/** A request to a library worker. */
export type WorkerMessage = { kind: 'decode'; buffer: ArrayBuffer } | { kind: 'png-strip'; job: PngStripJob };
export type WorkerRequest = WorkerMessage & { id: number };

/** Runs one worker request; `transfer` lists the result's buffers to hand over without copying. */
export async function runWorkerTask(
  request: WorkerRequest,
): Promise<{ result: RgbaImage[] | PngStripResult; transfer: Transferable[] }> {
  if (request.kind === 'png-strip') {
    const result = await encodePngStrip(request.job);
    return { result, transfer: [result.chunk.buffer] };
  }
  const images = await decodeHeicToRgba(request.buffer, { yieldBetweenTiles: false });
  return { result: images, transfer: images.map((img) => img.data.buffer) };
}
