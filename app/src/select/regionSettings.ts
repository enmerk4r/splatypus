const PREFIX = 'splatypus.region.';

function read(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    // Private mode can disable storage; settings still work for this session.
  }
}

function numberSetting(key: string, fallback: number, min: number, max: number): number {
  const raw = read(key);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * How the region tools behave. The two that matter most are on by default: without depth
 * gating a screen shape selects a tube through the whole scene, and without the snap the
 * selection is only ever as accurate as the hand that drew it.
 */
export class RegionSettingsStore extends EventTarget {
  /** Keep only splats on the front surface under the shape. */
  depthGate = true;
  /** Depth window behind the front surface, as a fraction of the layer's radius. */
  depthTolerance = 0.06;
  /** Move the selection boundary to where the cloud actually changes. */
  smartSnap = true;
  /** How much a colour change costs versus distance when snapping (0 = geometry only). */
  snapStrength = 8;
  /** Half-width in pixels of the uncertain band the snap is allowed to move within. */
  bandPx = 24;
  /** Selection brush radius in pixels. */
  brushRadiusPx = 24;
  /** Magic-wand budget, in "splat steps across matching colour". */
  wandTolerance = 250;
  /** Components below this many splats are dropped by Clean up. */
  minIslandSplats = 40;

  constructor() {
    super();
    this.depthGate = read('depthGate') !== '0';
    this.smartSnap = read('smartSnap') !== '0';
    this.depthTolerance = numberSetting('depthTolerance', 0.06, 0.005, 1);
    this.snapStrength = numberSetting('snapStrength', 8, 0, 30);
    this.bandPx = numberSetting('bandPx', 24, 4, 120);
    this.brushRadiusPx = numberSetting('brushRadiusPx', 24, 2, 200);
    this.wandTolerance = numberSetting('wandTolerance', 250, 10, 1500);
    this.minIslandSplats = numberSetting('minIslandSplats', 40, 1, 100_000);
  }

  setDepthGate(value: boolean): void {
    this.depthGate = value;
    this.changed('depthGate', value ? '1' : '0');
  }
  setDepthTolerance(value: number): void {
    this.depthTolerance = Math.min(1, Math.max(0.005, value));
    this.changed('depthTolerance', String(this.depthTolerance));
  }
  setSmartSnap(value: boolean): void {
    this.smartSnap = value;
    this.changed('smartSnap', value ? '1' : '0');
  }
  setSnapStrength(value: number): void {
    this.snapStrength = Math.min(30, Math.max(0, value));
    this.changed('snapStrength', String(this.snapStrength));
  }
  setBandPx(value: number): void {
    this.bandPx = Math.min(120, Math.max(4, value));
    this.changed('bandPx', String(this.bandPx));
  }
  setBrushRadiusPx(value: number): void {
    this.brushRadiusPx = Math.min(200, Math.max(2, Math.round(value)));
    this.changed('brushRadiusPx', String(this.brushRadiusPx));
  }
  adjustBrushRadius(factor: number): void {
    this.setBrushRadiusPx(this.brushRadiusPx * factor);
  }
  setWandTolerance(value: number): void {
    this.wandTolerance = Math.min(1500, Math.max(10, value));
    this.changed('wandTolerance', String(this.wandTolerance));
  }
  setMinIslandSplats(value: number): void {
    this.minIslandSplats = Math.min(100_000, Math.max(1, Math.round(value)));
    this.changed('minIslandSplats', String(this.minIslandSplats));
  }

  private changed(key: string, value: string): void {
    write(key, value);
    this.dispatchEvent(new Event('settings-changed'));
  }
}
