import { Matrix4 } from 'three';
import type { Layer } from '../model/Layer';
import type { Viewer } from '../viewer/Viewer';

/**
 * Screen-space index of a layer's live splat centres for the camera at pointer-down:
 * pixel positions, view depths, and a uniform 2D bucket grid, so a brush segment only
 * tests the splats in the cells it sweeps. Built once per gesture (the view is locked
 * while a brush is down).
 */
export class ScreenIndex {
  readonly px: Float32Array;
  readonly py: Float32Array;
  /** View depth (metres along the camera's forward axis) per store index; NaN if off-screen/dead. */
  readonly depth: Float32Array;
  private readonly cell: number;
  private readonly columns: number;
  private readonly rows: number;
  private readonly starts: Int32Array;
  private readonly items: Int32Array;

  constructor(layer: Layer, viewer: Viewer, width: number, height: number, cell = 16) {
    const { store } = layer;
    this.cell = cell;
    this.columns = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(height / cell));
    this.px = new Float32Array(store.count).fill(NaN);
    this.py = new Float32Array(store.count).fill(NaN);
    this.depth = new Float32Array(store.count).fill(NaN);
    const camera = viewer.camera;
    camera.updateMatrixWorld(true);
    layer.object.updateMatrixWorld(true);
    const toView = new Matrix4().multiplyMatrices(
      camera.matrixWorldInverse,
      layer.object.matrixWorld,
    );
    const toClip = new Matrix4().multiplyMatrices(camera.projectionMatrix, toView);
    const e = toClip.elements;
    const v = toView.elements;
    const counts = new Int32Array(this.columns * this.rows);
    const slotOf = new Int32Array(store.count).fill(-1);
    for (let index = 0; index < store.count; index += 1) {
      if (!store.alive[index]) continue;
      const x = store.centers[index * 3]!,
        y = store.centers[index * 3 + 1]!,
        z = store.centers[index * 3 + 2]!;
      const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (cw <= 0) continue;
      const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw;
      const ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw;
      const sx = ((nx + 1) / 2) * width;
      const sy = ((1 - ny) / 2) * height;
      if (sx < -cell || sy < -cell || sx > width + cell || sy > height + cell) continue;
      this.px[index] = sx;
      this.py[index] = sy;
      this.depth[index] = -(v[2] * x + v[6] * y + v[10] * z + v[14]);
      const column = Math.min(this.columns - 1, Math.max(0, Math.floor(sx / cell)));
      const row = Math.min(this.rows - 1, Math.max(0, Math.floor(sy / cell)));
      const slot = row * this.columns + column;
      slotOf[index] = slot;
      counts[slot] = counts[slot]! + 1;
    }
    this.starts = new Int32Array(counts.length + 1);
    for (let slot = 0; slot < counts.length; slot += 1)
      this.starts[slot + 1] = this.starts[slot]! + counts[slot]!;
    this.items = new Int32Array(this.starts[counts.length]!);
    const cursor = this.starts.slice(0, counts.length);
    for (let index = 0; index < store.count; index += 1) {
      const slot = slotOf[index]!;
      if (slot < 0) continue;
      this.items[cursor[slot]!] = index;
      cursor[slot] = cursor[slot]! + 1;
    }
  }

  /**
   * Visits store indices whose projected centre lies within `radius` px of the segment a→b,
   * passing the normalised distance (0 at the segment, 1 at the edge) for falloffs.
   */
  sweep(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    radius: number,
    visit: (index: number, normalisedDistance: number) => void,
  ): void {
    const minX = Math.min(ax, bx) - radius,
      maxX = Math.max(ax, bx) + radius;
    const minY = Math.min(ay, by) - radius,
      maxY = Math.max(ay, by) + radius;
    const c0 = Math.max(0, Math.floor(minX / this.cell)),
      c1 = Math.min(this.columns - 1, Math.floor(maxX / this.cell));
    const r0 = Math.max(0, Math.floor(minY / this.cell)),
      r1 = Math.min(this.rows - 1, Math.floor(maxY / this.cell));
    const dx = bx - ax,
      dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const radiusSq = radius * radius;
    for (let row = r0; row <= r1; row += 1)
      for (let column = c0; column <= c1; column += 1) {
        const slot = row * this.columns + column;
        for (let at = this.starts[slot]!; at < this.starts[slot + 1]!; at += 1) {
          const index = this.items[at]!;
          const x = this.px[index]!,
            y = this.py[index]!;
          const t =
            lengthSq > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / lengthSq)) : 0;
          const ex = x - (ax + dx * t),
            ey = y - (ay + dy * t);
          const distSq = ex * ex + ey * ey;
          if (distSq <= radiusSq) visit(index, Math.sqrt(distSq) / Math.max(radius, 1e-6));
        }
      }
  }

  /** Visits store indices within a circle (a degenerate sweep). */
  within(
    x: number,
    y: number,
    radius: number,
    visit: (index: number, normalisedDistance: number) => void,
  ): void {
    this.sweep(x, y, x, y, radius, visit);
  }
}
