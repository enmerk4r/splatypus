import type { SolidData } from '../mesh/solid';
import type { Document } from './Document';
import type { Layer } from './Layer';
import { LockedLayerError } from './history';
import type { Command } from './history';

/** Replaces a mesh layer's triangle mesh (extrude a face, re-edit, recolour) as one undo step. */
export class SetSolid implements Command {
  readonly label: string;
  private before?: SolidData;

  constructor(
    private readonly document: Document,
    private readonly layerId: string,
    private readonly after: SolidData,
    label: string,
  ) {
    this.label = label;
  }

  private layer(): Layer {
    const layer = this.document.getLayer(this.layerId);
    if (!layer) throw new Error('Layer no longer exists');
    if (layer.kind !== 'mesh') throw new Error('Only mesh layers have a solid.');
    if (layer.locked) throw new LockedLayerError('Unlock the layer before editing it.');
    return layer;
  }

  do(): void {
    const layer = this.layer();
    this.before ??= layer.solid;
    layer.setSolid(this.after);
    this.document.notifyLayerChanged(layer.id);
  }

  undo(): void {
    const layer = this.layer();
    layer.setSolid(this.before);
    this.document.notifyLayerChanged(layer.id);
  }
}
