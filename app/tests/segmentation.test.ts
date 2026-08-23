import { Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { Document } from '../src/model/Document';
import { Layer } from '../src/model/Layer';
import { SplatStore } from '../src/model/SplatStore';
import {
  ArrayLayer,
  GridArrayLayer,
  SetSplatsAlive,
  SplitSplats,
  snapToFloorCommand,
} from '../src/model/segmentCommands';
import { VoxelGrid } from '../src/spatial/VoxelGrid';
import { bakeConnectivity, encodeGroups, suggestOptions } from '../src/splats/bakeConnectivity';
import { GroupMap, UNASSIGNED } from '../src/splats/groups';

/** Two tight clusters 10 units apart, 8 splats each, plus one faint floater. */
function clusters(): SplatStore {
  const centers: number[] = [];
  const colors: number[] = [];
  for (const cluster of [0, 10]) {
    for (let i = 0; i < 8; i += 1) {
      centers.push(cluster + (i % 2) * 0.1, Math.floor(i / 2) * 0.1, 0);
      colors.push(cluster ? 0.9 : 0.1, 0.5, 0.5);
    }
  }
  centers.push(5, 5, 5);
  colors.push(0.5, 0.5, 0.5);
  const count = centers.length / 3;
  const opacities = new Float32Array(count).fill(1);
  opacities[count - 1] = 0.01;
  return new SplatStore({
    count,
    centers: new Float32Array(centers),
    scales: new Float32Array(count * 3).fill(0.05),
    rotations: Float32Array.from({ length: count * 4 }, (_, i) => (i % 4 === 3 ? 1 : 0)),
    opacities,
    colors: new Float32Array(colors),
    shDegree: 0,
  });
}

const documents: Document[] = [];
afterEach(() => documents.splice(0).forEach((document) => document.dispose()));

describe('.groups sidecar', () => {
  it('round-trips through encodeGroups/parse and rejects a count mismatch', () => {
    const ids = new Uint32Array([0, 0, 1, UNASSIGNED, 1]);
    const meta = { numSplats: 5, numGroups: 2, source: 'test' };
    // `.slice()` yields a fresh, exactly-sized ArrayBuffer.
    const bytes = encodeGroups(ids, meta).slice();
    const map = GroupMap.parse(bytes.buffer, 5);
    expect([...map.ids]).toEqual([...ids]);
    expect([...map.indicesOf(1)]).toEqual([2, 4]);
    expect(map.coverage).toBeCloseTo(4 / 5);
    expect(() => GroupMap.parse(bytes.buffer, 6)).toThrow(/covers 5/);
  });
});

describe('connectivity bake', () => {
  it('separates two clusters and leaves the faint floater unassigned', () => {
    const store = clusters();
    // The fixture is coarse (0.1 spacing), so use a voxel that makes neighbours adjacent.
    const options = {
      ...suggestOptions(store.centers, store.count),
      voxelSize: 0.15,
      minSplats: 2,
    };
    const { ids, groups } = bakeConnectivity(
      {
        count: store.count,
        centres: store.centers,
        colours: store.colors,
        opacities: store.opacities,
      },
      options,
    );
    expect(groups).toHaveLength(2);
    expect(new Set([...ids.subarray(0, 8)]).size).toBe(1);
    expect(new Set([...ids.subarray(8, 16)]).size).toBe(1);
    expect(ids[0]).not.toBe(ids[8]);
    expect(ids[16]).toBe(UNASSIGNED);
  });

  it('groups matching colours across disconnected positions when spatial connectivity is off', () => {
    const store = clusters();
    const colours = store.colors.slice();
    for (let index = 0; index < 16; index += 1) colours.set([0.2, 0.4, 0.6], index * 3);
    const { ids, groups } = bakeConnectivity(
      {
        count: store.count,
        centres: store.centers,
        colours,
        opacities: store.opacities,
      },
      {
        ...suggestOptions(store.centers, store.count),
        spatialConnectivity: false,
        minSplats: 2,
      },
    );
    expect(groups).toHaveLength(1);
    expect(new Set([...ids.subarray(0, 16)]).size).toBe(1);
    expect(ids[16]).toBe(UNASSIGNED);
  });
});

describe('VoxelGrid', () => {
  it('finds the nearest centre and honours the accept filter', () => {
    const store = clusters();
    const grid = VoxelGrid.forCentres(store.centers, 12);
    expect(grid.nearest(10.05, 0.02, 0, 1)).toBe(8);
    expect(grid.nearest(10.05, 0.02, 0, 1, (index) => index !== 8)).toBe(9);
    expect(grid.nearest(50, 50, 50, 1)).toBe(-1);
  });
});

describe('segment commands', () => {
  it('splits a group into a re-originned layer and undoes it', async () => {
    const document = new Document('test');
    documents.push(document);
    const source = new Layer({
      name: 'scan',
      kind: 'scan',
      sourceName: 'scan.ply',
      store: clusters(),
    });
    document.addLayer(source);
    source.object.position.set(0, 0, 1);
    source.object.updateMatrix();
    const indices = new Uint32Array([8, 9, 10, 11, 12, 13, 14, 15]);
    const command = new SplitSplats(document, source, indices, 'chair');
    document.history.push(command);
    expect(document.layers.map((layer) => layer.name)).toEqual(['scan', 'chair']);
    expect(source.store.liveCount()).toBe(17 - 8);
    const segment = command.segment;
    expect(segment.store.count).toBe(8);
    // Re-originned on the centroid (x ≈ 10.05, y ≈ 0.15) and placed so world positions are unchanged.
    expect(segment.object.position.x).toBeCloseTo(10.05, 5);
    expect(segment.object.position.z).toBeCloseTo(1, 5);
    const world = new Vector3(
      segment.store.centers[0],
      segment.store.centers[1],
      segment.store.centers[2],
    ).applyMatrix4(segment.object.matrix);
    expect(world.x).toBeCloseTo(10, 5);
    expect(world.z).toBeCloseTo(1, 5);
    await source.sync();
    expect(source.mesh.numSplats).toBe(9);
    document.history.undo();
    expect(document.layers.map((layer) => layer.name)).toEqual(['scan']);
    expect(source.store.liveCount()).toBe(17);
    document.history.redo();
    expect(document.layers).toHaveLength(2);
  });

  it('hides and restores splats, snaps to floor, and arrays copies', () => {
    const document = new Document('test');
    documents.push(document);
    const layer = new Layer({
      name: 'scan',
      kind: 'scan',
      sourceName: 'scan.ply',
      store: clusters(),
    });
    document.addLayer(layer);
    document.history.push(
      new SetSplatsAlive(document, layer.id, new Uint32Array([0, 1, 2]), false),
    );
    expect(layer.store.liveCount()).toBe(14);
    document.history.undo();
    expect(layer.store.liveCount()).toBe(17);

    layer.object.position.set(0, 2, 0);
    layer.object.updateMatrix();
    const floor = snapToFloorCommand(document, layer, 0);
    expect(floor).toBeDefined();
    document.history.push(floor!);
    layer.object.updateMatrixWorld(true);
    const bounds = layer.store.computeRobustBounds();
    const minY = Math.min(
      ...[bounds.min[1], bounds.max[1]].map(
        (y) => new Vector3(0, y, 0).applyMatrix4(layer.object.matrixWorld).y,
      ),
    );
    expect(minY).toBeCloseTo(0, 5);

    document.history.push(new ArrayLayer(document, layer, 3, new Vector3(2, 0, 0)));
    expect(document.layers).toHaveLength(4);
    const xs = document.layers
      .map((candidate) => candidate.object.position.x)
      .sort((a, b) => a - b);
    expect(xs).toEqual([0, 2, 4, 6]);
    document.history.undo();
    expect(document.layers).toHaveLength(1);

    document.history.push(
      new GridArrayLayer(document, layer, 3, 2, new Vector3(2, 0, 0), new Vector3(0, 0, 3)),
    );
    expect(document.layers).toHaveLength(6);
    const positions = document.layers
      .map((candidate) => [candidate.object.position.x, candidate.object.position.z])
      .sort((a, b) => a[1]! - b[1]! || a[0]! - b[0]!);
    expect(positions).toEqual([
      [0, 0],
      [2, 0],
      [4, 0],
      [0, 3],
      [2, 3],
      [4, 3],
    ]);
    document.history.undo();
    expect(document.layers).toHaveLength(1);
  });
});
