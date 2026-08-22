import { afterEach, describe, expect, it, vi } from 'vitest';
import { Document } from '../src/model/Document';
import { Layer } from '../src/model/Layer';
import { SplatStore } from '../src/model/SplatStore';
import { Segmentation } from '../src/select/Segmentation';
import { GroupMap } from '../src/splats/groups';
import type { Viewer } from '../src/viewer/Viewer';

vi.mock('../src/viewer/paint', () => ({
  baseColour: vi.fn(),
  paintSplats: vi.fn(),
}));

const documents: Document[] = [];
afterEach(() => documents.splice(0).forEach((document) => document.dispose()));

function fixture(): { document: Document; layer: Layer; segmentation: Segmentation } {
  const document = new Document('selection');
  documents.push(document);
  const count = 6;
  const layer = new Layer({
    name: 'scan',
    kind: 'scan',
    sourceName: 'scan.ply',
    store: new SplatStore({
      count,
      centers: new Float32Array(count * 3),
      scales: new Float32Array(count * 3).fill(0.05),
      rotations: Float32Array.from({ length: count * 4 }, (_, index) => (index % 4 === 3 ? 1 : 0)),
      opacities: new Float32Array(count).fill(1),
      colors: new Float32Array(count * 3),
      shDegree: 0,
    }),
  });
  layer.setGroups(
    GroupMap.fromIds(new Uint32Array([0, 0, 1, 1, 2, 2]), {
      numSplats: count,
      numGroups: 3,
      source: 'test',
    }),
  );
  document.addLayer(layer);
  class FakeViewer extends EventTarget {
    readonly document = document;
  }
  const viewer = new FakeViewer() as unknown as Viewer;
  return { document, layer, segmentation: new Segmentation(viewer) };
}

describe('segmentation group selection', () => {
  it('adds and removes groups with additive selection', () => {
    const { layer, segmentation } = fixture();
    segmentation.select(layer, 0);
    expect(segmentation.selection?.groupIds).toEqual([0]);
    expect([...segmentation.selection!.indices]).toEqual([0, 1]);

    segmentation.select(layer, 2, true);
    expect(segmentation.selection?.groupIds).toEqual([0, 2]);
    expect([...segmentation.selection!.indices]).toEqual([0, 1, 4, 5]);
    expect(segmentation.selection?.info.name).toBe('2 groups');

    segmentation.select(layer, 0, true);
    expect(segmentation.selection?.groupIds).toEqual([2]);
    expect([...segmentation.selection!.indices]).toEqual([4, 5]);
    segmentation.dispose();
  });
});
