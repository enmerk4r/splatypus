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
