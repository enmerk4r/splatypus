import { PlyReader, setPackedSplat, SplatMesh, utils } from '@sparkjsdev/spark';

/**
 * RGB point clouds (x/y/z/red/green/blue, no Gaussian attributes) are not splats.
 * Spark's worker decoder cannot read them, and its JS PlyReader gives every point a
 * fixed 1 mm radius, which renders as invisible dust. This module parses such files on
 * the main thread with a data-driven point radius and an optional point budget.
 */

export interface PointCloudOptions {
  /** Maximum number of points to keep; the file is stride-decimated above this. */
  pointBudget: number;
  /** Multiplier on the spacing-based radius estimate (1 = estimate). */
  pointSizeMul?: number;
}

export interface PointCloudInfo {
  sourcePoints: number;
  keptPoints: number;
  stride: number;
  /** Radius estimated from point spacing at load time (the UI slider is relative to this). */
  basePointScale: number;
  /** Radius currently applied. */
  pointScale: number;
}

export const DEFAULT_POINT_BUDGET = 3_000_000;

const SAMPLE_TARGET = 100_000;

function percentile(values: Float32Array, fraction: number): number {
  const sorted = values.slice().sort();
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

/**
 * Treat the cloud as a sampled surface: spacing ≈ robust-bbox diagonal / sqrt(N).
 * A radius of ~0.6× spacing closes most gaps without turning the cloud into a blob.
 */
function estimatePointScale(
  xs: Float32Array,
  ys: Float32Array,
  zs: Float32Array,
  total: number,
): number {
  if (xs.length < 2 || total < 2) return 0.01;
  const dx = percentile(xs, 0.98) - percentile(xs, 0.02);
  const dy = percentile(ys, 0.98) - percentile(ys, 0.02);
  const dz = percentile(zs, 0.98) - percentile(zs, 0.02);
  const diagonal = Math.hypot(dx, dy, dz);
  const spacing = diagonal / Math.sqrt(total);
  return Math.max(spacing * 0.6, 1e-5);
}

export async function isRgbPointCloudPly(
  fileBytes: Uint8Array,
  fileName: string,
): Promise<PlyReader | undefined> {
  if (!fileName.toLowerCase().endsWith('.ply')) return undefined;
  const reader = new PlyReader({ fileBytes });
  await reader.parseHeader();
  const properties = reader.elements.vertex?.properties;
  if (!properties) return undefined;
  const hasPosition = Boolean(properties.x && properties.y && properties.z);
  const hasRgb = Boolean(properties.red && properties.green && properties.blue);
  const hasGaussianScale = ['scale_0', 'scale_1', 'scale_2'].some((name) => properties[name]);
  return hasPosition && hasRgb && !hasGaussianScale ? reader : undefined;
}

export function createPointCloudMesh(
  reader: PlyReader,
  options: PointCloudOptions,
): { mesh: SplatMesh; info: PointCloudInfo } {
  const sourcePoints = reader.numSplats;
  const stride = Math.max(1, Math.ceil(sourcePoints / Math.max(1, options.pointBudget)));
  const keptPoints = Math.ceil(sourcePoints / stride);
  const sampleStride = Math.max(1, Math.ceil(keptPoints / SAMPLE_TARGET));
  const info: PointCloudInfo = {
    sourcePoints,
    keptPoints,
    stride,
    basePointScale: 0,
    pointScale: 0,
  };

  const mesh = new SplatMesh({
    maxSplats: keptPoints,
    constructSplats: (splats) => {
      const packedArray = splats.ensureSplats(keptPoints);
      const xs = new Float32Array(Math.ceil(keptPoints / sampleStride));
      const ys = new Float32Array(xs.length);
      const zs = new Float32Array(xs.length);
      let sampled = 0;
      let kept = 0;
      // Scale is patched in a second pass once we know the point spacing.
      PlyReader.defaultPointScale = 1e-3;
      reader.parseSplats((index, x, y, z, _sx, _sy, _sz, qx, qy, qz, qw, opacity, r, g, b) => {
        if (index % stride !== 0) return;
        setPackedSplat(
          packedArray,
          kept,
          x,
          y,
          z,
          1e-3,
          1e-3,
          1e-3,
          qx,
          qy,
          qz,
          qw,
          opacity,
          r,
          g,
          b,
        );
        if (kept % sampleStride === 0 && sampled < xs.length) {
          xs[sampled] = x;
          ys[sampled] = y;
          zs[sampled] = z;
          sampled += 1;
        }
        kept += 1;
      });
      const estimated = estimatePointScale(
        xs.subarray(0, sampled),
        ys.subarray(0, sampled),
        zs.subarray(0, sampled),
        kept,
      );
      const scale = estimated * (options.pointSizeMul ?? 1);
      for (let index = 0; index < kept; index += 1) {
        utils.setPackedSplatScales(packedArray, index, scale, scale, scale);
      }
      info.basePointScale = estimated;
      info.pointScale = scale;
      info.keptPoints = kept;
      splats.numSplats = kept;
      splats.needsUpdate = true;
    },
    onLoad: () => undefined,
  });
  return { mesh, info };
}

/** Rescale every point of an already-loaded point cloud in place (no re-parse). */
export function rescalePointCloud(mesh: SplatMesh, scale: number): void {
  const packed = mesh.packedSplats;
  if (!packed?.packedArray) return;
  for (let index = 0; index < packed.numSplats; index += 1) {
    utils.setPackedSplatScales(packed.packedArray, index, scale, scale, scale);
  }
  packed.needsUpdate = true;
}
