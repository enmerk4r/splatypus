import { Box3, Color, Group, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import { PackedSplats, SplatMesh } from '@sparkjsdev/spark';
import type { Viewer } from '../viewer/Viewer';
import type { GroupInfo } from '../splats/groups';
import { GroupMap, UNASSIGNED } from '../splats/groups';
import { bakeConnectivity, suggestOptions } from '../splats/bakeConnectivity';

/**
 * An object in the edited scene: a group lifted out of the scan, a copy of one, or a
 * grouping of several.
 *
 * `groupId` and `indices` belong only to the original lift-out, because only it owns
 * splats hidden in the scan — a duplicate has no claim on them, and merging one back
 * would restore splats that its source still stands for.
 */
export interface SegmentLayer {
  readonly id: number;
  groupId?: number;
  name: string;
  /** What the gizmo moves. A SplatMesh normally; a Group once objects are nested. */
  object: Object3D;
  mesh?: SplatMesh;
  indices?: Uint32Array;
  children: SegmentLayer[];
  /** Splats this object draws. Read from the source rather than from the mesh, whose
   *  own count stays zero until Spark finishes initialising a freshly built copy. */
  splatCount: number;
  /** Extent in the object's own space, for snapping and framing. */
  bounds: Box3;
  /** Placement at creation, so a transform can be undone without a command stack. */
  origin: Vector3;
  originQuaternion: Quaternion;
  originScale: Vector3;
  hidden: boolean;
}

/** Why the last click did not end in a selection — the two failures look identical
 *  on screen but mean very different things about the bake. */
export type PickOutcome = 'none' | 'missed' | 'unassigned' | 'selected';

export interface SelectionState {
  groupId: number;
  info: GroupInfo;
  indices: Uint32Array;
}

const HIGHLIGHT = new Color('#4ade80');
const HIGHLIGHT_STRENGTH = 0.65;
/** Hover is a lift towards white rather than towards the selection green, so that
 *  "this is what you would get" never looks like "this is what you have". */
const HOVER = new Color('#e8f6ec');
const HOVER_STRENGTH = 0.3;

/** What a re-bake groups splats by. */
export type BakeBasis = 'colour' | 'position';

/**
 * Detail 1..5 → colour cell size. Coarser cells put more of the scene into fewer, larger
 * groups; finer cells separate more but leave more splats unassigned.
 */
const COLOUR_SIZES = [0.3, 0.24, 0.18, 0.12, 0.08];
/** Detail 1..5 → multiplier on the suggested voxel size, used when colour is ignored. */
const VOXEL_SCALES = [2, 1.5, 1, 0.7, 0.5];

/**
 * Turns a click into a selected group, and a selected group into an editable layer.
 *
 * Splitting copies the group's splats into their own `SplatMesh` and hides the originals
 * in the scan. Once split, moving the object is a matrix update on an `Object3D` —
 * Spark re-sorts and nothing touches splat data — which is what makes gizmo dragging and
 * (later) physics cheap.
 */
export class Segments extends EventTarget {
  private readonly layers: SegmentLayer[] = [];
  private selectionValue?: SelectionState;
  private outcomeValue: PickOutcome = 'none';
  private hoverValue?: { groupId: number; indices: Uint32Array };
  private activeLayerValue?: SegmentLayer;
  private isolatedValue?: SegmentLayer;
  /** Objects ticked in the outliner, by id — what Group acts on. Ids rather than layers,
   *  so a tick cannot pin a deleted object in memory. */
  private readonly tickedIds = new Set<number>();
  private nextId = 1;

  constructor(private readonly viewer: Viewer) {
    super();
    viewer.addEventListener('canvas-click', (event) => {
      this.onClick((event as CustomEvent<{ event: MouseEvent }>).detail.event);
    });
    viewer.addEventListener('canvas-hover', (event) => {
      const detail = (event as CustomEvent<{ event: PointerEvent; point?: Vector3 }>).detail;
      this.onHover(detail.point, detail.event);
    });
    viewer.addEventListener('document-changed', () => this.reset());
  }

  get selection(): SelectionState | undefined {
    return this.selectionValue;
  }

  get outcome(): PickOutcome {
    return this.outcomeValue;
  }

  get segmentLayers(): readonly SegmentLayer[] {
    return this.layers;
  }

  /** Group under the pointer, when it is one that could be selected. */
  get hover(): number | undefined {
    return this.hoverValue?.groupId;
  }

  /**
   * A click hits an already-split layer, or the scan behind it. Testing layers first is
   * what lets a segment stay selectable after it has been moved away from the scan.
   */
  private onClick(event: MouseEvent): void {
    const raycaster = this.viewer.raycasterFor(event);
    const drawn = this.allLayers().filter(
      (layer): layer is SegmentLayer & { mesh: SplatMesh } =>
        layer.mesh !== undefined && layer.object.visible,
    );
    if (raycaster && drawn.length > 0) {
      const hit = raycaster.intersectObjects(
        drawn.map((layer) => layer.mesh),
        false,
      )[0];
      if (hit) {
        const layer = drawn.find((candidate) => candidate.mesh === hit.object);
        if (layer) {
          this.dispatchEvent(new CustomEvent('layer-picked', { detail: layer }));
          return;
        }
      }
    }
    const point = this.viewer.pointAt(event);
    if (point) this.pick(point);
  }

  /**
   * Lights the group under the pointer without selecting it, and reports its name so
   * the cursor can carry a label.
   *
   * Two groups deliberately never take a hover tint: the selected one, because the
   * hover would replace its highlight and then strip it again on the way out, and one
   * already split into a layer, because its splats in the scan are hidden — undoing a
   * tint on those would restore their original opacity and bring them back.
   */
  private onHover(point: Vector3 | undefined, event: PointerEvent): void {
    const document = this.viewer.document;
    if (!document?.groups || !document.isSegmentable) return;

    let groupId: number | undefined;
    if (point) {
      const splatIndex = document.pickSplat(point, document.pickRadius);
      if (splatIndex >= 0) {
        const id = document.groupOf(splatIndex);
        const held = id === this.selectionValue?.groupId;
        const split = this.layers.some((layer) => layer.groupId === id);
        if (id !== UNASSIGNED && !held && !split) groupId = id;
      }
    }
    if (groupId === this.hoverValue?.groupId) return;

    if (this.hoverValue) document.restore(this.hoverValue.indices);
    if (groupId === undefined) {
      this.hoverValue = undefined;
    } else {
      const indices = document.groups.indicesOf(groupId);
      this.hoverValue = { groupId, indices };
      document.tint(indices, HOVER, HOVER_STRENGTH);
    }
    const info = groupId === undefined ? undefined : document.groups.info(groupId);
    this.dispatchEvent(
      new CustomEvent('hover-changed', {
        detail: { info, x: event.clientX, y: event.clientY },
      }),
    );
  }

  /** Drops the hover tint, e.g. once a click has turned it into a selection. */
  private clearHover(): void {
    if (!this.hoverValue) return;
    this.viewer.document?.restore(this.hoverValue.indices);
    this.hoverValue = undefined;
    this.dispatchEvent(new CustomEvent('hover-changed', { detail: {} }));
  }

  /**
   * Re-applies the highlight over whatever colours the scene now has. A whole-scene
   * repaint writes straight over the tint, so the overlay calls this to restore it.
   */
  retint(): void {
    const document = this.viewer.document;
    const selection = this.selectionValue;
    if (document && selection) document.tint(selection.indices, HIGHLIGHT, HIGHLIGHT_STRENGTH);
  }

  /** Selects the group owning the splat nearest a surface point. */
  pick(worldPoint: Vector3): void {
    const document = this.viewer.document;
    if (!document?.groups || !document.isSegmentable) return;
    const splatIndex = document.pickSplat(worldPoint, document.pickRadius);
    if (splatIndex < 0) {
      this.outcomeValue = 'missed';
      this.select(undefined);
      return;
    }
    const groupId = document.groupOf(splatIndex);
    // An unassigned splat is not a bug: a bake leaves splats it could not confidently
    // label out of every group, and the connectivity bake leaves a lot of them.
    this.outcomeValue = groupId === UNASSIGNED ? 'unassigned' : 'selected';
    this.select(groupId === UNASSIGNED ? undefined : groupId);
  }

  select(groupId: number | undefined): void {
    const document = this.viewer.document;
    if (!document?.groups) return;

    this.clearHover();
    if (this.selectionValue) document.restore(this.selectionValue.indices);
    if (groupId === undefined) {
      this.selectionValue = undefined;
    } else {
      this.outcomeValue = 'selected';
      const indices = document.groups.indicesOf(groupId);
      this.selectionValue = { groupId, info: document.groups.info(groupId), indices };
      document.tint(indices, HIGHLIGHT, HIGHLIGHT_STRENGTH);
    }
    this.dispatchEvent(new Event('selection-changed'));
  }

  /** Lifts the current selection into its own mesh and hides it in the scan. */
  splitSelection(): SegmentLayer | undefined {
    const document = this.viewer.document;
    const selection = this.selectionValue;
    if (!document || !selection || selection.indices.length === 0) return undefined;
    if (this.allLayers().some((layer) => layer.groupId === selection.groupId)) return undefined;

    const packed = document.mesh.packedSplats;
    if (!packed) return undefined;

    // Copy before restoring, so the layer carries original colours rather than the tint.
    document.restore(selection.indices);
    const extracted = packed.extractSplats(new Uint32Array(selection.indices), false);

    // Re-origin the layer on its own centroid. Inheriting the scan's transform instead
    // would leave every layer's origin at the scene origin, so the gizmo would sit in
    // the same place whichever segment is selected, and rotation would swing the segment
    // around the scene rather than around itself.
    const centroid = document.centroidOf(selection.indices);
    const colour = new Color();
    for (let index = 0; index < extracted.numSplats; index += 1) {
      const splat = extracted.getSplat(index);
      splat.center.sub(centroid);
      // Take the colour from the load-time mirror rather than from the copy. The scan
      // may be showing label colours, and those are a diagnostic view of an unsegmented
      // cloud — an object lifted out of it is a real object and shows its own colours.
      document.baseColour(selection.indices[index]!, colour);
      extracted.setSplat(
        index,
        splat.center,
        splat.scales,
        splat.quaternion,
        splat.opacity,
        colour,
      );
    }
    extracted.needsUpdate = true;

    const mesh = new SplatMesh({ packedSplats: extracted });
    document.mesh.updateMatrixWorld(true);
    mesh.quaternion.copy(document.mesh.quaternion);
    mesh.scale.copy(document.mesh.scale);
    // The centroid's world position is where the re-originned layer must sit to land
    // exactly where its splats were.
    mesh.position.copy(centroid).applyMatrix4(document.mesh.matrixWorld);
    mesh.updateMatrixWorld(true);

    document.hide(selection.indices);
    this.viewer.attach(mesh);

    const layer: SegmentLayer = {
      id: this.nextId++,
      groupId: selection.groupId,
      name: selection.info.name,
      object: mesh,
      mesh,
      indices: selection.indices,
      children: [],
      splatCount: selection.indices.length,
      bounds: boundsOf(document.centres, selection.indices, centroid),
      origin: mesh.position.clone(),
      originQuaternion: mesh.quaternion.clone(),
      originScale: mesh.scale.clone(),
      hidden: false,
    };
    this.layers.push(layer);
    this.selectionValue = undefined;
    this.activate(layer);
    this.dispatchEvent(new Event('selection-changed'));
    this.dispatchEvent(new CustomEvent('layers-changed', { detail: layer }));
    return layer;
  }

  /** Puts a split layer back where it came from, along with anything nested in it. */
  mergeLayer(layer: SegmentLayer): void {
    this.dropLayer(layer, true);
    this.dispatchEvent(new Event('layers-changed'));
  }

  /**
   * Removes a layer's splats from view. They stay in the document as hidden splats;
   * compaction happens at export, so this remains undoable until then.
   */
  deleteLayer(layer: SegmentLayer): void {
    this.dropLayer(layer, false);
    this.dispatchEvent(new Event('layers-changed'));
  }

  /** Takes a layer out of the scene, optionally giving its splats back to the scan. */
  private dropLayer(layer: SegmentLayer, restore: boolean): void {
    for (const child of [...layer.children]) this.dropLayer(child, restore);
    const siblings = this.siblingsOf(layer);
    const at = siblings.indexOf(layer);
    if (at >= 0) siblings.splice(at, 1);
    this.tickedIds.delete(layer.id);
    if (this.activeLayerValue === layer) this.activate(undefined);
    if (this.isolatedValue === layer) this.isolate(undefined);
    layer.object.removeFromParent();
    this.viewer.detach(layer.object);
    layer.mesh?.dispose();
    // Only the original lift-out has splats hidden on its behalf; see SegmentLayer.
    if (restore && layer.indices) this.viewer.document?.restore(layer.indices);
  }

  private siblingsOf(layer: SegmentLayer): SegmentLayer[] {
    const parent = this.allLayers().find((candidate) => candidate.children.includes(layer));
    return parent ? parent.children : this.layers;
  }

  /** Every layer in the scene, parents before their children. */
  allLayers(): SegmentLayer[] {
    const flat: SegmentLayer[] = [];
    const walk = (layers: readonly SegmentLayer[]): void => {
      for (const layer of layers) {
        flat.push(layer);
        walk(layer.children);
      }
    };
    walk(this.layers);
    return flat;
  }

  /** The object the gizmo is on, and that the object tools act upon. */
  get activeLayer(): SegmentLayer | undefined {
    return this.activeLayerValue;
  }

  get isolated(): SegmentLayer | undefined {
    return this.isolatedValue;
  }

  activate(layer: SegmentLayer | undefined): void {
    if (this.activeLayerValue === layer) return;
    this.activeLayerValue = layer;
    this.dispatchEvent(new Event('active-changed'));
  }

  /** Objects ticked for the next Group, in outliner order. */
  get ticked(): SegmentLayer[] {
    return this.allLayers().filter((layer) => this.tickedIds.has(layer.id));
  }

  isTicked(layer: SegmentLayer): boolean {
    return this.tickedIds.has(layer.id);
  }

  setTicked(layer: SegmentLayer, ticked: boolean): void {
    if (ticked) this.tickedIds.add(layer.id);
    else this.tickedIds.delete(layer.id);
    this.dispatchEvent(new Event('layers-changed'));
  }

  groupTicked(): SegmentLayer | undefined {
    const made = this.groupLayers(this.ticked);
    if (made) this.tickedIds.clear();
    return made;
  }

  /** Puts an object back where it was lifted out, undoing every move since. */
  resetTransform(layer: SegmentLayer): void {
    layer.object.position.copy(layer.origin);
    layer.object.quaternion.copy(layer.originQuaternion);
    layer.object.scale.copy(layer.originScale);
    layer.object.updateMatrixWorld(true);
    this.dispatchEvent(new Event('layers-changed'));
  }

  rename(layer: SegmentLayer, name: string): void {
    const trimmed = name.trim();
    if (!trimmed || trimmed === layer.name) return;
    layer.name = trimmed;
    this.dispatchEvent(new Event('layers-changed'));
  }

  setHidden(layer: SegmentLayer, hidden: boolean): void {
    layer.hidden = hidden;
    layer.object.visible = !hidden;
    this.dispatchEvent(new Event('layers-changed'));
  }

  /**
   * Copies an object, offset by a fraction of its own size so the copy is visible
   * rather than hidden inside the original.
   */
  duplicate(layer: SegmentLayer, offset?: Vector3): SegmentLayer | undefined {
    const copy = this.copyOf(layer);
    if (!copy) return undefined;
    const step = offset ?? new Vector3(layer.bounds.getSize(new Vector3()).x * 1.2, 0, 0);
    copy.object.position.copy(layer.object.position).add(step);
    copy.object.quaternion.copy(layer.object.quaternion);
    copy.object.scale.copy(layer.object.scale);
    copy.object.updateMatrixWorld(true);
    copy.origin.copy(copy.object.position);
    copy.originQuaternion.copy(copy.object.quaternion);
    copy.originScale.copy(copy.object.scale);
    this.siblingsOf(layer).push(copy);
    this.dispatchEvent(new Event('layers-changed'));
    return copy;
  }

  /** Duplicates an object `count` times along a step vector — one chair becomes a row. */
  arrayCopies(layer: SegmentLayer, count: number, step?: Vector3): SegmentLayer[] {
    const spacing = step ?? new Vector3(layer.bounds.getSize(new Vector3()).x * 1.2, 0, 0);
    const made: SegmentLayer[] = [];
    for (let n = 1; n <= Math.max(1, Math.round(count)); n += 1) {
      const copy = this.duplicate(layer, spacing.clone().multiplyScalar(n));
      if (copy) made.push(copy);
    }
    return made;
  }

  /** Deep-copies a layer's splats and its nested children into a new layer. */
  private copyOf(layer: SegmentLayer): SegmentLayer | undefined {
    const object: Object3D | undefined = layer.mesh ? this.copyMesh(layer.mesh) : new Group();
    if (!object) return undefined;
    const copy: SegmentLayer = {
      id: this.nextId++,
      name: this.copyName(layer.name),
      object,
      ...(object instanceof SplatMesh ? { mesh: object } : {}),
      children: [],
      splatCount: layer.splatCount,
      bounds: layer.bounds.clone(),
      origin: new Vector3(),
      originQuaternion: new Quaternion(),
      originScale: new Vector3(1, 1, 1),
      hidden: false,
    };
    for (const child of layer.children) {
      const childCopy = this.copyOf(child);
      if (!childCopy) continue;
      childCopy.object.position.copy(child.object.position);
      childCopy.object.quaternion.copy(child.object.quaternion);
      childCopy.object.scale.copy(child.object.scale);
      object.add(childCopy.object);
      copy.children.push(childCopy);
    }
    if (!object.parent) this.viewer.attach(object);
    return copy;
  }

  /**
   * Names a copy so a row of them reads as a row. Group names already end in a number,
   * so the counter goes in a suffix of its own rather than straight onto the name.
   */
  private copyName(name: string): string {
    const root = name.replace(/ \(copy(?: \d+)?\)$/, '');
    const taken = new Set(this.allLayers().map((layer) => layer.name));
    if (!taken.has(`${root} (copy)`)) return `${root} (copy)`;
    for (let n = 2; ; n += 1) {
      if (!taken.has(`${root} (copy ${n})`)) return `${root} (copy ${n})`;
    }
  }

  private copyMesh(mesh: SplatMesh): SplatMesh | undefined {
    const source = mesh.packedSplats;
    if (!source?.packedArray) return undefined;
    // A duplicate owns its own splat data. Sharing the array would be cheaper, but then
    // editing one copy would edit them all, which is not what "duplicate" means.
    const packed = new PackedSplats({
      packedArray: source.packedArray.slice(),
      numSplats: source.numSplats,
      ...(source.splatEncoding ? { splatEncoding: source.splatEncoding } : {}),
    });
    packed.needsUpdate = true;
    return new SplatMesh({ packedSplats: packed });
  }

  /**
   * Nests several objects under one, so the gizmo moves them together.
   *
   * The group sits at the centre of what it holds rather than at the scene origin, for
   * the same reason a lifted-out segment does: a gizmo somewhere else entirely, and a
   * rotation that swings rather than spins, is not a usable handle.
   */
  groupLayers(members: readonly SegmentLayer[]): SegmentLayer | undefined {
    const chosen = members.filter((layer) => this.allLayers().includes(layer));
    if (chosen.length < 2) return undefined;

    const parent = new Group();
    const centre = new Vector3();
    for (const layer of chosen) {
      layer.object.updateMatrixWorld(true);
      centre.add(layer.object.getWorldPosition(new Vector3()));
    }
    centre.divideScalar(chosen.length);
    parent.position.copy(centre);
    this.viewer.attach(parent);
    parent.updateMatrixWorld(true);

    const bounds = new Box3();
    for (const layer of chosen) {
      const siblings = this.siblingsOf(layer);
      const at = siblings.indexOf(layer);
      if (at >= 0) siblings.splice(at, 1);
      // `attach` keeps the child where it is on screen while changing its parent.
      parent.attach(layer.object);
      bounds.union(layer.bounds.clone().translate(layer.object.position));
    }

    const group: SegmentLayer = {
      id: this.nextId++,
      name: `Group of ${chosen.length}`,
      object: parent,
      children: [...chosen],
      splatCount: chosen.reduce((total, layer) => total + layer.splatCount, 0),
      bounds,
      origin: parent.position.clone(),
      originQuaternion: parent.quaternion.clone(),
      originScale: parent.scale.clone(),
      hidden: false,
    };
    this.layers.push(group);
    this.activate(group);
    this.dispatchEvent(new Event('layers-changed'));
    return group;
  }

  /** Lifts a grouping's children back out to its own level and discards the grouping. */
  ungroup(layer: SegmentLayer): void {
    if (layer.children.length === 0) return;
    const siblings = this.siblingsOf(layer);
    const at = siblings.indexOf(layer);
    if (at < 0) return;
    const parentObject = this.parentObjectFor(siblings);
    for (const child of [...layer.children]) {
      // `attach` preserves world placement across the reparent; the scene root is the
      // parent when the grouping was top level.
      this.viewer.attachTo(child.object, parentObject);
      siblings.push(child);
    }
    layer.children.length = 0;
    siblings.splice(siblings.indexOf(layer), 1);
    if (this.activeLayerValue === layer) this.activate(undefined);
    layer.object.removeFromParent();
    this.viewer.detach(layer.object);
    this.dispatchEvent(new Event('layers-changed'));
  }

  private parentObjectFor(siblings: SegmentLayer[]): Object3D | undefined {
    if (siblings === this.layers) return undefined;
    return this.allLayers().find((candidate) => candidate.children === siblings)?.object;
  }

  /**
   * Shows one object alone. Everything else — the scan and every other layer — is hidden
   * rather than removed, so leaving isolation is a second click and not an undo.
   */
  isolate(layer: SegmentLayer | undefined): void {
    this.isolatedValue = layer;
    const document = this.viewer.document;
    if (document) document.mesh.visible = layer === undefined;
    for (const candidate of this.allLayers()) {
      const visible = layer === undefined || candidate === layer || this.contains(layer, candidate);
      candidate.object.visible = visible && !candidate.hidden;
    }
    this.dispatchEvent(new Event('layers-changed'));
  }

  private contains(parent: SegmentLayer, candidate: SegmentLayer): boolean {
    return parent.children.some((child) => child === candidate || this.contains(child, candidate));
  }

  /**
   * Drops an object until it rests on the ground plane the grid is drawn on. Placing a
   * lifted-out object by eye is the one thing an orbit camera makes genuinely hard,
   * because depth along the view direction is invisible.
   */
  snapToFloor(layer: SegmentLayer): void {
    layer.object.updateMatrixWorld(true);
    const world = layer.bounds.clone().applyMatrix4(layer.object.matrixWorld);
    if (world.isEmpty()) return;
    layer.object.position.y += this.viewer.floorY - world.min.y;
    layer.object.updateMatrixWorld(true);
    this.dispatchEvent(new Event('layers-changed'));
  }

  /**
   * Re-runs the geometric bake over the loaded scene and adopts the result. Split layers
   * are merged back first, because their group ids refer to the old bake.
   */
  rebake(basis: BakeBasis, detail: number): { numGroups: number; assigned: number } | undefined {
    const document = this.viewer.document;
    if (!document?.isSegmentable) return undefined;

    for (const layer of [...this.layers]) this.mergeLayer(layer);
    this.select(undefined);

    const options = suggestOptions(document.centres, document.numSplats);
    const step = Math.min(Math.max(Math.round(detail), 1), 5) - 1;
    if (basis === 'position') {
      options.colourSize = 0;
      options.voxelSize *= VOXEL_SCALES[step]!;
    } else {
      options.colourSize = COLOUR_SIZES[step]!;
    }

    const { ids, groups, stats } = bakeConnectivity(
      {
        count: document.numSplats,
        centres: document.centres,
        colours: document.colours,
        opacities: document.opacities,
      },
      options,
    );
    this.applyGroups(
      GroupMap.fromIds(ids, {
        numSplats: document.numSplats,
        numGroups: groups.length,
        source: basis === 'position' ? 'position' : 'colour + position',
        groups,
      }),
    );
    return { numGroups: groups.length, assigned: stats.assigned };
  }

  /** Adopts a different segmentation of the same scene. */
  applyGroups(groups: GroupMap): void {
    const document = this.viewer.document;
    if (!document) return;
    for (const layer of [...this.layers]) this.mergeLayer(layer);
    this.select(undefined);
    document.setGroups(groups);
    this.outcomeValue = 'none';
    this.dispatchEvent(new Event('groups-changed'));
    this.dispatchEvent(new Event('selection-changed'));
  }

  private reset(): void {
    for (const layer of this.allLayers()) {
      layer.object.removeFromParent();
      this.viewer.detach(layer.object);
      layer.mesh?.dispose();
    }
    this.layers.length = 0;
    this.selectionValue = undefined;
    this.hoverValue = undefined;
    this.activeLayerValue = undefined;
    this.isolatedValue = undefined;
    this.tickedIds.clear();
    this.dispatchEvent(new Event('active-changed'));
    this.dispatchEvent(new Event('groups-changed'));
    this.dispatchEvent(new Event('selection-changed'));
    this.dispatchEvent(new Event('layers-changed'));
  }
}

/** Extent of a set of splats about their own centroid, in the layer's own space. */
function boundsOf(centres: Float32Array, indices: Uint32Array, centroid: Vector3): Box3 {
  const box = new Box3();
  const point = new Vector3();
  for (const index of indices) {
    point.set(centres[index * 3]!, centres[index * 3 + 1]!, centres[index * 3 + 2]!).sub(centroid);
    box.expandByPoint(point);
  }
  return box;
}
