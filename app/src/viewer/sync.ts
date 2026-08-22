import { setPackedSplat, SplatMesh, utils } from '@sparkjsdev/spark';
import type { Layer } from '../model/Layer';
import { shCoefficients } from '../model/SplatStore';

export const LOD_ABOVE_SPLATS = 1_500_000;

function encodeSh(layer: Layer, packedIndex: number, storeIndex: number): void {
  const { packedSplats } = layer.mesh;
  const { shDegree, shRest } = layer.store;
  if (!packedSplats || shDegree === 0 || !shRest) return;
  const perChannel = shCoefficients(shDegree) / 3;
  const readBand = (offset: number, count: number): Float32Array => {
    const values = new Float32Array(count * 3);
    for (let coefficient = 0; coefficient < count; coefficient += 1)
      for (let channel = 0; channel < 3; channel += 1)
        values[coefficient * 3 + channel] =
          shRest[storeIndex * perChannel * 3 + channel * perChannel + offset + coefficient] ?? 0;
    return values;
  };
  utils.encodeSh1Rgb(
    packedSplats.ensureSplatsSh(1, layer.store.liveCount()),
    packedIndex,
    readBand(0, 3),
  );
  if (shDegree >= 2)
    utils.encodeSh2Rgb(
      packedSplats.ensureSplatsSh(2, layer.store.liveCount()),
      packedIndex,
      readBand(3, 5),
    );
  if (shDegree >= 3)
    utils.encodeSh3Rgb(
      packedSplats.ensureSplatsSh(3, layer.store.liveCount()),
      packedIndex,
      readBand(8, 7),
    );
}

export async function syncLayer(layer: Layer): Promise<number> {
  if (!layer.dirty) return 0;
  const started = performance.now();
  const live = layer.store.liveCount();
  const previous = layer.mesh;
  const packedToStore = new Uint32Array(live);
  const mesh = new SplatMesh({
    maxSplats: live,
    raycastable: true,
    constructSplats: (splats) => {
      const packed = splats.ensureSplats(live);
      let packedIndex = 0;
      for (let storeIndex = 0; storeIndex < layer.store.count; storeIndex += 1) {
        if (!layer.store.alive[storeIndex]) continue;
        const i3 = storeIndex * 3;
        const i4 = storeIndex * 4;
        setPackedSplat(
          packed,
          packedIndex,
          layer.store.centers[i3] ?? 0,
          layer.store.centers[i3 + 1] ?? 0,
          layer.store.centers[i3 + 2] ?? 0,
          layer.store.scales[i3] ?? 1,
          layer.store.scales[i3 + 1] ?? 1,
          layer.store.scales[i3 + 2] ?? 1,
          layer.store.rotations[i4] ?? 0,
          layer.store.rotations[i4 + 1] ?? 0,
          layer.store.rotations[i4 + 2] ?? 0,
          layer.store.rotations[i4 + 3] ?? 1,
          layer.store.opacities[storeIndex] ?? 1,
          layer.store.colors[i3] ?? 0.5,
          layer.store.colors[i3 + 1] ?? 0.5,
          layer.store.colors[i3 + 2] ?? 0.5,
        );
        packedToStore[packedIndex] = storeIndex;
        packedIndex += 1;
      }
      splats.numSplats = live;
      splats.needsUpdate = true;
    },
  });
  layer.replaceMesh(mesh, packedToStore);
  await mesh.initialized;
  for (let packedIndex = 0; packedIndex < packedToStore.length; packedIndex += 1)
    encodeSh(layer, packedIndex, packedToStore[packedIndex] ?? 0);
  mesh.packedSplats?.setMaxSh(layer.store.shDegree);
  if (mesh.packedSplats) mesh.packedSplats.needsUpdate = true;
  if (live >= LOD_ABOVE_SPLATS) await mesh.createLodSplats();
  previous.removeFromParent();
  previous.dispose();
  layer.dirty = false;
  return performance.now() - started;
}
