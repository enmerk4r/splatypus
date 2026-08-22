import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { SplatStore } from '../src/model/SplatStore';
import type { ShDegree } from '../src/model/SplatStore';
import { gaussianPlyHeader, writeGaussianPly } from '../src/io/plyWriter';
import { readStandardPly } from '../src/io/plyReader';

const identity = new Matrix4().toArray();

function randomStore(count: number, degree: ShDegree): SplatStore {
  let state = 0x12345678;
  const random = (): number => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const centers = new Float32Array(count * 3);
  const scales = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const opacities = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      centers[index * 3 + axis] = random() * 20 - 10;
      scales[index * 3 + axis] = 0.002 + random() * 0.3;
      colors[index * 3 + axis] = 0.05 + random() * 0.9;
    }
    const q = new Quaternion(
      random() - 0.5,
      random() - 0.5,
      random() - 0.5,
      random() - 0.5,
    ).normalize();
    rotations.set(q.toArray(), index * 4);
    opacities[index] = 0.05 + random() * 0.9;
  }
  const shRest = degree
    ? Float32Array.from(
        { length: count * (degree === 1 ? 9 : degree === 2 ? 24 : 45) },
        () => random() * 4 - 2,
      )
    : undefined;
  return new SplatStore({
    count,
    centers,
    scales,
    rotations,
    opacities,
    colors,
    shDegree: degree,
    ...(shRest ? { shRest } : {}),
  });
}

function expectClose(actual: Float32Array, expected: Float32Array, tolerance = 1e-5): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < actual.length; index += 1)
    expect(Math.abs((actual[index] ?? 0) - (expected[index] ?? 0))).toBeLessThanOrEqual(
      tolerance * Math.max(1, Math.abs(expected[index] ?? 0)),
    );
}

describe('standard Gaussian PLY round trip', () => {
  it('keeps degree-0 centers bit-identical and attributes within float tolerance', () => {
    const source = randomStore(1000, 0);
    const decoded = readStandardPly(writeGaussianPly([{ store: source, matrix: identity }]));
    expect([...decoded.arrays.centers]).toEqual([...source.centers]);
    expectClose(decoded.arrays.scales, source.scales);
    expectClose(decoded.arrays.opacities, source.opacities);
    expectClose(decoded.arrays.colors, source.colors);
    for (let index = 0; index < source.count; index += 1) {
      const a = new Quaternion().fromArray(decoded.arrays.rotations, index * 4);
      const b = new Quaternion().fromArray(source.rotations, index * 4);
      expect(Math.abs(a.dot(b))).toBeCloseTo(1, 5);
    }
  });

  it('keeps degree-3 f_rest bit-identical', () => {
    const source = randomStore(1000, 3);
    const decoded = readStandardPly(writeGaussianPly([{ store: source, matrix: identity }]));
    expect([...decoded.arrays.shRest!]).toEqual([...source.shRest!]);
  });

  it('bakes translation, 90-degree rotation, and uniform scale', () => {
    const identityLayer = randomStore(5, 0);
    const source = randomStore(20, 0);
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const matrix = new Matrix4().compose(new Vector3(3, -2, 5), rotation, new Vector3(2, 2, 2));
    const decoded = readStandardPly(
      writeGaussianPly([
        { store: identityLayer, matrix: identity },
        { store: source, matrix: matrix.toArray() },
      ]),
    );
    expect([...decoded.arrays.centers.slice(0, identityLayer.centers.length)]).toEqual([
      ...identityLayer.centers,
    ]);
    for (let index = 0; index < source.count; index += 1) {
      const decodedIndex = identityLayer.count + index;
      const expected = new Vector3().fromArray(source.centers, index * 3).applyMatrix4(matrix);
      expectClose(
        decoded.arrays.centers.subarray(decodedIndex * 3, decodedIndex * 3 + 3),
        Float32Array.from(expected.toArray()),
      );
      expectClose(
        decoded.arrays.scales.subarray(decodedIndex * 3, decodedIndex * 3 + 3),
        Float32Array.from(source.scales.subarray(index * 3, index * 3 + 3), (value) => value * 2),
      );
      const expectedRotation = rotation
        .clone()
        .multiply(new Quaternion().fromArray(source.rotations, index * 4));
      const actualRotation = new Quaternion().fromArray(decoded.arrays.rotations, decodedIndex * 4);
      expect(Math.abs(actualRotation.dot(expectedRotation))).toBeCloseTo(1, 5);
    }
  });

  it('omits dead and hidden splats unless requested', () => {
    const visible = randomStore(3, 0);
    visible.alive[1] = 0;
    const hidden = randomStore(4, 0);
    expect(
      readStandardPly(
        writeGaussianPly([
          { store: visible, matrix: identity },
          { store: hidden, matrix: identity, visible: false },
        ]),
      ).arrays.count,
    ).toBe(2);
    expect(
      readStandardPly(
        writeGaussianPly(
          [
            { store: visible, matrix: identity },
            { store: hidden, matrix: identity, visible: false },
          ],
          { includeHidden: true },
        ),
      ).arrays.count,
    ).toBe(6);
  });

  it('writes the exact degree-0 and degree-3 headers', () => {
    for (const degree of [0, 3] as const) {
      const store = randomStore(2, degree);
      const output = new Uint8Array(
        writeGaussianPly([{ store, matrix: identity }], { version: 'test' }),
      );
      const expected = [
        'ply',
        'format binary_little_endian 1.0',
        'comment Generated by Splatypus test',
        'element vertex 2',
        'property float x',
        'property float y',
        'property float z',
        'property float nx',
        'property float ny',
        'property float nz',
        'property float f_dc_0',
        'property float f_dc_1',
        'property float f_dc_2',
        ...Array.from(
          { length: degree === 3 ? 45 : 0 },
          (_, index) => `property float f_rest_${index}`,
        ),
        'property float opacity',
        'property float scale_0',
        'property float scale_1',
        'property float scale_2',
        'property float rot_0',
        'property float rot_1',
        'property float rot_2',
        'property float rot_3',
        'end_header',
        '',
      ].join('\n');
      const header = gaussianPlyHeader(2, degree, 'test');
      expect(header).toBe(expected);
      expect(
        new TextDecoder().decode(output.subarray(0, new TextEncoder().encode(header).length)),
      ).toBe(header);
    }
  });

  it('accepts obj_info and normals in a hand-built binary fixture', () => {
    const source = randomStore(10, 0);
    const written = new Uint8Array(
      writeGaussianPly([{ store: source, matrix: identity }], { version: 'fixture' }),
    );
    const oldHeader = new TextEncoder().encode(gaussianPlyHeader(10, 0, 'fixture'));
    const newHeaderText = gaussianPlyHeader(10, 0, 'fixture').replace(
      'comment Generated by Splatypus fixture\n',
      'obj_info Generated by CloudCompare!\n',
    );
    const newHeader = new TextEncoder().encode(newHeaderText);
    const fixture = new Uint8Array(newHeader.length + written.length - oldHeader.length);
    fixture.set(newHeader);
    fixture.set(written.subarray(oldHeader.length), newHeader.length);
    expect([...readStandardPly(fixture).arrays.centers]).toEqual([...source.centers]);
  });

  it('rejects ASCII and big-endian PLY explicitly', () => {
    const ascii = new TextEncoder().encode('ply\nformat ascii 1.0\nelement vertex 0\nend_header\n');
    const bigEndian = new TextEncoder().encode(
      'ply\nformat binary_big_endian 1.0\nelement vertex 0\nend_header\n',
    );
    expect(() => readStandardPly(ascii)).toThrow('ASCII PLY not supported');
    expect(() => readStandardPly(bigEndian)).toThrow('big-endian PLY not supported');
  });
});
