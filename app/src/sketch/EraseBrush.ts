import { utils } from '@sparkjsdev/spark';
import type { Document } from '../model/Document';
import type { Layer } from '../model/Layer';
import { SetSplatsAlive } from '../model/segmentCommands';
import type { ToastLevel } from '../ui/hud';
import type { Viewer } from '../viewer/Viewer';
import { ScreenIndex } from './screenIndex';

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
