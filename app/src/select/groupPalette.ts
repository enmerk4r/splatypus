import { Color } from 'three';

/**
 * Colour given to splats no group claimed. Cold, dark, and unsaturated on purpose:
 * an unsegmented part of the scene should read as *absent* rather than as one more
 * object, since that is exactly the distinction a user cannot otherwise make.
 */
export const UNASSIGNED_COLOUR = new Color('#39414d');

/**
 * Stepping the hue by the golden ratio keeps consecutive ids far apart on the wheel.
 * That matters here because a bake numbers groups in the order it finds them, so
 * neighbouring objects usually end up with neighbouring ids — the one case where a
 * naive evenly-spaced palette gives them near-identical colours.
 */
const HUE_STEP = 0.618033988749895;
const SATURATION_STEP = 0.7548776662466927;
const LIGHTNESS_STEP = 0.5698402909980532;

export function groupColour(id: number, out: Color): Color {
  return out.setHSL(
    (id * HUE_STEP) % 1,
    0.5 + ((id * SATURATION_STEP) % 1) * 0.35,
    0.42 + ((id * LIGHTNESS_STEP) % 1) * 0.22,
  );
}

/**
 * All group colours as a flat rgb array. Painting the scene reads this once per splat,
 * and an HSL conversion per splat would dominate the repaint at scene scale.
 */
export function buildPalette(numGroups: number): Float32Array {
  const palette = new Float32Array(numGroups * 3);
  const colour = new Color();
  for (let id = 0; id < numGroups; id += 1) {
    groupColour(id, colour);
    palette[id * 3] = colour.r;
    palette[id * 3 + 1] = colour.g;
    palette[id * 3 + 2] = colour.b;
  }
  return palette;
}
