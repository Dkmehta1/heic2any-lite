/**
 * The worker's code is bundled into this library as a string at build time (see build.mjs)
 * and started from a Blob URL, the same technique the original heic2any uses. This works
 * with every bundler, with CommonJS, and from a plain <script> tag, without the consumer
 * having to serve a separate worker file.
 *
 * If the page's Content-Security-Policy does not allow `blob:` workers, `new Worker` throws or
 * the worker fails to start; workerDecoder.ts then reports WorkerUnavailableError and
 * heic2any decodes on the main thread instead.
 */
declare const __HEIC2ANY_WORKER_SOURCE__: string;

let objectUrl: string | null = null;

export function createDecodeWorker(): Worker {
  if (typeof __HEIC2ANY_WORKER_SOURCE__ === 'undefined') {
    throw new Error('worker source was not bundled (running from unbuilt sources)');
  }
  // One URL for the life of the page: the worker is re-created from it after idle shutdown.
  if (!objectUrl) {
    objectUrl = URL.createObjectURL(new Blob([__HEIC2ANY_WORKER_SOURCE__], { type: 'text/javascript' }));
  }
  return new Worker(objectUrl, { name: 'heic2any-decoder' });
}
