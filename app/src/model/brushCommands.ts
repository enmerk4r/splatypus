import type { Document } from './Document';
import type { Layer } from './Layer';
import { LockedLayerError } from './history';
import type { Command } from './history';

/** Per-splat attribute deltas of a brush stroke, packed in `indices` order. */
export interface SplatEdit {
  indices: Uint32Array;
  colors?: Float32Array; // 3 per index
  opacities?: Float32Array; // 1 per index
  centers?: Float32Array; // 3 per index
  scales?: Float32Array; // 3 per index
}

function gather(store: Float32Array, indices: Uint32Array, stride: number): Float32Array {
  const out = new Float32Array(indices.length * stride);
  indices.forEach((index, at) => {
    for (let k = 0; k < stride; k += 1) out[at * stride + k] = store[index * stride + k] ?? 0;
  });
  return out;
}

function scatter(
  store: Float32Array,
  indices: Uint32Array,
  values: Float32Array,
  stride: number,
): void {
  indices.forEach((index, at) => {
    for (let k = 0; k < stride; k += 1) store[index * stride + k] = values[at * stride + k] ?? 0;
  });
}

/**
 * Applies a brush stroke's attribute changes to a layer's store (recolor, fade, grab,
 * inflate…) as one undo step. `after` holds the new values for the touched splats; the
 * previous values are captured on first `do` so undo is exact.
 */
export class EditSplats implements Command {
  readonly label: string;
  private before?: SplatEdit;

  constructor(
    private readonly document: Document,
    private readonly layerId: string,
    private readonly after: SplatEdit,
    label: string,
  ) {
    this.label = `${label} (${after.indices.length.toLocaleString()} splats)`;
  }

  private layer(): Layer {
    const layer = this.document.getLayer(this.layerId);
    if (!layer) throw new Error('Layer no longer exists');
    if (layer.locked) throw new LockedLayerError('Unlock the layer before editing it.');
    return layer;
  }

  private apply(edit: SplatEdit): void {
    const layer = this.layer();
    const { store } = layer;
    if (edit.colors) scatter(store.colors, edit.indices, edit.colors, 3);
    if (edit.opacities) scatter(store.opacities, edit.indices, edit.opacities, 1);
    if (edit.scales) scatter(store.scales, edit.indices, edit.scales, 3);
    if (edit.centers) {
      scatter(store.centers, edit.indices, edit.centers, 3);
      store.invalidateBounds();
      layer.invalidatePick();
    }
    layer.dirty = true;
    void layer.sync();
    this.document.notifyLayerChanged(layer.id);
  }

  do(): void {
    const { store } = this.layer();
    const { indices } = this.after;
    this.before ??= {
      indices,
      ...(this.after.colors ? { colors: gather(store.colors, indices, 3) } : {}),
      ...(this.after.opacities ? { opacities: gather(store.opacities, indices, 1) } : {}),
      ...(this.after.centers ? { centers: gather(store.centers, indices, 3) } : {}),
      ...(this.after.scales ? { scales: gather(store.scales, indices, 3) } : {}),
    };
    this.apply(this.after);
  }

  undo(): void {
    if (this.before) this.apply(this.before);
  }
}
