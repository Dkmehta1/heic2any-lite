// Smoke test of the built UMD file: CommonJS require, `.default`, and the browser-global path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const dist = path.join(__dirname, '..', 'dist');
const sample = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'src', '__fixtures__', 'sample.heic')));

(async () => {
  for (const file of ['heic2any.js', 'heic2any.min.js']) {
    const lib = require(path.join(dist, file));
    assert.equal(typeof lib, 'function', `${file}: require() returns the function`);
    assert.equal(lib.default, lib, `${file}: .default is the same function`);
    assert.equal(typeof lib.decodeHeicToRgba, 'function');
    assert.equal(lib.ERROR_CODES.LIBHEIF, 2);
    const [img] = await lib.decodeHeicToRgba(sample);
    assert.deepEqual([img.width, img.height, img.data.length], [800, 600, 800 * 600 * 4]);
    console.log(`${file}: pixels sha256 ${crypto.createHash('sha256').update(img.data).digest('hex').slice(0, 16)}`);

    // <script> tag: no module/exports/define -> sets the heic2any global, touches nothing else
    const sandbox = { self: {} };
    sandbox.globalThis = sandbox.self;
    vm.runInNewContext(fs.readFileSync(path.join(dist, file), 'utf8'), sandbox);
    const globals = Object.keys(sandbox.self);
    assert.deepEqual(globals, ['heic2any'], `${file}: only window.heic2any is defined (got ${globals})`);
    assert.equal(typeof sandbox.self.heic2any, 'function');
  }
  console.log('UMD OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
