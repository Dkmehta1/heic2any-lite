/**
 * Web Worker entry: decodes HEIC/HEIF files and encodes PNG strips off the main thread.
 * Request: WorkerRequest (see workerTask.ts). Response: { id, result } (buffers transferred) or { id, error }.
 */
import { runWorkerTask, type WorkerRequest } from './workerTask';

interface WorkerScope {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (ev) => {
  const { id } = ev.data;
  runWorkerTask(ev.data).then(
    ({ result, transfer }) => scope.postMessage({ id, result }, transfer),
    (error: unknown) => scope.postMessage({ id, error: typeof error === 'string' ? error : String(error) }),
  );
};
