import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Document } from '../model/Document';
import type { Layer } from '../model/Layer';
import type { SplatArrays } from '../model/SplatStore';
import { PRESETS } from './presets';
import { hashStrokeId, mulberry32, stampsFor } from './stamps';
import type { Stamp } from './stamps';
import type { Stroke, StrokeSettings } from './stroke';

export function makeWorldStamps(
  points: Float32Array,
  tangents: Float32Array,
  pressures: Float32Array,
  settings: StrokeSettings,
  viewDirs: Vector3 | Float32Array,
  strokeId: string,
): Stamp[] {
  const stamps: Stamp[] = [];
  const rng = mulberry32(hashStrokeId(strokeId));
  const preset = PRESETS[settings.preset];
  for (let index = 0; index < points.length / 3; index += 1) {
    const viewDir =
      viewDirs instanceof Vector3
        ? viewDirs
        : new Vector3().fromArray(viewDirs, index * 3).normalize();
    stamps.push(
      ...stampsFor(
        {
          p: new Vector3().fromArray(points, index * 3),
          t: new Vector3().fromArray(tangents, index * 3),
          pressure: pressures[index] ?? 1,
        },
        { dir: viewDir },
        settings,
        preset,
        rng,
      ),
    );
  }
  return stamps;
}

function worldMatrix(document: Document, layer: Layer): Matrix4 {
  document.root.updateMatrixWorld(true);
  layer.object.updateMatrix();
  if (layer.object.parent) {
    layer.object.updateMatrixWorld(true);
    return layer.object.matrixWorld.clone();
  }
  return new Matrix4().multiplyMatrices(document.root.matrixWorld, layer.object.matrix);
}

export function localiseStroke(
  document: Document,
  layer: Layer,
  stroke: Omit<Stroke, 'points' | 'range'>,
  worldPoints: Float32Array,
  stamps: readonly Stamp[],
): { stroke: Stroke; splats: SplatArrays } {
  const matrix = worldMatrix(document, layer);
  const inverse = matrix.clone().invert();
  const worldRotation = new Quaternion();
  const worldScale = new Vector3();
  matrix.decompose(new Vector3(), worldRotation, worldScale);
  const inverseRotation = worldRotation.clone().invert();
  const uniformScale = Math.max(
    (Math.abs(worldScale.x) + Math.abs(worldScale.y) + Math.abs(worldScale.z)) / 3,
    1e-9,
  );

  const points = worldPoints.slice();
  const point = new Vector3();
  for (let index = 0; index < points.length / 3; index += 1) {
    point
      .fromArray(points, index * 3)
      .applyMatrix4(inverse)
      .toArray(points, index * 3);
  }

  const count = stamps.length;
  const arrays: SplatArrays = {
    count,
    centers: new Float32Array(count * 3),
    scales: new Float32Array(count * 3),
    rotations: new Float32Array(count * 4),
    opacities: new Float32Array(count),
    colors: new Float32Array(count * 3),
    shDegree: 0,
  };
  const quaternion = new Quaternion();
  stamps.forEach((stamp, index) => {
    stamp.center
      .clone()
      .applyMatrix4(inverse)
      .toArray(arrays.centers, index * 3);
    arrays.scales.set(
      stamp.scales.map((value) => value / uniformScale),
      index * 3,
    );
    quaternion.fromArray(stamp.quat).premultiply(inverseRotation).normalize();
    quaternion.toArray(arrays.rotations, index * 4);
    arrays.opacities[index] = stamp.opacity;
    arrays.colors.set(stamp.rgb, index * 3);
  });
  return { stroke: { ...stroke, points, range: [0, count] }, splats: arrays };
}
