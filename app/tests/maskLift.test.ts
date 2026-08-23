import { PerspectiveCamera } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { Document } from '../src/model/Document';
import { Layer } from '../src/model/Layer';
import { SplatStore } from '../src/model/SplatStore';
import { growSelection, liftMask } from '../src/select/maskLift';
import type { MaskImage } from '../src/select/maskLift';
import { DepthGrid } from '../src/sketch/depthGrid';
import { ScreenIndex } from '../src/sketch/screenIndex';
import { VoxelGrid } from '../src/spatial/VoxelGrid';
import type { Viewer } from '../src/viewer/Viewer';

const SIZE = 200;
const SIDE = 40;
const NEAR_COUNT = SIDE * SIDE;

function store(centers: number[]): SplatStore {
  const count = centers.length / 3;
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

/**
 * Two solid 40×40 planes facing the camera, both spanning x,y ∈ [-0.4, 0.4]: a near one at
 * z = 0 and a far one at z = -3. Indices 0…1599 are near, 1600…3199 are far.
 *
 * They are dense on purpose. `DepthGrid` records the front depth per 6 px bin from splat
 * *centres*, so a sparse plane leaves bins the far plane can be seen through — at which
 * point the far splats really are the front surface there and the depth test correctly
 * keeps them. Only a surface dense enough to fill its bins occludes, which is what a real
 * scan looks like.
 */
function twoPlanes(): SplatStore {
  const centers: number[] = [];
  for (const z of [0, -3])
    for (let i = 0; i < SIDE; i += 1)
      for (let j = 0; j < SIDE; j += 1)
        centers.push((i / (SIDE - 1) - 0.5) * 0.8, (j / (SIDE - 1) - 0.5) * 0.8, z);
  return store(centers);
}

/** A sparse 5×5 plane at z = 0, 0.2 apart — for the flood-fill tests. */
function sparsePlane(): SplatStore {
  const centers: number[] = [];
  for (let i = 0; i < 5; i += 1)
    for (let j = 0; j < 5; j += 1) centers.push((i - 2) * 0.2, (j - 2) * 0.2, 0);
  return store(centers);
}

function fixture(splats: SplatStore = twoPlanes()): {
  document: Document;
  layer: Layer;
  viewer: Viewer;
  camera: PerspectiveCamera;
} {
  const document = new Document('test');
  const layer = new Layer({ name: 'p', kind: 'scan', sourceName: 'p.ply', store: splats });
  document.addLayer(layer);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 2);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return { document, layer, viewer: { camera } as unknown as Viewer, camera };
}

/** A mask covering the whole canvas. */
function fullMask(): MaskImage {
  return { data: new Uint8Array(SIZE * SIZE).fill(1), width: SIZE, height: SIZE };
}

/** A mask covering the left half of the canvas only. */
function leftHalfMask(): MaskImage {
  const data = new Uint8Array(SIZE * SIZE);
  for (let row = 0; row < SIZE; row += 1) data.fill(1, row * SIZE, row * SIZE + SIZE / 2);
  return { data, width: SIZE, height: SIZE };
}

const documents: Document[] = [];
afterEach(() => documents.splice(0).forEach((document) => document.dispose()));

describe('liftMask', () => {
  it('frustum projection takes the whole depth column; depth projection takes only the front', () => {
    const { document, layer, viewer, camera } = fixture();
    documents.push(document);
    const index = new ScreenIndex(layer, viewer, SIZE, SIZE);
    const front = DepthGrid.build(document, camera, SIZE, SIZE);
    const mask = fullMask();

    const frustum = liftMask(layer, index, front, mask, SIZE, SIZE, {
      depthTolerance: Infinity,
      minOpacity: 0.2,
    });
    expect(frustum.length).toBe(NEAR_COUNT * 2);

    const depth = liftMask(layer, index, front, mask, SIZE, SIZE, {
      depthTolerance: 0.5,
      minOpacity: 0.2,
    });
    expect([...depth]).toEqual([...Array(NEAR_COUNT).keys()]);
  });

  it('respects the mask outline', () => {
    const { document, layer, viewer, camera } = fixture();
    documents.push(document);
    const index = new ScreenIndex(layer, viewer, SIZE, SIZE);
    const front = DepthGrid.build(document, camera, SIZE, SIZE);

    const selected = liftMask(layer, index, front, leftHalfMask(), SIZE, SIZE, {
      depthTolerance: 0.5,
      minOpacity: 0.2,
    });
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(NEAR_COUNT);
    for (const splat of selected) {
      expect(splat).toBeLessThan(NEAR_COUNT);
      expect(index.px[splat]!).toBeLessThanOrEqual(SIZE / 2);
    }
  });

  it('scales a mask of a different resolution to the view', () => {
    const { document, layer, viewer, camera } = fixture();
    documents.push(document);
    const index = new ScreenIndex(layer, viewer, SIZE, SIZE);
    const front = DepthGrid.build(document, camera, SIZE, SIZE);
    const options = { depthTolerance: 0.5, minOpacity: 0.2 };

    // A fully-set mask selects the same splats at any resolution.
    const coarse = { data: new Uint8Array(50 * 50).fill(1), width: 50, height: 50 };
    expect([...liftMask(layer, index, front, coarse, SIZE, SIZE, options)]).toEqual([
      ...liftMask(layer, index, front, fullMask(), SIZE, SIZE, options),
    ]);

    // A boundary can only be resolved to the mask's own pixel pitch, so a half-resolution
    // mask may disagree within one of its pixels (2 view px) of the seam — but nowhere else.
    const half = { data: new Uint8Array(100 * 100), width: 100, height: 100 };
    for (let row = 0; row < 100; row += 1) half.data.fill(1, row * 100, row * 100 + 50);
    const scaled = new Set(liftMask(layer, index, front, half, SIZE, SIZE, options));
    const native = new Set(liftMask(layer, index, front, leftHalfMask(), SIZE, SIZE, options));
    const disagreements = [...new Set([...scaled, ...native])].filter(
      (splat) => scaled.has(splat) !== native.has(splat),
    );
    for (const splat of disagreements)
      expect(Math.abs(index.px[splat]! - SIZE / 2)).toBeLessThan(2);
    expect(disagreements.length).toBeLessThan(native.size * 0.1);
  });

  it('skips dead and near-transparent splats', () => {
    const { document, layer, viewer, camera } = fixture(sparsePlane());
    documents.push(document);
    layer.store.alive[0] = 0;
    layer.store.opacities[1] = 0.05;
    const index = new ScreenIndex(layer, viewer, SIZE, SIZE);
    const front = DepthGrid.build(document, camera, SIZE, SIZE);

    const selected = liftMask(layer, index, front, fullMask(), SIZE, SIZE, {
      depthTolerance: 0.5,
      minOpacity: 0.2,
    });
    expect(selected).not.toContain(0);
    expect(selected).not.toContain(1);
  });
});

describe('growSelection', () => {
  it('adds neighbours a hop at a time', () => {
    const { document, layer } = fixture(sparsePlane());
    documents.push(document);
    // Splat 12 is the centre of the 5×5 plane; its four neighbours are 0.2 away.
    const seeds = new Uint32Array([12]);

    expect([...growSelection(layer, seeds, 0.25, 1)]).toEqual([7, 11, 12, 13, 17]);
    // A second hop reaches the diagonals and the next ring out: a plus-shape of 13.
    expect(growSelection(layer, seeds, 0.25, 2).length).toBe(13);
  });

  it('returns the seeds unchanged for zero steps and honours the cap', () => {
    const { document, layer } = fixture(sparsePlane());
    documents.push(document);
    const seeds = new Uint32Array([12]);
    expect(growSelection(layer, seeds, 0.25, 0)).toBe(seeds);
    expect(growSelection(layer, seeds, 0.25, 5, 3).length).toBeLessThanOrEqual(5);
  });
});

describe('VoxelGrid.forEachWithin', () => {
  it('visits exactly the points inside the radius', () => {
    const centres = new Float32Array([0, 0, 0, 0.1, 0, 0, 5, 0, 0, 0, 0.3, 0]);
    const grid = new VoxelGrid(centres, 0.2);
    const hits: number[] = [];
    grid.forEachWithin(0, 0, 0, 0.2, (index) => hits.push(index));
    expect(hits.sort()).toEqual([0, 1]);

    const wide: number[] = [];
    grid.forEachWithin(0, 0, 0, 0.35, (index) => wide.push(index));
    expect(wide.sort()).toEqual([0, 1, 3]);
  });
});
