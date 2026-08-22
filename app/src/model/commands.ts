import type { Document } from './Document';
import type { Layer } from './Layer';
import { LayerValueCommand, LockedLayerError } from './history';
import type { Command } from './history';

export type { Command } from './history';
export { History, LockedLayerError } from './history';
export {
  DuplicateLayer,
  MergeLayers,
  SetLayerTransform,
  SetPointBudget,
  SetPointScale,
} from './compoundCommands';

export class AddLayers implements Command {
  readonly label: string;
  private attached = false;
  constructor(
    private readonly document: Document,
    readonly layers: Layer[],
    private readonly index?: number,
  ) {
    this.label = `Add ${layers.length === 1 ? (layers[0]?.name ?? 'layer') : `${layers.length} layers`}`;
  }
  do(): void {
    let index = this.index ?? this.document.layers.length;
    this.layers.forEach((layer) => this.document.addLayer(layer, index++));
    this.attached = true;
  }
  undo(): void {
    this.layers.forEach((layer) => this.document.removeLayer(layer.id));
    this.attached = false;
  }
  dispose(): void {
    if (!this.attached) this.layers.forEach((layer) => layer.dispose());
  }
}

export class RemoveLayers implements Command {
  readonly label: string;
  private records: { layer: Layer; index: number }[] = [];
  private attached = true;
  constructor(
    private readonly document: Document,
    private readonly ids: string[],
  ) {
    this.label = `Delete ${ids.length === 1 ? 'layer' : `${ids.length} layers`}`;
  }
  do(): void {
    this.records = this.ids
      .map((id) => ({
        layer: this.document.getLayer(id),
        index: this.document.layers.findIndex((layer) => layer.id === id),
      }))
      .filter((record): record is { layer: Layer; index: number } => Boolean(record.layer));
    if (this.records.some(({ layer }) => layer.locked))
      throw new LockedLayerError('Unlock layers before deleting them.');
    [...this.records]
      .sort((a, b) => b.index - a.index)
      .forEach(({ layer }) => this.document.removeLayer(layer.id));
    this.attached = false;
  }
  undo(): void {
    [...this.records]
      .sort((a, b) => a.index - b.index)
      .forEach(({ layer, index }) => this.document.addLayer(layer, index));
    this.attached = true;
  }
  dispose(): void {
    if (!this.attached) this.records.forEach(({ layer }) => layer.dispose());
  }
}

export class RenameLayer extends LayerValueCommand<string> {
  readonly label = 'Rename layer';
  apply(value: string): void {
    const layer = this.layer();
    if (layer.locked) throw new LockedLayerError('Unlock the layer before renaming it.');
    layer.name = value;
    layer.object.name = `Layer: ${value}`;
    this.document.notifyLayerChanged(layer.id);
  }
}

export class SetLayerVisible extends LayerValueCommand<boolean> {
  readonly label = 'Toggle layer visibility';
  apply(value: boolean): void {
    const layer = this.layer();
    layer.visible = value;
    layer.setShown(value);
    this.document.applySolo();
    this.document.notifyLayerChanged(layer.id);
  }
}

export class SetLayerLocked extends LayerValueCommand<boolean> {
  readonly label = 'Toggle layer lock';
  apply(value: boolean): void {
    const layer = this.layer();
    layer.locked = value;
    this.document.notifyLayerChanged(layer.id);
  }
}

export class MoveLayer implements Command {
  readonly label = 'Move layer';
  constructor(
    private readonly document: Document,
    private readonly id: string,
    private readonly from: number,
    private readonly to: number,
  ) {}
  do(): void {
    if (this.document.getLayer(this.id)?.locked)
      throw new LockedLayerError('Unlock the layer before moving it.');
    this.document.moveLayer(this.id, this.to);
  }
  undo(): void {
    this.document.moveLayer(this.id, this.from);
  }
}
