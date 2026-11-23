/**
 * Entry for the UMD build (dist/heic2any.js / dist/heic2any.min.js). Like the original
 * heic2any bundle, the module value is the function itself, with `.default` pointing at it,
 * so `require('heic2any-lite')`, `require(...).default`, AMD and `window.heic2any` all work.
 */
import heic2any from './heic2any';
import { decodeHeicToRgba } from './decodeHeic';
import { ERROR_CODES } from './errors';

const api = heic2any as typeof heic2any & {
  default: typeof heic2any;
  decodeHeicToRgba: typeof decodeHeicToRgba;
  ERROR_CODES: typeof ERROR_CODES;
};
api.default = heic2any;
api.decodeHeicToRgba = decodeHeicToRgba;
api.ERROR_CODES = ERROR_CODES;

export default api;
