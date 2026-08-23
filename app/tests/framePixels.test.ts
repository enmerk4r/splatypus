import { describe, expect, it } from 'vitest';
import { downscale, flipRows } from '../src/ai/framePixels';

/** An n×n RGBA image whose red channel encodes the pixel's row-major position. */
function ramp(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = i;
    data[i * 4 + 3] = 255;
  }
  return data;
}

describe('flipRows', () => {
  it('reverses row order and leaves pixels within a row alone', () => {
    // 2×2: rows are [0, 1] then [2, 3]; flipped they are [2, 3] then [0, 1].
    const flipped = flipRows(ramp(2, 2), 2, 2);
    expect([flipped[0], flipped[4], flipped[8], flipped[12]]).toEqual([2, 3, 0, 1]);
  });

  it('is its own inverse', () => {
    const original = ramp(3, 5);
    const twice = flipRows(new Uint8Array(flipRows(original, 3, 5)), 3, 5);
    expect([...twice]).toEqual([...original]);
  });
});

describe('downscale', () => {
  it('returns the frame untouched when it already fits', () => {
    const frame = { data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 };
    expect(downscale(frame, 8)).toBe(frame);
  });

  it('halves both edges and averages each 2×2 block', () => {
    const frame = { data: new Uint8ClampedArray(ramp(4, 4)), width: 4, height: 4 };
    const small = downscale(frame, 2);
    expect(small.width).toBe(2);
    expect(small.height).toBe(2);
    // Top-left averages source pixels 0, 1, 4, 5 → 2.5; bottom-right averages 10, 11, 14,
    // 15 → 12.5. Uint8ClampedArray rounds halves to even, so those store as 2 and 12.
    expect(small.data[0]).toBe(2);
    expect(small.data[12]).toBe(12);
  });

  it('preserves aspect ratio on a non-square frame', () => {
    const frame = { data: new Uint8ClampedArray(400 * 100 * 4), width: 400, height: 100 };
    const small = downscale(frame, 100);
    expect(small.width).toBe(100);
    expect(small.height).toBe(25);
    expect(small.data.length).toBe(100 * 25 * 4);
  });
});
