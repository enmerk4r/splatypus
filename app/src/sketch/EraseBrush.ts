import { Matrix4 } from 'three';
import { utils } from '@sparkjsdev/spark';
import type { Document } from '../model/Document';
import type { Layer } from '../model/Layer';
import { SetSplatsAlive } from '../model/segmentCommands';
import type { ToastLevel } from '../ui/hud';
import type { Viewer } from '../viewer/Viewer';

/**
 * Screen-space index of a layer's live splat centres for the camera at pointer-down:
 * pixel positions plus a uniform 2D bucket grid, so a brush segment only tests the splats
 * in the cells it sweeps.
 */
class ScreenIndex {
  readonly px: Float32Array;
  readonly py: Float32Array;
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
    const camera = viewer.camera;
    camera.updateMatrixWorld(true);
    layer.object.updateMatrixWorld(true);
    const toClip = new Matrix4().multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    toClip.multiply(layer.object.matrixWorld);
    const e = toClip.elements;
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

  /** Store indices whose projected centre lies within `radius` px of the segment a→b. */
  sweep(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    radius: number,
    visit: (index: number) => void,
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
          if (ex * ex + ey * ey <= radiusSq) visit(index);
        }
      }
  }
}

/**
 * Photoshop-style eraser: hides every splat of the **active layer** whose projected centre
 * passes under the brush circle (screen pixels), sketch or scan alike. Splats vanish live
 * (packed opacity → 0) and are committed as one undoable `SetSplatsAlive` on release.
 */
export class EraseBrush {
  private readonly layer: Layer;
  private readonly index: ScreenIndex;
  private readonly erased = new Set<number>();
  private last?: { x: number; y: number };

  /** Returns undefined (after a toast) when there is nothing to erase from. */
  static begin(
    viewer: Viewer,
    document: Document,
    radiusPx: number,
    notify: (message: string, level?: ToastLevel) => void,
  ): EraseBrush | undefined {
    const layer =
      document.active() ?? (document.layers.length === 1 ? document.layers[0] : undefined);
    if (!layer) {
      notify(
        'Select the layer to erase from (the eraser only affects the active layer).',
        'warning',
      );
      return undefined;
    }
    if (layer.locked) {
      notify(`“${layer.name}” is locked.`, 'warning');
      return undefined;
    }
    if (!layer.visible) {
      notify(`“${layer.name}” is hidden.`, 'warning');
      return undefined;
    }
    return new EraseBrush(viewer, document, layer, radiusPx);
  }

  private constructor(
    viewer: Viewer,
    private readonly document: Document,
    layer: Layer,
    private readonly radiusPx: number,
  ) {
    this.layer = layer;
    const rect = viewer.canvasElement.getBoundingClientRect();
    const started = performance.now();
    this.index = new ScreenIndex(layer, viewer, rect.width, rect.height);
    console.info(
      `Eraser index for “${layer.name}” (${layer.store.liveCount().toLocaleString()} splats) built in ${(performance.now() - started).toFixed(0)} ms`,
    );
  }

  get count(): number {
    return this.erased.size;
  }

  /** Canvas-relative pixel position of a pointer sample. */
  moveTo(x: number, y: number): void {
    const from = this.last ?? { x, y };
    this.last = { x, y };
    const packed = this.layer.mesh.packedSplats;
    const array = packed?.packedArray;
    const map = this.layer.storeToPacked();
    const before = this.erased.size;
    this.index.sweep(from.x, from.y, x, y, this.radiusPx, (index) => {
      if (this.erased.has(index)) return;
      this.erased.add(index);
      const packedIndex = map[index] ?? -1;
      if (array && packedIndex >= 0) utils.setPackedSplatOpacity(array, packedIndex, 0);
    });
    if (packed && this.erased.size > before) {
      packed.needsUpdate = true;
      this.layer.mesh.updateVersion();
    }
  }

  /** Commits the erase as one undo step (or restores the preview when nothing was hit). */
  finish(): number {
    if (this.erased.size === 0) return 0;
    const indices = Uint32Array.from(this.erased);
    this.document.history.push(
      new SetSplatsAlive(
        this.document,
        this.layer.id,
        indices,
        false,
        `Erase ${indices.length.toLocaleString()} splats`,
      ),
    );
    return indices.length;
  }

  /** Drops the live preview without committing. */
  cancel(): void {
    if (this.erased.size === 0) return;
    this.layer.dirty = true;
    void this.layer.sync();
  }
}
