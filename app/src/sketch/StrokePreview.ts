import { PackedSplats, setPackedSplat, SplatMesh } from '@sparkjsdev/spark';
import { Vector3 } from 'three';
import type { Viewer } from '../viewer/Viewer';
import { PRESETS } from './presets';
import { hashStrokeId, mulberry32, stampsFor } from './stamps';
import type { Stamp } from './stamps';
import type { StrokeSettings } from './stroke';

/** World-space GPU-only splats for the stroke currently under the pointer. */
export class StrokePreview {
  readonly mesh: SplatMesh;
  private readonly packed: PackedSplats;
  private count = 0;
  private lastPoint?: Vector3;
  private lastPressure = 1;
  private lastRadius = 0;
  private distanceSinceStamp = 0;
  private readonly rng: () => number;

  constructor(
    private readonly viewer: Viewer,
    private readonly settings: StrokeSettings,
    strokeId: string,
  ) {
    this.packed = new PackedSplats({ maxSplats: 4096 });
    this.mesh = new SplatMesh({ packedSplats: this.packed });
    this.mesh.name = 'Active sketch stroke';
    this.viewer.addHelper(this.mesh);
    this.rng = mulberry32(hashStrokeId(strokeId));
  }

  get numSplats(): number {
    return this.count;
  }

  /** @param radius world-space brush radius at this sample (derived from its depth). */
  appendPoint(point: Vector3, pressure: number, viewDir: Vector3, radius: number): void {
    const preset = PRESETS[this.settings.preset];
    const from = this.lastPoint;
    if (!from) {
      this.append(
        stampsFor(
          { p: point, t: new Vector3(1, 0, 0), pressure, radius },
          { dir: viewDir },
          this.settings,
          preset,
          this.rng,
        ),
      );
      this.lastPoint = point.clone();
      this.lastPressure = pressure;
      this.lastRadius = radius;
      return;
    }
    const delta = point.clone().sub(from);
    const length = delta.length();
    if (length <= 1e-12) return;
    const tangent = delta.clone().divideScalar(length);
    const spacing = preset.spacing * Math.max(radius, 1e-6);
    let along = 0;
    let needed = spacing - this.distanceSinceStamp;
    while (along + needed <= length) {
      along += needed;
      const t = along / length;
      this.append(
        stampsFor(
          {
            p: from.clone().addScaledVector(tangent, along),
            t: tangent,
            pressure: this.lastPressure + (pressure - this.lastPressure) * t,
            radius: this.lastRadius + (radius - this.lastRadius) * t,
          },
          { dir: viewDir },
          this.settings,
          preset,
          this.rng,
        ),
      );
      this.distanceSinceStamp = 0;
      needed = spacing;
    }
    this.distanceSinceStamp += length - along;
    this.lastPoint = point.clone();
    this.lastPressure = pressure;
    this.lastRadius = radius;
  }

  private append(stamps: readonly Stamp[]): void {
    if (stamps.length === 0) return;
    const next = this.count + stamps.length;
    const array = this.packed.ensureSplats(next);
    for (const stamp of stamps) {
      setPackedSplat(
        array,
        this.count,
        stamp.center.x,
        stamp.center.y,
        stamp.center.z,
        ...stamp.scales,
        ...stamp.quat,
        stamp.opacity,
        ...stamp.rgb,
      );
      this.count += 1;
    }
    this.packed.numSplats = this.count;
    this.packed.needsUpdate = true;
    this.mesh.updateVersion();
  }

  dispose(): void {
    this.viewer.removeHelper(this.mesh);
    this.mesh.dispose();
  }
}
