import { Matrix4 } from 'three';
import type { PointCloudInfo } from '../io/pointCloud';
import type { Document } from './Document';
import { Layer } from './Layer';
import { LayerValueCommand, LockedLayerError } from './history';
import type { Command } from './history';
import { SplatStore } from './SplatStore';
import type { ShDegree } from './SplatStore';
import { transformStore } from './storeTransforms';
import { rescaleLayerInPlace } from '../viewer/sync';

export class DuplicateLayer implements Command {
  readonly label: string;
  readonly duplicate: Layer;
  private attached = false;
  private readonly index: number;
  constructor(
    private readonly document: Document,
    source: Layer,
  ) {
    if (source.locked) throw new LockedLayerError('Unlock the layer before duplicating it.');
    this.duplicate = new Layer({
      name: `${source.name} copy`,
      kind: source.kind,
      store: source.store.compacted(),
      sourceName: source.sourceName,
      ...(source.pointCloud ? { pointCloud: source.pointCloud } : {}),
      // Source bytes are never mutated, so duplicates can share them instead of copying 100+ MB.
      ...(source.sourceBytes ? { sourceBytes: source.sourceBytes } : {}),
    });
    this.duplicate.object.matrix.copy(source.object.matrix);
    this.duplicate.object.matrix.decompose(
      this.duplicate.object.position,
      this.duplicate.object.quaternion,
      this.duplicate.object.scale,
    );
    this.index = document.layers.findIndex((layer) => layer.id === source.id) + 1;
    this.label = `Duplicate ${source.name}`;
  }
  do(): void {
    this.document.addLayer(this.duplicate, this.index);
    this.attached = true;
  }
  undo(): void {
    this.document.removeLayer(this.duplicate.id);
    this.attached = false;
  }
  dispose(): void {
    if (!this.attached) this.duplicate.dispose();
  }
}

export class MergeLayers implements Command {
  readonly label: string;
  readonly merged: Layer;
  private readonly originals: { layer: Layer; index: number }[];
  private attachedMerged = false;
  constructor(
    private readonly document: Document,
    ids: string[],
    targetName: string,
  ) {
    const layers = ids.map((id) => document.getLayer(id));
    if (!layers.every((layer): layer is Layer => Boolean(layer)))
      throw new Error('A selected layer no longer exists.');
    this.originals = layers.map((layer) => ({
      layer,
      index: document.layers.findIndex((candidate) => candidate.id === layer.id),
    }));
    if (this.originals.some(({ layer }) => layer.locked))
      throw new LockedLayerError('Unlock all selected layers before merging them.');
    const degree = Math.max(...this.originals.map(({ layer }) => layer.store.shDegree)) as ShDegree;
    const store = SplatStore.concat(
      this.originals.map(({ layer }) => transformStore(layer.store, layer.object.matrix)),
      degree,
    );
    this.merged = new Layer({
      name: targetName,
      kind: 'scan',
      store,
      sourceName: `${targetName}.ply`,
    });
    this.label = `Merge ${ids.length} layers`;
  }
  do(): void {
    [...this.originals]
      .sort((a, b) => b.index - a.index)
      .forEach(({ layer }) => this.document.removeLayer(layer.id));
    this.document.addLayer(this.merged, Math.min(...this.originals.map(({ index }) => index)));
    this.attachedMerged = true;
  }
  undo(): void {
    this.document.removeLayer(this.merged.id);
    [...this.originals]
      .sort((a, b) => a.index - b.index)
      .forEach(({ layer, index }) => this.document.addLayer(layer, index));
    this.attachedMerged = false;
  }
  dispose(): void {
    if (this.attachedMerged) this.originals.forEach(({ layer }) => layer.dispose());
    else this.merged.dispose();
  }
}

export class SetLayerTransform extends LayerValueCommand<Matrix4> {
  readonly label = 'Transform layer';
  apply(value: Matrix4): void {
    const layer = this.layer();
    if (layer.locked) throw new LockedLayerError('Unlock the layer before transforming it.');
    layer.object.matrix.copy(value);
    layer.object.matrix.decompose(
      layer.object.position,
      layer.object.quaternion,
      layer.object.scale,
    );
    layer.object.updateMatrixWorld(true);
    this.document.notifyLayerChanged(layer.id);
  }
}

export class SetPointScale extends LayerValueCommand<number> {
  readonly label = 'Resize point cloud';
  apply(value: number): void {
    const layer = this.layer();
    if (layer.locked) throw new LockedLayerError('Unlock the layer before editing it.');
    layer.store.scales.fill(value);
    if (layer.pointCloud) layer.pointCloud.pointScale = value;
    // Patch the packed scales in place when possible; fall back to a full rebuild (e.g. LoD meshes).
    if (!rescaleLayerInPlace(layer, value)) {
      layer.dirty = true;
      void layer.sync();
    }
    this.document.notifyLayerChanged(layer.id);
  }
}

export class SetPointBudget implements Command {
  readonly label = 'Change point budget';
  constructor(
    private readonly document: Document,
    private readonly id: string,
    private readonly before: { store: SplatStore; info: PointCloudInfo },
    private readonly after: { store: SplatStore; info: PointCloudInfo },
  ) {}
  do(): void {
    this.apply(this.after);
  }
  undo(): void {
    this.apply(this.before);
  }
  private apply(value: { store: SplatStore; info: PointCloudInfo }): void {
    const layer = this.document.getLayer(this.id);
    if (!layer) throw new Error('Layer no longer exists');
    if (layer.locked) throw new LockedLayerError('Unlock the layer before editing it.');
    layer.replaceStore(value.store, value.info);
    this.document.notifyLayerChanged(layer.id);
  }
}
