import { afterEach, describe, expect, it } from 'vitest';
import { Document } from '../src/model/Document';
import { Layer } from '../src/model/Layer';
import { DuplicateLayer } from '../src/model/commands';
import { LockedLayerError } from '../src/model/history';
import { ScaleSplats } from '../src/model/segmentCommands';
import {
  AddStroke,
  EraseStrokes,
  firstStrokeCommand,
  resolveSketchTarget,
  targetSketchLayer,
} from '../src/model/sketchCommands';
import { SplatStore } from '../src/model/SplatStore';
import type { SplatArrays } from '../src/model/SplatStore';
import type { Stroke } from '../src/sketch/stroke';

function arrays(count: number, offset = 0): SplatArrays {
  const centers = new Float32Array(count * 3);
  const scales = new Float32Array(count * 3).fill(0.02);
  const rotations = new Float32Array(count * 4);
  const opacities = new Float32Array(count).fill(0.9);
  const colors = new Float32Array(count * 3).fill(0.5);
  for (let index = 0; index < count; index += 1) {
    centers[index * 3] = offset + index;
    rotations[index * 4 + 3] = 1;
  }
  return { count, centers, scales, rotations, opacities, colors, shDegree: 0 };
}

function stroke(id: string, count: number): Stroke {
  return {
    id,
    settings: {
      preset: 'ink',
      colour: [1, 0, 0],
      radiusPx: 10,
      radius: 0.02,
      opacity: 1,
      pressure: true,
      placement: 'surface',
    },
    points: new Float32Array([0, 0, 0]),
    pressures: new Float32Array([1]),
    range: [0, count],
  };
}

function layer(name: string, kind: 'scan' | 'sketch' = 'sketch'): Layer {
  return new Layer({
    name,
    kind,
    sourceName: name,
    store: new SplatStore(arrays(0)),
  });
}

const documents: Document[] = [];
afterEach(() => documents.splice(0).forEach((document) => document.dispose()));

describe('sketch commands', () => {
  it('appends a stroke and restores the exact previous store on undo/redo', () => {
    const document = new Document('test');
    documents.push(document);
    const sketch = layer('Sketch');
    document.addLayer(sketch);
    const added = stroke('one', 3);
    document.history.push(new AddStroke(document, sketch.id, added, arrays(3, 10)));
    expect(sketch.store.count).toBe(3);
    expect(sketch.strokes).toEqual([added]);
    expect(added.range).toEqual([0, 3]);
    document.history.undo();
    expect(sketch.store.count).toBe(0);
    expect(sketch.strokes).toEqual([]);
    document.history.redo();
    expect([...sketch.store.centers]).toEqual([...arrays(3, 10).centers]);
  });

  it('erases whole ranges and restores their exact alive mask', () => {
    const document = new Document('test');
    documents.push(document);
    const sketch = layer('Sketch');
    document.addLayer(sketch);
    const a = stroke('a', 2);
    const b = stroke('b', 2);
    document.history.push(new AddStroke(document, sketch.id, a, arrays(2)));
    document.history.push(new AddStroke(document, sketch.id, b, arrays(2, 2)));
    document.history.push(new EraseStrokes(document, sketch.id, ['a']));
    expect([...sketch.store.alive]).toEqual([0, 0, 1, 1]);
    expect(a.erased).toBe(true);
    document.history.undo();
    expect([...sketch.store.alive]).toEqual([1, 1, 1, 1]);
    expect(a.erased).toBe(false);
  });

  it('rebases live ranges when appending after an erase', () => {
    const document = new Document('test');
    documents.push(document);
    const sketch = layer('Sketch');
    document.addLayer(sketch);
    const a = stroke('a', 2),
      b = stroke('b', 2),
      c = stroke('c', 1);
    document.history.push(new AddStroke(document, sketch.id, a, arrays(2)));
    document.history.push(new AddStroke(document, sketch.id, b, arrays(2, 2)));
    document.history.push(new EraseStrokes(document, sketch.id, ['a']));
    document.history.push(new AddStroke(document, sketch.id, c, arrays(1, 4)));
    expect(sketch.store.count).toBe(3);
    expect(a.range).toEqual([0, 0]);
    expect(b.range).toEqual([0, 2]);
    expect(c.range).toEqual([2, 1]);
    document.history.push(new EraseStrokes(document, sketch.id, ['b']));
    expect([...sketch.store.alive]).toEqual([0, 0, 1]);
  });

  it('chooses the active sketch, then topmost unlocked sketch, then creates one', async () => {
    const document = new Document('test');
    documents.push(document);
    const scan = layer('Scan', 'scan');
    const lower = layer('Lower');
    const upper = layer('Upper');
    document.addLayer(scan);
    document.addLayer(lower);
    document.addLayer(upper);
    document.setSelection([lower.id]);
    expect(targetSketchLayer(document)).toBe(lower);
    lower.locked = true;
    expect(targetSketchLayer(document)).toBe(upper);
    upper.locked = true;
    const target = resolveSketchTarget(document);
    expect(target.isNew).toBe(true);
    expect(target.layer.kind).toBe('sketch');
    await target.layer.sync();
    expect(target.layer.mesh.packedSplats?.numSplats).toBe(0);
    target.layer.dispose();
  });

  it('creates the first sketch layer inside the stroke undo step', () => {
    const document = new Document('test');
    documents.push(document);
    document.addLayer(layer('Scan', 'scan'));
    const target = resolveSketchTarget(document);
    document.history.push(firstStrokeCommand(document, target, stroke('first', 1), arrays(1)));
    expect(document.layers.map((item) => item.kind)).toEqual(['scan', 'sketch']);
    document.history.undo();
    expect(document.layers.map((item) => item.kind)).toEqual(['scan']);
    document.history.redo();
    expect(document.layers[1]?.strokes).toHaveLength(1);
  });

  it('duplicates sketch vector metadata independently', () => {
    const document = new Document('test');
    documents.push(document);
    const sketch = layer('Sketch');
    document.addLayer(sketch);
    document.history.push(new AddStroke(document, sketch.id, stroke('source', 2), arrays(2)));
    sketch.store.alive[0] = 0; // A crop/edit can hide part of a stroke before duplication.
    const command = new DuplicateLayer(document, sketch);
    document.history.push(command);
    expect(command.duplicate.kind).toBe('sketch');
    expect(command.duplicate.strokes).toHaveLength(1);
    expect(command.duplicate.strokes[0]?.range).toEqual([0, 1]);
    expect(command.duplicate.strokes[0]?.id).not.toBe(sketch.strokes[0]?.id);
    document.history.push(
      new EraseStrokes(document, command.duplicate.id, [command.duplicate.strokes[0]!.id]),
    );
    expect([...command.duplicate.store.alive]).toEqual([0]);
    expect([...sketch.store.alive]).toEqual([0, 1]);
  });

  it('refuses stroke edits on locked layers', () => {
    const document = new Document('test');
    documents.push(document);
    const sketch = layer('Sketch');
    document.addLayer(sketch);
    sketch.locked = true;
    expect(() =>
      document.history.push(new AddStroke(document, sketch.id, stroke('a', 1), arrays(1))),
    ).toThrow(LockedLayerError);
    expect(() => document.history.push(new EraseStrokes(document, sketch.id, ['a']))).toThrow(
      LockedLayerError,
    );
  });

  it('keeps vector points aligned when anisotropic gizmo scale is baked', () => {
    const document = new Document('test');
    documents.push(document);
    const sketch = layer('Sketch');
    document.addLayer(sketch);
    const vector = stroke('vector', 1);
    vector.points = new Float32Array([1, 2, 3]);
    document.history.push(new AddStroke(document, sketch.id, vector, arrays(1)));
    document.history.push(new ScaleSplats(document, sketch.id, [2, 3, 4]));
    expect([...vector.points]).toEqual([2, 6, 12]);
    document.history.undo();
    expect([...vector.points]).toEqual([1, 2, 3]);
  });
});
