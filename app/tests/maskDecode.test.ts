import { describe, expect, it } from 'vitest';
import { bestCandidate, decodeMasks, maskArea, pointsToImageSpace } from '../src/ai/maskDecode';

describe('decodeMasks', () => {
  it('splits a [1, 3, h, w] tensor into one mask per candidate', () => {
    // Three 2×2 candidates: the first empty, the second full, the third a diagonal.
    const data = Uint8Array.from([0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1]);
    const result = decodeMasks(data, [1, 3, 2, 2], [0.1, 0.9, 0.4]);

    expect(result.masks).toHaveLength(3);
    expect(result.masks.every((mask) => mask.width === 2 && mask.height === 2)).toBe(true);
    expect([...result.masks[0]!.data]).toEqual([0, 0, 0, 0]);
    expect([...result.masks[1]!.data]).toEqual([1, 1, 1, 1]);
    expect([...result.masks[2]!.data]).toEqual([1, 0, 0, 1]);
    expect(result.scores).toEqual([0.1, 0.9, 0.4]);
    expect(result.best).toBe(1);
  });

  it('copies rather than viewing, so masks outlive the tensor buffer', () => {
    const data = Uint8Array.from([1, 1, 0, 0]);
    const result = decodeMasks(data, [1, 1, 2, 2], [1]);
    data.fill(0);
    expect([...result.masks[0]!.data]).toEqual([1, 1, 0, 0]);
  });

  it('survives a single-candidate tensor and a short score list', () => {
    const result = decodeMasks(Uint8Array.from([1, 0, 0, 1]), [1, 1, 2, 2], []);
    expect(result.masks).toHaveLength(1);
    expect(result.scores).toEqual([]);
    expect(result.best).toBe(0);
  });
});

describe('bestCandidate', () => {
  it('finds the highest score and keeps the first on a tie', () => {
    expect(bestCandidate([0.2, 0.9, 0.5])).toBe(1);
    expect(bestCandidate([0.5, 0.5])).toBe(0);
    expect(bestCandidate([])).toBe(0);
  });
});

describe('maskArea', () => {
  it('counts set pixels', () => {
    expect(maskArea({ data: Uint8Array.from([1, 0, 1, 1]), width: 2, height: 2 })).toBe(3);
    expect(maskArea({ data: new Uint8Array(4), width: 2, height: 2 })).toBe(0);
  });
});

describe('pointsToImageSpace', () => {
  it('scales canvas clicks into the captured image and labels them', () => {
    const mapped = pointsToImageSpace(
      [
        { x: 100, y: 50, positive: true },
        { x: 20, y: 10, positive: false },
      ],
      0.5,
      2,
    );
    expect(mapped.points).toEqual([
      [50, 100],
      [10, 20],
    ]);
    // SAM reads 1 as "include this" and 0 as "exclude this".
    expect(mapped.labels).toEqual([1, 0]);
  });
});
