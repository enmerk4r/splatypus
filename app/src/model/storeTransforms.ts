import { Matrix4, Quaternion, Vector3 } from 'three';
import { SplatStore } from './SplatStore';

export function transformStore(source: SplatStore, matrix: Matrix4): SplatStore {
  const store = source.compacted();
  const centers = store.centers.slice();
  const scales = store.scales.slice();
  const rotations = store.rotations.slice();
  const position = new Vector3();
  const layerRotation = new Quaternion();
  const layerScale = new Vector3();
  matrix.decompose(position, layerRotation, layerScale);
  const uniformScale =
    (Math.abs(layerScale.x) + Math.abs(layerScale.y) + Math.abs(layerScale.z)) / 3;
  const center = new Vector3();
  const rotation = new Quaternion();
  for (let index = 0; index < store.count; index += 1) {
    const i3 = index * 3;
    const i4 = index * 4;
    center.set(centers[i3] ?? 0, centers[i3 + 1] ?? 0, centers[i3 + 2] ?? 0).applyMatrix4(matrix);
    centers.set(center.toArray(), i3);
    scales[i3] = (scales[i3] ?? 0) * uniformScale;
    scales[i3 + 1] = (scales[i3 + 1] ?? 0) * uniformScale;
    scales[i3 + 2] = (scales[i3 + 2] ?? 0) * uniformScale;
    rotation
      .set(
        rotations[i4] ?? 0,
        rotations[i4 + 1] ?? 0,
        rotations[i4 + 2] ?? 0,
        rotations[i4 + 3] ?? 1,
      )
      .premultiply(layerRotation)
      .normalize();
    rotations.set(rotation.toArray(), i4);
  }
  return new SplatStore({
    count: store.count,
    centers,
    scales,
    rotations,
    opacities: store.opacities.slice(),
    colors: store.colors.slice(),
    shDegree: store.shDegree,
    ...(store.shRest ? { shRest: store.shRest.slice() } : {}),
  });
}
