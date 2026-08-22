import { Matrix4, Quaternion, Vector3 } from 'three';
import { bakeAnisotropicScale } from './anisotropic';
import type { Factor3 } from './anisotropic';
import type { Document } from './Document';
import { Layer } from './Layer';
import { DuplicateLayer, SetLayerTransform } from './compoundCommands';
import { LockedLayerError } from './history';
import type { Command } from './history';

/** Runs several commands as one undo step (in order; undone in reverse). */
export class CompositeCommand implements Command {
  constructor(
    readonly label: string,
    private readonly commands: Command[],
  ) {}
  do(): void {
    this.commands.forEach((command) => command.do());
  }
  undo(): void {
    [...this.commands].reverse().forEach((command) => command.undo());
  }
  dispose(): void {
    this.commands.forEach((command) => command.dispose?.());
  }
}

function setAlive(layer: Layer, indices: Uint32Array, alive: boolean): void {
  const mask = layer.store.alive;
  const value = alive ? 1 : 0;
  for (const index of indices) mask[index] = value;
  layer.store.invalidateBounds();
  layer.invalidatePick();
  layer.dirty = true;
  void layer.sync();
}

/** Hides (alive = 0) or restores a set of splats in one layer. Dead splats are skipped by sync and export. */
export class SetSplatsAlive implements Command {
  readonly label: string;
  private readonly indices: Uint32Array;
  constructor(
    private readonly document: Document,
    private readonly layerId: string,
    indices: Uint32Array,
    private readonly alive: boolean,
  ) {
    this.indices = indices.slice();
    this.label = `${alive ? 'Restore' : 'Hide'} ${indices.length.toLocaleString()} splats`;
  }
  private layer(): Layer {
    const layer = this.document.getLayer(this.layerId);
    if (!layer) throw new Error('Layer no longer exists');
    if (layer.locked) throw new LockedLayerError('Unlock the layer before editing it.');
    return layer;
  }
  do(): void {
    setAlive(this.layer(), this.indices, this.alive);
    this.document.notifyLayerChanged(this.layerId);
  }
  undo(): void {
    setAlive(this.layer(), this.indices, !this.alive);
    this.document.notifyLayerChanged(this.layerId);
  }
}

/**
 * Lifts a set of splats out of a layer into a new `segment` layer and hides them in the
 * source. The new layer is re-originned on the splats' centroid so the gizmo sits on the
 * object and rotation spins it about itself; its transform composes with the source's.
 */
export class SplitSplats implements Command {
  readonly label: string;
  readonly segment: Layer;
  private readonly indices: Uint32Array;
  private readonly sourceId: string;
  private readonly index: number;
  private attached = false;

  constructor(
    private readonly document: Document,
    source: Layer,
    indices: Uint32Array,
    name: string,
  ) {
    if (source.locked) throw new LockedLayerError('Unlock the layer before splitting it.');
    const alive = source.store.alive;
    this.indices = indices.filter((index) => alive[index] === 1);
    if (this.indices.length === 0) throw new Error('Nothing to split.');
    const store = source.store.slice(this.indices);
    const centroid = new Vector3();
    for (let index = 0; index < store.count; index += 1)
      centroid.x += store.centers[index * 3] ?? 0;
    for (let index = 0; index < store.count; index += 1)
      centroid.y += store.centers[index * 3 + 1] ?? 0;
    for (let index = 0; index < store.count; index += 1)
      centroid.z += store.centers[index * 3 + 2] ?? 0;
    centroid.divideScalar(store.count);
    for (let index = 0; index < store.count; index += 1) {
      store.centers[index * 3] = (store.centers[index * 3] ?? 0) - centroid.x;
      store.centers[index * 3 + 1] = (store.centers[index * 3 + 1] ?? 0) - centroid.y;
      store.centers[index * 3 + 2] = (store.centers[index * 3 + 2] ?? 0) - centroid.z;
    }
    store.invalidateBounds();
    this.segment = new Layer({ name, kind: 'segment', store, sourceName: source.sourceName });
    source.object.updateMatrix();
    this.segment.object.matrix
      .copy(source.object.matrix)
      .multiply(new Matrix4().makeTranslation(centroid.x, centroid.y, centroid.z));
    this.segment.object.matrix.decompose(
      this.segment.object.position,
      this.segment.object.quaternion,
      this.segment.object.scale,
    );
    this.sourceId = source.id;
    this.index = document.layers.findIndex((layer) => layer.id === source.id) + 1;
    this.label = `Split ${name}`;
  }

  private source(): Layer {
    const layer = this.document.getLayer(this.sourceId);
    if (!layer) throw new Error('Source layer no longer exists');
    return layer;
  }

  do(): void {
    const source = this.source();
    setAlive(source, this.indices, false);
    this.document.addLayer(this.segment, this.index);
    this.attached = true;
    this.document.notifyLayerChanged(source.id);
  }

  undo(): void {
    this.document.removeLayer(this.segment.id);
    const source = this.source();
    setAlive(source, this.indices, true);
    this.attached = false;
    this.document.notifyLayerChanged(source.id);
  }

  dispose(): void {
    if (!this.attached) this.segment.dispose();
  }
}

/**
 * Bakes a non-uniform scale (layer-local axes) into a layer's splats. Spark renders a
 * layer's Object3D with a uniform scale only, so anisotropic scaling has to change the
 * data: centres scale, covariances are re-diagonalised. Undo restores exact snapshots.
 */
export class ScaleSplats implements Command {
  readonly label: string;
  private snapshot?: { centers: Float32Array; scales: Float32Array; rotations: Float32Array };
  constructor(
    private readonly document: Document,
    private readonly layerId: string,
    private readonly factor: Factor3,
  ) {
    this.label = `Scale ×${factor.map((value) => value.toFixed(2)).join(' · ')}`;
  }
  private layer(): Layer {
    const layer = this.document.getLayer(this.layerId);
    if (!layer) throw new Error('Layer no longer exists');
    if (layer.locked) throw new LockedLayerError('Unlock the layer before scaling it.');
    return layer;
  }
  do(): void {
    const layer = this.layer();
    const { store } = layer;
    this.snapshot = {
      centers: store.centers.slice(),
      scales: store.scales.slice(),
      rotations: store.rotations.slice(),
    };
    bakeAnisotropicScale(store, this.factor);
    layer.invalidatePick();
    layer.dirty = true;
    void layer.sync();
    this.document.notifyLayerChanged(layer.id);
  }
  undo(): void {
    const layer = this.layer();
    if (!this.snapshot) return;
    layer.store.centers.set(this.snapshot.centers);
    layer.store.scales.set(this.snapshot.scales);
    layer.store.rotations.set(this.snapshot.rotations);
    layer.store.invalidateBounds();
    layer.invalidatePick();
    layer.dirty = true;
    void layer.sync();
    this.document.notifyLayerChanged(layer.id);
  }
}

/** Duplicates a layer `count` times along `step` (layer-parent space): one chair becomes a row. */
export class ArrayLayer extends CompositeCommand {
  constructor(document: Document, source: Layer, count: number, step: Vector3) {
    const copies: DuplicateLayer[] = [];
    for (let n = 1; n <= Math.max(1, Math.round(count)); n += 1) {
      const copy = new DuplicateLayer(document, source);
      copy.duplicate.name = `${source.name} ${n + 1}`;
      copy.duplicate.object.position.add(step.clone().multiplyScalar(n));
      copy.duplicate.object.updateMatrix();
      copies.push(copy);
    }
    super(`Array ×${copies.length + 1}`, copies);
  }
}

/**
 * A transform command that drops the layer until its lowest robust-bounds corner sits on
 * the world plane `floorY` (the grid). Returns undefined when it is already there.
 */
export function snapToFloorCommand(
  document: Document,
  layer: Layer,
  floorY = 0,
): SetLayerTransform | undefined {
  if (layer.locked) throw new LockedLayerError('Unlock the layer before moving it.');
  layer.object.updateMatrixWorld(true);
  const local = layer.store.computeRobustBounds();
  const corner = new Vector3();
  let minY = Infinity;
  for (const x of [local.min[0], local.max[0]])
    for (const y of [local.min[1], local.max[1]])
      for (const z of [local.min[2], local.max[2]])
        minY = Math.min(minY, corner.set(x, y, z).applyMatrix4(layer.object.matrixWorld).y);
  if (!Number.isFinite(minY)) return undefined;
  const lift = floorY - minY;
  if (Math.abs(lift) < 1e-6) return undefined;
  // Express the world-space lift in the parent's frame (the document root carries the up-axis flip).
  const parentRotation = new Quaternion();
  layer.object.parent?.getWorldQuaternion(parentRotation);
  const delta = new Vector3(0, lift, 0).applyQuaternion(parentRotation.invert());
  layer.object.updateMatrix();
  const before = layer.object.matrix.clone();
  const after = before.clone().setPosition(layer.object.position.clone().add(delta));
  return new SetLayerTransform(document, layer.id, before, after);
}
