import { ShapeUtils, Vector2, Vector3 } from 'three';
import type { SplatArrays, StoreBounds } from '../model/SplatStore';
import { mulberry32 } from '../sketch/stamps';

/** Triangle mesh of a `mesh` layer, in layer-local coordinates. */
export interface SolidData {
  positions: Float32Array; // 3 per vertex
  indices: Uint32Array; // 3 per triangle
  /** Linear RGB 0..1 */
  colour: [number, number, number];
  /** How it was authored, kept so a project can re-edit it later. */
  source?: {
    kind: 'extrude';
    /** Closed polygon in the plane, as (x, z) pairs in layer-local space. */
    polygon: Float32Array;
    baseY: number;
    height: number;
  };
}

export function solidBounds(positions: Float32Array): StoreBounds {
  if (positions.length < 3)
    return { min: [-1, -1, -1], max: [1, 1, 1], center: [0, 0, 0], radius: 1 };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k += 1) {
      const v = positions[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  const center: [number, number, number] = [
    (min[0]! + max[0]!) / 2,
    (min[1]! + max[1]!) / 2,
    (min[2]! + max[2]!) / 2,
  ];
  return {
    min: [min[0]!, min[1]!, min[2]!],
    max: [max[0]!, max[1]!, max[2]!],
    center,
    radius: Math.max(Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) / 2, 1e-4),
  };
}

/**
 * Capped extrusion of a closed polygon lying in a horizontal plane (y = baseY), along +Y
 * by `height` (negative extrudes downwards). Polygon as (x, z) pairs; self-intersecting
 * outlines are not supported (ear clipping).
 */
export function extrudePolygon(
  polygon: Float32Array,
  baseY: number,
  height: number,
): Omit<SolidData, 'colour'> {
  const n = Math.floor(polygon.length / 2);
  if (n < 3) throw new Error('A polygon needs at least three points.');
  const contour = Array.from(
    { length: n },
    (_, i) => new Vector2(polygon[i * 2], polygon[i * 2 + 1]),
  );
  // Ear clipping wants a consistently wound contour; flip if it is clockwise in (x, z).
  const ccw = ShapeUtils.isClockWise(contour) ? [...contour].reverse() : contour;
  const faces = ShapeUtils.triangulateShape(ccw, []);
  const top = baseY + height;
  const positions = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i += 1) {
    const p = ccw[i]!;
    positions.set([p.x, baseY, p.y], i * 3); // bottom ring
    positions.set([p.x, top, p.y], (n + i) * 3); // top ring
  }
  const indices: number[] = [];
  // In (x, z) with y up, a counter-clockwise contour seen from +Y is clockwise in the
  // right-handed (x, y, z) sense, so the bottom cap uses the face order as is (normal −Y)
  // and the top cap is reversed (normal +Y); flip everything if the extrusion is downward.
  const flip = height < 0;
  const tri = (a: number, b: number, c: number): void => {
    if (flip) indices.push(a, c, b);
    else indices.push(a, b, c);
  };
  for (const [a, b, c] of faces) {
    tri(a!, b!, c!);
    tri(n + a!, n + c!, n + b!);
  }
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    // Side quad between bottom i→j and top i→j, outward facing for a CCW (from +Y) contour.
    tri(i, n + i, j);
    tri(j, n + i, n + j);
  }
  return {
    positions,
    indices: Uint32Array.from(indices),
    source: { kind: 'extrude', polygon: polygon.slice(), baseY, height },
  };
}

/**
 * Samples a solid's surface into flat gaussians (one per ~spacing²), oriented with each
 * triangle's normal, in the solid's colour. Deterministic for a given seed.
 */
export function meshToSplats(solid: SolidData, spacing: number, seed = 1): SplatArrays {
  const { positions, indices, colour } = solid;
  const rng = mulberry32(seed);
  const sigma = spacing * 0.6;
  const centers: number[] = [];
  const scales: number[] = [];
  const rotations: number[] = [];
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3(),
    ab = new Vector3(),
    ac = new Vector3(),
    normal = new Vector3(),
    tangent = new Vector3(),
    bitangent = new Vector3();
  for (let t = 0; t < indices.length; t += 3) {
    a.fromArray(positions, indices[t]! * 3);
    b.fromArray(positions, indices[t + 1]! * 3);
    c.fromArray(positions, indices[t + 2]! * 3);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    normal.crossVectors(ab, ac);
    const area = normal.length() / 2;
    if (area <= 0) continue;
    normal.divideScalar(area * 2);
    tangent.copy(ab).normalize();
    bitangent.crossVectors(normal, tangent).normalize();
    // Quaternion whose x/y axes span the face and z is the normal (scale z is the thin axis).
    const q = quaternionFromBasis(tangent, bitangent, normal);
    const count = Math.max(1, Math.ceil(area / (spacing * spacing)));
    for (let k = 0; k < count; k += 1) {
      let u = rng(),
        v = rng();
      if (u + v > 1) {
        u = 1 - u;
        v = 1 - v;
      }
      centers.push(a.x + ab.x * u + ac.x * v, a.y + ab.y * u + ac.y * v, a.z + ab.z * u + ac.z * v);
      scales.push(sigma, sigma, sigma * 0.15);
      rotations.push(q[0], q[1], q[2], q[3]);
    }
  }
  const n = centers.length / 3;
  return {
    count: n,
    centers: Float32Array.from(centers),
    scales: Float32Array.from(scales),
    rotations: Float32Array.from(rotations),
    opacities: new Float32Array(n).fill(1),
    colors: Float32Array.from({ length: n * 3 }, (_, i) => colour[i % 3]!),
    shDegree: 0,
  };
}

function quaternionFromBasis(x: Vector3, y: Vector3, z: Vector3): [number, number, number, number] {
  // Rotation matrix columns x, y, z → quaternion (Shepperd).
  const m00 = x.x,
    m01 = y.x,
    m02 = z.x;
  const m10 = x.y,
    m11 = y.y,
    m12 = z.y;
  const m20 = x.z,
    m21 = y.z,
    m22 = z.z;
  const trace = m00 + m11 + m22;
  let qx: number, qy: number, qz: number, qw: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    qw = 0.25 / s;
    qx = (m21 - m12) * s;
    qy = (m02 - m20) * s;
    qz = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }
  const l = Math.hypot(qx, qy, qz, qw) || 1;
  return [qx / l, qy / l, qz / l, qw / l];
}

/** Default splat spacing for converting a solid: ~1/120 of its size, at least 5 mm. */
export function defaultSplatSpacing(solid: SolidData): number {
  return Math.max(solidBounds(solid.positions).radius / 60, 0.005);
}
