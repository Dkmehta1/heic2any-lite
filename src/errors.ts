/**
 * Error shape returned by heic2any: `{ code, message }` where the message starts with
 * one of the ERR_* prefixes below. The codes match the original heic2any package.
 */
export interface Heic2AnyError {
  code: number;
  message: string;
}

export const ERROR_CODES = {
  UNKNOWN: 0,
  USER: 1,
  LIBHEIF: 2,
  GIF: 3,
  DOM: 4,
  CANVAS: 5,
} as const;

const PREFIXES = ['ERR_USER', 'ERR_LIBHEIF', 'ERR_GIF', 'ERR_DOM', 'ERR_CANVAS'];

/** Same normalisation as heic2any's utils.error(). */
export function toHeic2AnyError(message: unknown): Heic2AnyError {
  let text: string;
  if (!message) {
    text = 'ERR_UNKNOWN';
  } else if (typeof message !== 'string') {
    const m = message as { toString?: () => string };
    text = m.toString ? m.toString() : JSON.stringify(message);
  } else {
    text = message;
  }
  let code = 0;
  PREFIXES.forEach((prefix, index) => {
    if (text.indexOf(prefix) === 0) code = index + 1;
  });
  return { code, message: text };
}

/** Thrown inside the decoder for malformed or unsupported bitstreams. */
export class HeicDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeicDecodeError';
  }
}
