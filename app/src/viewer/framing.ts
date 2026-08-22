import { Box3, Vector3 } from 'three';
import type { SplatMesh } from '@sparkjsdev/spark';

export interface RobustBounds {
  center: Vector3;
  radius: number;
  min: Vector3;
  max: Vector3;
}

const MAX_SAMPLES = 200_000;

function percentile(values: number[], fraction: number): number {
  values.sort((a, b) => a - b);
  const index = Math.min(values.length - 1, Math.floor((values.length - 1) * fraction));
  return values[index] ?? 0;
}

export function getRobustBounds(mesh: SplatMesh): RobustBounds {
  mesh.updateWorldMatrix(true, false);
  const stride = Math.max(1, Math.ceil(mesh.numSplats / MAX_SAMPLES));
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const worldCenter = new Vector3();

  mesh.forEachSplat((index, center) => {
    if (index % stride !== 0) return;
    worldCenter.copy(center).applyMatrix4(mesh.matrixWorld);
    xs.push(worldCenter.x);
    ys.push(worldCenter.y);
    zs.push(worldCenter.z);
  });

  if (xs.length === 0) {
    return {
      center: new Vector3(),
      radius: 1,
      min: new Vector3(-1, -1, -1),
      max: new Vector3(1, 1, 1),
    };
  }

  // Percentile bounds prevent a handful of scan floaters from ruining framing.
  const min = new Vector3(percentile(xs, 0.02), percentile(ys, 0.02), percentile(zs, 0.02));
  const max = new Vector3(percentile(xs, 0.98), percentile(ys, 0.98), percentile(zs, 0.98));
  const box = new Box3(min, max);
  const center = box.getCenter(new Vector3());
  const radius = Math.max(box.getSize(new Vector3()).length() / 2, 0.01);
  return { center, radius, min, max };
}
