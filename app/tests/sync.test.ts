import { expect, it } from 'vitest';
import { Layer } from '../src/model/Layer';
import { SplatStore } from '../src/model/SplatStore';

it('maps SH3 and packed indices into the Spark render cache', async () => {
  const layer = new Layer({
    name: 'SH3',
    kind: 'scan',
    sourceName: 'sh3.ply',
    store: new SplatStore({
      count: 2,
      centers: new Float32Array([0, 0, 0, 1, 2, 3]),
      scales: new Float32Array(6).fill(0.1),
      rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
      opacities: new Float32Array([0.8, 0.9]),
      colors: new Float32Array(6).fill(0.5),
      shDegree: 3,
      shRest: Float32Array.from({ length: 90 }, (_, index) => (index - 45) / 100),
    }),
  });
  await layer.sync();
  const packed = layer.mesh.packedSplats;
  expect(packed?.getNumSh()).toBe(3);
  expect(packed?.maxSh).toBe(3);
  expect(packed?.extra.sh1).toBeInstanceOf(Uint32Array);
  expect(packed?.extra.sh2).toBeInstanceOf(Uint32Array);
  expect(packed?.extra.sh3).toBeInstanceOf(Uint32Array);
  expect([...layer.packedToStore]).toEqual([0, 1]);
  layer.dispose();
});
