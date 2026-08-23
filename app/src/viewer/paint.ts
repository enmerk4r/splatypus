import { Color } from 'three';
import { utils } from '@sparkjsdev/spark';
import type { Layer } from '../model/Layer';

/** Produces the display colour for a store index. */
export type ColourAt = (storeIndex: number, out: Color) => void;
/** Produces the temporary display opacity for a store index. */
export type OpacityAt = (storeIndex: number) => number;

/**
 * Writes display colours straight into a layer's packed GPU cache, leaving the store
 * untouched: the store stays the truth (and what gets exported), while hover/selection
 * tints and the group overlay are purely a view. A resync rebuilds the cache from the
 * store, so callers repaint on the layer's `synced` event.
 *
 * Colour-only paints preserve opacity. A temporary opacity callback is used by views such
 * as the flat segmentation mask and never changes the store.
 */
export function paintSplats(
  layer: Layer,
  colourAt: ColourAt,
  indices?: Iterable<number>,
  opacityAt?: OpacityAt,
): void {
  const packed = layer.mesh.packedSplats;
  const array = packed?.packedArray;
  if (!packed || !array) return;
  const map = layer.storeToPacked();
  const encoding = packed.splatEncoding;
  const out = new Color();
  const write = (storeIndex: number): void => {
    const packedIndex = map[storeIndex] ?? -1;
    if (packedIndex < 0) return;
    colourAt(storeIndex, out);
    utils.setPackedSplatRgb(array, packedIndex, out.r, out.g, out.b, encoding);
    if (opacityAt) utils.setPackedSplatOpacity(array, packedIndex, opacityAt(storeIndex));
  };
  if (indices) for (const index of indices) write(index);
  else for (let index = 0; index < layer.store.count; index += 1) write(index);
  // Both are needed: `needsUpdate` re-uploads the packed texture, `updateVersion` makes
  // SparkRenderer regenerate what it has accumulated for this mesh.
  packed.needsUpdate = true;
  layer.mesh.updateVersion();
}

/** The colour a splat has in the store (what the file holds), before any overlay or tint. */
export function baseColour(layer: Layer, storeIndex: number, out: Color): Color {
  const colors = layer.store.colors;
  return out.setRGB(
    colors[storeIndex * 3] ?? 0.5,
    colors[storeIndex * 3 + 1] ?? 0.5,
    colors[storeIndex * 3 + 2] ?? 0.5,
  );
}
