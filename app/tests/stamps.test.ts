import { Color, Quaternion, Vector3 } from 'three';
import { PackedSplats } from '@sparkjsdev/spark';
import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/sketch/presets';
import { SketchSettingsStore } from '../src/sketch/settings';
import { makeWorldStamps } from '../src/sketch/bakeStroke';
import { mulberry32, stampsFor } from '../src/sketch/stamps';
import type { StrokeSettings } from '../src/sketch/stroke';

const settings: StrokeSettings = {
  preset: 'ink',
  colour: [1, 0, 0],
  radiusPx: 10,
  radius: 0.1,
  opacity: 1,
  pressure: true,
  placement: 'surface',
};
const sample = { p: new Vector3(1, 2, 3), t: new Vector3(1, 0, 0), pressure: 1 };

describe('stroke stamps', () => {
  it('orients an Ink ribbon toward the view direction', () => {
    const stamp = stampsFor(
      sample,
      { dir: new Vector3(0, 0, 1) },
      settings,
      PRESETS.ink,
      () => 0.5,
    )[0]!;
    const facing = new Vector3(0, 0, 1).applyQuaternion(new Quaternion().fromArray(stamp.quat));
    expect(facing.dot(new Vector3(0, 0, 1))).toBeCloseTo(1, 6);
    expect(stamp.scales[0]).toBeCloseTo(0.16);
    expect(stamp.scales.slice(1)).toEqual([0.1, 0.015]);
  });

  it('keeps Tube orientation independent of the camera', () => {
    const a = stampsFor(
      sample,
      { dir: new Vector3(0, 0, 1) },
      settings,
      PRESETS.tube,
      () => 0.5,
    )[0]!;
    const b = stampsFor(
      sample,
      { dir: new Vector3(0, 1, 0) },
      settings,
      PRESETS.tube,
      () => 0.5,
    )[0]!;
    expect(a.quat).toEqual(b.quat);
    expect(a.scales[0]).toBeCloseTo(0.14);
    expect(a.scales.slice(1)).toEqual([0.1, 0.1]);
  });

  it('uses pressure for radius and opacity', () => {
    const stamp = stampsFor(
      { ...sample, pressure: 0 },
      { dir: new Vector3(0, 0, 1) },
      settings,
      PRESETS.ink,
      () => 0.5,
    )[0]!;
    expect(stamp.scales[1]).toBeCloseTo(0.04);
    expect(stamp.opacity).toBeCloseTo(0.95 * 0.6);
  });

  it('creates deterministic Spray scatter from a seeded RNG', () => {
    const a = stampsFor(
      sample,
      { dir: new Vector3(0, 0, 1) },
      settings,
      PRESETS.spray,
      mulberry32(42),
    );
    const b = stampsFor(
      sample,
      { dir: new Vector3(1, 0, 0) },
      settings,
      PRESETS.spray,
      mulberry32(42),
    );
    expect(a).toHaveLength(8);
    expect(a.map((stamp) => [...stamp.center, ...stamp.quat])).toEqual(
      b.map((stamp) => [...stamp.center, ...stamp.quat]),
    );
  });

  it('grows preview storage exponentially without losing packed data', () => {
    const packed = new PackedSplats({ maxSplats: 4096 });
    const initial = packed.ensureSplats(4096);
    initial[0] = 0x12345678;
    const grown = packed.ensureSplats(4097);
    expect(grown).not.toBe(initial);
    expect(grown[0]).toBe(0x12345678);
    expect(packed.maxSplats).toBeGreaterThanOrEqual(8192);
    packed.dispose();
  });

  it('converts UI hex colours to linear RGB exactly once', () => {
    const store = new SketchSettingsStore();
    store.setColour('#ff3b30');
    expect(store.snapshot().colour).toEqual(new Color('#ff3b30').toArray());
  });

  it('uses the camera direction captured for each resampled point', () => {
    const stamps = makeWorldStamps(
      new Float32Array([0, 0, 0, 1, 0, 0]),
      new Float32Array([1, 0, 0, 1, 0, 0]),
      new Float32Array([1, 1]),
      settings,
      new Float32Array([0, 0, 1, 0, 1, 0]),
      'views',
    );
    const first = new Vector3(0, 0, 1).applyQuaternion(new Quaternion().fromArray(stamps[0]!.quat));
    const second = new Vector3(0, 0, 1).applyQuaternion(
      new Quaternion().fromArray(stamps[1]!.quat),
    );
    expect(first.dot(new Vector3(0, 0, 1))).toBeCloseTo(1, 6);
    expect(second.dot(new Vector3(0, 1, 0))).toBeCloseTo(1, 6);
  });
});
