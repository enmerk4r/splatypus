import { describe, expect, it } from 'vitest';
import { SplatStore } from '../src/model/SplatStore';

function store(count = 4): SplatStore {
  return new SplatStore({
    count,
    centers: Float32Array.from({ length: count * 3 }, (_, index) => index),
    scales: new Float32Array(count * 3).fill(0.25),
    rotations: Float32Array.from({ length: count * 4 }, (_, index) => (index % 4 === 3 ? 1 : 0)),
    opacities: new Float32Array(count).fill(0.8),
    colors: new Float32Array(count * 3).fill(0.5),
    shDegree: 0,
  });
}

describe('SplatStore', () => {
  it('slices, compacts, and concatenates without dead splats', () => {
    const first = store();
    first.alive[1] = 0;
    const compacted = first.compacted();
    expect(compacted.count).toBe(3);
    expect([...compacted.centers]).toEqual([0, 1, 2, 6, 7, 8, 9, 10, 11]);
    const selected = first.slice(new Uint32Array([3, 0]));
    expect([...selected.centers]).toEqual([9, 10, 11, 0, 1, 2]);
    expect(SplatStore.concat([first, selected], 0).count).toBe(5);
  });

  it('pads lower-degree SH by channel when concatenating', () => {
    const source = store(1);
    const low = new SplatStore({
      count: 1,
      centers: source.centers,
      scales: source.scales,
      rotations: source.rotations,
      opacities: source.opacities,
      colors: source.colors,
      shDegree: 1,
      shRest: Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    });
    const merged = SplatStore.concat([low], 3);
    expect([...merged.shRest!.slice(0, 15)]).toEqual([1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...merged.shRest!.slice(15, 30)]).toEqual([
      4, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it('computes percentile bounds over live centers', () => {
    const value = store(100);
    value.alive[99] = 0;
    const bounds = value.computeRobustBounds(1);
    expect(bounds.min[0]).toBe(3);
    expect(bounds.max[0]).toBe(288);
    expect(bounds.radius).toBeGreaterThan(1);
  });
});
