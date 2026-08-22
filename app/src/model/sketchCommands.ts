import type { Document } from './Document';
import { Layer } from './Layer';
import { AddLayers } from './commands';
import { LockedLayerError } from './history';
import type { Command } from './history';
import { CompositeCommand } from './segmentCommands';
import { SplatStore } from './SplatStore';
import type { SplatArrays } from './SplatStore';
import type { Stroke } from '../sketch/stroke';

function emptyStore(): SplatStore {
  return new SplatStore({
    count: 0,
    centers: new Float32Array(),
    scales: new Float32Array(),
    rotations: new Float32Array(),
    opacities: new Float32Array(),
    colors: new Float32Array(),
    shDegree: 0,
  });
}

function changed(document: Document, layer: Layer): void {
  layer.store.invalidateBounds();
  layer.invalidatePick();
  layer.dirty = true;
  void layer.sync();
  document.notifyLayerChanged(layer.id);
}

export function targetSketchLayer(document: Document): Layer | undefined {
  const active = document.active();
  if (active?.kind === 'sketch' && !active.locked) return active;
  return [...document.layers].reverse().find((layer) => layer.kind === 'sketch' && !layer.locked);
}

export function newSketchLayer(): Layer {
  return new Layer({ name: 'Sketch', kind: 'sketch', store: emptyStore(), sourceName: 'Sketch' });
}

export interface SketchTarget {
  layer: Layer;
  isNew: boolean;
}

export function resolveSketchTarget(document: Document): SketchTarget {
  const existing = targetSketchLayer(document);
  return existing ? { layer: existing, isNew: false } : { layer: newSketchLayer(), isNew: true };
}

export class AddStroke implements Command {
  readonly label: string;
  private previousStore?: SplatStore;
  private previousRanges?: [number, number][];

  constructor(
    private readonly document: Document,
    private readonly layerId: string,
    readonly stroke: Stroke,
    private readonly splats: SplatArrays,
  ) {
    this.label = `Stroke (${stroke.settings.preset}, ${splats.count.toLocaleString()} splats)`;
  }

  private layer(): Layer {
    const layer = this.document.getLayer(this.layerId);
    if (!layer) throw new Error('Sketch layer no longer exists.');
    if (layer.kind !== 'sketch') throw new Error('Strokes can only be added to sketch layers.');
    if (layer.locked) throw new LockedLayerError('Unlock the sketch layer before drawing.');
    return layer;
  }

  do(): void {
    const layer = this.layer();
    this.previousStore ??= layer.store;
    this.previousRanges ??= layer.strokes.map((item) => [...item.range]);
    const extra = new SplatStore(this.splats);
    const next = SplatStore.concat([layer.store, extra], 0);
    // concat compacts dead splats. Rebase surviving stroke ranges so an erase followed by a
    // new stroke cannot leave later strokes pointing at the old store indices.
    let first = 0;
    for (const existing of layer.strokes) {
      if (existing.erased) {
        existing.range = [first, 0];
      } else {
        let live = 0;
        const end = existing.range[0] + existing.range[1];
        for (let index = existing.range[0]; index < end; index += 1)
          live += layer.store.alive[index] ?? 0;
        existing.range = [first, live];
        first += live;
      }
    }
    this.stroke.range = [first, this.splats.count];
    layer.replaceStore(next);
    layer.strokes.push(this.stroke);
    this.document.notifyLayerChanged(layer.id);
  }

  undo(): void {
    const layer = this.layer();
    if (!this.previousStore || !this.previousRanges) return;
    const index = layer.strokes.findIndex((item) => item.id === this.stroke.id);
    if (index >= 0) layer.strokes.splice(index, 1);
    layer.strokes.forEach((item, at) => {
      item.range = [...(this.previousRanges?.[at] ?? item.range)];
    });
    layer.replaceStore(this.previousStore);
    this.document.notifyLayerChanged(layer.id);
  }
}

interface EraseRecord {
  stroke: Stroke;
  erased: boolean;
  alive: Uint8Array;
}

export class EraseStrokes implements Command {
  readonly label: string;
  private records?: EraseRecord[];

  constructor(
    private readonly document: Document,
    private readonly layerId: string,
    private readonly strokeIds: string[],
  ) {
    const count = new Set(strokeIds).size;
    this.label = `Erase ${count} stroke${count === 1 ? '' : 's'}`;
  }

  private layer(): Layer {
    const layer = this.document.getLayer(this.layerId);
    if (!layer) throw new Error('Sketch layer no longer exists.');
    if (layer.kind !== 'sketch') throw new Error('Only sketch strokes can be erased.');
    if (layer.locked) throw new LockedLayerError('Unlock the sketch layer before erasing.');
    return layer;
  }

  do(): void {
    const layer = this.layer();
    const ids = new Set(this.strokeIds);
    const selected = layer.strokes.filter((stroke) => ids.has(stroke.id));
    this.records ??= selected.map((stroke) => ({
      stroke,
      erased: Boolean(stroke.erased),
      alive: layer.store.alive.slice(stroke.range[0], stroke.range[0] + stroke.range[1]),
    }));
    for (const { stroke } of this.records) {
      layer.store.alive.fill(0, stroke.range[0], stroke.range[0] + stroke.range[1]);
      stroke.erased = true;
    }
    changed(this.document, layer);
  }

  undo(): void {
    const layer = this.layer();
    for (const record of this.records ?? []) {
      layer.store.alive.set(record.alive, record.stroke.range[0]);
      record.stroke.erased = record.erased;
    }
    changed(this.document, layer);
  }
}

export function firstStrokeCommand(
  document: Document,
  target: SketchTarget,
  stroke: Stroke,
  splats: SplatArrays,
): Command {
  const addStroke = new AddStroke(document, target.layer.id, stroke, splats);
  return target.isNew
    ? new CompositeCommand('Sketch', [new AddLayers(document, [target.layer]), addStroke])
    : addStroke;
}
