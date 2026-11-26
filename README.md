# heic2any-lite

Convert HEIC/HEIF images (iPhone photos) to **PNG, JPEG or GIF in the browser**.

A drop-in replacement for [`heic2any`](https://github.com/alexcorvi/heic2any): same function, same options, same
results and the same error objects. Underneath it has its own HEIF parser and HEVC decoder written in TypeScript,
with no dependencies and no WebAssembly.

|                         | `heic2any` 0.0.4                    | `heic2any-lite`                                  |
| ----------------------- | ----------------------------------- | --------------------------------------------------- |
| Size (minified)         | 1.35 MB                             | 127 KB; the ESM entry is ~6 KB, the rest loads on first use |
| PNG files               | canvas encoder (RGBA, light compression) | own lossless encoder: same pixels, ~35% smaller files |
| On import               | starts a Web Worker, sets `window.__heic2any__worker` | does nothing (SSR-safe, tree-shakeable) |
| Decoding                | Web Worker (libde265 via asm.js)    | Web Worker, started on first use, closed after 30 s idle |
| CSP blocks `blob:` workers | conversion fails                 | falls back to the main thread, yielding so the page stays responsive |
| Pixel accuracy          | its libde265 build mis-decodes some samples | bit-exact with the browser's hardware HEVC decoder |
| Module formats          | UMD                                 | ESM (code-split) + UMD (CommonJS / AMD / `<script>`) |
| Decode without a DOM    | no                                  | `decodeHeicToRgba()` works in workers and Node      |

## Install

```sh
npm install heic2any-lite
```

## Migrating from heic2any

Change the import. Nothing else changes.

```diff
- import heic2any from 'heic2any';
+ import heic2any from 'heic2any-lite';
```

CommonJS (`require('heic2any-lite')` and `require(...).default`), AMD and the `window.heic2any` global work the
same way as before.

## Usage

```ts
import heic2any from 'heic2any-lite';

const png = (await heic2any({ blob: file })) as Blob;                                  // PNG
const jpeg = (await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.8 })) as Blob;
const all = (await heic2any({ blob: file, multiple: true })) as Blob[];               // every image in the file
const gif = (await heic2any({ blob: file, toType: 'image/gif', gifInterval: 0.5 })) as Blob; // animated if several
```

Plain `<script>` tag (no bundler):

```html
<script src="https://cdn.jsdelivr.net/npm/heic2any-lite@1/dist/heic2any.min.js"></script>
<script>
  heic2any({ blob }).then((png) => { /* ... */ });
</script>
```

### `heic2any(options): Promise<Blob | Blob[]>`

| Option        | Type     | Default       | Meaning |
| ------------- | -------- | ------------- | ------- |
| `blob`        | `Blob`   | (required)    | The HEIC/HEIF file. |
| `toType`      | `string` | `'image/png'` | `'image/png'`, `'image/jpeg'` or `'image/gif'`. Any other value gives PNG. |
| `quality`     | `number` | `0.92`        | JPEG quality, 0 to 1. Values outside that range use 0.92. |
| `multiple`    | `true`   | (not set)     | Resolve with an array holding every top-level image instead of only the first. |
| `gifInterval` | `number` | `0.4`         | Seconds per frame when `toType` is `'image/gif'`. Every image in the file becomes a frame. |

It resolves with a `Blob`, or `Blob[]` when `multiple` is set (a GIF is always one `Blob`).

It rejects with `{ code, message }`, like heic2any:

| `code` | `ERROR_CODES` | Example `message` |
| ------ | ------------- | ----------------- |
| 1 | `USER`    | `ERR_USER Image is already browser readable: image/png` |
| 2 | `LIBHEIF` | `ERR_LIBHEIF format not supported` |
| 3 | `GIF`     | `ERR_GIF ...` |
| 4 | `DOM`     | `ERR_DOM ...` |
| 5 | `CANVAS`  | `ERR_CANVAS Error on converting imagedata to blob: ...` |
| 0 | `UNKNOWN` | anything else |

```ts
import heic2any, { ERROR_CODES, type Heic2AnyError } from 'heic2any-lite';

try {
  await heic2any({ blob: file });
} catch (e) {
  if ((e as Heic2AnyError).code === ERROR_CODES.USER) {
    // already a PNG/JPEG/GIF: use the file as it is
  }
}
```

### `decodeHeicToRgba(data, options?): Promise<RgbaImage[]>`

Decodes every top-level image to `{ width, height, data: Uint8ClampedArray }` RGBA pixels, with no canvas.
Use it in a Web Worker, in Node, or to draw the pixels yourself. Pass `{ yieldBetweenTiles: false }` when you
are not on a page's main thread.

## What it decodes

- HEIC/HEIF still images: single images, grids (`grid`, the format iPhones use), overlays (`iovl`) and derived
  images (`iden`), with rotation (`irot`), mirroring (`imir`) and cropping (`clap`) applied.
- HEVC Main, Main Still Picture and Main 10 (8 to 12 bit, converted to 8-bit output), 4:2:0 and monochrome.
- Like heic2any, it ignores alpha and depth auxiliary images and EXIF orientation.
- It does not support 4:2:2/4:4:4 chroma or the HEVC range-extension coding tools. These files reject with
  `ERR_LIBHEIF Error while processing single image ...` (heic2any cannot convert them either).

## Output compared with heic2any

The API, option handling, colour conversion (same coefficients, nearest chroma sample) and error objects all
reproduce heic2any. The decoded pixels are **not** byte-identical to heic2any, deliberately. The libde265 build
inside heic2any 0.0.4 mis-decodes some samples along sharp edges (about 4% of samples in the test image are off
by up to 22 luma / 63 chroma levels). This library matches the browser's own hardware HEVC decoder exactly, and
`npm run test:browser` checks that. In practice the two outputs look the same (PSNR ≈ 45 dB).

### PNG size

heic2any makes PNGs with `canvas.toBlob()`. Browsers tune that encoder for speed: it always stores an alpha
channel and compresses lightly. This library encodes PNGs itself, in the worker. It writes RGB when every pixel
is opaque (always true for HEIC photos) and picks the best PNG filter for every row. Deflate is the browser's
own `CompressionStream`, so no compression code is bundled. The pixels are exactly the same. Only the file is
smaller:

| Photo (Edge 158)        | HEIC    | PNG from canvas | PNG from this library |
| ----------------------- | ------- | --------------- | --------------------- |
| iPhone, 5712×4284       | 2.47 MB | 29.0 MB         | 19.1 MB (−34%)        |
| 4000×3000               | 1.44 MB | 19.0 MB         | 12.5 MB (−34%)        |

This compression needs more CPU than the canvas's, so the image is cut into strips that are compressed in
parallel on a small worker pool (one worker per core minus one, at most 8). The strips are joined into the single
stream PNG requires, so the file is byte-identical whatever the core count. For the 24 MP photo above, encoding
takes about 1.4 s with 8 workers, about the same as the canvas, and about 2.6 s on a 4-core device (canvas: about
1 s). Decoding the HEIC (3 to 5 s) is unchanged. Browsers without `CompressionStream`
(before Chrome 80, Firefox 113 and Safari 16.4) get the canvas PNG as before. A PNG is still several times
bigger than the HEIC, because the HEIC is lossy and the PNG is not. If you don't need lossless output,
`toType: 'image/jpeg'` at the default quality of 0.92 is about the size of the HEIC (3.05 MB for the first
photo).

## Content-Security-Policy

Decoding runs in a Web Worker created from a `blob:` URL, as heic2any's does. If your CSP has `worker-src`
(or `script-src` as its fallback) without `blob:`, the worker cannot start. The library then decodes on the main
thread and pauses between tiles so the page stays responsive. Add `blob:` to `worker-src` to keep decoding off
the main thread.

## Development

```sh
npm install
npm test              # unit tests (jest): HEIF parser, HEVC decoder, PNG and GIF encoders, worker protocol, API
npm run typecheck
npm run build         # dist/esm (ESM), dist/heic2any.js + .min.js (UMD), dist/types
npm run test:dist     # the built UMD and ESM files, in Node
npm run test:browser  # real Edge/Chrome: worker, CSP fallback, hardware-decoder bit-exactness,
                      # comparison with the original heic2any (installed as a devDependency)
```

`npm publish` runs the type-check, the unit tests, the build and the dist tests first (`prepublishOnly`).

## License

MIT © Darshit Mehta & kanha vishwakarma. It reproduces the API of [heic2any](https://github.com/alexcorvi/heic2any) and the GIF
output of gifshot/omggif (all MIT). See [LICENSE](LICENSE) for the third-party notices.
