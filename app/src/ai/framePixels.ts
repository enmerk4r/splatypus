/**
 * Pixel plumbing between a WebGL readback and an image a model can consume.
 *
 * Kept separate from `Viewer` because this is the part that can be tested: the capture
 * itself needs a GL context, but the two transforms it applies afterwards do not, and they
 * are where the off-by-one bugs live.
 */

export interface FrameImage {
  /** RGBA, row-major, top-left origin. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Reverses row order. WebGL's framebuffer origin is bottom-left and every image API in the
 * browser is top-left, so a readback that skips this arrives upside down.
 */
export function flipRows(rgba: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const stride = width * 4;
  const flipped = new Uint8ClampedArray(rgba.length);
  for (let row = 0; row < height; row += 1) {
    const from = row * stride;
    flipped.set(rgba.subarray(from, from + stride), (height - 1 - row) * stride);
  }
  return flipped;
}

/**
 * Box-filters the image down so its longest edge is at most `maxEdge`, returning the input
 * untouched when it already fits. SAM works at a fixed input resolution, so handing it a
 * 4K canvas only costs upload bandwidth.
 */
export function downscale(frame: FrameImage, maxEdge: number): FrameImage {
  const longest = Math.max(frame.width, frame.height);
  if (longest <= maxEdge || maxEdge <= 0) return frame;

  const width = Math.max(1, Math.round((frame.width * maxEdge) / longest));
  const height = Math.max(1, Math.round((frame.height * maxEdge) / longest));
  const data = new Uint8ClampedArray(width * height * 4);
  const xRatio = frame.width / width;
  const yRatio = frame.height / height;

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.min(frame.height, Math.max(y0 + 1, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(frame.width, Math.max(x0 + 1, Math.floor((x + 1) * xRatio)));
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        samples = 0;
      for (let sy = y0; sy < y1; sy += 1)
        for (let sx = x0; sx < x1; sx += 1) {
          const at = (sy * frame.width + sx) * 4;
          r += frame.data[at]!;
          g += frame.data[at + 1]!;
          b += frame.data[at + 2]!;
          a += frame.data[at + 3]!;
          samples += 1;
        }
      const out = (y * width + x) * 4;
      data[out] = r / samples;
      data[out + 1] = g / samples;
      data[out + 2] = b / samples;
      data[out + 3] = a / samples;
    }
  }
  return { data, width, height };
}

/** A rectangle in image pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Cuts a rectangle out of a frame, clamped to its bounds.
 *
 * `pad` grows the rectangle by a fraction of its own size before cutting. A classifier
 * shown a mask trimmed exactly to an object sees it with no surroundings at all, which is
 * unlike anything in its training data; a little context measurably improves the guess.
 */
export function cropFrame(frame: FrameImage, rect: Rect, pad = 0): FrameImage {
  const padX = rect.width * pad;
  const padY = rect.height * pad;
  const x0 = Math.max(0, Math.floor(rect.x - padX));
  const y0 = Math.max(0, Math.floor(rect.y - padY));
  const x1 = Math.min(frame.width, Math.ceil(rect.x + rect.width + padX));
  const y1 = Math.min(frame.height, Math.ceil(rect.y + rect.height + padY));
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);

  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const from = ((y0 + row) * frame.width + x0) * 4;
    data.set(frame.data.subarray(from, from + width * 4), row * width * 4);
  }
  return { data, width, height };
}

/**
 * Softmax over CLIP similarities.
 *
 * Raw cosine similarities sit in a narrow band -- the winner might be 0.26 against a
 * runner-up of 0.22 -- which is useless as a confidence measure. CLIP is trained with a
 * learned temperature (100) that spreads those into real probabilities, so applying it is
 * what makes a threshold meaningful rather than arbitrary.
 */
export function softmax(similarities: readonly number[], temperature = 100): number[] {
  const scaled = similarities.map((value) => value * temperature);
  const top = Math.max(...scaled);
  const exponentials = scaled.map((value) => Math.exp(value - top));
  const total = exponentials.reduce((sum, value) => sum + value, 0) || 1;
  return exponentials.map((value) => value / total);
}
