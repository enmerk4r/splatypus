import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import type { Document } from '../model/Document';

/**
 * A screen-space depth image of the scene's splat centres, built once per stroke from the
 * (locked) camera. Surface placement then costs one array lookup per sample instead of a
 * Spark raycast per pointer event — which is what made drawing take seconds on big scans.
 *
 * Each bin keeps the smallest view depth of the live, reasonably opaque splats that project
 * into it. Empty bins are searched outward ring by ring on lookup.
 */
export class DepthGrid {
  private readonly depths: Float32Array;
  private readonly columns: number;
  private readonly rows: number;

  private constructor(
    private readonly bin: number,
    width: number,
    height: number,
  ) {
    this.columns = Math.max(1, Math.ceil(width / bin));
    this.rows = Math.max(1, Math.ceil(height / bin));
    this.depths = new Float32Array(this.columns * this.rows).fill(Infinity);
  }

  /**
   * @param width/height canvas size in CSS pixels (the same space as pointer events, relative to the canvas).
   * @param bin bin size in CSS pixels.
   */
  static build(
    document: Document,
    camera: PerspectiveCamera,
    width: number,
    height: number,
    bin = 6,
    minOpacity = 0.2,
  ): DepthGrid {
    const grid = new DepthGrid(bin, width, height);
    camera.updateMatrixWorld(true);
    document.root.updateMatrixWorld(true);
    const view = camera.matrixWorldInverse;
    const projection = camera.projectionMatrix;
    const toView = new Matrix4();
    const toClip = new Matrix4();
    for (const layer of document.layers) {
      if (!layer.visible) continue;
      layer.object.updateMatrixWorld(true);
      toView.multiplyMatrices(view, layer.object.matrixWorld);
      toClip.multiplyMatrices(projection, toView);
      const e = toClip.elements;
      const v = toView.elements;
      const { store } = layer;
      const { centers, alive, opacities } = store;
      for (let index = 0; index < store.count; index += 1) {
        if (!alive[index] || (opacities[index] ?? 1) < minOpacity) continue;
        const x = centers[index * 3]!,
          y = centers[index * 3 + 1]!,
          z = centers[index * 3 + 2]!;
        // View-space depth (positive in front of the camera).
        const depth = -(v[2] * x + v[6] * y + v[10] * z + v[14]);
        if (depth <= 0) continue;
        const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
        if (cw <= 0) continue;
        const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw;
        const ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw;
        if (nx < -1 || nx > 1 || ny < -1 || ny > 1) continue;
        const column = Math.min(grid.columns - 1, Math.floor((((nx + 1) / 2) * width) / bin));
        const row = Math.min(grid.rows - 1, Math.floor((((1 - ny) / 2) * height) / bin));
        const slot = row * grid.columns + column;
        if (depth < grid.depths[slot]!) grid.depths[slot] = depth;
      }
    }
    return grid;
  }

  /**
   * Smallest depth around a canvas-relative pixel, searching up to `maxRing` bins outward
   * (the first ring that has anything wins, so a hit stays close to the pointer). Undefined
   * when nothing is near.
   */
  depthAt(px: number, py: number, maxRing = 3): number | undefined {
    const cx = Math.floor(px / this.bin);
    const cy = Math.floor(py / this.bin);
    for (let ring = 0; ring <= maxRing; ring += 1) {
      let best = Infinity;
      for (let dy = -ring; dy <= ring; dy += 1) {
        const row = cy + dy;
        if (row < 0 || row >= this.rows) continue;
        for (let dx = -ring; dx <= ring; dx += 1) {
          if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
          const column = cx + dx;
          if (column < 0 || column >= this.columns) continue;
          const depth = this.depths[row * this.columns + column]!;
          if (depth < best) best = depth;
        }
      }
      if (best < Infinity) return best;
    }
    return undefined;
  }

  /** World point on the pointer's ray at a given view depth. */
  static pointAtDepth(
    camera: PerspectiveCamera,
    ndcX: number,
    ndcY: number,
    depth: number,
    out = new Vector3(),
  ): Vector3 {
    // A point at NDC (x, y) on the near plane, pushed along the ray to the requested depth.
    const near = out.set(ndcX, ndcY, -1).unproject(camera);
    const origin = camera.getWorldPosition(new Vector3());
    const direction = near.sub(origin).normalize();
    const forward = camera.getWorldDirection(new Vector3());
    const along = depth / Math.max(direction.dot(forward), 1e-6);
    return origin.addScaledVector(direction, along);
  }
}
