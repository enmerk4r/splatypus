import type { SplatArrays, ShDegree } from '../model/SplatStore';
import type { DecodedSplats, DecodeOptions } from './decodeTypes';
import { readPlyHeader, readPlyScalar } from './plyHeader';
import type { PlyProperty } from './plyHeader';
import { DEFAULT_POINT_BUDGET, estimatePointScale } from './pointCloud';

export const SH_C0 = 0.28209479177387814;

function degreeFor(restCount: number): ShDegree {
  return restCount === 9 ? 1 : restCount === 24 ? 2 : restCount === 45 ? 3 : 0;
}

function allocate(count: number, shDegree: ShDegree, restCount: number): SplatArrays {
  return {
    count,
    centers: new Float32Array(count * 3),
    scales: new Float32Array(count * 3),
    rotations: new Float32Array(count * 4),
    opacities: new Float32Array(count),
    colors: new Float32Array(count * 3),
    shDegree,
    ...(shDegree > 0 ? { shRest: new Float32Array(count * restCount) } : {}),
  };
}

export function readStandardPly(
  input: Uint8Array | ArrayBuffer,
  options: DecodeOptions = {},
  onProgress?: (loaded: number, total: number) => void,
): DecodedSplats {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const header = readPlyHeader(bytes);
  if (header.compressed) throw new Error('Compressed PLY must be decoded with the Spark reader');
  if (header.vertexOffset + header.vertexCount * header.vertexStride > bytes.byteLength)
    throw new Error('PLY vertex payload is truncated');
  const get = (name: string): PlyProperty | undefined => header.properties.get(name);
  for (const name of ['x', 'y', 'z']) if (!get(name)) throw new Error(`Missing ${name} property`);
  const pointCloud = Boolean(get('red') && get('green') && get('blue') && !get('scale_0'));
  if (!pointCloud)
    for (const name of [
      'f_dc_0',
      'f_dc_1',
      'f_dc_2',
      'opacity',
      'scale_0',
      'scale_1',
      'scale_2',
      'rot_0',
      'rot_1',
      'rot_2',
      'rot_3',
    ])
      if (!get(name)) throw new Error(`Missing ${name} property`);
  const sourceCount = header.vertexCount;
  const pointBudget = Math.max(1, options.pointBudget ?? DEFAULT_POINT_BUDGET);
  const stride = pointCloud ? Math.max(1, Math.ceil(sourceCount / pointBudget)) : 1;
  const count = Math.ceil(sourceCount / stride);
  const restNames = [...header.properties.keys()]
    .filter((name) => /^f_rest_\d+$/.test(name))
    .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
  const shDegree = pointCloud ? 0 : degreeFor(restNames.length);
  const warnings =
    !pointCloud && restNames.length > 0 && shDegree === 0
      ? [`Ignored unsupported SH coefficient count (${restNames.length}).`]
      : [];
  const arrays = allocate(count, shDegree, restNames.length);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = (base: number, name: string): number => {
    const property = get(name)!;
    return readPlyScalar(view, base + property.offset, property);
  };
  let target = 0;
  let reportedAt = performance.now();
  for (let source = 0; source < sourceCount; source += stride) {
    const base = header.vertexOffset + source * header.vertexStride;
    const i3 = target * 3;
    const i4 = target * 4;
    arrays.centers[i3] = value(base, 'x');
    arrays.centers[i3 + 1] = value(base, 'y');
    arrays.centers[i3 + 2] = value(base, 'z');
    if (pointCloud) {
      for (const [channel, name] of ['red', 'green', 'blue'].entries()) {
        const property = get(name)!;
        const raw = readPlyScalar(view, base + property.offset, property);
        const divisor =
          property.type === 'uchar' || property.type === 'char'
            ? 255
            : property.type === 'ushort' || property.type === 'short'
              ? 65535
              : raw > 1
                ? 255
                : 1;
        arrays.colors[i3 + channel] = Math.min(1, Math.max(0, raw / divisor));
      }
      arrays.rotations[i4 + 3] = 1;
      arrays.opacities[target] = 1;
    } else {
      arrays.scales[i3] = Math.exp(value(base, 'scale_0'));
      arrays.scales[i3 + 1] = Math.exp(value(base, 'scale_1'));
      arrays.scales[i3 + 2] = Math.exp(value(base, 'scale_2'));
      const qx = value(base, 'rot_1'),
        qy = value(base, 'rot_2');
      const qz = value(base, 'rot_3'),
        qw = value(base, 'rot_0');
      const length = Math.hypot(qx, qy, qz, qw) || 1;
      arrays.rotations.set([qx / length, qy / length, qz / length, qw / length], i4);
      arrays.opacities[target] = 1 / (1 + Math.exp(-value(base, 'opacity')));
      arrays.colors[i3] = Math.min(1, Math.max(0, value(base, 'f_dc_0') * SH_C0 + 0.5));
      arrays.colors[i3 + 1] = Math.min(1, Math.max(0, value(base, 'f_dc_1') * SH_C0 + 0.5));
      arrays.colors[i3 + 2] = Math.min(1, Math.max(0, value(base, 'f_dc_2') * SH_C0 + 0.5));
      if (arrays.shRest)
        restNames.forEach((name, index) => {
          arrays.shRest![target * restNames.length + index] = value(base, name);
        });
    }
    target += 1;
    if (onProgress && (source + stride >= sourceCount || performance.now() - reportedAt >= 250)) {
      onProgress(Math.min(source + stride, sourceCount), sourceCount);
      reportedAt = performance.now();
    }
  }
  if (pointCloud) {
    const basePointScale = estimatePointScale(arrays.centers, sourceCount);
    const pointScale = basePointScale * (options.pointSizeMul ?? 1);
    arrays.scales.fill(pointScale);
    return {
      arrays,
      kind: 'pointcloud',
      pointCloud: {
        sourcePoints: sourceCount,
        keptPoints: count,
        stride,
        basePointScale,
        pointScale,
        pointBudget,
      },
      warnings,
    };
  }
  return { arrays, kind: 'scan', warnings };
}
