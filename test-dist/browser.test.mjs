// Real-browser check of dist/heic2any.min.js loaded with a <script> tag:
//  - PNG / JPEG / GIF / `multiple` / unsupported-type conversions run in the Blob-URL worker
//  - conversions still work when the page's CSP blocks blob: workers (main-thread fallback)
//  - same { code, message } rejections as heic2any
//  - decoded pixels are bit-exact with the browser's own (hardware) HEVC decoder via WebCodecs
//  - if the original heic2any bundle is available: same API behaviour, visually equivalent output
//
// Usage: node test-dist/browser.test.mjs [path/to/original/heic2any.min.js]
// Uses the installed Microsoft Edge (or Chrome) through playwright-core; no browser download.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
// the original package (devDependency heic2any@0.0.4), or a path given on the command line
const ORIGINAL = process.argv[2] ?? createRequire(import.meta.url).resolve('heic2any/dist/heic2any.min.js');
const sample = readFileSync(here('../src/__fixtures__/sample.heic'));

/** Payload of the only box of this type in the fixture (it has a single coded image). */
function boxPayload(type) {
  const at = sample.indexOf(Buffer.from(type));
  assert.ok(at >= 4 && sample.indexOf(Buffer.from(type), at + 1) === -1, `one ${type} box in the fixture`);
  return sample.subarray(at + 4, at - 4 + sample.readUInt32BE(at - 4));
}

const files = {
  '/new.js': readFileSync(here('../dist/heic2any.min.js')),
  '/orig.js': existsSync(ORIGINAL) ? readFileSync(ORIGINAL) : null,
  '/sample.heic': sample,
  '/hvcC.bin': boxPayload('hvcC'), // HEVC decoder configuration
  '/hevc.bin': boxPayload('mdat'), // the image's length-prefixed NAL units
};

const page = (libs) => `<!doctype html><meta charset="utf-8"><script>
  const RealWorker = window.Worker;
  window.__workers = 0;
  window.__cspBlocked = 0;
  document.addEventListener('securitypolicyviolation', () => window.__cspBlocked++);
  window.Worker = function (...args) { window.__workers++; return new RealWorker(...args); };
</script>${libs.map((l) => `<script src="/${l}.js"></script><script>window.${l}Lib = window.heic2any;</script>`).join('')}`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/page') {
    const headers = { 'content-type': 'text/html' };
    if (url.searchParams.get('csp')) headers['content-security-policy'] = "worker-src 'self'";
    res.writeHead(200, headers).end(page(url.searchParams.get('libs').split(',')));
  } else if (files[url.pathname]) {
    res.writeHead(200, { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    res.end(files[url.pathname]);
  } else res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let browser;
for (const channel of ['msedge', 'chrome']) {
  try {
    browser = await chromium.launch({ channel });
    console.log(`browser : ${channel} ${browser.version()}`);
    break;
  } catch {
    /* try next */
  }
}
if (!browser) throw new Error('Neither Microsoft Edge nor Google Chrome is installed');

async function open(libs, csp = false) {
  const tab = await browser.newPage();
  const errors = [];
  tab.on('pageerror', (e) => errors.push(String(e)));
  await tab.goto(`${base}/page?libs=${libs.join(',')}${csp ? '&csp=1' : ''}`);
  return { tab, errors };
}

/** Runs every conversion with the library stored at window[libName]. */
async function convertAll(tab, libName) {
  return tab.evaluate(async (libName) => {
    const lib = window[libName];
    const hash = async (b) =>
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await b.arrayBuffer())), (x) => x.toString(16).padStart(2, '0')).join('').slice(0, 16);
    const describe = async (b) => ({ type: b.type, size: b.size, sha: await hash(b) });
    const blob = await (await fetch('/sample.heic')).blob();
    const workersBefore = window.__workers;
    const t0 = performance.now();
    const png = await lib({ blob });
    const ms = Math.round(performance.now() - t0);
    const jpeg = await lib({ blob, toType: 'image/jpeg', quality: 0.5 });
    const gif = await lib({ blob, toType: 'image/gif' });
    const multiple = await lib({ blob, multiple: true });
    const bmp = await lib({ blob, toType: 'image/bmp' }); // unsupported type -> PNG, like heic2any
    const errors = [];
    for (const bad of [png, new Blob([new Uint8Array(64)])]) {
      try {
        await lib({ blob: bad });
        errors.push('resolved');
      } catch (e) {
        errors.push(`${e.code}: ${e.message}`);
      }
    }
    const bitmap = await createImageBitmap(png);
    return {
      workersUsed: window.__workers - workersBefore,
      ms,
      dims: [bitmap.width, bitmap.height],
      png: await describe(png),
      jpeg: await describe(jpeg),
      gif: await describe(gif),
      multiple: Array.isArray(multiple) ? await Promise.all(multiple.map(describe)) : 'not an array',
      bmp: await describe(bmp),
      errors,
    };
  }, libName);
}

try {
  // 1. conversions in the worker
  const { tab, errors } = await open(['new']);
  assert.equal(await tab.evaluate(() => window.__workers), 0, 'loading the script must not start a worker');
  const fresh = await convertAll(tab, 'newLib');
  console.log('worker  :', JSON.stringify(fresh));
  assert.equal(fresh.workersUsed, 1, 'decoding runs in one shared worker');
  assert.deepEqual(fresh.dims, [800, 600]);
  assert.equal(fresh.png.type, 'image/png');
  assert.equal(fresh.jpeg.type, 'image/jpeg');
  assert.equal(fresh.gif.type, 'image/gif');
  assert.equal(fresh.bmp.type, 'image/png');
  assert.equal(fresh.multiple.length, 1);
  assert.equal(fresh.multiple[0].sha, fresh.png.sha);
  assert.deepEqual(fresh.errors, [
    '1: ERR_USER Image is already browser readable: image/png',
    '2: ERR_LIBHEIF format not supported',
  ]);

  // 2. pixels vs the browser's own HEVC decoder (WebCodecs), converted with heic2any's formula
  const hw = await tab.evaluate(async () => {
    const description = new Uint8Array(await (await fetch('/hvcC.bin')).arrayBuffer());
    const data = new Uint8Array(await (await fetch('/hevc.bin')).arrayBuffer());
    const config = { codec: 'hvc1.1.6.L93.B0', description };
    if (typeof VideoDecoder === 'undefined' || !(await VideoDecoder.isConfigSupported(config)).supported) return null;
    const frame = await new Promise((resolve, reject) => {
      const decoder = new VideoDecoder({ output: resolve, error: reject });
      decoder.configure(config);
      decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data }));
      decoder.flush().catch(reject);
    });
    const { codedWidth: w, codedHeight: h, format } = frame;
    const buf = new Uint8Array(frame.allocationSize());
    const layout = await frame.copyTo(buf);
    frame.close();
    if (format !== 'NV12' && format !== 'I420') return { format };
    const chroma = (x, y, plane) =>
      format === 'NV12'
        ? buf[layout[1].offset + (y >> 1) * layout[1].stride + (x >> 1) * 2 + plane]
        : buf[layout[1 + plane].offset + (y >> 1) * layout[1 + plane].stride + (x >> 1)];
    const ref = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const A = 1.164 * (buf[layout[0].offset + y * layout[0].stride + x] - 16);
        const e = chroma(x, y, 0) - 128;
        const r = chroma(x, y, 1) - 128;
        const o = (y * w + x) * 4;
        ref[o] = A + 1.596 * r;
        ref[o + 1] = A - 0.813 * r - 0.391 * e;
        ref[o + 2] = A + 2.018 * e;
        ref[o + 3] = 255;
      }
    }
    const heic = new Uint8Array(await (await fetch('/sample.heic')).arrayBuffer());
    const [ours] = await newLib.decodeHeicToRgba(heic);
    let differing = 0;
    for (let i = 0; i < ref.length; i++) if (ref[i] !== ours.data[i]) differing++;
    return { format, size: [w, h], differing };
  });
  if (!hw) {
    console.log('hardware: this browser has no WebCodecs HEVC decoder; bit-exactness check skipped');
  } else {
    console.log('hardware:', JSON.stringify(hw));
    assert.equal(hw.differing, 0, 'decoded pixels are bit-exact with the browser HEVC decoder');
  }
  assert.deepEqual(errors, []);
  await tab.close();

  // 3. CSP without blob: workers -> main-thread fallback, same output
  const cspPage = await open(['new'], true);
  const csp = await convertAll(cspPage.tab, 'newLib');
  assert.ok((await cspPage.tab.evaluate(() => window.__cspBlocked)) > 0, 'the browser really blocked the blob: worker');
  console.log('csp     :', JSON.stringify(csp));
  for (const key of ['png', 'jpeg', 'gif']) assert.equal(csp[key].sha, fresh[key].sha, `fallback ${key} = worker ${key}`);
  await cspPage.tab.close();

  // 4. against the original heic2any: same behaviour; pixels visually equivalent. They are not
  //    bit-identical because the libde265 build inside heic2any 0.0.4 mis-decodes some edge
  //    samples (it disagrees with the hardware decoder, which this library matches exactly).
  if (files['/orig.js']) {
    const both = await open(['new', 'orig']);
    const orig = await convertAll(both.tab, 'origLib');
    console.log('original:', JSON.stringify(orig));
    for (const key of ['png', 'jpeg', 'gif', 'bmp']) assert.equal(fresh[key].type, orig[key].type, `${key} type`);
    assert.deepEqual(fresh.dims, orig.dims);
    assert.equal(fresh.multiple.length, orig.multiple.length);
    assert.deepEqual(fresh.errors, orig.errors, 'same rejections as the original heic2any');
    const psnr = await both.tab.evaluate(async () => {
      const blob = await (await fetch('/sample.heic')).blob();
      const pixels = async (lib) => {
        const bmp = await createImageBitmap(await lib({ blob }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      };
      const a = await pixels(newLib);
      const b = await pixels(origLib);
      let se = 0;
      for (let i = 0; i < a.length; i++) if ((i & 3) !== 3) se += (a[i] - b[i]) ** 2;
      return 10 * Math.log10((255 * 255) / (se / ((a.length / 4) * 3)));
    });
    console.log(`original: PSNR vs this library ${psnr.toFixed(1)} dB; decode ${fresh.ms} ms vs ${orig.ms} ms`);
    assert.ok(psnr > 40, 'visually equivalent to the original');
    await both.tab.close();
  } else {
    console.log('original heic2any not found: comparison skipped');
  }
  console.log('BROWSER OK');
} finally {
  await browser.close();
  server.close();
}
