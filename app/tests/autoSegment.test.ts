import { describe, expect, it } from 'vitest';
import { bestChannel, cropLowResMask } from '../src/ai/maskDecode';
import { partitionProposals, samplePoints } from '../src/select/autoSegment';
import type { Proposal } from '../src/select/autoSegment';
import { UNASSIGNED } from '../src/splats/groups';

const SETTINGS = { maxCoverage: 0.5, minSplats: 2, maxOverlap: 0.5 };
const proposal = (indices: number[], score = 1): Proposal => ({
  indices: Uint32Array.from(indices),
  score,
});

describe('samplePoints', () => {
  it('lays a centred grid over the view with nothing on the edge', () => {
    const points = samplePoints(400, 200, 4);
    expect(points).toHaveLength(16);
    expect(points[0]).toEqual({ x: 50, y: 25 });
    expect(points.at(-1)).toEqual({ x: 350, y: 175 });
    for (const point of points) {
      expect(point.x).toBeGreaterThan(0);
      expect(point.x).toBeLessThan(400);
      expect(point.y).toBeGreaterThan(0);
      expect(point.y).toBeLessThan(200);
    }
  });

  it('never degenerates below a 2×2 grid', () => {
    expect(samplePoints(100, 100, 0)).toHaveLength(4);
  });
});

describe('partitionProposals', () => {
  it('produces a partition: every splat lands in at most one group', () => {
    const result = partitionProposals(
      [proposal([0, 1, 2, 3]), proposal([6, 7, 8]), proposal([10, 11])],
      12,
      12,
      SETTINGS,
    );
    expect(result.groups).toHaveLength(3);
    const counts = new Map<number, number>();
    for (const id of result.ids) if (id !== UNASSIGNED) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect([...counts.values()]).toEqual([4, 3, 2]);
    expect(result.assigned).toBe(9);
  });

  it('takes the tightest first, so an over-inclusive blob cannot swallow real objects', () => {
    // Two distinct objects, plus one confident blob spanning both and the gap between.
    const objectA = proposal([0, 1, 2]);
    const objectB = proposal([8, 9, 10]);
    const blob = proposal([0, 1, 2, 4, 5, 6, 8, 9, 10]);
    const result = partitionProposals([blob, objectA, objectB], 20, 40, SETTINGS);

    // Both objects survive as their own groups...
    expect(result.groups.length).toBeGreaterThanOrEqual(2);
    expect(result.ids[0]).toBe(0);
    expect(result.ids[8]).toBe(1);
    expect(result.ids[0]).not.toBe(result.ids[8]);
    // ...and the blob did not take either of them.
    expect(result.ids[1]).toBe(result.ids[0]);
    expect(result.ids[9]).toBe(result.ids[8]);
  });

  it('rejects a proposal that covers most of the layer — that is the background', () => {
    const background = proposal([...Array(9).keys()]);
    const object = proposal([10, 11, 12]);
    const result = partitionProposals([background, object], 20, 10, SETTINGS);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.count).toBe(3);
    expect(result.ids[0]).toBe(UNASSIGNED);
  });

  it('keeps a partly-overlapping proposal but only its unclaimed splats', () => {
    const first = proposal([0, 1, 2, 3, 4, 5]);
    // Same size, so ordering is stable: three of six already taken = 50 % overlap, which
    // is not *above* maxOverlap, so it is kept with the three that are free.
    const overlapping = proposal([3, 4, 5, 6, 7, 8]);
    const result = partitionProposals([first, overlapping], 20, 40, SETTINGS);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[1]!.count).toBe(3);
    expect(result.ids[3]).toBe(0);
    expect(result.ids[6]).toBe(1);
  });

  it('drops what is left of a proposal once overlap is removed and too little remains', () => {
    // The tight proposal claims first; the wider one is left with only splats 6 and 7.
    const tight = proposal([0, 1, 2, 3, 4, 5]);
    const wider = proposal([0, 1, 2, 3, 4, 5, 6, 7]);
    const result = partitionProposals([wider, tight], 20, 40, { ...SETTINGS, minSplats: 3 });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.count).toBe(6);
    expect(result.ids[6]).toBe(UNASSIGNED);
    expect(result.ids[7]).toBe(UNASSIGNED);
  });

  it('returns nothing for no proposals', () => {
    const result = partitionProposals([], 10, 10, SETTINGS);
    expect(result.groups).toHaveLength(0);
    expect(result.assigned).toBe(0);
    expect([...result.ids].every((id) => id === UNASSIGNED)).toBe(true);
  });
});

describe('cropLowResMask', () => {
  it('keeps the image corner of a padded mask and thresholds at logit zero', () => {
    // One 4×4 mask whose valid region is the top-left 3×2, with positive logits on the
    // left column of each valid row and in the padding (which must be discarded).
    const side = 4;
    const logits = new Float32Array(side * side).fill(-1);
    const set = (r: number, c: number): void => void (logits[r * side + c] = 1);
    set(0, 0);
    set(1, 0);
    set(0, 3); // padding column
    set(3, 0); // padding row
    const mask = cropLowResMask(logits, side, 0, 0, 1, { width: 3, height: 2 });

    expect(mask.width).toBe(3);
    expect(mask.height).toBe(2);
    expect([...mask.data]).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('indexes the right prompt and channel out of a batched block', () => {
    const side = 2;
    const channels = 3;
    const prompts = 2;
    const logits = new Float32Array(prompts * channels * side * side).fill(-1);
    // Prompt 1, channel 2 is fully set; nothing else is.
    const base = (1 * channels + 2) * side * side;
    for (let i = 0; i < side * side; i += 1) logits[base + i] = 1;

    const wanted = cropLowResMask(logits, side, 1, 2, channels, { width: 2, height: 2 });
    expect([...wanted.data]).toEqual([1, 1, 1, 1]);
    const other = cropLowResMask(logits, side, 0, 2, channels, { width: 2, height: 2 });
    expect([...other.data]).toEqual([0, 0, 0, 0]);
  });

  it('clamps a valid region larger than the mask', () => {
    const logits = new Float32Array(4).fill(1);
    const mask = cropLowResMask(logits, 2, 0, 0, 1, { width: 99, height: 99 });
    expect(mask.width).toBe(2);
    expect(mask.height).toBe(2);
  });
});

describe('bestChannel', () => {
  it('picks the highest-scoring channel for the given prompt', () => {
    const scores = [0.1, 0.9, 0.3, /* prompt 1: */ 0.8, 0.2, 0.4];
    expect(bestChannel(scores, 0, 3)).toBe(1);
    expect(bestChannel(scores, 1, 3)).toBe(0);
  });
});
