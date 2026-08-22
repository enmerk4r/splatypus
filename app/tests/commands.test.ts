import { Matrix4 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { Document } from '../src/model/Document';
import { Layer } from '../src/model/Layer';
import {
  AddLayers,
  DuplicateLayer,
  LockedLayerError,
  MergeLayers,
  MoveLayer,
  RemoveLayers,
  RenameLayer,
  SetLayerTransform,
  SetLayerVisible,
} from '../src/model/commands';
import { SplatStore } from '../src/model/SplatStore';

function layer(name: string): Layer {
  return new Layer({
    name,
    kind: 'scan',
    sourceName: `${name}.ply`,
    store: new SplatStore({
      count: 1,
      centers: new Float32Array([1, 2, 3]),
      scales: new Float32Array([0.1, 0.2, 0.3]),
      rotations: new Float32Array([0, 0, 0, 1]),
      opacities: new Float32Array([0.8]),
      colors: new Float32Array([0.2, 0.4, 0.6]),
      shDegree: 0,
    }),
  });
}

const documents: Document[] = [];
afterEach(() => documents.splice(0).forEach((document) => document.dispose()));

describe('layer commands', () => {
  it('undoes and redoes add, transform, visibility, and rename in order', async () => {
    const document = new Document('test');
    documents.push(document);
    const a = layer('A');
    const b = layer('B');
    await Promise.all([a.sync(), b.sync()]);
    document.addLayer(a);
    document.history.push(new AddLayers(document, [b]));
    const moved = new Matrix4().makeTranslation(4, 5, 6);
    document.history.push(new SetLayerTransform(document, b.id, new Matrix4(), moved));
    document.history.push(new SetLayerVisible(document, a.id, true, false));
    document.history.push(new RenameLayer(document, b.id, 'B', 'Renamed'));

    for (let index = 0; index < 4; index += 1) document.history.undo();
    expect(document.layers.map((item) => item.name)).toEqual(['A']);
    expect(a.visible).toBe(true);
    expect(b.object.matrix.equals(new Matrix4())).toBe(true);
    expect(b.name).toBe('B');

    for (let index = 0; index < 4; index += 1) document.history.redo();
    expect(document.layers.map((item) => item.name)).toEqual(['A', 'Renamed']);
    expect(a.visible).toBe(false);
    expect(b.object.position.toArray()).toEqual([4, 5, 6]);
  });

  it('restores duplicate/merge/delete state and original order', async () => {
    const document = new Document('test');
    documents.push(document);
    const original = layer('Original');
    await original.sync();
    document.addLayer(original);
    const duplicate = new DuplicateLayer(document, original);
    document.history.push(duplicate);
    const merge = new MergeLayers(document, [original.id, duplicate.duplicate.id], 'Merged');
    document.history.push(merge);
    document.history.push(new RemoveLayers(document, [merge.merged.id]));
    expect(document.layers).toHaveLength(0);
    document.history.undo();
    expect(document.layers.map((item) => item.name)).toEqual(['Merged']);
    document.history.undo();
    expect(document.layers.map((item) => item.name)).toEqual(['Original', 'Original copy']);
  });

  it('refuses destructive and ordering commands for locked layers', async () => {
    const document = new Document('test');
    documents.push(document);
    const a = layer('A');
    const b = layer('B');
    await Promise.all([a.sync(), b.sync()]);
    document.addLayer(a);
    document.addLayer(b);
    a.locked = true;
    expect(() => document.history.push(new RemoveLayers(document, [a.id]))).toThrow(
      LockedLayerError,
    );
    expect(() => document.history.push(new MoveLayer(document, a.id, 0, 1))).toThrow(
      LockedLayerError,
    );
    expect(() => new MergeLayers(document, [a.id, b.id], 'Nope')).toThrow(LockedLayerError);
    expect(document.layers.map((item) => item.name)).toEqual(['A', 'B']);
  });
});
