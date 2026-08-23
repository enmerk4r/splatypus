import type { Layer } from '../model/Layer';
import type { DepthGrid } from '../sketch/depthGrid';
import type { ScreenIndex } from '../sketch/screenIndex';

/**
 * Lifting a 2D selection mask to a 3D splat selection — the geometric half of ArtisanGS
 * (arXiv 2602.10173), independent of where the mask came from (a SAM click, a lasso, a
 * painted region).
 *
 * The paper distinguishes two operators, which here are one function under a threshold:
 *
 * - **Frustum projection** — take every splat whose centre projects inside the mask.
 *   `depthTolerance: Infinity`.
 * - **Depth projection** — the same, minus everything hiding behind the front surface.
 *   A finite tolerance.
 *
 * Frustum projection alone drags in the whole depth column under the mask: click a chair
 * and you also get the wall behind it. The depth test is what makes a click mean "this
 * object" rather than "this direction".
 *
 * Nothing here touches the GPU or the store, so it is unit-testable headlessly.
 */

/** A binary image: one byte per pixel, non-zero meaning inside the selection. */
export interface MaskImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface LiftOptions {
  /**
   * How far behind the front surface a splat may sit and still count, in scene units.
   * `Infinity` disables the test, degrading to plain frustum projection.
   */
  depthTolerance: number;
  /** Splats fainter than this are ignored, matching `DepthGrid`'s own cutoff. */
  minOpacity: number;
}

export const DEFAULT_LIFT_OPTIONS: LiftOptions = { depthTolerance: Infinity, minOpacity: 0.2 };

/**
 * Splat indices of `layer` whose projected centres fall inside `mask` and, when
 * `depthTolerance` is finite, sit within that tolerance of the scene's front surface.
 *
 * @param index Projection of this layer's centres for the current camera.
 * @param front Front-surface depth over the *whole document*, so an occluder in another
 *   layer still rejects. Pass `undefined` to skip the depth test entirely.
 * @param viewWidth/viewHeight Canvas size in CSS pixels — the space `index` projects into.
 *   The mask may be a different resolution; it is scaled to match.
 */
export function liftMask(
  layer: Layer,
  index: ScreenIndex,
  front: DepthGrid | undefined,
  mask: MaskImage,
  viewWidth: number,
  viewHeight: number,
  options: LiftOptions = DEFAULT_LIFT_OPTIONS,
): Uint32Array {
  const { store } = layer;
  const scaleX = mask.width / Math.max(viewWidth, 1);
  const scaleY = mask.height / Math.max(viewHeight, 1);
  const testDepth = front !== undefined && Number.isFinite(options.depthTolerance);
  const selected = new Uint32Array(store.count);
  let found = 0;

  for (let splat = 0; splat < store.count; splat += 1) {
    if (!store.alive[splat]) continue;
    if ((store.opacities[splat] ?? 1) < options.minOpacity) continue;
    const px = index.px[splat]!;
    if (Number.isNaN(px)) continue;
    const py = index.py[splat]!;

    const column = Math.round(px * scaleX);
    const row = Math.round(py * scaleY);
    if (column < 0 || row < 0 || column >= mask.width || row >= mask.height) continue;
    if (!mask.data[row * mask.width + column]) continue;

    if (testDepth) {
      const surface = front.depthAt(px, py);
      // No surface recorded near this pixel means nothing opaque projects there, so there
      // is nothing this splat could be hiding behind — keep it rather than guess.
      if (surface !== undefined && index.depth[splat]! > surface + options.depthTolerance) continue;
    }

    selected[found] = splat;
    found += 1;
  }

  return selected.slice(0, found);
}

/**
 * Adds splats within `radius` of the seeds, repeatedly, up to `steps` hops.
 *
 * A mask clips at the object's silhouette, and a gaussian's centre can sit just outside it
 * while the gaussian itself is plainly part of the object — so a lifted selection tends to
 * be eroded at the edges. A short flood over the layer's pick grid fills that back in.
 * It grows along contact, so too many steps will happily walk from a chair onto the floor:
 * this is a refinement, not a segmenter.
 */
export function growSelection(
  layer: Layer,
  seeds: Uint32Array,
  radius: number,
  steps: number,
  maxSplats = layer.store.count,
): Uint32Array {
  if (steps <= 0 || radius <= 0 || seeds.length === 0) return seeds;
  const { store } = layer;
  const grid = layer.pickGrid;
  const inSelection = new Uint8Array(store.count);
  const result: number[] = [];
  for (const seed of seeds) {
    inSelection[seed] = 1;
    result.push(seed);
  }

  let frontier = Array.from(seeds);
  for (let step = 0; step < steps && result.length < maxSplats; step += 1) {
    const next: number[] = [];
    for (const splat of frontier) {
      grid.forEachWithin(
        store.centers[splat * 3]!,
        store.centers[splat * 3 + 1]!,
        store.centers[splat * 3 + 2]!,
        radius,
        (candidate) => {
          if (inSelection[candidate] || !store.alive[candidate]) return;
          inSelection[candidate] = 1;
          result.push(candidate);
          next.push(candidate);
        },
      );
      if (result.length >= maxSplats) break;
    }
    if (next.length === 0) break;
    frontier = next;
  }

  return Uint32Array.from(result).sort();
}
