import type { RgbaImage } from '../decodeHeic';
import { createDecodeWorker } from './createDecodeWorker';

/** Rejection used when the worker itself cannot run (CSP, failed chunk load, crash). */
export class WorkerUnavailableError extends Error {
  constructor(reason: string) {
    super(`heic2any worker unavailable: ${reason}`);
    this.name = 'WorkerUnavailableError';
  }
}

/** The worker is closed after this much idle time to give its memory back. */
const IDLE_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (images: RgbaImage[]) => void;
  reject: (reason: unknown) => void;
}

let worker: Worker | null = null;
let disabled = false;
let nextId = 1;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<number, Pending>();

function shutdown(reason: string): void {
  disabled = true;
  worker?.terminate();
  worker = null;
  const error = new WorkerUnavailableError(reason);
  pending.forEach((p) => p.reject(error));
  pending.clear();
}

function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size === 0 && worker) {
      worker.terminate();
      worker = null;
    }
  }, IDLE_TIMEOUT_MS);
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = createDecodeWorker();
  w.onmessage = (ev: MessageEvent<{ id: number; images?: RgbaImage[]; error?: string }>) => {
    const { id, images, error } = ev.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error !== undefined) p.reject(error);
    else p.resolve(images as RgbaImage[]);
    if (pending.size === 0) scheduleIdleShutdown();
  };
  w.onerror = (ev: ErrorEvent) => {
    ev.preventDefault?.();
    shutdown(ev.message || 'worker error');
  };
  worker = w;
  return w;
}

/**
 * Decodes in a shared Web Worker. Rejects with the decoder's message string for bad files
 * (same as the main-thread decoder), or with WorkerUnavailableError when no worker can run,
 * in which case the caller should decode on the main thread instead.
 */
export function decodeInWorker(buffer: ArrayBuffer): Promise<RgbaImage[]> {
  if (disabled) return Promise.reject(new WorkerUnavailableError('disabled after an earlier failure'));
  return new Promise<RgbaImage[]>((resolve, reject) => {
    let w: Worker;
    try {
      w = getWorker();
    } catch (e) {
      shutdown(e instanceof Error ? e.message : String(e));
      reject(new WorkerUnavailableError(e instanceof Error ? e.message : String(e)));
      return;
    }
    if (idleTimer) clearTimeout(idleTimer);
    const id = nextId++;
    pending.set(id, { resolve, reject });
    // structured clone (not transfer) keeps the caller's buffer usable for a main-thread retry
    w.postMessage({ id, buffer });
  });
}

/** Test hook: forget the current worker and failure state. */
export function resetWorkerForTests(): void {
  worker?.terminate();
  worker = null;
  disabled = false;
  pending.clear();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}
