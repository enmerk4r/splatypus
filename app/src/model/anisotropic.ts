import { utils } from '@sparkjsdev/spark';
import type { Layer } from './Layer';
import type { SplatStore } from './SplatStore';

export type Factor3 = readonly [number, number, number];

/**
 * Eigen-decomposition of a symmetric 3×3 matrix (row-major, 9 numbers) by cyclic Jacobi
 * rotations. Returns eigenvalues and the eigenvector matrix (row-major; eigenvector k is
 * column k), orthonormal with det +1.
 */
export function eigenSymmetric3(m: ArrayLike<number>): { values: number[]; vectors: number[] } {
  const a = [m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, m[6]!, m[7]!, m[8]!];
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 24; sweep += 1) {
    const off = a[1]! * a[1]! + a[2]! * a[2]! + a[5]! * a[5]!;
    const diag = a[0]! * a[0]! + a[4]! * a[4]! + a[8]! * a[8]!;
    if (off <= 1e-22 * Math.max(diag, 1e-300)) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = a[p * 3 + q]!;
      if (apq === 0) continue;
      const app = a[p * 3 + p]!;
      const aqq = a[q * 3 + q]!;
      const theta = (aqq - app) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      // A ← Jᵀ A J
      for (let k = 0; k < 3; k += 1) {
        const akp = a[k * 3 + p]!;
        const akq = a[k * 3 + q]!;
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k += 1) {
        const apk = a[p * 3 + k]!;
        const aqk = a[q * 3 + k]!;
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      // V ← V J
      for (let k = 0; k < 3; k += 1) {
        const vkp = v[k * 3 + p]!;
        const vkq = v[k * 3 + q]!;
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  const det =
    v[0]! * (v[4]! * v[8]! - v[5]! * v[7]!) -
    v[1]! * (v[3]! * v[8]! - v[5]! * v[6]!) +
    v[2]! * (v[3]! * v[7]! - v[4]! * v[6]!);
  if (det < 0) {
    v[2] = -v[2]!;
    v[5] = -v[5]!;
    v[8] = -v[8]!;
  }
  return { values: [a[0]!, a[4]!, a[8]!], vectors: v };
}

/** Rotation matrix (row-major) from a unit quaternion (x, y, z, w). */
function rotationFromQuat(x: number, y: number, z: number, w: number, out: number[]): void {
  const xx = x * x,
    yy = y * y,
    zz = z * z;
  const xy = x * y,
    xz = x * z,
    yz = y * z;
  const wx = w * x,
    wy = w * y,
    wz = w * z;
  out[0] = 1 - 2 * (yy + zz);
  out[1] = 2 * (xy - wz);
  out[2] = 2 * (xz + wy);
  out[3] = 2 * (xy + wz);
  out[4] = 1 - 2 * (xx + zz);
  out[5] = 2 * (yz - wx);
  out[6] = 2 * (xz - wy);
  out[7] = 2 * (yz + wx);
  out[8] = 1 - 2 * (xx + yy);
}

/** Unit quaternion (x, y, z, w) from a proper rotation matrix (row-major). */
function quatFromRotation(r: ArrayLike<number>): [number, number, number, number] {
  const m00 = r[0]!,
    m01 = r[1]!,
    m02 = r[2]!;
  const m10 = r[3]!,
    m11 = r[4]!,
    m12 = r[5]!;
  const m20 = r[6]!,
    m21 = r[7]!,
    m22 = r[8]!;
  const trace = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const length = Math.hypot(x, y, z, w) || 1;
  return [x / length, y / length, z / length, w / length];
}

/**
 * Applies an anisotropic scale (layer-local axes) to every splat of a store, exactly:
 * centres are scaled; each gaussian's covariance Σ = R diag(s²) Rᵀ becomes F Σ F and is
 * re-diagonalised into new scales and a new rotation. SH coefficients are left as they are.
 */
export function bakeAnisotropicScale(store: SplatStore, factor: Factor3): void {
  const [fx, fy, fz] = factor;
  const { centers, scales, rotations } = store;
  const r: number[] = new Array<number>(9).fill(0);
  const a: number[] = new Array<number>(9).fill(0);
  const sigma: number[] = new Array<number>(9).fill(0);
  for (let index = 0; index < store.count; index += 1) {
    const i3 = index * 3,
      i4 = index * 4;
    centers[i3] = (centers[i3] ?? 0) * fx;
    centers[i3 + 1] = (centers[i3 + 1] ?? 0) * fy;
    centers[i3 + 2] = (centers[i3 + 2] ?? 0) * fz;
    rotationFromQuat(
      rotations[i4] ?? 0,
      rotations[i4 + 1] ?? 0,
      rotations[i4 + 2] ?? 0,
      rotations[i4 + 3] ?? 1,
      r,
    );
    const sx = scales[i3] ?? 0,
      sy = scales[i3 + 1] ?? 0,
      sz = scales[i3 + 2] ?? 0;
    // A = diag(f) · R · diag(s)
    a[0] = fx * r[0]! * sx;
    a[1] = fx * r[1]! * sy;
    a[2] = fx * r[2]! * sz;
    a[3] = fy * r[3]! * sx;
    a[4] = fy * r[4]! * sy;
    a[5] = fy * r[5]! * sz;
    a[6] = fz * r[6]! * sx;
    a[7] = fz * r[7]! * sy;
    a[8] = fz * r[8]! * sz;
    // Σ = A Aᵀ (symmetric)
    for (let row = 0; row < 3; row += 1)
      for (let col = row; col < 3; col += 1) {
        const value =
          a[row * 3]! * a[col * 3]! +
          a[row * 3 + 1]! * a[col * 3 + 1]! +
          a[row * 3 + 2]! * a[col * 3 + 2]!;
        sigma[row * 3 + col] = value;
        sigma[col * 3 + row] = value;
      }
    const { values, vectors } = eigenSymmetric3(sigma);
    scales[i3] = Math.sqrt(Math.max(values[0]!, 0));
    scales[i3 + 1] = Math.sqrt(Math.max(values[1]!, 0));
    scales[i3 + 2] = Math.sqrt(Math.max(values[2]!, 0));
    const q = quatFromRotation(vectors);
    rotations[i4] = q[0];
    rotations[i4 + 1] = q[1];
    rotations[i4 + 2] = q[2];
    rotations[i4 + 3] = q[3];
  }
  store.invalidateBounds();
}

/**
 * Cheap live preview of an anisotropic scale written straight into the layer's packed GPU
 * cache: centres exact, each splat's own axes scaled by the factor's projection onto them
 * (exact for axis-aligned splats, an approximation otherwise). The next sync discards it.
 */
export function previewAnisotropicScale(layer: Layer, factor: Factor3): void {
  const packed = layer.mesh.packedSplats;
  const array = packed?.packedArray;
  if (!packed || !array) return;
  const [fx, fy, fz] = factor;
  const { centers, scales, rotations } = layer.store;
  const encoding = packed.splatEncoding;
  const r: number[] = new Array<number>(9).fill(0);
  layer.packedToStore.forEach((storeIndex, packedIndex) => {
    const i3 = storeIndex * 3,
      i4 = storeIndex * 4;
    utils.setPackedSplatCenter(
      array,
      packedIndex,
      (centers[i3] ?? 0) * fx,
      (centers[i3 + 1] ?? 0) * fy,
      (centers[i3 + 2] ?? 0) * fz,
    );
    rotationFromQuat(
      rotations[i4] ?? 0,
      rotations[i4 + 1] ?? 0,
      rotations[i4 + 2] ?? 0,
      rotations[i4 + 3] ?? 1,
      r,
    );
    // Column k of R is the splat's k-th axis in layer space; scale it by |diag(f) · column|.
    const gx = Math.hypot(fx * r[0]!, fy * r[3]!, fz * r[6]!);
    const gy = Math.hypot(fx * r[1]!, fy * r[4]!, fz * r[7]!);
    const gz = Math.hypot(fx * r[2]!, fy * r[5]!, fz * r[8]!);
    utils.setPackedSplatScales(
      array,
      packedIndex,
      (scales[i3] ?? 0) * gx,
      (scales[i3 + 1] ?? 0) * gy,
      (scales[i3 + 2] ?? 0) * gz,
      encoding,
    );
  });
  packed.needsUpdate = true;
  layer.mesh.updateVersion();
}
