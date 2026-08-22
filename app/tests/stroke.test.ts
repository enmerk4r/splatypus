import { describe, expect, it } from 'vitest';
import { resample, resamplePressures, smoothScreenPoints } from '../src/sketch/stroke';

describe('stroke sampling', () => {
  it('applies an EMA to screen position and pressure', () => {
    expect(
      smoothScreenPoints([
        { x: 0, y: 0, pressure: 0 },
        { x: 10, y: 4, pressure: 1 },
        { x: 10, y: 8, pressure: 1 },
      ]),
    ).toEqual([
      { x: 0, y: 0, pressure: 0 },
      { x: 5, y: 2, pressure: 0.5 },
      { x: 7.5, y: 5, pressure: 0.75 },
    ]);
  });

  it('resamples at fixed arc-length spacing with unit tangents', () => {
    const sampled = resample(new Float32Array([0, 0, 0, 0.75, 0, 0, 2.4, 0, 0]), 1);
    expect([...sampled.points]).toEqual([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    expect([...sampled.tangents]).toEqual([1, 0, 0, 1, 0, 0, 1, 0, 0]);
  });

  it('turns a path shorter than one spacing into a dot', () => {
    const path = new Float32Array([2, 3, 4, 2.1, 3, 4]);
    const sampled = resample(path, 1);
    expect([...sampled.points]).toEqual([2, 3, 4]);
    expect([...sampled.tangents]).toEqual([1, 0, 0]);
    expect([...resamplePressures(path, new Float32Array([0.25, 0.75]), sampled.points)]).toEqual([
      0.25,
    ]);
  });

  it('interpolates pressure onto the resampled path', () => {
    const path = new Float32Array([0, 0, 0, 2, 0, 0]);
    const samples = resample(path, 0.5).points;
    expect([...resamplePressures(path, new Float32Array([0, 1]), samples)]).toEqual([
      0, 0.25, 0.5, 0.75, 1,
    ]);
  });

  it('keeps pressure interpolation on the correct segment through a corner', () => {
    const path = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]);
    const samples = resample(path, 0.5).points;
    expect([...resamplePressures(path, new Float32Array([0, 0.5, 1]), samples)]).toEqual([
      0, 0.25, 0.5, 0.75, 1,
    ]);
  });
});
