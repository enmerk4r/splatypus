import { PerspectiveCamera, Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { EditSplats } from '../src/model/brushCommands';
import { Document } from '../src/model/Document';
import { Layer } from '../src/model/Layer';
import { SplatStore } from '../src/model/SplatStore';
import { ScreenIndex } from '../src/sketch/screenIndex';
import { falloff } from '../src/sketch/SplatBrush';
import type { Viewer } from '../src/viewer/Viewer';

function grid(): SplatStore {
  // 5×5 splats on the z = 0 plane, 0.2 apart, centred on the origin.
  const centers: number[] = [];
  for (let i = 0; i < 5; i += 1)
    for (let j = 0; j < 5; j += 1) centers.push((i - 2) * 0.2, (j - 2) * 0.2, 0);
  const count = 25;
  return new SplatStore({
    count,
    centers: new Float32Array(centers),
    scales: new Float32Array(count * 3).fill(0.05),
    rotations: Float32Array.from({ length: count * 4 }, (_, i) => (i % 4 === 3 ? 1 : 0)),
    opacities: new Float32Array(count).fill(0.8),
    colors: new Float32Array(count * 3).fill(0.5),
    shDegree: 0,
  });
}

const documents: Document[] = [];
afterEach(() => documents.splice(0).forEach((document) => document.dispose()));

describe('falloff', () => {
  it('is 1 at the centre, 0 at the edge, and flat when hard-edged', () => {
    expect(falloff(0, true)).toBe(1);
    expect(falloff(1, true)).toBe(0);
    expect(falloff(0.5, true)).toBeCloseTo(0.75);
    expect(falloff(0.9, false)).toBe(1);
  });
});

describe('ScreenIndex', () => {
  it('projects centres and sweeps only what the brush covers', () => {
    const document = new Document('test');
    documents.push(document);
    const layer = new Layer({ name: 'g', kind: 'scan', sourceName: 'g.ply', store: grid() });
    document.addLayer(layer);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 2);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const viewer = { camera } as unknown as Viewer;
    const index = new ScreenIndex(layer, viewer, 200, 200, 16);
    // The centre splat (i = j = 2 → index 12) projects to the middle of the canvas.
    expect(index.px[12]).toBeCloseTo(100, 3);
    expect(index.py[12]).toBeCloseTo(100, 3);
    expect(index.depth[12]).toBeCloseTo(2, 5);
    const hits: number[] = [];
    index.within(100, 100, 5, (i) => hits.push(i));
    expect(hits).toEqual([12]);
    // A horizontal sweep across the middle row catches the five splats of that row only.
    const row: number[] = [];
    index.sweep(0, 100, 200, 100, 5, (i) => row.push(i));
    expect(row.sort((a, b) => a - b)).toEqual([2, 7, 12, 17, 22]);
  });
});

describe('EditSplats', () => {
  it('applies colour/opacity/centre/scale edits and undoes them exactly', () => {
    const document = new Document('test');
    documents.push(document);
    const layer = new Layer({ name: 'g', kind: 'scan', sourceName: 'g.ply', store: grid() });
    document.addLayer(layer);
    const indices = new Uint32Array([3, 12]);
    let lastLabel = '';
    document.history.addEventListener('history-changed', (event) => {
      lastLabel = (event as CustomEvent<{ label: string }>).detail.label;
    });
    const before = {
      colors: Array.from(layer.store.colors),
      opacities: Array.from(layer.store.opacities),
      centers: Array.from(layer.store.centers),
      scales: Array.from(layer.store.scales),
    };
    document.history.push(
      new EditSplats(
        document,
        layer.id,
        {
          indices,
          colors: new Float32Array([1, 0, 0, 0, 1, 0]),
          opacities: new Float32Array([0.1, 0.2]),
          centers: new Float32Array([9, 9, 9, 8, 8, 8]),
          scales: new Float32Array([1, 1, 1, 2, 2, 2]),
        },
        'Test',
      ),
    );
    expect([...layer.store.colors.subarray(36, 39)]).toEqual([0, 1, 0]);
    expect(layer.store.opacities[3]).toBeCloseTo(0.1);
    expect([...layer.store.centers.subarray(9, 12)]).toEqual([9, 9, 9]);
    expect(layer.store.scales[36]).toBe(2);
    expect(lastLabel).toBe('Test (2 splats)');
    document.history.undo();
    expect(Array.from(layer.store.colors)).toEqual(before.colors);
    expect(Array.from(layer.store.opacities)).toEqual(before.opacities);
    expect(Array.from(layer.store.centers)).toEqual(before.centers);
    expect(Array.from(layer.store.scales)).toEqual(before.scales);
    document.history.redo();
    expect(layer.store.opacities[12]).toBeCloseTo(0.2);
    const position = new Vector3().fromArray(layer.store.centers, 36);
    expect(position.x).toBe(8);
  });
});
