import { Color, Vector2, Vector3 } from 'three';
import { dyno } from '@sparkjsdev/spark';
import type { GsplatModifier } from '@sparkjsdev/spark';

/** The UI accent (lime) used for every selection cue, as sRGB hex and linear RGB. */
export const SELECTION_ACCENT_HEX = 0xb8f34a;
const ACCENT_LINEAR = new Color(SELECTION_ACCENT_HEX); // three converts hex sRGB → linear

/** How far a selected splat layer's colours move towards the accent (0..1). */
export const SELECTION_TINT = 0.1;
/** Extra brightness of a selected splat layer (1 = none). */
export const SELECTION_BRIGHTEN = 1.12;

/**
 * Cheap, per-layer selection highlight for splats, compiled into the layer's generator: each
 * splat's colour is nudged towards the accent and brightened, scaled by `amount` (a uniform
 * 0..1 so toggling needs no recompile). Details stay legible — it is a shift, not an overlay.
 * A true silhouette outline would need a second render pass per selected layer (mask +
 * edge detection), which is not cheap with Spark's single accumulator, so this is the
 * approach used instead.
 */
export function selectionModifier(amount: dyno.DynoFloat): GsplatModifier {
  const accent = dyno.dynoConst(
    'vec3',
    new Vector3(ACCENT_LINEAR.r, ACCENT_LINEAR.g, ACCENT_LINEAR.b),
  );
  const tint = dyno.dynoConst('float', SELECTION_TINT);
  const brighten = dyno.dynoConst('float', SELECTION_BRIGHTEN - 1);
  const one = dyno.dynoConst('float', 1);
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    if (!gsplat) throw new Error('selectionModifier: missing gsplat input');
    const { rgb } = dyno.splitGsplat(gsplat).outputs;
    const tinted = dyno.mix(rgb, accent, dyno.mul(amount, tint));
    const gain = dyno.add(one, dyno.mul(amount, brighten));
    const highlighted = dyno.mul(tinted, gain);
    return { gsplat: dyno.combineGsplat({ gsplat, rgb: highlighted }) };
  });
}

/**
 * Viewport size in CSS pixels, shared by every thick-line material (three's `LineMaterial`
 * needs it to size lines in pixels). The viewer updates it on resize; materials reference
 * the same vector so they follow automatically.
 */
export const lineResolution = new Vector2(1, 1);

export function setLineResolution(width: number, height: number): void {
  lineResolution.set(Math.max(width, 1), Math.max(height, 1));
}
