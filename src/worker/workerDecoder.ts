import type { RgbaImage } from '../decodeHeic';
import type { PngStripJob, PngStripResult } from '../png/encodePng';
import { createDecodeWorker } from './createDecodeWorker';
import type { WorkerMessage } from './workerTask';

/** Rejection used when the worker itself cannot run (CSP, failed chunk load, crash). */
export class WorkerUnavailableError extends Error {
  constructor(reason: string) {
    super(`heic2any worker unavailable: ${reason}`);
    this.name = 'WorkerUnavailableError';
  }
}

/** The workers are closed after this much idle time to give their memory back. */
const IDLE_TIMEOUT_MS = 30_000;
/** Upper bound on workers used for PNG strips, whatever the core count. */
const MAX_WORKERS = 8;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (reason: unknown) => void;
  worker: Worker;
}

/**
 * workers[0] decodes (one at a time, like the original single worker). PNG strips go to the
 * least busy worker, and more workers are started for them up to `poolSize()`.
 */
let workers: Worker[] = [];
let disabled = false;
/** Set when an extra worker failed to start; no more are tried until the pool is closed. */
let growthFailed = false;
let nextId = 1;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<number, Pending>();

/** Workers to use for parallel work: one per core, leaving one for the page, at most MAX_WORKERS. */
export function poolSize(): number {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}

function terminateAll(): void {
  workers.forEach((w) => w.terminate());
  workers = [];
  growthFailed = false;
}

function shutdown(reason: string): void {
  disabled = true;
  terminateAll();
  const error = new WorkerUnavailableError(reason);
  pending.forEach((p) => p.reject(error));
  pending.clear();
}

function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size === 0) terminateAll();
  }, IDLE_TIMEOUT_MS);
}

function spawn(): Worker {
  const w = createDecodeWorker();
  w.onmessage = (ev: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const { id, result, error } = ev.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error !== undefined) p.reject(error);
    else p.resolve(result);
    if (pending.size === 0) scheduleIdleShutdown();
  };
  w.onerror = (ev: ErrorEvent) => {
    ev.preventDefault?.();
    shutdown(ev.message || 'worker error');
  };
  workers.push(w);
  return w;
}

function load(w: Worker): number {
  let n = 0;
  pending.forEach((p) => {
    if (p.worker === w) n++;
  });
  return n;
}

function pickWorker(forDecode: boolean): Worker {
  if (!workers.length) return spawn(); // failure here means no worker can run at all
  if (forDecode) return workers[0];
  let best = workers[0];
  let bestLoad = load(best);
  for (const w of workers) {
    const l = load(w);
    if (l < bestLoad) (best = w), (bestLoad = l);
  }
  if (bestLoad > 0 && !growthFailed && workers.length < poolSize()) {
    try {
      return spawn();
    } catch {
      growthFailed = true; // could not start another one: share the existing workers from now on
    }
  }
  return best;
}

function request<T>(message: WorkerMessage, forDecode: boolean): Promise<T> {
  if (disabled) return Promise.reject(new WorkerUnavailableError('disabled after an earlier failure'));
  return new Promise<T>((resolve, reject) => {
    let w: Worker;
    try {
      w = pickWorker(forDecode);
    } catch (e) {
      shutdown(e instanceof Error ? e.message : String(e));
      reject(new WorkerUnavailableError(e instanceof Error ? e.message : String(e)));
      return;
    }
    if (idleTimer) clearTimeout(idleTimer);
    const id = nextId++;
    pending.set(id, { resolve: resolve as (result: unknown) => void, reject, worker: w });
    // structured clone (not transfer) keeps the caller's data usable for a main-thread retry
    w.postMessage({ ...message, id });
  });
}

/**
 * Decodes in a shared Web Worker. Rejects with the decoder's message string for bad files
 * (same as the main-thread decoder), or with WorkerUnavailableError when no worker can run,
 * in which case the caller should decode on the main thread instead.
 */
export function decodeInWorker(buffer: ArrayBuffer): Promise<RgbaImage[]> {
  return request<RgbaImage[]>({ kind: 'decode', buffer }, true);
}

/** Encodes one PNG strip in the worker pool (see encodePng.ts); same error contract as decodeInWorker. */
export function encodePngStripInWorker(job: PngStripJob): Promise<PngStripResult> {
  return request<PngStripResult>({ kind: 'png-strip', job }, false);
}

/** Test hook: forget the current workers and failure state. */
export function resetWorkerForTests(): void {
  terminateAll();
  disabled = false;
  pending.clear();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}
