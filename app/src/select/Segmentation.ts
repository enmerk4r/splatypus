import { Color, Matrix4, Vector3 } from 'three';
import type { Document } from '../model/Document';
import type { Layer } from '../model/Layer';
import { SetGroups, SplitSplats } from '../model/segmentCommands';
import { withAddedGroup } from '../splats/addGroup';
import { bakeConnectivity, suggestOptions } from '../splats/bakeConnectivity';
import { GroupMap, UNASSIGNED } from '../splats/groups';
import type { GroupInfo } from '../splats/groups';
import { baseColour, paintSplats } from '../viewer/paint';
import type { ColourAt } from '../viewer/paint';
import type { LayerHit } from '../viewer/picking';
import type { Viewer } from '../viewer/Viewer';
import { buildPalette } from './groupPalette';
import { RegionSelection } from './RegionSelection';
import type { RegionChange } from './RegionSelection';
import { bakeGeodesicPatches } from './superpixels';

export interface GroupSelection {
  layer: Layer;
  /** Last group clicked, retained as the primary group for hover comparisons. */
  groupId: number;
  /** All groups in the selection. Shift-click adds or removes ids in this list. */
  groupIds: readonly number[];
  info: GroupInfo;
  /** Store indices of the group (may include splats hidden since the bake). */
  indices: Uint32Array;
}

/** Why the last click did not end in a selection — the two failures look identical on screen. */
export type PickOutcome = 'none' | 'missed' | 'unassigned' | 'selected';

/** What a re-bake groups splats by. */
export type BakeBasis = 'patches' | 'colour' | 'colour-only' | 'position';

const HIGHLIGHT = new Color('#b8f34a');
const HIGHLIGHT_STRENGTH = 0.65;
/** Hover lifts towards white rather than the selection colour, so "would get" never looks like "have". */
const HOVER = new Color('#e8f6ec');
const HOVER_STRENGTH = 0.3;
/**
 * With the segmentation overlay on, a lime tint on a field of random patch colours is
 * invisible. Everything outside the selection is dimmed to this instead, so the selection
 * reads as the lit part of the mask.
 */
const UNSELECTED_DIM = 0.35;
/** Detail 0..5 → colour cell size (coarser cells: fewer, larger groups; finer: more unassigned). */
const COLOUR_SIZES = [0.45, 0.3, 0.24, 0.18, 0.12, 0.08];
/** Detail 0..5 → multiplier on the suggested voxel size, used when colour is ignored. */
const VOXEL_SCALES = [3, 2, 1.5, 1, 0.7, 0.5];
/** Detail 0..5 → how many patches the geodesic carve aims for. */
const PATCH_COUNTS = [30, 80, 200, 500, 1200, 3000];

/**
 * Group selection on top of the layer model: a click picks the nearest splat of the hit
 * layer and looks its group up in that layer's `.groups` map; the selection can then be
 * split into its own layer (an undoable command). Tints and the group overlay are painted
 * into the GPU cache only — the store is never touched — and re-applied after a resync.
 *
 * Events: `selection-changed`, `hover-changed` ({info, x, y}), `groups-changed`, `overlay-changed`.
 */
export class Segmentation extends EventTarget {
  private document?: Document;
  private selectionValue?: GroupSelection;
  private hoverValue?: GroupSelection;
  private outcomeValue: PickOutcome = 'none';
  private overlayEnabled = false;
  private blendValue = 1;
  private readonly subscribed = new Set<Layer>();
  /** Selected split layers use the same green language as selected unsplit groups. */
  private highlightedLayers = new Set<Layer>();
  /** Layers currently painted with the mask dimmed around a selection. */
  private readonly dimmedLayers = new Set<Layer>();
  /**
   * The free-form, per-splat selection. Groups answer "what did the baker think this is";
   * this answers "what do I want", and the two share one highlight colour and one
   * "Split to layer" because to the hand they are the same act.
   */
  readonly region = new RegionSelection();

  constructor(private readonly viewer: Viewer) {
    super();
    this.region.addEventListener('region-changed', this.onRegionChanged);
    viewer.addEventListener('document-changed', this.onDocumentChanged);
    viewer.addEventListener('canvas-click', this.onClick);
    viewer.addEventListener('canvas-hover', this.onHover);
    this.onDocumentChanged();
  }

  get selection(): GroupSelection | undefined {
    return this.selectionValue;
  }
  get hover(): GroupSelection | undefined {
    return this.hoverValue;
  }
  get outcome(): PickOutcome {
    return this.outcomeValue;
  }
  get overlay(): boolean {
    return this.overlayEnabled;
  }
  get blend(): number {
    return this.blendValue;
  }
  /** Any layer carrying a segmentation. */
  get segmentedLayers(): Layer[] {
    return this.document?.layers.filter((layer) => layer.groups !== undefined) ?? [];
  }

  /** The layer segmentation acts on: the active one, else the only layer. */
  targetLayer(): Layer | undefined {
    const document = this.document;
    if (!document) return undefined;
    return document.active() ?? (document.layers.length === 1 ? document.layers[0] : undefined);
  }

  select(layer: Layer | undefined, groupId?: number, additive = false): void {
    this.clearHover();
    if (this.selectionValue) this.restore(this.selectionValue.layer, this.selectionValue.indices);
    if (!layer?.groups || groupId === undefined || groupId === UNASSIGNED) {
      this.selectionValue = undefined;
    } else {
      const previous = this.selectionValue;
      const groupIds =
        additive && previous?.layer === layer ? [...previous.groupIds] : ([] as number[]);
      const existing = groupIds.indexOf(groupId);
      if (existing >= 0) groupIds.splice(existing, 1);
      else groupIds.push(groupId);
      this.selectionValue = groupIds.length
        ? this.makeSelection(layer, groupIds, groupId)
        : undefined;
      if (this.selectionValue) {
        this.outcomeValue = 'selected';
        // A group inside a layer is only a candidate until it is split out. Clear the
        // editable-layer selection so the containing layer's gumball does not imply that
        // the unsplit group itself can already be transformed.
        this.document?.setSelection([]);
        this.tint(layer, this.selectionValue.indices, HIGHLIGHT, HIGHLIGHT_STRENGTH);
      }
    }
    this.dispatchEvent(new Event('selection-changed'));
  }

  /** Selects every group containing a projected splat accepted by the screen predicate. */
  selectProjected(
    accepts: (clientX: number, clientY: number) => boolean,
    additive = false,
  ): number {
    const layer =
      this.selectionValue?.layer ??
      this.targetLayer() ??
      (this.segmentedLayers.length === 1 ? this.segmentedLayers[0] : undefined);
    const groups = layer?.groups;
    if (!layer || !groups) return 0;
    const camera = this.viewer.camera;
    const rect = this.viewer.canvasElement.getBoundingClientRect();
    const world = new Vector3();
    const projected = new Vector3();
    const selected = new Set<number>();
    layer.object.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    for (let index = 0; index < layer.store.count; index += 1) {
      if (!layer.store.alive[index]) continue;
      const groupId = groups.groupOf(index);
      if (groupId === UNASSIGNED || selected.has(groupId)) continue;
      world.fromArray(layer.store.centers, index * 3).applyMatrix4(layer.object.matrixWorld);
      projected.copy(world).project(camera);
      if (projected.z < -1 || projected.z > 1) continue;
      const clientX = rect.left + ((projected.x + 1) * rect.width) / 2;
      const clientY = rect.top + ((1 - projected.y) * rect.height) / 2;
      if (accepts(clientX, clientY)) selected.add(groupId);
    }
    this.selectGroups(layer, [...selected], additive);
    return selected.size;
  }

  /**
   * Adopts a free set of splat indices as a new group on the layer, and selects it.
   *
   * This is where a selection that did not come from a bake enters the model — a SAM mask
   * lifted to 3D, or any other per-splat set. Once it is a group it behaves like every
   * other group: click, hover, overlay, split to layer, save, export. Undoable.
   *
   * @returns the new group's id, or −1 when there was nothing to add.
   */
  selectIndices(
    layer: Layer,
    indices: Uint32Array,
    options: { name: string; source?: string; additive?: boolean },
  ): number {
    const document = this.document;
    if (!document || indices.length === 0) return -1;
    // Adopting the new map clears the selection, so remember what was held before it does.
    const held =
      options.additive && this.selectionValue?.layer === layer
        ? [...this.selectionValue.groupIds]
        : [];
    const next = withAddedGroup(layer.groups, layer.store.count, indices, {
      name: options.name,
      source: options.source ?? 'sam',
    });
    const newId = next.numGroups - 1;
    document.history.push(
      new SetGroups(
        document,
        layer.id,
        next,
        (target, groups) => this.applyGroups(target, groups),
        `Select ${options.name}`,
      ),
    );
    this.selectGroups(layer, [...held, newId], false);
    return newId;
  }

  private selectGroups(layer: Layer, groupIds: readonly number[], additive: boolean): void {
    this.clearHover();
    if (this.selectionValue) this.restore(this.selectionValue.layer, this.selectionValue.indices);
    const combined =
      additive && this.selectionValue?.layer === layer
        ? [...this.selectionValue.groupIds]
        : ([] as number[]);
    for (const groupId of groupIds) if (!combined.includes(groupId)) combined.push(groupId);
    this.selectionValue = combined.length
      ? this.makeSelection(layer, combined, combined.at(-1)!)
      : undefined;
    if (this.selectionValue) {
      this.outcomeValue = 'selected';
      this.document?.setSelection([]);
      this.tint(layer, this.selectionValue.indices, HIGHLIGHT, HIGHLIGHT_STRENGTH);
    }
    this.dispatchEvent(new Event('selection-changed'));
  }

  /** Splats currently selected either way, for the UI's enable/disable logic. */
  get hasSelection(): boolean {
    return this.selectionValue !== undefined || !this.region.isEmpty;
  }

  /**
   * Lifts the current selection into its own layer (undoable) and selects that layer. The
   * free-form region wins when both exist: it is the one the hand just drew.
   */
  splitSelection(): Layer | undefined {
    const document = this.document;
    if (!document) return undefined;
    const regionLayer = this.region.layer;
    if (regionLayer && !this.region.isEmpty) {
      const indices = this.region.indices();
      this.region.clear();
      const command = new SplitSplats(document, regionLayer, indices, 'region');
      document.history.push(command);
      document.setSelection([command.segment.id]);
      return command.segment;
    }
    const selection = this.selectionValue;
    if (!selection) return undefined;
    const command = new SplitSplats(
      document,
      selection.layer,
      selection.indices,
      selection.info.name,
    );
    this.select(undefined);
    document.history.push(command);
    document.setSelection([command.segment.id]);
    return command.segment;
  }

  /** Adopts a segmentation for a layer (from a sidecar or a bake). */
  applyGroups(layer: Layer, groups: GroupMap | undefined): void {
    this.select(undefined);
    layer.setGroups(groups);
    this.outcomeValue = 'none';
    this.repaint(layer);
    this.dispatchEvent(new Event('groups-changed'));
  }

  /**
   * Renames one group in place.
   *
   * Not undoable, and deliberately so: this exists for the object namer, whose answer
   * arrives after the selection is already made. Pushing a second history entry for it
   * would mean the user has to undo twice to get rid of one click.
   */
  renameGroup(layer: Layer, groupId: number, name: string): void {
    const groups = layer.groups;
    if (!groups || groupId < 0 || groupId >= groups.numGroups) return;
    const list = groups.meta.groups;
    const info = list?.find((group) => group.id === groupId);
    if (info) info.name = name;
    else if (list) list.push({ id: groupId, name, count: groups.indicesOf(groupId).length });
    else return;
    this.dispatchEvent(new Event('groups-changed'));
    this.dispatchEvent(new Event('selection-changed'));
  }

  /**
   * Adopts a whole segmentation for a layer as one undo step — for a bake that produces
   * many groups at once, rather than a single selection.
   */
  applyGroupsUndoable(layer: Layer, groups: GroupMap | undefined, label: string): void {
    const document = this.document;
    if (!document) {
      this.applyGroups(layer, groups);
      return;
    }
    document.history.push(
      new SetGroups(
        document,
        layer.id,
        groups,
        (target, next) => this.applyGroups(target, next),
        label,
      ),
    );
  }

  /** Re-runs the geometric bake over a layer's store and adopts the result. */
  rebake(layer: Layer, basis: BakeBasis, detail: number): { numGroups: number; assigned: number } {
    const store = layer.store;
    const step = Math.min(Math.max(Math.round(detail), 0), 5);
    if (basis === 'patches') return this.bakePatches(layer, step);
    const options = suggestOptions(store.centers, store.count);
    if (basis === 'position') {
      options.colourSize = 0;
      options.voxelSize *= VOXEL_SCALES[step]!;
    } else {
      options.colourSize = COLOUR_SIZES[step]!;
      options.spatialConnectivity = basis !== 'colour-only';
    }
    // Hidden splats must not bridge objects: give them zero opacity for the bake.
    const opacities = store.opacities.slice();
    for (let index = 0; index < store.count; index += 1)
      if (!store.alive[index]) opacities[index] = 0;
    const { ids, groups, stats } = bakeConnectivity(
      { count: store.count, centres: store.centers, colours: store.colors, opacities },
      options,
    );
    this.applyGroups(
      layer,
      GroupMap.fromIds(ids, {
        numSplats: store.count,
        numGroups: groups.length,
        source:
          basis === 'position'
            ? 'position'
            : basis === 'colour-only'
              ? 'colour'
              : 'colour + position',
        groups,
      }),
    );
    return { numGroups: groups.length, assigned: stats.assigned };
  }

  /**
   * Carves the layer into patches that partition it, rather than looking for cells that
   * happen to match. Every splat the graph reaches lands in a patch, so the overlay reads
   * as a flat segmentation mask instead of a scatter of coloured specks.
   */
  private bakePatches(layer: Layer, step: number): { numGroups: number; assigned: number } {
    const store = layer.store;
    const { ids, groups, assigned } = bakeGeodesicPatches(
      store.centers,
      store.colors,
      store.count,
      this.region.graph(layer),
      PATCH_COUNTS[step]!,
    );
    this.applyGroups(
      layer,
      GroupMap.fromIds(ids, {
        numSplats: store.count,
        numGroups: groups.length,
        source: 'geodesic patches',
        groups,
      }),
    );
    return { numGroups: groups.length, assigned };
  }

  setOverlay(enabled: boolean): void {
    if (enabled === this.overlayEnabled) return;
    this.overlayEnabled = enabled;
    this.dimmedLayers.clear();
    const regionLayer = this.region.layer;
    if (regionLayer && this.dimsForRegion(regionLayer)) this.dimmedLayers.add(regionLayer);
    this.segmentedLayers.forEach((layer) => this.repaint(layer));
    if (regionLayer && !this.segmentedLayers.includes(regionLayer)) this.repaint(regionLayer);
    this.dispatchEvent(new Event('overlay-changed'));
  }

  setBlend(blend: number): void {
    this.blendValue = Math.min(Math.max(blend, 0), 1);
    if (this.overlayEnabled) this.segmentedLayers.forEach((layer) => this.repaint(layer));
    this.dispatchEvent(new Event('overlay-changed'));
  }

  dispose(): void {
    this.viewer.removeEventListener('document-changed', this.onDocumentChanged);
    this.viewer.removeEventListener('canvas-click', this.onClick);
    this.viewer.removeEventListener('canvas-hover', this.onHover);
    this.region.removeEventListener('region-changed', this.onRegionChanged);
    this.region.dispose();
    this.unsubscribe();
  }

  /** Repaints only what entered or left the free-form selection. */
  private readonly onRegionChanged = (event: Event): void => {
    const { layer, added, removed } = (event as CustomEvent<RegionChange>).detail;
    if (this.document?.getLayer(layer.id)) {
      const dimming = this.dimsForRegion(layer);
      if (dimming !== this.dimmedLayers.has(layer)) {
        // The rule for every *unselected* splat just changed, so nothing incremental will
        // do — but it only changes when a selection appears or goes away, not as it grows.
        if (dimming) this.dimmedLayers.add(layer);
        else this.dimmedLayers.delete(layer);
        this.repaint(layer);
      } else {
        if (removed.length > 0) this.restore(layer, removed);
        if (added.length > 0) this.tint(layer, added, HIGHLIGHT, HIGHLIGHT_STRENGTH);
      }
    }
    this.dispatchEvent(new Event('region-changed'));
  };

  // ---- picking ----------------------------------------------------------------------

  private pickGroup(hit: LayerHit): { layer: Layer; groupId: number } | 'missed' | 'no-groups' {
    const layer = hit.layer;
    if (!layer.groups) return 'no-groups';
    layer.object.updateMatrixWorld(true);
    const local = hit.point
      .clone()
      .applyMatrix4(new Matrix4().copy(layer.object.matrixWorld).invert());
    const groups = layer.groups;
    const nearest = layer.pickSplat(local);
    if (nearest < 0) return 'missed';
    // A bake leaves most splats unassigned; if the very nearest one is, prefer the nearest
    // assigned splat in the same radius so clicking a coloured patch selects that patch.
    const index =
      groups.groupOf(nearest) === UNASSIGNED
        ? layer.pickSplat(
            local,
            layer.pickRadius,
            (candidate) => groups.groupOf(candidate) !== UNASSIGNED,
          )
        : nearest;
    return { layer, groupId: index < 0 ? UNASSIGNED : groups.groupOf(index) };
  }

  private readonly onClick = (event: Event): void => {
    const detail = (
      event as CustomEvent<{ event: PointerEvent; hit?: LayerHit; additive?: boolean }>
    ).detail;
    const { hit } = detail;
    if (this.segmentedLayers.length === 0) return;
    const picked = hit ? this.pickGroup(hit) : 'missed';
    if (picked === 'no-groups') {
      this.outcomeValue = 'none';
      this.select(undefined);
    } else if (picked === 'missed') {
      this.outcomeValue = 'missed';
      this.select(undefined);
    } else if (picked.groupId === UNASSIGNED) {
      // Not a bug: a bake leaves splats it could not confidently label out of every group.
      this.outcomeValue = 'unassigned';
      this.select(undefined);
    } else {
      this.select(picked.layer, picked.groupId, detail.additive ?? detail.event.shiftKey);
    }
  };

  private readonly onHover = (event: Event): void => {
    const detail = (event as CustomEvent<{ event: PointerEvent; hit?: LayerHit }>).detail;
    if (this.segmentedLayers.length === 0) return;
    const picked = detail.hit ? this.pickGroup(detail.hit) : 'missed';
    let next: GroupSelection | undefined;
    if (typeof picked !== 'string' && picked.groupId !== UNASSIGNED) {
      const { layer, groupId } = picked;
      const held =
        this.selectionValue?.layer === layer && this.selectionValue.groupIds.includes(groupId);
      if (!held && layer.groups)
        next = {
          layer,
          groupId,
          groupIds: [groupId],
          info: layer.groups.info(groupId),
          indices: layer.groups.indicesOf(groupId),
        };
    }
    if (next?.layer === this.hoverValue?.layer && next?.groupId === this.hoverValue?.groupId)
      return;
    if (this.hoverValue) this.restore(this.hoverValue.layer, this.hoverValue.indices);
    this.hoverValue = next;
    if (next) this.tint(next.layer, next.indices, HOVER, HOVER_STRENGTH);
    this.dispatchEvent(
      new CustomEvent('hover-changed', {
        detail: { info: next?.info, x: detail.event.clientX, y: detail.event.clientY },
      }),
    );
  };

  private clearHover(): void {
    if (!this.hoverValue) return;
    this.restore(this.hoverValue.layer, this.hoverValue.indices);
    this.hoverValue = undefined;
    this.dispatchEvent(new CustomEvent('hover-changed', { detail: {} }));
  }

  private makeSelection(
    layer: Layer,
    groupIds: readonly number[],
    primary: number,
  ): GroupSelection {
    const groups = layer.groups!;
    const parts = groupIds.map((id) => groups.indicesOf(id));
    const count = parts.reduce((total, indices) => total + indices.length, 0);
    const indices = new Uint32Array(count);
    let offset = 0;
    for (const part of parts) {
      indices.set(part, offset);
      offset += part.length;
    }
    const info =
      groupIds.length === 1
        ? groups.info(groupIds[0]!)
        : { id: primary, name: `${groupIds.length} groups`, count };
    return { layer, groupId: primary, groupIds: [...groupIds], info, indices };
  }

  // ---- painting ---------------------------------------------------------------------

  /** Display colour before any tint: the store colour, or the group label when the overlay is on. */
  private painter(layer: Layer): ColourAt {
    const groups = layer.groups;
    const region = this.region;
    const dimming = this.dimsForRegion(layer);
    if (!this.overlayEnabled || !groups) return (index, out) => void baseColour(layer, index, out);
    const palette = buildPalette(groups.numGroups);
    const blend = this.blendValue;
    const label = new Color();
    return (index, out): void => {
      const id = groups.groupOf(index);
      if (id === UNASSIGNED || id >= groups.numGroups) baseColour(layer, index, out);
      else {
        label.setRGB(palette[id * 3]!, palette[id * 3 + 1]!, palette[id * 3 + 2]!);
        baseColour(layer, index, out).lerp(label, blend);
      }
      if (dimming && !region.has(index)) out.multiplyScalar(UNSELECTED_DIM);
    };
  }

  /** Whether the mask is currently being dimmed around a selection on this layer. */
  private dimsForRegion(layer: Layer): boolean {
    return this.overlayEnabled && this.region.layer === layer && !this.region.isEmpty;
  }

  private tint(
    layer: Layer,
    indices: Iterable<number> | undefined,
    colour: Color,
    strength: number,
  ): void {
    const base = this.painter(layer);
    paintSplats(
      layer,
      (index, out) => {
        base(index, out);
        out.lerp(colour, strength);
      },
      indices,
    );
  }

  private restore(layer: Layer, indices: Uint32Array): void {
    paintSplats(layer, this.painter(layer), indices);
  }

  /** Whole-layer repaint (overlay state) with the current tints put back on top. */
  private repaint(layer: Layer): void {
    const groups = layer.groups;
    paintSplats(
      layer,
      this.painter(layer),
      undefined,
      this.overlayEnabled && groups
        ? (index) =>
            groups.groupOf(index) === UNASSIGNED ? (layer.store.opacities[index] ?? 1) : 1
        : (index) => layer.store.opacities[index] ?? 1,
    );
    if (this.selectionValue?.layer === layer)
      this.tint(layer, this.selectionValue.indices, HIGHLIGHT, HIGHLIGHT_STRENGTH);
    if (this.hoverValue?.layer === layer)
      this.tint(layer, this.hoverValue.indices, HOVER, HOVER_STRENGTH);
    if (this.highlightedLayers.has(layer))
      this.tint(layer, undefined, HIGHLIGHT, HIGHLIGHT_STRENGTH);
    if (this.region.layer === layer && !this.region.isEmpty)
      this.tint(layer, this.region.indices(), HIGHLIGHT, HIGHLIGHT_STRENGTH);
  }

  // ---- document wiring ---------------------------------------------------------------

  private readonly onDocumentChanged = (): void => {
    this.unsubscribe();
    this.document?.removeEventListener('layers-changed', this.onLayersChanged);
    this.document?.removeEventListener('selection-changed', this.syncLayerHighlights);
    this.document = this.viewer.document;
    this.dimmedLayers.clear();
    this.region.forget();
    this.selectionValue = undefined;
    this.hoverValue = undefined;
    this.highlightedLayers.clear();
    this.outcomeValue = 'none';
    this.overlayEnabled = false;
    this.document?.addEventListener('layers-changed', this.onLayersChanged);
    this.document?.addEventListener('selection-changed', this.syncLayerHighlights);
    this.onLayersChanged();
    this.syncLayerHighlights();
    this.dispatchEvent(new Event('region-changed'));
    this.dispatchEvent(new Event('groups-changed'));
    this.dispatchEvent(new Event('selection-changed'));
    this.dispatchEvent(new Event('overlay-changed'));
  };

  /** Follow every layer's `synced` so paint survives a mesh rebuild; drop stale selections. */
  private readonly onLayersChanged = (): void => {
    const layers = new Set(this.document?.layers ?? []);
    for (const layer of [...this.subscribed])
      if (!layers.has(layer)) {
        layer.removeEventListener('synced', this.onLayerSynced);
        this.subscribed.delete(layer);
      }
    for (const layer of layers)
      if (!this.subscribed.has(layer)) {
        layer.addEventListener('synced', this.onLayerSynced);
        this.subscribed.add(layer);
      }
    if (this.selectionValue && !layers.has(this.selectionValue.layer)) {
      this.selectionValue = undefined;
      this.dispatchEvent(new Event('selection-changed'));
    }
    if (this.hoverValue && !layers.has(this.hoverValue.layer)) this.hoverValue = undefined;
    const regionLayer = this.region.layer;
    if (regionLayer && !layers.has(regionLayer)) {
      this.region.forget();
      this.dispatchEvent(new Event('region-changed'));
    }
    this.syncLayerHighlights();
  };

  private readonly onLayerSynced = (event: Event): void => {
    const layer = event.target as Layer;
    if (layer.groups || this.highlightedLayers.has(layer) || this.region.layer === layer)
      this.repaint(layer);
  };

  private readonly syncLayerHighlights = (): void => {
    const document = this.document;
    const next = new Set(
      document?.layers.filter(
        (layer) => layer.kind === 'segment' && document.selection.has(layer.id),
      ) ?? [],
    );
    const changed = new Set([...this.highlightedLayers, ...next]);
    this.highlightedLayers = next;
    changed.forEach((layer) => {
      if (this.document?.getLayer(layer.id)) this.repaint(layer);
    });
  };

  private unsubscribe(): void {
    this.subscribed.forEach((layer) => layer.removeEventListener('synced', this.onLayerSynced));
    this.subscribed.clear();
  }
}

/** World-space centroid helper for UI (e.g. framing a selection). */
export function selectionCentroid(selection: GroupSelection): Vector3 {
  const { layer, indices } = selection;
  const centroid = new Vector3();
  let count = 0;
  for (const index of indices) {
    if (!layer.store.alive[index]) continue;
    centroid.x += layer.store.centers[index * 3] ?? 0;
    centroid.y += layer.store.centers[index * 3 + 1] ?? 0;
    centroid.z += layer.store.centers[index * 3 + 2] ?? 0;
    count += 1;
  }
  if (count > 0) centroid.divideScalar(count);
  layer.object.updateMatrixWorld(true);
  return centroid.applyMatrix4(layer.object.matrixWorld);
}
