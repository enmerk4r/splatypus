export type PresetName = 'ink' | 'tube' | 'marker' | 'spray';

export interface Preset {
  name: PresetName;
  spacing: number;
  stretch: number;
  side: number;
  flat: number;
  opacity: number;
  scatter?: { count: number; radius: number; size: number };
  billboard: boolean;
}

export const PRESETS: Readonly<Record<PresetName, Preset>> = {
  ink: {
    name: 'ink',
    spacing: 0.45,
    stretch: 1.6,
    side: 1,
    flat: 0.15,
    opacity: 0.95,
    billboard: true,
  },
  tube: {
    name: 'tube',
    spacing: 0.5,
    stretch: 1.4,
    side: 1,
    flat: 1,
    opacity: 0.9,
    billboard: false,
  },
  marker: {
    name: 'marker',
    spacing: 0.5,
    stretch: 1.6,
    side: 2.5,
    flat: 0.12,
    opacity: 0.35,
    billboard: true,
  },
  spray: {
    name: 'spray',
    spacing: 0.8,
    stretch: 1,
    side: 1,
    flat: 1,
    opacity: 0.55,
    scatter: { count: 8, radius: 1, size: 0.3 },
    billboard: false,
  },
};
