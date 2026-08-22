export interface PointCloudInfo {
  sourcePoints: number;
  keptPoints: number;
  stride: number;
  basePointScale: number;
  pointScale: number;
  pointBudget: number;
}

export const DEFAULT_POINT_BUDGET = 3_000_000;
const SAMPLE_TARGET = 100_000;

function percentile(values: number[], fraction: number): number {
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))] ?? 0;
}

export function estimatePointScale(centers: Float32Array, total: number): number {
  if (centers.length < 6 || total < 2) return 0.01;
  const count = centers.length / 3;
  const stride = Math.max(1, Math.ceil(count / SAMPLE_TARGET));
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let index = 0; index < count; index += stride) {
    xs.push(centers[index * 3] ?? 0);
    ys.push(centers[index * 3 + 1] ?? 0);
    zs.push(centers[index * 3 + 2] ?? 0);
  }
  const diagonal = Math.hypot(
    percentile(xs, 0.98) - percentile(xs, 0.02),
    percentile(ys, 0.98) - percentile(ys, 0.02),
    percentile(zs, 0.98) - percentile(zs, 0.02),
  );
  return Math.max((diagonal / Math.sqrt(total)) * 0.6, 1e-5);
}
