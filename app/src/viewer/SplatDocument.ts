import { Color, Quaternion, Vector3 } from 'three';
import type { SplatMesh } from '@sparkjsdev/spark';
import type { PointCloudInfo } from '../io/pointCloud';
import { rescalePointCloud } from '../io/pointCloud';
import { VoxelGrid } from '../spatial/VoxelGrid';
import type { GroupMap } from '../splats/groups';
import { UNASSIGNED } from '../splats/groups';
import type { RobustBounds } from './framing';
import { getRobustBounds } from './framing';

export type DocumentKind = 'splat' | 'pointcloud';

/** Splat attributes as Spark hands them back, kept so an edit can be undone exactly. */
interface SplatSnapshot {
  index: number;
  center: Vector3;
  scales: Vector3;
  quaternion: Quaternion;
  opacity: number;
  color: Color;
}

export class SplatDocument {
  readonly mesh: SplatMesh;
  readonly name: string;
  readonly byteLength: number;
  readonly kind: DocumentKind;
  /** Source bytes, retained for point clouds so the point budget can be changed. */
  readonly bytes?: ArrayBuffer;
  readonly pointCloud?: PointCloudInfo;
  private boundsCache?: RobustBounds;

  /** Splat centres in mesh-local space, mirrored on the CPU for picking and editing. */
  readonly centres: Float32Array;
  /** Splat base colours, mirrored so a re-bake needs no second pass over the mesh. */
  readonly colours: Float32Array;
  /** Splat opacities, mirrored for the same reason. */
  readonly opacities: Float32Array;
  /** Scene radius measured once at load; picking needs a scale, not live bounds. */
  private readonly sceneRadius: number;
  private readonly grid: VoxelGrid;
  private groupsValue?: GroupMap;

  /** Original attributes of every splat currently modified, keyed by splat index. */
  private readonly edited = new Map<number, SplatSnapshot>();

  /**
   * Whether this document can be segmented at all.
   *
   * Spark's level-of-detail tree (which loadSplat turns on above LOD_ABOVE_SPLATS) moves
   * the splats into a separate `lodSplats` array and renumbers them, leaving
   * `forEachSplat` with nothing to walk. Everything here — the CPU mirror, picking, and
   * the index-addressed .groups sidecar — depends on file-order indexing, so on such a
   * scene segmentation is not merely degraded, it is meaningless. Better to say so than
   * to fail silently on every click.
   */
  readonly isSegmentable: boolean;

  constructor(
    mesh: SplatMesh,
    name: string,
    byteLength: number,
    kind: DocumentKind = 'splat',
    extra: { bytes?: ArrayBuffer; pointCloud?: PointCloudInfo } = {},
  ) {
    this.mesh = mesh;
    this.name = name;
    this.byteLength = byteLength;
    this.kind = kind;
    if (extra.bytes) this.bytes = extra.bytes;
    if (extra.pointCloud) this.pointCloud = extra.pointCloud;

    this.centres = new Float32Array(mesh.numSplats * 3);
    this.colours = new Float32Array(mesh.numSplats * 3);
    this.opacities = new Float32Array(mesh.numSplats);
    mesh.forEachSplat((index, center, _scales, _quaternion, opacity, color) => {
      this.centres[index * 3] = center.x;
      this.centres[index * 3 + 1] = center.y;
      this.centres[index * 3 + 2] = center.z;
      this.colours[index * 3] = color.r;
      this.colours[index * 3 + 1] = color.g;
      this.colours[index * 3 + 2] = color.b;
      this.opacities[index] = opacity;
    });
    this.isSegmentable = mesh.numSplats > 0;
    this.sceneRadius = this.getRobustBounds().radius;
    this.grid = VoxelGrid.forCentres(this.centres, this.sceneRadius * 2);
  }

  get numSplats(): number {
    return this.mesh.numSplats;
  }

  get pointScale(): number | undefined {
    return this.pointCloud?.pointScale;
  }

  /** Current point radius relative to the load-time estimate (point clouds only). */
  get pointSizeMul(): number | undefined {
    const info = this.pointCloud;
    if (!info || info.basePointScale <= 0) return undefined;
    return info.pointScale / info.basePointScale;
  }

  /** Point clouds only: change the per-point radius in place. */
  setPointScale(scale: number): void {
    if (this.kind !== 'pointcloud' || !this.pointCloud) return;
    this.pointCloud.pointScale = scale;
    rescalePointCloud(this.mesh, scale);
  }

  getRobustBounds(): RobustBounds {
    // Bounds are in world space and depend on the mesh orientation; recompute when it changes.
    const key = this.mesh.quaternion.toArray().join(',');
    if (!this.boundsCache || this.boundsKey !== key) {
      this.boundsCache = getRobustBounds(this.mesh);
      this.boundsKey = key;
    }
    return this.boundsCache;
  }
  private boundsKey = '';

  get groups(): GroupMap | undefined {
    return this.groupsValue;
  }

  setGroups(groups: GroupMap | undefined): void {
    this.groupsValue = groups;
  }

  /**
   * How far from a ray hit to look for a splat centre. The hit sits on a gaussian's
   * surface rather than on its centre, so this has to be generous relative to scene
   * scale — but it is a constant, not something to re-measure on every click.
   */
  get pickRadius(): number {
    return this.sceneRadius * 0.05;
  }

  /** Mean of the given splats' centres, in mesh-local space. */
  centroidOf(indices: Iterable<number>): Vector3 {
    const centroid = new Vector3();
    let count = 0;
    for (const index of indices) {
      centroid.x += this.centres[index * 3]!;
      centroid.y += this.centres[index * 3 + 1]!;
      centroid.z += this.centres[index * 3 + 2]!;
      count += 1;
    }
    return count > 0 ? centroid.divideScalar(count) : centroid;
  }

  /**
   * Splat index nearest to a world-space point, or -1 if none is within `maxRadius`.
   * Spark's raycast returns where a ray met the cloud but not which splat it met, so
   * picking is a two-step: raycast for the surface point, then this for the identity.
   */
  pickSplat(worldPoint: Vector3, maxRadius: number): number {
    this.mesh.updateWorldMatrix(true, false);
    const local = worldPoint.clone().applyMatrix4(this.mesh.matrixWorld.clone().invert());
    return this.grid.nearest(local.x, local.y, local.z, maxRadius);
  }

  /** Group containing a splat, or `UNASSIGNED` when no sidecar is loaded. */
  groupOf(splatIndex: number): number {
    return this.groupsValue?.groupOf(splatIndex) ?? UNASSIGNED;
  }

  /** Tints splats in place, remembering their originals so the tint can be undone. */
  tint(indices: Iterable<number>, colour: Color, strength: number): void {
    this.edit(indices, (splat, original) => {
      splat.color.copy(original.color).lerp(colour, strength);
    });
  }

  /**
   * Repaints every splat, leaving geometry and opacity untouched.
   *
   * This writes the packed array directly instead of going through getSplat/setSplat,
   * which allocate four THREE objects per splat — at scene scale that difference is
   * what separates an instant repaint from a visible stall. Only the low three bytes
   * are written; the top byte holds opacity, and a repaint must not unhide a splat
   * that a split layer hid.
   */
  paintBy(colourAt: (index: number, out: Color) => void): void {
    const packed = this.mesh.packedSplats;
    const array = packed?.packedArray;
    if (!packed || !array) return;
    const min = packed.splatEncoding?.rgbMin ?? 0;
    const range = (packed.splatEncoding?.rgbMax ?? 1) - min || 1;
    const scratch = new Color();
    for (let index = 0; index < this.numSplats; index += 1) {
      colourAt(index, scratch);
      const slot = index * 4;
      array[slot] =
        (array[slot]! & 0xff000000) |
        quantise(scratch.r, min, range) |
        (quantise(scratch.g, min, range) << 8) |
        (quantise(scratch.b, min, range) << 16);
      // An edit in flight remembers the colour it has to undo to; that is now this one.
      this.edited.get(index)?.color.copy(scratch);
    }
    this.commit();
  }

  /** Puts every splat back to the colour it was loaded with. */
  resetColours(): void {
    this.paintBy((index, out) => {
      out.setRGB(
        this.colours[index * 3]!,
        this.colours[index * 3 + 1]!,
        this.colours[index * 3 + 2]!,
      );
    });
  }

  /** The colour a splat had at load time, before any overlay or tint. */
  baseColour(index: number, out: Color): Color {
    return out.setRGB(
      this.colours[index * 3]!,
      this.colours[index * 3 + 1]!,
      this.colours[index * 3 + 2]!,
    );
  }

  /** Makes splats invisible without removing them, so the change stays reversible. */
  hide(indices: Iterable<number>): void {
    this.edit(indices, (splat) => {
      splat.opacity = 0;
    });
  }

  /** Restores splats to the attributes they had before any edit. Omit for all of them. */
  restore(indices?: Iterable<number>): void {
    const packed = this.mesh.packedSplats;
    if (!packed || this.edited.size === 0) return;
    const snapshots: SplatSnapshot[] = [];
    if (indices === undefined) {
      snapshots.push(...this.edited.values());
    } else {
      for (const index of indices) {
        const snapshot = this.edited.get(index);
        if (snapshot) snapshots.push(snapshot);
      }
    }
    for (const snapshot of snapshots) {
      packed.setSplat(
        snapshot.index,
        snapshot.center,
        snapshot.scales,
        snapshot.quaternion,
        snapshot.opacity,
        snapshot.color,
      );
      this.edited.delete(snapshot.index);
    }
    this.commit();
  }

  /**
   * Applies a per-splat change, snapshotting each splat the first time it is touched.
   * The mutator always sees the *original* attributes, so repeated edits to the same
   * splat do not compound.
   */
  private edit(
    indices: Iterable<number>,
    mutate: (splat: SplatSnapshot, original: SplatSnapshot) => void,
  ): void {
    const packed = this.mesh.packedSplats;
    if (!packed) return;
    for (const index of indices) {
      const splat = packed.getSplat(index);
      const current: SplatSnapshot = { index, ...splat };
      if (!this.edited.has(index)) {
        this.edited.set(index, {
          index,
          center: splat.center.clone(),
          scales: splat.scales.clone(),
          quaternion: splat.quaternion.clone(),
          opacity: splat.opacity,
          color: splat.color.clone(),
        });
      }
      mutate(current, this.edited.get(index)!);
      packed.setSplat(
        index,
        current.center,
        current.scales,
        current.quaternion,
        current.opacity,
        current.color,
      );
    }
    this.commit();
  }

  /**
   * Publishes CPU-side splat edits to the renderer.
   *
   * Both steps are needed: `needsUpdate` re-uploads the packed array to its texture,
   * while `updateVersion` is what makes SparkRenderer regenerate the splats it has
   * accumulated for this mesh. Setting only the former uploads new data that nothing
   * ever reads, and the edit silently does not appear.
   */
  private commit(): void {
    const packed = this.mesh.packedSplats;
    if (!packed) return;
    packed.needsUpdate = true;
    this.mesh.updateVersion();
  }

  dispose(): void {
    this.mesh.dispose();
  }
}

/** Packs a linear colour channel into the byte the renderer reads it from. */
function quantise(value: number, min: number, range: number): number {
  return Math.max(0, Math.min(255, Math.round(((value - min) / range) * 255)));
}
