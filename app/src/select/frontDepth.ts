import type { ScreenIndex } from '../sketch/screenIndex';

/**
 * A coarse depth buffer over the layer's projected splats: for each screen cell, how far
 * away the *front surface* is.
 *
 * This is what stops a lasso from also grabbing the wall behind the object. A screen
 * shape says nothing about depth, so without it every region selection is a tube running
 * all the way through the scene — which is the single biggest reason a selection "can't
 * be cut out cleanly".
 *
 * Floaters would otherwise pull a cell's front all the way towards the camera, so a cell
 * with enough splats reports its **third** nearest rather than its nearest.
 */
export class FrontDepth {
  private readonly columns: number;
  private readonly rows: number;
  private readonly cell: number;
  /** Third-nearest (or nearest available) view depth per cell; Infinity when empty. */
  private readonly front: Float32Array;

  constructor(index: ScreenIndex, count: number, width: number, height: number, cell = 8) {
    this.cell = cell;
    this.columns = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(height / cell));
    const slots = this.columns * this.rows;
    // Three running minima per cell, ascending.
    const nearest = new Float32Array(slots * 3).fill(Number.POSITIVE_INFINITY);
    for (let splat = 0; splat < count; splat += 1) {
      const depth = index.depth[splat]!;
      if (!Number.isFinite(depth)) continue;
      const column = Math.min(this.columns - 1, Math.max(0, Math.floor(index.px[splat]! / cell)));
      const row = Math.min(this.rows - 1, Math.max(0, Math.floor(index.py[splat]! / cell)));
      const base = (row * this.columns + column) * 3;
      if (depth < nearest[base]!) {
        nearest[base + 2] = nearest[base + 1]!;
        nearest[base + 1] = nearest[base]!;
        nearest[base] = depth;
      } else if (depth < nearest[base + 1]!) {
        nearest[base + 2] = nearest[base + 1]!;
        nearest[base + 1] = depth;
      } else if (depth < nearest[base + 2]!) {
        nearest[base + 2] = depth;
      }
    }
    this.front = new Float32Array(slots);
    for (let slot = 0; slot < slots; slot += 1) {
      const base = slot * 3;
      const third = nearest[base + 2]!;
      const second = nearest[base + 1]!;
      this.front[slot] = Number.isFinite(third)
        ? third
        : Number.isFinite(second)
          ? second
          : nearest[base]!;
    }
  }

  /** Front-surface depth at a canvas pixel, or Infinity where nothing projects. */
  at(x: number, y: number): number {
    const column = Math.min(this.columns - 1, Math.max(0, Math.floor(x / this.cell)));
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cell)));
    return this.front[row * this.columns + column]!;
  }

  /** Whether a projected splat is on the front surface, within `tolerance` world units. */
  accepts(index: ScreenIndex, splat: number, tolerance: number): boolean {
    const depth = index.depth[splat]!;
    if (!Number.isFinite(depth)) return false;
    const front = this.at(index.px[splat]!, index.py[splat]!);
    return !Number.isFinite(front) || depth <= front + tolerance;
  }
}
