import { setPackedSplat, SplatMesh, utils } from '@sparkjsdev/spark';
import type { PackedSplats } from '@sparkjsdev/spark';
import type { Layer } from '../model/Layer';
import { shCoefficients } from '../model/SplatStore';
import type { SplatStore } from '../model/SplatStore';

export const LOD_ABOVE_SPLATS = 1_500_000;

/**
 * Encode the store's SH coefficients (3DGS channel-major f_rest order) into Spark's
 * band-wise RGB arrays. Must run inside `constructSplats`: Spark builds its SH textures
 * lazily from `extra.sh*` the first time the mesh generator is compiled, so the arrays
 * have to exist before the mesh is first rendered.
 */
function encodeSh(splats: PackedSplats, store: SplatStore, packedToStore: Uint32Array): void {
  const { shDegree, shRest } = store;
  if (shDegree === 0 || !shRest) return;
  const live = packedToStore.length;
  const perChannel = shCoefficients(shDegree) / 3;
  const sh1 = splats.ensureSplatsSh(1, live);
  const sh2 = shDegree >= 2 ? splats.ensureSplatsSh(2, live) : undefined;
  const sh3 = shDegree >= 3 ? splats.ensureSplatsSh(3, live) : undefined;
  const band1 = new Float32Array(9);
  const band2 = new Float32Array(15);
  const band3 = new Float32Array(21);
  const readBand = (target: Float32Array, base: number, offset: number, count: number): void => {
    for (let coefficient = 0; coefficient < count; coefficient += 1)
      for (let channel = 0; channel < 3; channel += 1)
        target[coefficient * 3 + channel] =
          shRest[base + channel * perChannel + offset + coefficient] ?? 0;
  };
  for (let packedIndex = 0; packedIndex < live; packedIndex += 1) {
    const base = (packedToStore[packedIndex] ?? 0) * perChannel * 3;
    readBand(band1, base, 0, 3);
    utils.encodeSh1Rgb(sh1, packedIndex, band1);
    if (sh2) {
      readBand(band2, base, 3, 5);
      utils.encodeSh2Rgb(sh2, packedIndex, band2);
    }
    if (sh3) {
      readBand(band3, base, 8, 7);
      utils.encodeSh3Rgb(sh3, packedIndex, band3);
    }
  }
  splats.setMaxSh(shDegree);
}

/** Rebuild the layer's GPU mesh from its store. Returns the elapsed milliseconds (0 if clean). */
export async function syncLayer(layer: Layer): Promise<number> {
  if (!layer.dirty) return 0;
  // Clear first so edits made while this sync runs re-dirty the layer and trigger another pass.
  layer.dirty = false;
  const started = performance.now();
  const store = layer.store;
  const live = store.liveCount();
  const previous = layer.mesh;
  const packedToStore = new Uint32Array(live);
  const mesh = new SplatMesh({
    maxSplats: live,
    raycastable: true,
    constructSplats: (splats) => {
      const packed = splats.ensureSplats(live);
      let packedIndex = 0;
      for (let storeIndex = 0; storeIndex < store.count; storeIndex += 1) {
        if (!store.alive[storeIndex]) continue;
        const i3 = storeIndex * 3;
        const i4 = storeIndex * 4;
        setPackedSplat(
          packed,
          packedIndex,
          store.centers[i3] ?? 0,
          store.centers[i3 + 1] ?? 0,
          store.centers[i3 + 2] ?? 0,
          store.scales[i3] ?? 1,
          store.scales[i3 + 1] ?? 1,
          store.scales[i3 + 2] ?? 1,
          store.rotations[i4] ?? 0,
          store.rotations[i4 + 1] ?? 0,
          store.rotations[i4 + 2] ?? 0,
          store.rotations[i4 + 3] ?? 1,
          store.opacities[storeIndex] ?? 1,
          store.colors[i3] ?? 0.5,
          store.colors[i3 + 1] ?? 0.5,
          store.colors[i3 + 2] ?? 0.5,
        );
        packedToStore[packedIndex] = storeIndex;
        packedIndex += 1;
      }
      encodeSh(splats, store, packedToStore);
      splats.numSplats = live;
      splats.needsUpdate = true;
    },
  });
  layer.replaceMesh(mesh, packedToStore);
  await mesh.initialized;
  if (live >= LOD_ABOVE_SPLATS) await mesh.createLodSplats();
  previous.removeFromParent();
  previous.dispose();
  return performance.now() - started;
}

/**
 * Fast path for point-cloud radius changes: patch the packed scales in place instead of
 * rebuilding the mesh. Returns false when a full sync is required (e.g. a LoD tree exists,
 * which is derived from the packed data and would go stale).
 */
export function rescaleLayerInPlace(layer: Layer, scale: number): boolean {
  const packed = layer.mesh.packedSplats;
  if (!packed?.packedArray || packed.lodSplats || packed.numSplats !== layer.packedToStore.length)
    return false;
  for (let index = 0; index < packed.numSplats; index += 1)
    utils.setPackedSplatScales(packed.packedArray, index, scale, scale, scale);
  packed.needsUpdate = true;
  return true;
}
