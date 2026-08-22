export type ShDegree = 0 | 1 | 2 | 3;
export type Vec3Tuple = [number, number, number];

export interface SplatArrays {
  count: number;
  centers: Float32Array;
  scales: Float32Array;
  rotations: Float32Array;
  opacities: Float32Array;
  colors: Float32Array;
  shDegree: ShDegree;
  shRest?: Float32Array;
}

export interface StoreBounds {
  min: Vec3Tuple;
  max: Vec3Tuple;
  center: Vec3Tuple;
  radius: number;
}

export function shCoefficients(degree: ShDegree): number {
  return degree === 0 ? 0 : degree === 1 ? 9 : degree === 2 ? 24 : 45;
}

function percentile(values: number[], fraction: number): number {
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))] ?? 0;
}

export class SplatStore {
  readonly count: number;
  readonly alive: Uint8Array;
  readonly centers: Float32Array;
  readonly scales: Float32Array;
  readonly rotations: Float32Array;
  readonly opacities: Float32Array;
  readonly colors: Float32Array;
  readonly shDegree: ShDegree;
  readonly shRest?: Float32Array;

  constructor(arrays: SplatArrays, alive?: Uint8Array) {
    const { count } = arrays;
    const expectedSh = count * shCoefficients(arrays.shDegree);
    if (
      count < 0 ||
      arrays.centers.length !== count * 3 ||
      arrays.scales.length !== count * 3 ||
      arrays.rotations.length !== count * 4 ||
      arrays.opacities.length !== count ||
      arrays.colors.length !== count * 3 ||
      (expectedSh > 0 && arrays.shRest?.length !== expectedSh) ||
      (expectedSh === 0 && arrays.shRest !== undefined)
    ) {
      throw new Error('Invalid SplatStore array lengths');
    }
    if (alive && alive.length !== count) throw new Error('Invalid SplatStore alive mask');
    this.count = count;
    this.centers = arrays.centers;
    this.scales = arrays.scales;
    this.rotations = arrays.rotations;
    this.opacities = arrays.opacities;
    this.colors = arrays.colors;
    this.shDegree = arrays.shDegree;
    if (arrays.shRest) this.shRest = arrays.shRest;
    this.alive = alive ?? new Uint8Array(count).fill(1);
  }

  liveCount(): number {
    let count = 0;
    for (const value of this.alive) count += value;
    return count;
  }

  slice(indices: Uint32Array): SplatStore {
    const count = indices.length;
    const coeffs = shCoefficients(this.shDegree);
    const arrays: SplatArrays = {
      count,
      centers: new Float32Array(count * 3),
      scales: new Float32Array(count * 3),
      rotations: new Float32Array(count * 4),
      opacities: new Float32Array(count),
      colors: new Float32Array(count * 3),
      shDegree: this.shDegree,
      ...(coeffs > 0 ? { shRest: new Float32Array(count * coeffs) } : {}),
    };
    indices.forEach((source, target) => {
      if (source >= this.count) throw new Error(`Splat index ${source} is out of range`);
      arrays.centers.set(this.centers.subarray(source * 3, source * 3 + 3), target * 3);
      arrays.scales.set(this.scales.subarray(source * 3, source * 3 + 3), target * 3);
      arrays.rotations.set(this.rotations.subarray(source * 4, source * 4 + 4), target * 4);
      arrays.opacities[target] = this.opacities[source] ?? 0;
      arrays.colors.set(this.colors.subarray(source * 3, source * 3 + 3), target * 3);
      if (arrays.shRest && this.shRest)
        arrays.shRest.set(
          this.shRest.subarray(source * coeffs, source * coeffs + coeffs),
          target * coeffs,
        );
    });
    return new SplatStore(arrays);
  }

  compacted(): SplatStore {
    const indices = new Uint32Array(this.liveCount());
    let target = 0;
    for (let index = 0; index < this.count; index += 1) {
      if (this.alive[index]) indices[target++] = index;
    }
    return this.slice(indices);
  }

  computeRobustBounds(stride = Math.max(1, Math.ceil(this.count / 200_000))): StoreBounds {
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    for (let index = 0; index < this.count; index += stride) {
      if (!this.alive[index]) continue;
      xs.push(this.centers[index * 3] ?? 0);
      ys.push(this.centers[index * 3 + 1] ?? 0);
      zs.push(this.centers[index * 3 + 2] ?? 0);
    }
    if (xs.length === 0) {
      return { min: [-1, -1, -1], max: [1, 1, 1], center: [0, 0, 0], radius: 1 };
    }
    const min: Vec3Tuple = [percentile(xs, 0.02), percentile(ys, 0.02), percentile(zs, 0.02)];
    const max: Vec3Tuple = [percentile(xs, 0.98), percentile(ys, 0.98), percentile(zs, 0.98)];
    const center: Vec3Tuple = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    return {
      min,
      max,
      center,
      radius: Math.max(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2, 0.01),
    };
  }

  static concat(stores: SplatStore[], shDegree: ShDegree): SplatStore {
    const count = stores.reduce((sum, store) => sum + store.liveCount(), 0);
    const coeffs = shCoefficients(shDegree);
    const arrays: SplatArrays = {
      count,
      centers: new Float32Array(count * 3),
      scales: new Float32Array(count * 3),
      rotations: new Float32Array(count * 4),
      opacities: new Float32Array(count),
      colors: new Float32Array(count * 3),
      shDegree,
      ...(coeffs > 0 ? { shRest: new Float32Array(count * coeffs) } : {}),
    };
    let target = 0;
    for (const store of stores) {
      const sourceCoeffs = shCoefficients(store.shDegree);
      for (let source = 0; source < store.count; source += 1) {
        if (!store.alive[source]) continue;
        arrays.centers.set(store.centers.subarray(source * 3, source * 3 + 3), target * 3);
        arrays.scales.set(store.scales.subarray(source * 3, source * 3 + 3), target * 3);
        arrays.rotations.set(store.rotations.subarray(source * 4, source * 4 + 4), target * 4);
        arrays.opacities[target] = store.opacities[source] ?? 0;
        arrays.colors.set(store.colors.subarray(source * 3, source * 3 + 3), target * 3);
        if (arrays.shRest && store.shRest)
          for (let channel = 0; channel < 3; channel += 1) {
            const sourcePerChannel = sourceCoeffs / 3;
            const targetPerChannel = coeffs / 3;
            const sourceBase = source * sourceCoeffs + channel * sourcePerChannel;
            const targetBase = target * coeffs + channel * targetPerChannel;
            arrays.shRest.set(
              store.shRest.subarray(sourceBase, sourceBase + sourcePerChannel),
              targetBase,
            );
          }
        target += 1;
      }
    }
    return new SplatStore(arrays);
  }
}
