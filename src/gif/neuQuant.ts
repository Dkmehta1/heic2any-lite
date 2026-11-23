/*
 * NeuQuant Neural-Net Quantization Algorithm
 * Copyright (c) 1994 Anthony Dekker
 *
 * NEUQUANT Neural-Net quantization algorithm by Anthony Dekker, 1994. See
 * "Kohonen neural networks for optimal colour quantization" in "Network:
 * Computation in Neural Systems" Vol. 5 (1994) pp 351-367.
 *
 * Any party obtaining a copy of these files from the author, directly or
 * indirectly, is granted, free of charge, a full and unrestricted irrevocable,
 * world-wide, paid up, royalty-free, nonexclusive right and license to deal in
 * this software and documentation files (the "Software"), including without
 * limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons who
 * receive copies from any such party to do so, with the only requirement being
 * that this copyright notice remain intact.
 *
 * TypeScript implementation that keeps the exact arithmetic (including floating-point
 * learning-rate updates) of the JavaScript variant used by gifshot 0.4.5, so that
 * palettes — and therefore GIF bytes — match the original heic2any output for the same pixels.
 */

const NETSIZE = 256;
const PRIME1 = 499;
const PRIME2 = 491;
const PRIME3 = 487;
const PRIME4 = 503;
const MIN_PICTURE_BYTES = 3 * PRIME4;
const MAX_NET_POS = NETSIZE - 1;
const NET_BIAS_SHIFT = 4;
const N_CYCLES = 100;
const INT_BIAS_SHIFT = 16;
const INT_BIAS = 1 << INT_BIAS_SHIFT;
const GAMMA_SHIFT = 10;
const BETA_SHIFT = 10;
const BETA = INT_BIAS >> BETA_SHIFT;
const BETA_GAMMA = INT_BIAS << (GAMMA_SHIFT - BETA_SHIFT);
const INIT_RAD = NETSIZE >> 3;
const RADIUS_BIAS_SHIFT = 6;
const RADIUS_BIAS = 1 << RADIUS_BIAS_SHIFT;
const INIT_RADIUS = INIT_RAD * RADIUS_BIAS;
const RADIUS_DEC = 30;
const ALPHA_BIAS_SHIFT = 10;
const INIT_ALPHA = 1 << ALPHA_BIAS_SHIFT;
const RAD_BIAS_SHIFT = 8;
const RAD_BIAS = 1 << RAD_BIAS_SHIFT;
const ALPHA_RAD_BIAS = 1 << (ALPHA_BIAS_SHIFT + RAD_BIAS_SHIFT);

export class NeuQuant {
  private readonly network: number[][] = [];
  private readonly netindex: number[] = [];
  private readonly bias: number[] = [];
  private readonly freq: number[] = [];
  private readonly radpower: number[] = [];
  private samplefac: number;

  /** `pixels` holds 3 components per pixel; `length` is the number of components. */
  constructor(
    private readonly pixels: ArrayLike<number>,
    private readonly length: number,
    sampleFactor: number,
  ) {
    this.samplefac = sampleFactor;
    for (let i = 0; i < NETSIZE; i++) {
      const v = ((i << (NET_BIAS_SHIFT + 8)) / NETSIZE) | 0;
      this.network[i] = [v, v, v, 0];
      this.freq[i] = (INT_BIAS / NETSIZE) | 0;
      this.bias[i] = 0;
    }
  }

  /** Runs the network and returns the 256-colour palette as [c0, c1, c2, ...] triples. */
  process(): number[] {
    this.learn();
    this.unbiasnet();
    this.inxbuild();
    return this.colorMap();
  }

  private colorMap(): number[] {
    const map: number[] = [];
    const index: number[] = new Array(NETSIZE);
    for (let i = 0; i < NETSIZE; i++) index[this.network[i][3]] = i;
    for (let l = 0; l < NETSIZE; l++) {
      const n = this.network[index[l]];
      map.push(n[0], n[1], n[2]);
    }
    return map;
  }

  private inxbuild(): void {
    const { network, netindex } = this;
    let previouscol = 0;
    let startpos = 0;
    for (let i = 0; i < NETSIZE; i++) {
      const p = network[i];
      let smallpos = i;
      let smallval = p[1];
      for (let j = i + 1; j < NETSIZE; j++) {
        if (network[j][1] < smallval) {
          smallpos = j;
          smallval = network[j][1];
        }
      }
      const q = network[smallpos];
      if (i !== smallpos) {
        for (let c = 0; c < 4; c++) {
          const t = q[c];
          q[c] = p[c];
          p[c] = t;
        }
      }
      if (smallval !== previouscol) {
        netindex[previouscol] = (startpos + i) >> 1;
        for (let j = previouscol + 1; j < smallval; j++) netindex[j] = i;
        previouscol = smallval;
        startpos = i;
      }
    }
    netindex[previouscol] = (startpos + MAX_NET_POS) >> 1;
    for (let j = previouscol + 1; j < 256; j++) netindex[j] = MAX_NET_POS;
  }

  private learn(): void {
    const p = this.pixels;
    const lengthcount = this.length;
    if (lengthcount < MIN_PICTURE_BYTES) this.samplefac = 1;
    const alphadec = 30 + (this.samplefac - 1) / 3;
    const samplepixels = lengthcount / (3 * this.samplefac);
    let delta = (samplepixels / N_CYCLES) | 0;
    let alpha = INIT_ALPHA;
    let radius = INIT_RADIUS;
    let rad = radius >> RADIUS_BIAS_SHIFT;
    if (rad <= 1) rad = 0;
    for (let i = 0; i < rad; i++) this.radpower[i] = alpha * (((rad * rad - i * i) * RAD_BIAS) / (rad * rad));

    let step: number;
    if (lengthcount < MIN_PICTURE_BYTES) step = 3;
    else if (lengthcount % PRIME1 !== 0) step = 3 * PRIME1;
    else if (lengthcount % PRIME2 !== 0) step = 3 * PRIME2;
    else if (lengthcount % PRIME3 !== 0) step = 3 * PRIME3;
    else step = 3 * PRIME4;

    let pix = 0;
    let i = 0;
    while (i < samplepixels) {
      const b = (p[pix] & 0xff) << NET_BIAS_SHIFT;
      const g = (p[pix + 1] & 0xff) << NET_BIAS_SHIFT;
      const r = (p[pix + 2] & 0xff) << NET_BIAS_SHIFT;
      const j = this.contest(b, g, r);
      this.altersingle(alpha, j, b, g, r);
      if (rad !== 0) this.alterneigh(rad, j, b, g, r);
      pix += step;
      if (pix >= lengthcount) pix -= lengthcount;
      i++;
      if (delta === 0) delta = 1;
      if (i % delta === 0) {
        alpha -= alpha / alphadec;
        radius -= radius / RADIUS_DEC;
        rad = radius >> RADIUS_BIAS_SHIFT;
        if (rad <= 1) rad = 0;
        for (let k = 0; k < rad; k++) this.radpower[k] = alpha * (((rad * rad - k * k) * RAD_BIAS) / (rad * rad));
      }
    }
  }

  /** Index of the palette entry closest to the given components. */
  map(b: number, g: number, r: number): number {
    const { network } = this;
    let bestd = 1000;
    let best = -1;
    let i = this.netindex[g];
    let j = i - 1;
    while (i < NETSIZE || j >= 0) {
      if (i < NETSIZE) {
        const p = network[i];
        let dist = p[1] - g;
        if (dist >= bestd) {
          i = NETSIZE;
        } else {
          i++;
          if (dist < 0) dist = -dist;
          let a = p[0] - b;
          if (a < 0) a = -a;
          dist += a;
          if (dist < bestd) {
            a = p[2] - r;
            if (a < 0) a = -a;
            dist += a;
            if (dist < bestd) {
              bestd = dist;
              best = p[3];
            }
          }
        }
      }
      if (j >= 0) {
        const p = network[j];
        let dist = g - p[1];
        if (dist >= bestd) {
          j = -1;
        } else {
          j--;
          if (dist < 0) dist = -dist;
          let a = p[0] - b;
          if (a < 0) a = -a;
          dist += a;
          if (dist < bestd) {
            a = p[2] - r;
            if (a < 0) a = -a;
            dist += a;
            if (dist < bestd) {
              bestd = dist;
              best = p[3];
            }
          }
        }
      }
    }
    return best;
  }

  private unbiasnet(): void {
    for (let i = 0; i < NETSIZE; i++) {
      const n = this.network[i];
      n[0] >>= NET_BIAS_SHIFT;
      n[1] >>= NET_BIAS_SHIFT;
      n[2] >>= NET_BIAS_SHIFT;
      n[3] = i;
    }
  }

  private alterneigh(rad: number, i: number, b: number, g: number, r: number): void {
    let lo = i - rad;
    if (lo < -1) lo = -1;
    let hi = i + rad;
    if (hi > NETSIZE) hi = NETSIZE;
    let j = i + 1;
    let k = i - 1;
    let m = 1;
    while (j < hi || k > lo) {
      const a = this.radpower[m++];
      if (j < hi) {
        const p = this.network[j++];
        p[0] -= ((a * (p[0] - b)) / ALPHA_RAD_BIAS) | 0;
        p[1] -= ((a * (p[1] - g)) / ALPHA_RAD_BIAS) | 0;
        p[2] -= ((a * (p[2] - r)) / ALPHA_RAD_BIAS) | 0;
      }
      if (k > lo) {
        const p = this.network[k--];
        p[0] -= ((a * (p[0] - b)) / ALPHA_RAD_BIAS) | 0;
        p[1] -= ((a * (p[1] - g)) / ALPHA_RAD_BIAS) | 0;
        p[2] -= ((a * (p[2] - r)) / ALPHA_RAD_BIAS) | 0;
      }
    }
  }

  private altersingle(alpha: number, i: number, b: number, g: number, r: number): void {
    const n = this.network[i];
    const alphaMult = alpha / INIT_ALPHA;
    n[0] -= (alphaMult * (n[0] - b)) | 0;
    n[1] -= (alphaMult * (n[1] - g)) | 0;
    n[2] -= (alphaMult * (n[2] - r)) | 0;
  }

  private contest(b: number, g: number, r: number): number {
    const { network, bias, freq } = this;
    let bestd = ~(1 << 31);
    let bestbiasd = bestd;
    let bestpos = -1;
    let bestbiaspos = bestpos;
    for (let i = 0; i < NETSIZE; i++) {
      const n = network[i];
      let dist = n[0] - b;
      if (dist < 0) dist = -dist;
      let a = n[1] - g;
      if (a < 0) a = -a;
      dist += a;
      a = n[2] - r;
      if (a < 0) a = -a;
      dist += a;
      if (dist < bestd) {
        bestd = dist;
        bestpos = i;
      }
      const biasdist = dist - (bias[i] >> (INT_BIAS_SHIFT - NET_BIAS_SHIFT));
      if (biasdist < bestbiasd) {
        bestbiasd = biasdist;
        bestbiaspos = i;
      }
      const betafreq = freq[i] >> BETA_SHIFT;
      freq[i] -= betafreq;
      bias[i] += betafreq << GAMMA_SHIFT;
    }
    freq[bestpos] += BETA;
    bias[bestpos] -= BETA_GAMMA;
    return bestbiaspos;
  }
}
