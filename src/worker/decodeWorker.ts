/**
 * Web Worker entry: decodes HEIC/HEIF files off the main thread.
 * Request: { id, buffer }. Response: { id, images } (pixel buffers transferred) or { id, error }.
 */
import { decodeHeicToRgba } from '../decodeHeic';

interface WorkerScope {
  onmessage: ((ev: MessageEvent<{ id: number; buffer: ArrayBuffer }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (ev) => {
  const { id, buffer } = ev.data;
  decodeHeicToRgba(buffer, { yieldBetweenTiles: false }).then(
    (images) =>
      scope.postMessage(
        { id, images },
        images.map((img) => img.data.buffer),
      ),
    (error: unknown) => scope.postMessage({ id, error: typeof error === 'string' ? error : String(error) }),
  );
};
