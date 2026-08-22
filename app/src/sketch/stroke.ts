import type { PresetName } from './presets';

export type PlacementMode = 'surface' | 'depth' | 'plane';

export interface StrokeSettings {
  preset: PresetName;
  colour: [number, number, number];
  radius: number;
  opacity: number;
  pressure: boolean;
  placement: PlacementMode;
}

export interface Stroke {
  id: string;
  settings: StrokeSettings;
  points: Float32Array;
  pressures: Float32Array;
  range: [number, number];
  erased?: boolean;
}

export function cloneLiveStrokes(strokes: readonly Stroke[], alive?: Uint8Array): Stroke[] {
  let first = 0;
  return strokes
    .filter((stroke) => !stroke.erased)
    .map((stroke) => {
      let count = stroke.range[1];
      if (alive) {
        count = 0;
        const end = stroke.range[0] + stroke.range[1];
        for (let index = stroke.range[0]; index < end; index += 1) count += alive[index] ?? 0;
      }
      const copy: Stroke = {
        id: crypto.randomUUID(),
        settings: { ...stroke.settings, colour: [...stroke.settings.colour] },
        points: stroke.points.slice(),
        pressures: stroke.pressures.slice(),
        range: [first, count],
      };
      first += count;
      return copy;
    });
}

export interface ScreenPoint {
  x: number;
  y: number;
  pressure: number;
}

/** Exponential moving average over pointer coordinates and pressure. */
export function smoothScreenPoints(points: readonly ScreenPoint[], alpha = 0.5): ScreenPoint[] {
  if (points.length === 0) return [];
  const weight = Math.min(1, Math.max(0, alpha));
  const first = points[0]!;
  const result: ScreenPoint[] = [{ ...first }];
  let previous = result[0]!;
  for (const point of points.slice(1)) {
    previous = {
      x: previous.x + (point.x - previous.x) * weight,
      y: previous.y + (point.y - previous.y) * weight,
      pressure: previous.pressure + (point.pressure - previous.pressure) * weight,
    };
    result.push(previous);
  }
  return result;
}

function pointAt(points: Float32Array, index: number): [number, number, number] {
  return [points[index * 3] ?? 0, points[index * 3 + 1] ?? 0, points[index * 3 + 2] ?? 0];
}

/** Fixed arc-length samples and central-difference unit tangents along a 3D polyline. */
export function resample(
  points3d: Float32Array,
  spacing: number,
): { points: Float32Array; tangents: Float32Array } {
  const count = Math.floor(points3d.length / 3);
  if (count === 0) return { points: new Float32Array(), tangents: new Float32Array() };
  if (!(spacing > 0)) throw new Error('Stroke spacing must be positive.');

  const samples: number[] = [...pointAt(points3d, 0)];
  let travelled = 0;
  let next = spacing;
  for (let index = 1; index < count; index += 1) {
    const a = pointAt(points3d, index - 1);
    const b = pointAt(points3d, index);
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      dz = b[2] - a[2];
    const length = Math.hypot(dx, dy, dz);
    if (length <= 1e-12) continue;
    while (travelled + length >= next) {
      const t = (next - travelled) / length;
      samples.push(a[0] + dx * t, a[1] + dy * t, a[2] + dz * t);
      next += spacing;
    }
    travelled += length;
  }

  const points = new Float32Array(samples);
  const tangents = new Float32Array(points.length);
  const sampleCount = points.length / 3;
  for (let index = 0; index < sampleCount; index += 1) {
    const before = Math.max(0, index - 1);
    const after = Math.min(sampleCount - 1, index + 1);
    let x = (points[after * 3] ?? 0) - (points[before * 3] ?? 0);
    let y = (points[after * 3 + 1] ?? 0) - (points[before * 3 + 1] ?? 0);
    let z = (points[after * 3 + 2] ?? 0) - (points[before * 3 + 2] ?? 0);
    const length = Math.hypot(x, y, z);
    if (length > 1e-12) {
      x /= length;
      y /= length;
      z /= length;
    } else {
      x = 1;
      y = 0;
      z = 0;
    }
    tangents.set([x, y, z], index * 3);
  }
  return { points, tangents };
}

/** Linearly transfers per-input-point pressure onto an already resampled path. */
export function resamplePressures(
  path: Float32Array,
  pressures: Float32Array,
  samples: Float32Array,
): Float32Array {
  const result = new Float32Array(samples.length / 3).fill(1);
  const pathCount = path.length / 3;
  if (pathCount === 0 || pressures.length === 0) return result;
  let segment = 0;
  for (let sample = 0; sample < result.length; sample += 1) {
    const sx = samples[sample * 3] ?? 0,
      sy = samples[sample * 3 + 1] ?? 0,
      sz = samples[sample * 3 + 2] ?? 0;
    let bestSegment = segment;
    let bestT = 0;
    let bestDistance = Infinity;
    for (let candidate = segment; candidate < Math.max(pathCount - 1, 1); candidate += 1) {
      const end = Math.min(candidate + 1, pathCount - 1);
      const ax = path[candidate * 3] ?? 0,
        ay = path[candidate * 3 + 1] ?? 0,
        az = path[candidate * 3 + 2] ?? 0;
      const bx = path[end * 3] ?? ax,
        by = path[end * 3 + 1] ?? ay,
        bz = path[end * 3 + 2] ?? az;
      const dx = bx - ax,
        dy = by - ay,
        dz = bz - az;
      const lengthSq = dx * dx + dy * dy + dz * dz;
      const t =
        lengthSq > 1e-12
          ? Math.min(1, Math.max(0, ((sx - ax) * dx + (sy - ay) * dy + (sz - az) * dz) / lengthSq))
          : 0;
      const distance = (sx - ax - dx * t) ** 2 + (sy - ay - dy * t) ** 2 + (sz - az - dz * t) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestSegment = candidate;
        bestT = t;
      }
      if (distance < 1e-10) break;
    }
    segment = bestSegment;
    const end = Math.min(segment + 1, pathCount - 1);
    const a = pressures[segment] ?? 1;
    result[sample] = a + ((pressures[end] ?? a) - a) * bestT;
  }
  return result;
}

export function resampleVectors(
  path: Float32Array,
  vectors: Float32Array,
  samples: Float32Array,
): Float32Array {
  const result = new Float32Array(samples.length);
  for (let axis = 0; axis < 3; axis += 1) {
    const component = new Float32Array(vectors.length / 3);
    for (let index = 0; index < component.length; index += 1)
      component[index] = vectors[index * 3 + axis] ?? 0;
    const sampled = resamplePressures(path, component, samples);
    for (let index = 0; index < sampled.length; index += 1)
      result[index * 3 + axis] = sampled[index] ?? 0;
  }
  return result;
}
