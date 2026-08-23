import { afterEach, describe, expect, it, vi } from 'vitest';
import { Document } from '../src/model/Document';
import { Layer } from '../src/model/Layer';
import { SplatStore } from '../src/model/SplatStore';
import { Segmentation } from '../src/select/Segmentation';
import { withAddedGroup } from '../src/splats/addGroup';
import { GroupMap, UNASSIGNED } from '../src/splats/groups';
import type { Viewer } from '../src/viewer/Viewer';

// Painting is the one thing here that needs a GPU; everything else is plain data.
vi.mock('../src/viewer/paint', () => ({ baseColour: vi.fn(), paintSplats: vi.fn() }));

/** Ten splats in a row. */
function row(): SplatStore {
  const count = 10;
  return new SplatStore({
    count,
    centers: Float32Array.from({ length: count * 3 }, (_, i) => (i % 3 === 0 ? i / 3 : 0)),
    scales: new Float32Array(count * 3).fill(0.05),
    rotations: Float32Array.from({ length: count * 4 }, (_, i) => (i % 4 === 3 ? 1 : 0)),
    opacities: new Float32Array(count).fill(1),
    colors: new Float32Array(count * 3).fill(0.5),
    shDegree: 0,
  });
}

class FakeViewer extends EventTarget {
  document?: Document;
}

const documents: Document[] = [];
afterEach(() => documents.splice(0).forEach((document) => document.dispose()));

function fixture(): { document: Document; layer: Layer; segmentation: Segmentation } {
  const document = new Document('test');
  documents.push(document);
  const layer = new Layer({ name: 'r', kind: 'scan', sourceName: 'r.ply', store: row() });
  document.addLayer(layer);
  const viewer = new FakeViewer();
  viewer.document = document;
  const segmentation = new Segmentation(viewer as unknown as Viewer);
  return { document, layer, segmentation };
}

describe('withAddedGroup', () => {
  it('creates group 0 on a layer that has no segmentation yet', () => {
    const groups = withAddedGroup(undefined, 10, new Uint32Array([2, 3, 4]), {
      name: 'chair',
      source: 'sam',
    });
    expect(groups.numGroups).toBe(1);
    expect([...groups.indicesOf(0)]).toEqual([2, 3, 4]);
    expect(groups.groupOf(0)).toBe(UNASSIGNED);
    expect(groups.info(0)).toMatchObject({ name: 'chair', count: 3 });
    expect(groups.meta.source).toBe('sam');
  });

  it('appends a new id, leaves the other groups addressable, and recounts what it took', () => {
    const existing = GroupMap.fromIds(
      Uint32Array.from([0, 0, 0, 1, 1, 1, UNASSIGNED, UNASSIGNED, UNASSIGNED, UNASSIGNED]),
      {
        numSplats: 10,
        numGroups: 2,
        source: 'colour + position',
        groups: [
          { id: 0, name: 'floor', count: 3, colour: '#ff0000' },
          { id: 1, name: 'wall', count: 3 },
        ],
      },
    );
    // Splat 5 is stolen from group 1; 8 and 9 were unassigned.
    const next = withAddedGroup(existing, 10, new Uint32Array([5, 8, 9]), {
      name: 'lamp',
      source: 'sam',
    });

    expect(next.numGroups).toBe(3);
    expect([...next.indicesOf(2)]).toEqual([5, 8, 9]);
    expect([...next.indicesOf(0)]).toEqual([0, 1, 2]);
    // Group 1 lost a member and its count reflects that.
    expect([...next.indicesOf(1)]).toEqual([3, 4]);
    expect(next.info(1).count).toBe(2);
    // Existing names and swatches survive.
    expect(next.info(0)).toMatchObject({ name: 'floor', colour: '#ff0000' });
    expect(next.info(2).name).toBe('lamp');
    // The original map is untouched.
    expect([...existing.indicesOf(1)]).toEqual([3, 4, 5]);
  });

  it('keeps an emptied group in the list so ids never shift', () => {
    const existing = withAddedGroup(undefined, 10, new Uint32Array([0, 1]), {
      name: 'a',
      source: 'test',
    });
    const next = withAddedGroup(existing, 10, new Uint32Array([0, 1]), {
      name: 'b',
      source: 'test',
    });
    expect(next.numGroups).toBe(2);
    expect(next.info(0).count).toBe(0);
    expect([...next.indicesOf(1)]).toEqual([0, 1]);
  });

  it('rejects a segmentation that does not cover the layer', () => {
    const existing = withAddedGroup(undefined, 10, new Uint32Array([0]), {
      name: 'a',
      source: 'test',
    });
    expect(() =>
      withAddedGroup(existing, 9, new Uint32Array([0]), { name: 'b', source: 't' }),
    ).toThrow(/covers 10 splats but the layer has 9/);
  });
});

describe('Segmentation.selectIndices', () => {
  it('commits a raw index set as a selected group', () => {
    const { layer, segmentation } = fixture();
    let selectionChanges = 0;
    segmentation.addEventListener('selection-changed', () => (selectionChanges += 1));

    const id = segmentation.selectIndices(layer, new Uint32Array([1, 2, 3]), { name: 'chair' });

    expect(id).toBe(0);
    expect(layer.groups?.numGroups).toBe(1);
    expect(segmentation.selection?.groupIds).toEqual([0]);
    expect([...segmentation.selection!.indices]).toEqual([1, 2, 3]);
    expect(segmentation.selection?.info.name).toBe('chair');
    expect(selectionChanges).toBeGreaterThan(0);
  });

  it('is undoable and restores the previous segmentation exactly', () => {
    const { document, layer, segmentation } = fixture();
    segmentation.selectIndices(layer, new Uint32Array([1, 2]), { name: 'first' });
    segmentation.selectIndices(layer, new Uint32Array([5, 6]), { name: 'second' });
    expect(layer.groups?.numGroups).toBe(2);

    document.history.undo();
    expect(layer.groups?.numGroups).toBe(1);
    expect([...layer.groups!.indicesOf(0)]).toEqual([1, 2]);

    document.history.undo();
    expect(layer.groups).toBeUndefined();

    document.history.redo();
    expect(layer.groups?.numGroups).toBe(1);
    expect(layer.groups?.info(0).name).toBe('first');
  });

  it('does nothing for an empty selection', () => {
    const { layer, segmentation } = fixture();
    expect(segmentation.selectIndices(layer, new Uint32Array(0), { name: 'nothing' })).toBe(-1);
    expect(layer.groups).toBeUndefined();
  });

  it('adds to the current selection when additive', () => {
    const { layer, segmentation } = fixture();
    segmentation.selectIndices(layer, new Uint32Array([1, 2]), { name: 'a' });
    segmentation.selectIndices(layer, new Uint32Array([5, 6]), { name: 'b', additive: true });
    expect(segmentation.selection?.groupIds).toEqual([0, 1]);
    expect([...segmentation.selection!.indices].sort((x, y) => x - y)).toEqual([1, 2, 5, 6]);
  });
});
