/**
 * @jest-environment node
 */
import { decodeHeicToRgba } from '../decodeHeic';
import { loadSample } from '../__fixtures__/heifBuilder';

describe('server-side / Node usage', () => {
  it('can be imported without window, document or Worker (unlike heic2any, which creates a Worker on import)', async () => {
    expect(typeof window).toBe('undefined');
    const mod = await import('..');
    expect(typeof mod.default).toBe('function');
  });

  it('decodes in Node (no DOM needed for decoding)', async () => {
    const [img] = await decodeHeicToRgba(loadSample());
    expect([img.width, img.height, img.data.length]).toEqual([800, 600, 800 * 600 * 4]);
  });
});
