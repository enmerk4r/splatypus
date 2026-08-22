import type { ShDegree, SplatArrays } from '../model/SplatStore';
import { shCoefficients } from '../model/SplatStore';

export function storeShBands(
  arrays: SplatArrays,
  index: number,
  sh1: Float32Array,
  sh2?: Float32Array,
  sh3?: Float32Array,
): void {
  if (!arrays.shRest) return;
  const perChannel = shCoefficients(arrays.shDegree) / 3;
  const write = (values: Float32Array | undefined, offset: number): void => {
    if (!values) return;
    for (let coefficient = 0; coefficient < values.length / 3; coefficient += 1)
      for (let channel = 0; channel < 3; channel += 1)
        arrays.shRest![index * perChannel * 3 + channel * perChannel + offset + coefficient] =
          values[coefficient * 3 + channel] ?? 0;
  };
  write(sh1, 0);
  write(sh2, 3);
  write(sh3, 8);
}

function signed(value: number, bits: number): number {
  const sign = 2 ** (bits - 1);
  return value >= sign ? value - 2 ** bits : value;
}

function packedBits(array: Uint32Array, base: number, bit: number, width: number): number {
  const word = Math.floor(bit / 32);
  const offset = bit - word * 32;
  let value = (array[base + word] ?? 0) >>> offset;
  if (offset + width > 32) value |= (array[base + word + 1] ?? 0) << (32 - offset);
  return value & (2 ** width - 1);
}

export function decodePackedSh(
  extra: Record<string, unknown> | undefined,
  count: number,
): { degree: ShDegree; shRest?: Float32Array } {
  const sh1 = extra?.sh1 instanceof Uint32Array ? extra.sh1 : undefined;
  const sh2 = extra?.sh2 instanceof Uint32Array ? extra.sh2 : undefined;
  const sh3 = extra?.sh3 instanceof Uint32Array ? extra.sh3 : undefined;
  const degree: ShDegree = sh3 ? 3 : sh2 ? 2 : sh1 ? 1 : 0;
  if (!sh1 || degree === 0) return { degree };
  const arrays: SplatArrays = {
    count,
    centers: new Float32Array(count * 3),
    scales: new Float32Array(count * 3),
    rotations: new Float32Array(count * 4),
    opacities: new Float32Array(count),
    colors: new Float32Array(count * 3),
    shDegree: degree,
    shRest: new Float32Array(count * shCoefficients(degree)),
  };
  const band1 = new Float32Array(9);
  const band2 = new Float32Array(15);
  const band3 = new Float32Array(21);
  for (let index = 0; index < count; index += 1) {
    for (let value = 0; value < 9; value += 1)
      band1[value] = signed(packedBits(sh1, index * 2, value * 7, 7), 7) / 63;
    if (sh2)
      for (let value = 0; value < 15; value += 1)
        band2[value] =
          signed(((sh2[index * 4 + Math.floor(value / 4)] ?? 0) >>> ((value % 4) * 8)) & 255, 8) /
          127;
    if (sh3)
      for (let value = 0; value < 21; value += 1)
        band3[value] = signed(packedBits(sh3, index * 4, value * 6, 6), 6) / 31;
    storeShBands(arrays, index, band1, sh2 ? band2 : undefined, sh3 ? band3 : undefined);
  }
  return { degree, shRest: arrays.shRest };
}
