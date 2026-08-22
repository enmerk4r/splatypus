import { utils } from '@sparkjsdev/spark';
import { expect, it } from 'vitest';
import { decodePackedSh } from '../src/io/sh';

it('decodes Spark packed SH back to 3DGS channel-major order', () => {
  const sh1 = Float32Array.from({ length: 9 }, (_, index) => (index - 4) / 10);
  const sh2 = Float32Array.from({ length: 15 }, (_, index) => (index - 7) / 20);
  const sh3 = Float32Array.from({ length: 21 }, (_, index) => (index - 10) / 25);
  const packed1 = new Uint32Array(2);
  const packed2 = new Uint32Array(4);
  const packed3 = new Uint32Array(4);
  utils.encodeSh1Rgb(packed1, 0, sh1);
  utils.encodeSh2Rgb(packed2, 0, sh2);
  utils.encodeSh3Rgb(packed3, 0, sh3);
  const decoded = decodePackedSh({ sh1: packed1, sh2: packed2, sh3: packed3 }, 1);
  expect(decoded.degree).toBe(3);
  const expected = new Float32Array(45);
  for (let coefficient = 0; coefficient < 3; coefficient += 1)
    for (let channel = 0; channel < 3; channel += 1)
      expected[channel * 15 + coefficient] = sh1[coefficient * 3 + channel]!;
  for (let coefficient = 0; coefficient < 5; coefficient += 1)
    for (let channel = 0; channel < 3; channel += 1)
      expected[channel * 15 + 3 + coefficient] = sh2[coefficient * 3 + channel]!;
  for (let coefficient = 0; coefficient < 7; coefficient += 1)
    for (let channel = 0; channel < 3; channel += 1)
      expected[channel * 15 + 8 + coefficient] = sh3[coefficient * 3 + channel]!;
  decoded.shRest?.forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index] ?? 0, 1);
  });
});
