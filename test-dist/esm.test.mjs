// Smoke test of the built ESM entry (Node resolves it through package.json "exports").
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import heic2any, { decodeHeicToRgba, ERROR_CODES } from 'heic2any-lite';

const sample = new Uint8Array(readFileSync(new URL('../src/__fixtures__/sample.heic', import.meta.url)));
const sha = (d) => createHash('sha256').update(d).digest('hex');

assert.equal(typeof heic2any, 'function');
assert.equal(ERROR_CODES.CANVAS, 5);
const [img] = await decodeHeicToRgba(sample);
assert.deepEqual([img.width, img.height], [800, 600]);

// same pixels as the CommonJS build
const cjs = createRequire(import.meta.url)('heic2any-lite');
const [ref] = await cjs.decodeHeicToRgba(sample);
assert.equal(sha(img.data), sha(ref.data), 'ESM and UMD builds decode identically');

// rejections keep heic2any's message strings
await assert.rejects(decodeHeicToRgba(new Uint8Array(64)), (e) => e === 'ERR_LIBHEIF format not supported');
console.log('ESM OK');
