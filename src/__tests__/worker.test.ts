import { createHash } from 'crypto';
import { decodeHeicToRgba, MSG_FORMAT_NOT_SUPPORTED } from '../decodeHeic';
import { encodePng } from '../png/encodePng';
import { runWorkerTask, type WorkerRequest } from '../worker/workerTask';
import { loadSample } from '../__fixtures__/heifBuilder';

/**
 * jsdom has no Worker. A fake worker runs the real worker logic in-process so the
 * request/response protocol, error mapping and fallbacks are tested; the real browser
 * worker is covered by the demo/consumer checks.
 */
type MockMode = 'ok' | 'crash-on-start' | 'throw-on-create' | 'only-one-worker';
let mockMode: MockMode = 'ok';
let mockCreated = 0;
let mockAttempts = 0;
let mockTerminated = 0;

class MockWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: { message: string; preventDefault: () => void }) => void) | null = null;

  constructor() {
    mockCreated++;
  }

  postMessage(msg: WorkerRequest): void {
    setTimeout(async () => {
      if (mockMode === 'crash-on-start') {
        this.onerror?.({ message: 'Failed to load worker script', preventDefault: () => undefined });
        return;
      }
      try {
        const { result } = await runWorkerTask(msg);
        this.onmessage?.({ data: { id: msg.id, result } });
      } catch (e) {
        this.onmessage?.({ data: { id: msg.id, error: e } });
      }
    }, 0);
  }

  terminate(): void {
    mockTerminated++;
  }
}

jest.mock('../worker/createDecodeWorker', () => ({
  createDecodeWorker: () => {
    mockAttempts++;
    if (mockMode === 'throw-on-create') throw new Error('Refused by Content-Security-Policy');
    if (mockMode === 'only-one-worker' && mockCreated >= 1) throw new Error('Too many workers');
    return new MockWorker();
  },
}));

// eslint-disable-next-line import/first
import { WorkerUnavailableError, decodeInWorker, encodePngStripInWorker, poolSize, resetWorkerForTests } from '../worker/workerDecoder';

const sha = (d: ArrayLike<number>): string => createHash('sha256').update(Buffer.from(d as Uint8Array)).digest('hex');
const sampleBuffer = (): ArrayBuffer => loadSample().slice().buffer;

beforeEach(() => {
  mockMode = 'ok';
  mockCreated = 0;
  mockAttempts = 0;
  mockTerminated = 0;
  resetWorkerForTests();
});

describe('worker decoding', () => {
  it('returns the same pixels as main-thread decoding', async () => {
    const [img] = await decodeInWorker(sampleBuffer());
    const [ref] = await decodeHeicToRgba(sampleBuffer());
    expect([img.width, img.height]).toEqual([800, 600]);
    expect(sha(img.data)).toBe(sha(ref.data));
  });

  it('uses one worker per core minus one, between 1 and 8', () => {
    const cores = jest.spyOn(navigator, 'hardwareConcurrency', 'get');
    try {
      for (const [n, expected] of [[1, 1], [2, 1], [4, 3], [16, 8]]) {
        cores.mockReturnValue(n);
        expect(poolSize()).toBe(expected);
      }
    } finally {
      cores.mockRestore();
    }
  });

  it('keeps using the workers it has when another one cannot start, without retrying for every strip', async () => {
    const g = globalThis as { CompressionStream?: unknown };
    g.CompressionStream = (await import('stream/web')).CompressionStream;
    const cores = jest.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(8);
    try {
      mockMode = 'only-one-worker';
      const image = { width: 400, height: 6000, data: new Uint8ClampedArray(400 * 6000 * 4).fill(200) }; // 7 strips
      const png = await encodePng(image, { concurrency: poolSize(), runStrip: encodePngStripInWorker });
      expect(png!.type).toBe('image/png');
      expect(mockCreated).toBe(1);
      expect(mockAttempts).toBe(2); // the first worker, then one failed attempt
    } finally {
      cores.mockRestore();
      delete g.CompressionStream;
    }
  });

  it('encodes PNG strips on several workers, producing the same file as one thread', async () => {
    const g = globalThis as { CompressionStream?: unknown };
    g.CompressionStream = (await import('stream/web')).CompressionStream;
    const cores = jest.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(4);
    const bytes = (blob: Blob) =>
      new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(sha(new Uint8Array(reader.result as ArrayBuffer)));
        reader.readAsArrayBuffer(blob);
      });
    try {
      // a tall image, so it has several strips
      const [img] = await decodeHeicToRgba(sampleBuffer());
      const tall = { width: 400, height: 3000, data: new Uint8ClampedArray(400 * 3000 * 4) };
      for (let y = 0; y < tall.height; y++) {
        const src = ((y % 600) * 800 + 200) * 4;
        tall.data.set(img.data.subarray(src, src + 400 * 4), y * 400 * 4);
      }
      const parallel = await encodePng(tall, { concurrency: poolSize(), runStrip: encodePngStripInWorker });
      expect(mockCreated).toBe(3);
      const local = await encodePng(tall);
      expect(await bytes(parallel!)).toBe(await bytes(local!));
    } finally {
      cores.mockRestore();
      delete g.CompressionStream;
    }
  });

  it('reuses one worker for concurrent and later requests', async () => {
    await Promise.all([decodeInWorker(sampleBuffer()), decodeInWorker(sampleBuffer())]);
    await decodeInWorker(sampleBuffer());
    expect(mockCreated).toBe(1);
  });

  it('passes decoder errors through unchanged (no main-thread retry needed)', async () => {
    await expect(decodeInWorker(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).rejects.toBe(MSG_FORMAT_NOT_SUPPORTED);
  });

  it('reports WorkerUnavailableError when the worker cannot be mockCreated', async () => {
    mockMode = 'throw-on-create';
    await expect(decodeInWorker(sampleBuffer())).rejects.toBeInstanceOf(WorkerUnavailableError);
  });

  it('reports WorkerUnavailableError when the worker crashes, and stays disabled afterwards', async () => {
    mockMode = 'crash-on-start';
    await expect(decodeInWorker(sampleBuffer())).rejects.toBeInstanceOf(WorkerUnavailableError);
    expect(mockTerminated).toBe(1);
    mockMode = 'ok';
    await expect(decodeInWorker(sampleBuffer())).rejects.toBeInstanceOf(WorkerUnavailableError);
  });

  it('closes the worker after 30 seconds idle to release its memory, and starts a new one when needed', async () => {
    jest.useFakeTimers();
    try {
      const first = decodeInWorker(sampleBuffer());
      await jest.advanceTimersByTimeAsync(1); // the fake worker answers on a timer
      await first;
      await jest.advanceTimersByTimeAsync(29_000);
      expect(mockTerminated).toBe(0);
      await jest.advanceTimersByTimeAsync(1_001);
      expect(mockTerminated).toBe(1);
      const second = decodeInWorker(sampleBuffer());
      await jest.advanceTimersByTimeAsync(1);
      await second;
      expect(mockCreated).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('heic2any with a Worker available', () => {
  class FakeImageData {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  }
  const realCreateElement = document.createElement.bind(document);

  beforeAll(() => {
    (globalThis as unknown as { Worker: unknown }).Worker = MockWorker;
    (globalThis as unknown as { ImageData: unknown }).ImageData = FakeImageData;
  });
  afterAll(() => {
    delete (globalThis as unknown as { Worker?: unknown }).Worker;
  });
  beforeEach(() => {
    jest.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
      tag === 'canvas'
        ? ({
            width: 0,
            height: 0,
            getContext: () => ({ putImageData: () => undefined }),
            toBlob: (cb: (b: Blob) => void, type: string) => cb(new Blob(['x'], { type })),
          } as unknown as HTMLElement)
        : realCreateElement(tag)) as typeof document.createElement);
  });
  afterEach(() => jest.restoreAllMocks());

  const run = async (): Promise<Blob> => {
    const { default: heic2any } = await import('..');
    return (await heic2any({ blob: new Blob([loadSample() as BlobPart]), toType: 'image/jpeg' })) as Blob;
  };

  it('decodes in the worker', async () => {
    expect((await run()).type).toBe('image/jpeg');
    expect(mockCreated).toBe(1);
  });

  it.each(['crash-on-start', 'throw-on-create'] as MockMode[])('falls back to the main thread when the worker fails (%s)', async (m) => {
    mockMode = m;
    expect((await run()).type).toBe('image/jpeg');
  });

  it('keeps heic2any error objects when decoding fails inside the worker', async () => {
    const { default: heic2any } = await import('..');
    await expect(heic2any({ blob: new Blob(['definitely not heic']) })).rejects.toEqual({
      code: 2,
      message: 'ERR_LIBHEIF format not supported',
    });
  });
});
