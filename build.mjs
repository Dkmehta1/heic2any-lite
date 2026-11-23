// Builds every output of the package:
//   dist/esm/          ESM for bundlers (code-split: decoder, GIF encoder and worker load on demand)
//   dist/heic2any.js   UMD (CommonJS / AMD / window.heic2any) — same entry point as the original package
//   dist/heic2any.min.js  minified UMD for <script> tags and CDNs
// Type declarations are emitted separately by `tsc -p tsconfig.build.json` (see package.json).
import { build } from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';

const TARGET = 'es2017';
const pkg = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8'));
const banner = `/*! ${pkg.name} v${pkg.version} | MIT | NeuQuant (c) 1994 Anthony Dekker */`;

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

// 1. The worker, as one self-contained classic script (classic, not module, so it also runs in
//    browsers without module-worker support). It is embedded in the library as a string.
const worker = await build({
  entryPoints: ['src/worker/decodeWorker.ts'],
  bundle: true,
  format: 'iife',
  minify: true,
  target: TARGET,
  write: false,
  legalComments: 'none',
});
const workerSource = worker.outputFiles[0].text;
const define = { __HEIC2ANY_WORKER_SOURCE__: JSON.stringify(workerSource) };

// 2. ESM for bundlers.
await build({
  entryPoints: { index: 'src/index.ts' },
  outdir: 'dist/esm',
  bundle: true,
  splitting: true,
  format: 'esm',
  target: TARGET,
  define,
  banner: { js: banner },
  chunkNames: 'chunks/[name]-[hash]',
  outExtension: { '.js': '.mjs' },
  legalComments: 'inline',
});

// 3. UMD, readable and minified.
const UMD_HEAD = `(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
    module.exports.default = module.exports;
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root = typeof globalThis !== 'undefined' ? globalThis : root || self;
    root.heic2any = factory();
  }
})(this, function () {
`;
const UMD_TAIL = `
return __heic2any.default;
});
`;
for (const minify of [false, true]) {
  const umd = await build({
    entryPoints: ['src/umd.ts'],
    bundle: true,
    format: 'iife',
    globalName: '__heic2any',
    minify,
    target: TARGET,
    define,
    write: false,
    legalComments: 'none',
  });
  const body = umd.outputFiles[0].text.replace(/^"use strict";\s*/, '');
  const file = minify ? 'dist/heic2any.min.js' : 'dist/heic2any.js';
  await writeFile(file, `${banner}\n"use strict";\n${UMD_HEAD}${body}${UMD_TAIL}`);
}

console.log(`built dist/ (worker ${(workerSource.length / 1024).toFixed(1)} KiB)`);
