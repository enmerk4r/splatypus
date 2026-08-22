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

  constructor(private readonly viewer: Viewer) {
    super();
    viewer.addEventListener('canvas-click', (event) => {
      this.onClick((event as CustomEvent<{ event: MouseEvent }>).detail.event);
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
    for (let index = 0; index < extracted.numSplats; index += 1) {
      const splat = extracted.getSplat(index);
      splat.center.sub(centroid);
      extracted.setSplat(
        index,
        splat.center,
        splat.scales,
        splat.quaternion,
        splat.opacity,
        splat.color,
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
    this.dispatchEvent(new Event('selection-changed'));
  }

  private reset(): void {
    for (const layer of this.layers) {
      this.viewer.detach(layer.mesh);
      layer.mesh.dispose();
    }
    this.layers.length = 0;
    this.selectionValue = undefined;
    this.dispatchEvent(new Event('selection-changed'));
    this.dispatchEvent(new Event('layers-changed'));
  }
}
