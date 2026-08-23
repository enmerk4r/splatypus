import { describe, expect, it } from 'vitest';
import { cropFrame, softmax } from '../src/ai/framePixels';
import { allPhrases, nameOf, REJECT_PHRASES, VOCABULARY } from '../src/ai/vocabulary';

/** A width×height RGBA frame whose red channel encodes row-major position. */
function frame(
  width: number,
  height: number,
): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = i;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

describe('cropFrame', () => {
  it('cuts out exactly the requested rectangle', () => {
    // 4×4 frame; take the 2×2 block at (1, 1) → source pixels 5, 6, 9, 10.
    const crop = cropFrame(frame(4, 4), { x: 1, y: 1, width: 2, height: 2 });
    expect(crop.width).toBe(2);
    expect(crop.height).toBe(2);
    expect([crop.data[0], crop.data[4], crop.data[8], crop.data[12]]).toEqual([5, 6, 9, 10]);
  });

  it('grows the rectangle by the padding fraction', () => {
    // A 2×2 rect padded by 50 % gains one pixel on each side.
    const crop = cropFrame(frame(8, 8), { x: 3, y: 3, width: 2, height: 2 }, 0.5);
    expect(crop.width).toBe(4);
    expect(crop.height).toBe(4);
  });

  it('clamps to the frame rather than reading outside it', () => {
    const crop = cropFrame(frame(4, 4), { x: 0, y: 0, width: 2, height: 2 }, 2);
    expect(crop.width).toBe(4);
    expect(crop.height).toBe(4);
    // Top-left of the clamped crop is still source pixel 0.
    expect(crop.data[0]).toBe(0);
  });

  it('never returns an empty image for a degenerate rectangle', () => {
    const crop = cropFrame(frame(4, 4), { x: 2, y: 2, width: 0, height: 0 });
    expect(crop.width).toBeGreaterThanOrEqual(1);
    expect(crop.height).toBeGreaterThanOrEqual(1);
    expect(crop.data.length).toBe(crop.width * crop.height * 4);
  });
});

describe('softmax', () => {
  it('produces a distribution that sums to one', () => {
    const probabilities = softmax([0.26, 0.22, 0.21]);
    expect(probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(probabilities[0]).toBeGreaterThan(probabilities[1]!);
  });

  it("separates CLIP's narrow similarity band into usable confidences", () => {
    // Raw cosine similarities differ by 0.04, which is meaningless as a confidence.
    // At CLIP's trained temperature that becomes a decisive margin.
    const raw = [0.26, 0.22];
    expect(raw[0]! - raw[1]!).toBeLessThan(0.05);
    const probabilities = softmax(raw);
    expect(probabilities[0]!).toBeGreaterThan(0.9);
  });

  it('is stable for large inputs rather than overflowing to NaN', () => {
    const probabilities = softmax([10, 9.5], 100);
    expect(probabilities.every((value) => Number.isFinite(value))).toBe(true);
    expect(probabilities[0]).toBeCloseTo(1, 6);
  });
});

describe('vocabulary', () => {
  it('offers every label plus the reject classes, in that order', () => {
    const phrases = allPhrases();
    expect(phrases).toHaveLength(VOCABULARY.length + REJECT_PHRASES.length);
    expect(phrases.every((phrase) => phrase.startsWith('a photo of '))).toBe(true);
  });

  it('maps a vocabulary index to its display name', () => {
    expect(nameOf(0)).toBe(VOCABULARY[0]!.name);
  });

  it('gives no name for a reject class, so nothing is labelled on a bad match', () => {
    expect(nameOf(VOCABULARY.length)).toBeUndefined();
    expect(nameOf(VOCABULARY.length + REJECT_PHRASES.length - 1)).toBeUndefined();
  });

  it('lets several phrasings share one display name', () => {
    // Monitor and television look nothing alike to CLIP but mean the same to a user.
    const monitors = VOCABULARY.filter((entry) => entry.name === 'Monitor');
    expect(monitors.length).toBeGreaterThan(1);
    expect(new Set(monitors.map((entry) => entry.phrase)).size).toBe(monitors.length);
  });
});
