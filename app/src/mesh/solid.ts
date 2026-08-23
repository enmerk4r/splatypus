import { ShapeUtils, Vector2, Vector3 } from 'three';
import type { SplatArrays, StoreBounds } from '../model/SplatStore';
import { mulberry32 } from '../sketch/stamps';

/** A flat, closed, planar outline (3 coords per point, layer-local) with its unit normal. */
export interface FaceData {
  polygon: Float32Array;
  normal: [number, number, number];
}

/** Triangle mesh of a `mesh` layer, in layer-local coordinates. */
export interface SolidData {
  positions: Float32Array; // 3 per vertex
  indices: Uint32Array; // 3 per triangle
  /** Linear RGB 0..1 */
  colour: [number, number, number];
  /** Present while the mesh is still an unextruded face (rendered translucent, double-sided). */
  face?: FaceData;
  /** How it was authored, kept so a project can re-edit it later. */
  source?: { kind: 'extrude'; face: FaceData; height: number };
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

/** Mean of a face's outline points. */
export function faceCentroid(face: FaceData, out = new Vector3()): Vector3 {
  out.set(0, 0, 0);
  const n = face.polygon.length / 3;
  for (let i = 0; i < n; i += 1) {
    out.x += face.polygon[i * 3]!;
    out.y += face.polygon[i * 3 + 1]!;
    out.z += face.polygon[i * 3 + 2]!;
  }
  return n > 0 ? out.divideScalar(n) : out;
}

/** Orthonormal (u, v) spanning the plane of `normal`, with u × v = normal. */
function planeBasis(normal: Vector3): { u: Vector3; v: Vector3 } {
  const helper = Math.abs(normal.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const u = new Vector3().crossVectors(helper, normal).normalize();
  const v = new Vector3().crossVectors(normal, u).normalize();
  return { u, v };
}

/** Triangulates the outline (ear clipping) as index triples into the polygon's points, wound towards +normal. */
function triangulate(face: FaceData): [number, number, number][] {
  const n = face.polygon.length / 3;
  if (n < 3) throw new Error('A face needs at least three points.');
  const normal = new Vector3(...face.normal).normalize();
  const { u, v } = planeBasis(normal);
  const point = new Vector3();
  const contour = Array.from({ length: n }, (_, i) => {
    point.fromArray(face.polygon, i * 3);
    return new Vector2(point.dot(u), point.dot(v));
  });
  const faces = ShapeUtils.triangulateShape(contour, []);
  const flip = ShapeUtils.isClockWise(contour);
  return faces.map(([a, b, c]) => (flip ? [a!, c!, b!] : [a!, b!, c!]));
}

/** A flat face mesh from an outline: positions = the outline points, indices = its triangulation. */
export function makeFace(face: FaceData): Omit<SolidData, 'colour'> {
  const tris = triangulate(face);
  return {
    positions: face.polygon.slice(),
    indices: Uint32Array.from(tris.flat()),
    face: { polygon: face.polygon.slice(), normal: [...face.normal] as [number, number, number] },
  };
}

/** Signed volume (divergence theorem); positive when triangles face outward. */
export function signedVolume(positions: Float32Array, indices: Uint32Array): number {
  let volume = 0;
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3();
  for (let t = 0; t < indices.length; t += 3) {
    a.fromArray(positions, indices[t]! * 3);
    b.fromArray(positions, indices[t + 1]! * 3);
    c.fromArray(positions, indices[t + 2]! * 3);
    volume += a.dot(new Vector3().crossVectors(b, c)) / 6;
  }
  return volume;
}

/**
 * Capped extrusion of a face along its normal by `height` (negative = opposite direction).
 * Outward-facing regardless of outline winding or direction.
 */
export function extrudeFace(face: FaceData, height: number): Omit<SolidData, 'colour'> {
  const tris = triangulate(face);
  const n = face.polygon.length / 3;
  const normal = new Vector3(...face.normal).normalize();
  const positions = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i += 1) {
    const x = face.polygon[i * 3]!,
      y = face.polygon[i * 3 + 1]!,
      z = face.polygon[i * 3 + 2]!;
    positions.set([x, y, z], i * 3);
    positions.set(
      [x + normal.x * height, y + normal.y * height, z + normal.z * height],
      (n + i) * 3,
    );
  }
  const indices: number[] = [];
  for (const [a, b, c] of tris) {
    indices.push(a, c, b); // base cap (faces −normal)
    indices.push(n + a, n + b, n + c); // top cap (faces +normal)
  }
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    indices.push(i, j, n + i);
    indices.push(j, n + j, n + i);
  }
  let index = Uint32Array.from(indices);
  // Winding depends on outline orientation × extrusion direction: make it outward by measurement.
  if (signedVolume(positions, index) < 0) {
    const flipped = index.slice();
    for (let t = 0; t < flipped.length; t += 3) {
      flipped[t + 1] = index[t + 2]!;
      flipped[t + 2] = index[t + 1]!;
    }
    index = flipped;
  }
  return {
    positions,
    indices: index,
    source: {
      kind: 'extrude',
      face: { polygon: face.polygon.slice(), normal: [...face.normal] as [number, number, number] },
      height,
    },
  };
}

/** Capped extrusion of an (x, z) outline lying in the plane y = baseY, along +Y by `height`. */
export function extrudePolygon(
  polygon: Float32Array,
  baseY: number,
  height: number,
): Omit<SolidData, 'colour'> {
  const n = Math.floor(polygon.length / 2);
  const points = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) points.set([polygon[i * 2]!, baseY, polygon[i * 2 + 1]!], i * 3);
  return extrudeFace({ polygon: points, normal: [0, 1, 0] }, height);
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
