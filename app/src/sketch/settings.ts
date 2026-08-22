import { Color } from 'three';
import type { PresetName } from './presets';
import type { PlacementMode, StrokeSettings } from './stroke';

const PREFIX = 'splatypus.sketch.';
const PRESET_NAMES: PresetName[] = ['ink', 'tube', 'marker', 'spray'];
const PLACEMENTS: PlacementMode[] = ['surface', 'depth', 'plane'];

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
  const value = Number(read(key));
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export class SketchSettingsStore extends EventTarget {
  preset: PresetName = 'ink';
  colour = '#ff3b30';
  radius = 0.02;
  opacity = 1;
  pressure = true;
  placement: PlacementMode = 'surface';

  constructor() {
    super();
    const preset = read('preset') as PresetName | null;
    const placement = read('placement') as PlacementMode | null;
    const colour = read('colour');
    if (preset && PRESET_NAMES.includes(preset)) this.preset = preset;
    if (placement && PLACEMENTS.includes(placement)) this.placement = placement;
    if (colour && /^#[0-9a-f]{6}$/i.test(colour)) this.colour = colour;
    this.radius = numberSetting('radius', 0.02, 0.002, 0.5);
    this.opacity = numberSetting('opacity', 1, 0, 1);
    this.pressure = read('pressure') !== '0';
  }

  snapshot(): StrokeSettings {
    // three.js converts CSS/sRGB hex colours into its linear working space on construction.
    const colour = new Color(this.colour);
    return {
      preset: this.preset,
      colour: [colour.r, colour.g, colour.b],
      radius: this.radius,
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
  setRadius(value: number): void {
    this.radius = Math.min(0.5, Math.max(0.002, value));
    this.changed('radius', String(this.radius));
  }
  adjustRadius(factor: number): void {
    this.setRadius(this.radius * factor);
  }
  setOpacity(value: number): void {
    this.opacity = Math.min(1, Math.max(0, value));
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
