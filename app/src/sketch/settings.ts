import { Color } from 'three';
import type { PresetName } from './presets';
import type { PlacementMode, StrokeSettings } from './stroke';

const PREFIX = 'splatypus.sketch.';
const PRESET_NAMES: PresetName[] = ['ink', 'tube', 'marker', 'spray'];
const PLACEMENTS: PlacementMode[] = ['surface', 'depth', 'plane'];

export const MIN_RADIUS_PX = 1;
export const MAX_RADIUS_PX = 80;
export const DEFAULT_RADIUS_PX = 10;

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

/** A stored number, or the fallback when the key is unset or not a finite number. */
function numberSetting(key: string, fallback: number, min: number, max: number): number {
  const raw = read(key);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * Brush settings. The size is in **screen pixels**: the cursor circle keeps its on-screen
 * size while zooming, so the stroke's world size follows the view (zoom in for fine detail,
 * zoom out for thick marks), exactly like a 2D paint program over the 3D view.
 */
export class SketchSettingsStore extends EventTarget {
  preset: PresetName = 'ink';
  colour = '#ff3b30';
  radiusPx = DEFAULT_RADIUS_PX;
  opacity = 1;
  pressure = true;
  placement: PlacementMode = 'surface';
  /** Brush strength (recolor/fade/grab/inflate), 0.05..1. */
  strength = 0.5;
  /** Brushes fall off towards the ring edge (true) or act as a hard disc (false). */
  softEdge = true;

  constructor() {
    super();
    const preset = read('preset') as PresetName | null;
    const placement = read('placement') as PlacementMode | null;
    const colour = read('colour');
    if (preset && PRESET_NAMES.includes(preset)) this.preset = preset;
    if (placement && PLACEMENTS.includes(placement)) this.placement = placement;
    if (colour && /^#[0-9a-f]{6}$/i.test(colour)) this.colour = colour;
    this.radiusPx = numberSetting('radiusPx', DEFAULT_RADIUS_PX, MIN_RADIUS_PX, MAX_RADIUS_PX);
    this.opacity = numberSetting('opacity', 1, 0.05, 1);
    this.pressure = read('pressure') !== '0';
    this.strength = numberSetting('strength', 0.5, 0.05, 1);
    this.softEdge = read('softEdge') !== '0';
  }

  setStrength(value: number): void {
    this.strength = Math.min(1, Math.max(0.05, value));
    this.changed('strength', String(this.strength));
  }
  setSoftEdge(value: boolean): void {
    this.softEdge = value;
    this.changed('softEdge', value ? '1' : '0');
  }

  /** Settings for a stroke about to start. `radius` (world) is filled in by the tool from the first sample's depth. */
  snapshot(): StrokeSettings {
    // three.js converts CSS/sRGB hex colours into its linear working space on construction.
    const colour = new Color(this.colour);
    return {
      preset: this.preset,
      colour: [colour.r, colour.g, colour.b],
      radiusPx: this.radiusPx,
      radius: 0,
      opacity: this.opacity,
      pressure: this.pressure,
      placement: this.placement,
    };
  }

  setPreset(value: PresetName): void {
    this.preset = value;
    this.changed('preset', value);
  }
  setColour(value: string): void {
    this.colour = value;
    this.changed('colour', value);
  }
  setRadiusPx(value: number): void {
    this.radiusPx = Math.min(MAX_RADIUS_PX, Math.max(MIN_RADIUS_PX, value));
    this.changed('radiusPx', String(this.radiusPx));
  }
  adjustRadius(factor: number): void {
    this.setRadiusPx(this.radiusPx * factor);
  }
  setOpacity(value: number): void {
    this.opacity = Math.min(1, Math.max(0.05, value));
    this.changed('opacity', String(this.opacity));
  }
  adjustOpacity(delta: number): void {
    this.setOpacity(this.opacity + delta);
  }
  setPressure(value: boolean): void {
    this.pressure = value;
    this.changed('pressure', value ? '1' : '0');
  }
  setPlacement(value: PlacementMode): void {
    this.placement = value;
    this.changed('placement', value);
  }

  private changed(key: string, value: string): void {
    write(key, value);
    this.dispatchEvent(new Event('settings-changed'));
  }
}
