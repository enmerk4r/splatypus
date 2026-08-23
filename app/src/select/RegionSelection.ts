import type { Layer } from '../model/Layer';
import { buildNeighbourGraph, connectedComponents } from './neighbourGraph';
import type { NeighbourGraph } from './neighbourGraph';

/** What changed, so the view can repaint just those splats instead of the whole layer. */
export interface RegionChange {
  layer: Layer;
  added: Uint32Array;
  removed: Uint32Array;
}

const EMPTY = new Uint32Array(0);

/**
 * Above this the neighbour graph would cost more memory than it is worth; the smart tools
 * decline rather than freeze the tab.
 */
export const MAX_GRAPH_SPLATS = 600_000;

export class GraphTooLargeError extends Error {}

/**
 * A free-form selection of individual splats in one layer, held as a mask rather than as
 * a set of baked groups.
 *
 * The group segmentation answers "which patch did the baker think this is?"; this answers
 * "which splats do I want?", which is the question a hand-drawn selection actually asks.
 * It owns the neighbour graph for its layer too, because every operation that makes the
 * selection *better* — grow, shrink, drop islands, snap to a boundary — is a walk on it.
 *
 * Events: `region-changed` (detail: {@link RegionChange}).
 */
export class RegionSelection extends EventTarget {
  private layerValue?: Layer;
  private maskValue = new Uint8Array(0);
  private countValue = 0;
  private graphLayer?: Layer;
  private graphValue?: NeighbourGraph;

  get layer(): Layer | undefined {
    return this.layerValue;
  }
  get count(): number {
    return this.countValue;
  }
  get isEmpty(): boolean {
    return this.countValue === 0;
  }
  has(index: number): boolean {
    return this.maskValue[index] === 1;
  }

  indices(): Uint32Array {
    if (this.countValue === 0) return EMPTY;
    const out = new Uint32Array(this.countValue);
    let at = 0;
    for (let index = 0; index < this.maskValue.length; index += 1)
      if (this.maskValue[index] === 1) out[at++] = index;
    return out;
  }

  /** Replaces the whole selection, switching layers if needed. */
  replace(layer: Layer | undefined, indices: Uint32Array = EMPTY): void {
    if (this.layerValue && this.layerValue !== layer) this.clear();
    if (!layer) return;
    if (this.layerValue !== layer) {
      this.layerValue = layer;
      this.maskValue = new Uint8Array(layer.store.count);
      this.countValue = 0;
    }
    const removed = this.countValue > 0 ? this.indices() : EMPTY;
    this.maskValue.fill(0);
    this.countValue = 0;
    const added = this.mark(indices, 1);
    this.emit(
      layer,
      added,
      removed.filter((index) => this.maskValue[index] !== 1),
    );
  }

  add(indices: Uint32Array): void {
    const layer = this.layerValue;
    if (!layer) return;
    this.emit(layer, this.mark(indices, 1), EMPTY);
  }

  subtract(indices: Uint32Array): void {
    const layer = this.layerValue;
    if (!layer) return;
    this.emit(layer, EMPTY, this.mark(indices, 0));
  }

  clear(): void {
    const layer = this.layerValue;
    if (!layer) return;
    const removed = this.indices();
    this.maskValue = new Uint8Array(0);
    this.countValue = 0;
    this.layerValue = undefined;
    this.emit(layer, EMPTY, removed);
  }

  /** Drops the selection without touching the graph cache (used when a layer disappears). */
  forget(): void {
    this.layerValue = undefined;
    this.maskValue = new Uint8Array(0);
    this.countValue = 0;
    this.releaseGraph();
  }

  /** Adds every live splat within `steps` graph hops of the selection. */
  grow(steps = 1): void {
    this.morph(steps, true);
  }

  /** Peels `steps` hops off the selection's boundary — the way to shed a clinging rim. */
  shrink(steps = 1): void {
    this.morph(steps, false);
  }

  /**
   * Keeps only components of at least `minSplats` splats, which is how the stray floaters
   * a screen-space selection inevitably drags in get dropped in one click.
   */
  removeIslands(minSplats: number): number {
    const layer = this.layerValue;
    if (!layer || this.countValue === 0) return 0;
    const graph = this.graph(layer);
    const { labels, sizes } = connectedComponents(
      graph,
      (local) => this.maskValue[graph.nodes[local]!] === 1,
    );
    const dropped: number[] = [];
    for (let local = 0; local < graph.count; local += 1) {
      const label = labels[local]!;
      if (label < 0 || sizes[label]! >= minSplats) continue;
      dropped.push(graph.nodes[local]!);
    }
    if (dropped.length === 0) return 0;
    const removed = this.mark(Uint32Array.from(dropped), 0);
    this.emit(layer, EMPTY, removed);
    return removed.length;
  }

  /** Keeps the single largest connected component. */
  keepLargest(): number {
    const layer = this.layerValue;
    if (!layer || this.countValue === 0) return 0;
    const graph = this.graph(layer);
    const { sizes } = connectedComponents(
      graph,
      (local) => this.maskValue[graph.nodes[local]!] === 1,
    );
    if (sizes.length <= 1) return 0;
    let largest = 0;
    for (const size of sizes) if (size > largest) largest = size;
    return this.removeIslands(largest);
  }

  /** Whether {@link graph} would return immediately rather than indexing the layer. */
  hasGraph(layer: Layer): boolean {
    return this.graphLayer === layer && this.graphValue !== undefined;
  }

  /**
   * The neighbour graph over the layer's live splats, built once and reused until the
   * layer resyncs. Throws {@link GraphTooLargeError} on clouds too big to index.
   */
  graph(layer: Layer): NeighbourGraph {
    if (this.graphLayer === layer && this.graphValue) return this.graphValue;
    this.releaseGraph();
    const store = layer.store;
    let live = 0;
    for (let index = 0; index < store.count; index += 1) if (store.alive[index]) live += 1;
    if (live > MAX_GRAPH_SPLATS)
      throw new GraphTooLargeError(
        `“${layer.name}” has ${live.toLocaleString()} live splats; the smart tools handle up to ${MAX_GRAPH_SPLATS.toLocaleString()}. Split it down first.`,
      );
    const nodes = new Uint32Array(live);
    let at = 0;
    for (let index = 0; index < store.count; index += 1)
      if (store.alive[index]) nodes[at++] = index;
    this.graphValue = buildNeighbourGraph(store.centers, store.count, nodes);
    this.graphLayer = layer;
    layer.addEventListener('synced', this.onLayerSynced);
    return this.graphValue;
  }

  dispose(): void {
    this.forget();
  }

  private readonly onLayerSynced = (): void => {
    // Alive flags or centres moved: the graph no longer describes the cloud.
    this.releaseGraph();
  };

  private releaseGraph(): void {
    this.graphLayer?.removeEventListener('synced', this.onLayerSynced);
    this.graphLayer = undefined;
    this.graphValue = undefined;
  }

  private morph(steps: number, add: boolean): void {
    const layer = this.layerValue;
    if (!layer || this.countValue === 0) return;
    const graph = this.graph(layer);
    const changed: number[] = [];
    const mask = this.maskValue;
    for (let step = 0; step < Math.max(1, steps); step += 1) {
      // Nearest-neighbour links are not symmetric, so both directions walk *out* from the
      // selected nodes: grow takes in their neighbours, shrink drops any of them that has
      // a neighbour still outside. Reading the rim from the other side would let a distant
      // splat that merely happens to list a selected one as its neighbour jump in.
      const front: number[] = [];
      for (let local = 0; local < graph.count; local += 1) {
        const index = graph.nodes[local]!;
        if (mask[index] !== 1) continue;
        const base = local * graph.stride;
        for (let at = 0; at < graph.degree[local]!; at += 1) {
          const neighbour = graph.nodes[graph.items[base + at]!]!;
          if (mask[neighbour] === 1) continue;
          if (add) front.push(neighbour);
          else {
            front.push(index);
            break;
          }
        }
      }
      if (front.length === 0) break;
      const applied = this.mark(Uint32Array.from(front), add ? 1 : 0);
      changed.push(...applied);
    }
    if (changed.length === 0) return;
    const touched = Uint32Array.from(changed);
    this.emit(layer, add ? touched : EMPTY, add ? EMPTY : touched);
  }

  /** Sets the mask for the given store indices, returning the ones that actually changed. */
  private mark(indices: Uint32Array, value: 0 | 1): Uint32Array {
    const layer = this.layerValue;
    if (!layer) return EMPTY;
    const alive = layer.store.alive;
    const changed: number[] = [];
    for (const index of indices) {
      if (index >= this.maskValue.length) continue;
      if (value === 1 && alive[index] !== 1) continue;
      if (this.maskValue[index] === value) continue;
      this.maskValue[index] = value;
      this.countValue += value === 1 ? 1 : -1;
      changed.push(index);
    }
    return Uint32Array.from(changed);
  }

  private emit(layer: Layer, added: Uint32Array, removed: Uint32Array): void {
    this.dispatchEvent(
      new CustomEvent<RegionChange>('region-changed', { detail: { layer, added, removed } }),
    );
  }
}
