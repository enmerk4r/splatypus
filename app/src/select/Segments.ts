import { Color, Vector3 } from 'three';
import { SplatMesh } from '@sparkjsdev/spark';
import type { Viewer } from '../viewer/Viewer';
import type { GroupInfo } from '../splats/groups';
import { GroupMap, UNASSIGNED } from '../splats/groups';
import { bakeConnectivity, suggestOptions } from '../splats/bakeConnectivity';

/** A group lifted out of the scan into its own mesh, so it can be moved or removed. */
export interface SegmentLayer {
  groupId: number;
  name: string;
  mesh: SplatMesh;
  indices: Uint32Array;
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
    if (raycaster && this.layers.length > 0) {
      const meshes = this.layers.map((layer) => layer.mesh);
      const hit = raycaster.intersectObjects(meshes, false)[0];
      if (hit) {
        const layer = this.layers.find((candidate) => candidate.mesh === hit.object);
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
    if (this.layers.some((layer) => layer.groupId === selection.groupId)) return undefined;

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
      groupId: selection.groupId,
      name: selection.info.name,
      mesh,
      indices: selection.indices,
    };
    this.layers.push(layer);
    this.selectionValue = undefined;
    this.dispatchEvent(new Event('selection-changed'));
    this.dispatchEvent(new CustomEvent('layers-changed', { detail: layer }));
    return layer;
  }

  /** Puts a split layer back where it came from. */
  mergeLayer(layer: SegmentLayer): void {
    const document = this.viewer.document;
    const at = this.layers.indexOf(layer);
    if (at < 0) return;
    this.layers.splice(at, 1);
    this.viewer.detach(layer.mesh);
    layer.mesh.dispose();
    document?.restore(layer.indices);
    this.dispatchEvent(new Event('layers-changed'));
  }

  /**
   * Removes a layer's splats from view. They stay in the document as hidden splats;
   * compaction happens at export, so this remains undoable until then.
   */
  deleteLayer(layer: SegmentLayer): void {
    const at = this.layers.indexOf(layer);
    if (at < 0) return;
    this.layers.splice(at, 1);
    this.viewer.detach(layer.mesh);
    layer.mesh.dispose();
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
    for (const layer of this.layers) {
      this.viewer.detach(layer.mesh);
      layer.mesh.dispose();
    }
    this.layers.length = 0;
    this.selectionValue = undefined;
    this.hoverValue = undefined;
    this.dispatchEvent(new Event('groups-changed'));
    this.dispatchEvent(new Event('selection-changed'));
    this.dispatchEvent(new Event('layers-changed'));
  }
}
