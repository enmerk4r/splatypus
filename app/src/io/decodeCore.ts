import { PlyReader, SpzReader, unpackSplat, unpackSplats } from '@sparkjsdev/spark';
import type { SplatArrays, ShDegree } from '../model/SplatStore';
import { shCoefficients } from '../model/SplatStore';
import type { DecodedSplats, DecodeOptions } from './decodeTypes';
import { readPlyHeader } from './plyHeader';
import { readStandardPly } from './plyReader';
import { decodePackedSh, storeShBands } from './sh';

type Progress = (loaded: number, total: number) => void;

function allocate(count: number, shDegree: ShDegree): SplatArrays {
  const coeffs = shCoefficients(shDegree);
  return {
    count,
    centers: new Float32Array(count * 3),
    scales: new Float32Array(count * 3),
    rotations: new Float32Array(count * 4),
    opacities: new Float32Array(count),
    colors: new Float32Array(count * 3),
    shDegree,
    ...(coeffs ? { shRest: new Float32Array(count * coeffs) } : {}),
  };
}

function degreeFor(count: number): ShDegree {
  return count >= 45 ? 3 : count >= 24 ? 2 : count >= 9 ? 1 : 0;
}

async function decodeCompressedPly(
  bytes: Uint8Array,
  onProgress?: Progress,
): Promise<DecodedSplats> {
  const reader = new PlyReader({ fileBytes: bytes });
  await reader.parseHeader();
  const shProperties = reader.elements.sh?.properties ?? reader.elements.vertex?.properties ?? {};
  const degree = degreeFor(
    Object.keys(shProperties).filter((name) => /^f_rest_\d+$/.test(name)).length,
  );
  const arrays = allocate(reader.numSplats, degree);
  let reportedAt = performance.now();
  reader.parseSplats(
    (index, x, y, z, sx, sy, sz, qx, qy, qz, qw, opacity, r, g, b) => {
      const i3 = index * 3,
        i4 = index * 4;
      arrays.centers.set([x, y, z], i3);
      arrays.scales.set([sx, sy, sz], i3);
      const length = Math.hypot(qx, qy, qz, qw) || 1;
      arrays.rotations.set([qx / length, qy / length, qz / length, qw / length], i4);
      arrays.opacities[index] = opacity;
      arrays.colors.set([r, g, b], i3);
      if (onProgress && (index + 1 === reader.numSplats || performance.now() - reportedAt >= 250)) {
        onProgress(index + 1, reader.numSplats);
        reportedAt = performance.now();
      }
    },
    (index, sh1, sh2, sh3) => storeShBands(arrays, index, sh1, sh2, sh3),
  );
  return { arrays, kind: 'scan' };
}

async function decodeSpz(bytes: Uint8Array, onProgress?: Progress): Promise<DecodedSplats> {
  const reader = new SpzReader({ fileBytes: bytes });
  await reader.parseHeader();
  const degree = Math.min(3, reader.shDegree) as ShDegree;
  const arrays = allocate(reader.numSplats, degree);
  const total = reader.numSplats * 6;
  let reportedAt = performance.now();
  const report = (pass: number, index: number): void => {
    if (onProgress && (index + 1 === reader.numSplats || performance.now() - reportedAt >= 250)) {
      onProgress(pass * reader.numSplats + index + 1, total);
      reportedAt = performance.now();
    }
  };
  await reader.parseSplats(
    (i, x, y, z) => {
      arrays.centers.set([x, y, z], i * 3);
      report(0, i);
    },
    (i, alpha) => {
      arrays.opacities[i] = alpha;
      report(1, i);
    },
    (i, r, g, b) => {
      arrays.colors.set([r, g, b], i * 3);
      report(2, i);
    },
    (i, x, y, z) => {
      arrays.scales.set([x, y, z], i * 3);
      report(3, i);
    },
    (i, x, y, z, w) => {
      const length = Math.hypot(x, y, z, w) || 1;
      arrays.rotations.set([x / length, y / length, z / length, w / length], i * 4);
      report(4, i);
    },
    (i, sh1, sh2, sh3) => {
      storeShBands(arrays, i, sh1, sh2, sh3);
      report(5, i);
    },
  );
  onProgress?.(total, total);
  return { arrays, kind: 'scan' };
}

function decodeSplat(bytes: Uint8Array, onProgress?: Progress): DecodedSplats {
  if (bytes.byteLength % 32 !== 0) throw new Error('Invalid .splat byte length');
  const count = bytes.byteLength / 32;
  const arrays = allocate(count, 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let reportedAt = performance.now();
  for (let index = 0; index < count; index += 1) {
    const base = index * 32,
      i3 = index * 3,
      i4 = index * 4;
    for (let axis = 0; axis < 3; axis += 1) {
      arrays.centers[i3 + axis] = view.getFloat32(base + axis * 4, true);
      arrays.scales[i3 + axis] = view.getFloat32(base + 12 + axis * 4, true);
      arrays.colors[i3 + axis] = (bytes[base + 24 + axis] ?? 0) / 255;
    }
    arrays.opacities[index] = (bytes[base + 27] ?? 0) / 255;
    const qw = ((bytes[base + 28] ?? 128) - 128) / 128;
    const qx = ((bytes[base + 29] ?? 128) - 128) / 128;
    const qy = ((bytes[base + 30] ?? 128) - 128) / 128;
    const qz = ((bytes[base + 31] ?? 128) - 128) / 128;
    const length = Math.hypot(qx, qy, qz, qw) || 1;
    arrays.rotations.set([qx / length, qy / length, qz / length, qw / length], i4);
    if (onProgress && (index + 1 === count || performance.now() - reportedAt >= 250)) {
      onProgress(index + 1, count);
      reportedAt = performance.now();
    }
  }
  return { arrays, kind: 'scan' };
}

async function decodeQuantised(
  bytes: Uint8Array,
  name: string,
  onProgress?: Progress,
): Promise<DecodedSplats> {
  const decoded = await unpackSplats({ input: bytes, pathOrUrl: name });
  const packedSh = decodePackedSh(decoded.extra, decoded.numSplats);
  const arrays = allocate(decoded.numSplats, packedSh.degree);
  if (arrays.shRest && packedSh.shRest) arrays.shRest.set(packedSh.shRest);
  let reportedAt = performance.now();
  for (let index = 0; index < decoded.numSplats; index += 1) {
    const splat = unpackSplat(decoded.packedArray, index);
    arrays.centers.set(splat.center.toArray(), index * 3);
    arrays.scales.set(splat.scales.toArray(), index * 3);
    arrays.rotations.set(splat.quaternion.toArray(), index * 4);
    arrays.opacities[index] = splat.opacity;
    arrays.colors.set(splat.color.toArray(), index * 3);
    if (onProgress && (index + 1 === decoded.numSplats || performance.now() - reportedAt >= 250)) {
      onProgress(index + 1, decoded.numSplats);
      reportedAt = performance.now();
    }
  }
  return { arrays, kind: 'scan', lossy: 'quantised import (ksplat/sog)' };
}

export async function decodeBytes(
  bytes: Uint8Array,
  name: string,
  options: DecodeOptions = {},
  onProgress?: Progress,
): Promise<DecodedSplats> {
  const extension = name.toLowerCase().split('?')[0]?.split('.').pop();
  if (extension === 'ply') {
    const header = readPlyHeader(bytes);
    return header.compressed
      ? decodeCompressedPly(bytes, onProgress)
      : readStandardPly(bytes, options, onProgress);
  }
  if (extension === 'spz') return decodeSpz(bytes, onProgress);
  if (extension === 'splat') return decodeSplat(bytes, onProgress);
  if (extension === 'ksplat' || extension === 'sog')
    return decodeQuantised(bytes, name, onProgress);
  throw new Error(`Unsupported file type: .${extension ?? ''}`);
}
