import {
  BufferAttribute,
  BufferGeometry,
  Color,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  DoubleSide,
  MeshLambertMaterial,
  Object3D,
} from 'three';
import type { Vector3 } from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { dyno, SplatMesh } from '@sparkjsdev/spark';
import { lineResolution, SELECTION_ACCENT_HEX } from '../viewer/highlight';
import type { PointCloudInfo } from '../io/pointCloud';
import { solidBounds } from '../mesh/solid';
import type { SolidData } from '../mesh/solid';
import { VoxelGrid } from '../spatial/VoxelGrid';
import type { GroupMap } from '../splats/groups';
import type { Stroke } from '../sketch/stroke';
import { syncLayer } from '../viewer/sync';
import type { SplatStore, StoreBounds } from './SplatStore';

export type LayerKind = 'scan' | 'pointcloud' | 'sketch' | 'segment' | 'mesh';

export interface LayerOptions {
  name: string;
  kind: LayerKind;
  store: SplatStore;
  sourceName: string;
  pointCloud?: PointCloudInfo;
  sourceBytes?: ArrayBuffer;
  groups?: GroupMap;
  strokes?: Stroke[];
  /** Triangle mesh for `mesh` layers (the store is then empty). */
  solid?: SolidData;
  id?: string;
}

/**
 * A layer owns a CPU `SplatStore` (the truth) and a Spark mesh rebuilt from it. `mesh`
 * layers additionally carry a triangle `solid` rendered as a three.js Mesh; their store is
 * empty and they are converted to splats on export/merge.
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
  readonly strokes: Stroke[] = [];
  private storeValue: SplatStore;
  private meshValue = new SplatMesh({ maxSplats: 0 });
  private syncInFlight?: Promise<number>;
  private groupsValue?: GroupMap;
  private gridValue?: VoxelGrid;
  private storeToPackedValue?: Int32Array;
  private solidValue?: SolidData;
  private solidObjectValue?: Mesh;
  private solidEdges?: Object3D;
  /** Geometry/materials behind `solidEdges`, disposed when the edges are rebuilt. */
  private edgeResources: { dispose(): void }[] = [];
  private shown = true;
  private selectedValue = false;
  /**
   * 0..1 selection highlight amount read by the splat generator (`selectionModifier`): a
   * uniform, so selecting a layer tints/brightens its splats without rebuilding the mesh.
   */
  readonly highlight = new dyno.DynoFloat({ value: 0 });

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
    if (options.strokes) this.strokes.push(...options.strokes);
    if (options.solid) this.setSolid(options.solid);
    this.object.name = `Layer: ${this.name}`;
    void this.sync();
  }

  get store(): SplatStore {
    return this.storeValue;
  }

  get mesh(): SplatMesh {
    return this.meshValue;
  }

  /** Triangle mesh of a `mesh` layer, if any. */
  get solid(): SolidData | undefined {
    return this.solidValue;
  }

  /** The three.js Mesh rendering `solid` (child of `object`). */
  get solidObject(): Mesh | undefined {
    return this.solidObjectValue;
  }

  /** Whether the layer is drawn with its selection cue (set by the viewer from the document selection). */
  get selected(): boolean {
    return this.selectedValue;
  }

  /**
   * Selection cue: splats are nudged towards the accent and brightened (uniform, no rebuild);
   * a mesh's edges become thick glowing accent lines.
   */
  setSelected(selected: boolean): void {
    if (selected === this.selectedValue) return;
    this.selectedValue = selected;
    this.highlight.value = selected ? 1 : 0;
    this.meshValue.updateVersion();
    if (this.solidObjectValue) this.rebuildEdges(this.solidObjectValue);
  }

  /** (Re)creates the edge lines of the solid's mesh for the current face/selection state. */
  private rebuildEdges(mesh: Mesh): void {
    this.disposeEdges();
    const isFace = this.solidValue?.face !== undefined;
    const edges = new EdgesGeometry(mesh.geometry, 20);
    let lines: Object3D;
    if (this.selectedValue) {
      // Glow: a wide translucent accent line under a crisp one (pixel widths via LineMaterial).
      const geometry = new LineSegmentsGeometry().fromEdgesGeometry(edges);
      edges.dispose();
      const halo = new LineMaterial({
        color: SELECTION_ACCENT_HEX,
        linewidth: 10,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      });
      const core = new LineMaterial({
        color: SELECTION_ACCENT_HEX,
        linewidth: 3,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      });
      // Share the viewer's resolution vector so resizes need no per-material update.
      for (const material of [halo, core])
        (material.uniforms.resolution as { value: unknown }).value = lineResolution;
      const group = new Group();
      const haloLines = new LineSegments2(geometry, halo);
      const coreLines = new LineSegments2(geometry, core);
      haloLines.renderOrder = 1;
      coreLines.renderOrder = 2;
      group.add(haloLines, coreLines);
      lines = group;
      this.edgeResources = [geometry, halo, core];
    } else {
      const material = new LineBasicMaterial({
        color: isFace ? SELECTION_ACCENT_HEX : 0x000000,
        transparent: true,
        opacity: isFace ? 0.9 : 0.35,
      });
      lines = new LineSegments(edges, material);
      this.edgeResources = [edges, material];
    }
    lines.name = 'Solid edges';
    mesh.add(lines);
    this.solidEdges = lines;
  }

  private disposeEdges(): void {
    const edges = this.solidEdges;
    if (!edges) return;
    edges.removeFromParent();
    this.edgeResources.forEach((resource) => resource.dispose());
    this.edgeResources = [];
    this.solidEdges = undefined;
  }

  /** Replaces the triangle mesh (and its render object). */
  setSolid(solid: SolidData | undefined): void {
    this.disposeSolid();
    this.solidValue = solid;
    if (!solid) return;
    const indexed = new BufferGeometry();
    indexed.setAttribute('position', new BufferAttribute(solid.positions, 3));
    indexed.setIndex(new BufferAttribute(solid.indices, 1));
    const geometry = indexed.toNonIndexed();
    geometry.computeVertexNormals();
    indexed.dispose();
    const isFace = solid.face !== undefined;
    const material = new MeshLambertMaterial({
      color: new Color(solid.colour[0], solid.colour[1], solid.colour[2]),
      flatShading: true,
      // An unextruded face is a translucent, double-sided sheet until it is extruded.
      side: isFace ? DoubleSide : undefined,
      transparent: isFace,
      opacity: isFace ? 0.45 : 1,
      depthWrite: !isFace,
    });
    const mesh = new Mesh(geometry, material);
    mesh.name = `Solid: ${this.name}`;
    mesh.visible = this.shown;
    this.solidObjectValue = mesh;
    this.rebuildEdges(mesh);
    this.object.add(mesh);
  }

  /** Mesh layers: recolour the solid (three.js material + data). */
  setSolidColour(colour: [number, number, number]): void {
    if (!this.solidValue || !this.solidObjectValue) return;
    this.solidValue = { ...this.solidValue, colour };
    (this.solidObjectValue.material as MeshLambertMaterial).color.setRGB(
      colour[0],
      colour[1],
      colour[2],
    );
  }

  /** Bounds in layer-local space: the solid's box for mesh layers, robust store bounds otherwise. */
  localBounds(): StoreBounds {
    return this.solidValue
      ? solidBounds(this.solidValue.positions)
      : this.storeValue.computeRobustBounds();
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
    mesh.visible = this.shown;
    this.object.add(mesh);
  }

  /** Show/hide the layer's render objects (visibility × solo) without touching `visible`. */
  setShown(shown: boolean): void {
    this.shown = shown;
    this.meshValue.visible = shown;
    if (this.solidObjectValue) this.solidObjectValue.visible = shown;
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

  private disposeSolid(): void {
    this.disposeEdges();
    if (this.solidObjectValue) {
      this.solidObjectValue.removeFromParent();
      this.solidObjectValue.geometry.dispose();
      (this.solidObjectValue.material as MeshLambertMaterial).dispose();
      this.solidObjectValue = undefined;
    }
  }

  dispose(): void {
    this.meshValue.removeFromParent();
    this.meshValue.dispose();
    this.disposeSolid();
    this.object.removeFromParent();
  }
}
