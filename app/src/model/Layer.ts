import { Object3D } from 'three';
import type { Vector3 } from 'three';
import { SplatMesh } from '@sparkjsdev/spark';
import type { PointCloudInfo } from '../io/pointCloud';
import { VoxelGrid } from '../spatial/VoxelGrid';
import type { GroupMap } from '../splats/groups';
import { syncLayer } from '../viewer/sync';
import type { SplatStore } from './SplatStore';

export type LayerKind = 'scan' | 'pointcloud' | 'sketch' | 'segment';

export interface LayerOptions {
  name: string;
  kind: LayerKind;
  store: SplatStore;
  sourceName: string;
  pointCloud?: PointCloudInfo;
  sourceBytes?: ArrayBuffer;
  groups?: GroupMap;
  id?: string;
}

/**
 * A layer owns a CPU `SplatStore` (the truth) and a Spark mesh rebuilt from it.
 * Events: `synced` after the GPU mesh was rebuilt from the store.
 */
export class Layer extends EventTarget {
  readonly id: string;
  name: string;
  readonly kind: LayerKind;
  visible = true;
  locked = false;
  readonly object = new Object3D();
  dirty = true;
  pointCloud?: PointCloudInfo;
  sourceName: string;
  sourceBytes?: ArrayBuffer;
  packedToStore: Uint32Array = new Uint32Array();
  private storeValue: SplatStore;
  private meshValue = new SplatMesh({ maxSplats: 0 });
  private syncInFlight?: Promise<number>;
  private groupsValue?: GroupMap;
  private gridValue?: VoxelGrid;
  private storeToPackedValue?: Int32Array;

  constructor(options: LayerOptions) {
    super();
    this.id = options.id ?? crypto.randomUUID();
    this.name = options.name;
    this.kind = options.kind;
    this.storeValue = options.store;
    this.sourceName = options.sourceName;
    if (options.pointCloud) this.pointCloud = { ...options.pointCloud };
    if (options.sourceBytes) this.sourceBytes = options.sourceBytes;
    if (options.groups) this.setGroups(options.groups);
    this.object.name = `Layer: ${this.name}`;
    void this.sync();
  }

  get store(): SplatStore {
    return this.storeValue;
  }

  get mesh(): SplatMesh {
    return this.meshValue;
  }

  /** Per-splat segmentation of this layer's store (index-aligned), if any. */
  get groups(): GroupMap | undefined {
    return this.groupsValue;
  }

  setGroups(groups: GroupMap | undefined): void {
    if (groups && groups.ids.length !== this.storeValue.count)
      throw new Error(
        `The .groups file covers ${groups.ids.length} splats but the layer has ${this.storeValue.count}.`,
      );
    this.groupsValue = groups;
  }

  replaceStore(store: SplatStore, pointCloud?: PointCloudInfo): void {
    this.storeValue = store;
    this.pointCloud = pointCloud ? { ...pointCloud } : undefined;
    // A different store means different indices: segmentation and the pick grid no longer apply.
    if (this.groupsValue && this.groupsValue.ids.length !== store.count)
      this.groupsValue = undefined;
    this.gridValue = undefined;
    this.dirty = true;
    void this.sync();
  }

  replaceMesh(mesh: SplatMesh, packedToStore: Uint32Array): void {
    this.meshValue.removeFromParent();
    this.meshValue = mesh;
    this.packedToStore = packedToStore;
    this.storeToPackedValue = undefined;
    mesh.visible = this.visible;
    this.object.add(mesh);
  }

  /** Inverse of `packedToStore`: GPU slot per store index, −1 for dead splats. Built on demand. */
  storeToPacked(): Int32Array {
    if (!this.storeToPackedValue) {
      const map = new Int32Array(this.storeValue.count).fill(-1);
      this.packedToStore.forEach((storeIndex, packedIndex) => {
        map[storeIndex] = packedIndex;
      });
      this.storeToPackedValue = map;
    }
    return this.storeToPackedValue;
  }

  /** Voxel hash grid over the store's centres (layer-local), built on first use. */
  get pickGrid(): VoxelGrid {
    this.gridValue ??= VoxelGrid.forCentres(
      this.storeValue.centers,
      this.storeValue.computeRobustBounds().radius * 2,
    );
    return this.gridValue;
  }

  /**
   * How far from a surface hit to look for a splat centre. A raycast lands on a gaussian's
   * surface, not its centre, so this is generous relative to the layer's size.
   */
  get pickRadius(): number {
    return Math.max(this.storeValue.computeRobustBounds().radius * 0.05, 1e-4);
  }

  /**
   * Nearest live splat (store index) to a layer-local point within `maxRadius`, or −1.
   * `accept` narrows the candidates further (e.g. to splats that belong to a group).
   */
  pickSplat(
    local: Vector3,
    maxRadius = this.pickRadius,
    accept: (index: number) => boolean = () => true,
  ): number {
    const alive = this.storeValue.alive;
    return this.pickGrid.nearest(
      local.x,
      local.y,
      local.z,
      maxRadius,
      (index) => alive[index] === 1 && accept(index),
    );
  }

  /** Call after centres changed; the grid is rebuilt on next use (dead splats are filtered at query time). */
  invalidatePick(): void {
    this.gridValue = undefined;
  }

  async sync(): Promise<number> {
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = syncLayer(this)
      .finally(() => {
        this.syncInFlight = undefined;
      })
      .then((elapsed) => {
        this.dispatchEvent(new Event('synced'));
        // The store changed while we were rebuilding: run again so the GPU cache catches up.
        return this.dirty ? this.sync().then((more) => elapsed + more) : elapsed;
      });
    return this.syncInFlight;
  }

  dispose(): void {
    this.meshValue.removeFromParent();
    this.meshValue.dispose();
    this.object.removeFromParent();
  }
}
