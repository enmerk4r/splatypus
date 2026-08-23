import { describe, expect, it } from 'vitest';
import { Layer } from '../src/model/Layer';
import { SplatStore } from '../src/model/SplatStore';
import { FrontDepth } from '../src/select/frontDepth';
import { geodesicFlood, geodesicPartition, geodesicRefine } from '../src/select/geodesic';
import {
  buildNeighbourGraph,
  connectedComponents,
  estimateSpacing,
} from '../src/select/neighbourGraph';
import { RegionSelection } from '../src/select/RegionSelection';
import { bakeGeodesicPatches, pickSeeds } from '../src/select/superpixels';
import { UNASSIGNED } from '../src/splats/groups';
import { ScreenMask } from '../src/select/screenMask';
import { VoxelGrid } from '../src/spatial/VoxelGrid';

/** A store from explicit centres and colours; everything else is a sane constant. */
function storeOf(centres: number[], colours?: number[]): SplatStore {
  const count = centres.length / 3;
  return new SplatStore({
    count,
    centers: new Float32Array(centres),
    scales: new Float32Array(count * 3).fill(0.05),
    rotations: Float32Array.from({ length: count * 4 }, (_, i) => (i % 4 === 3 ? 1 : 0)),
    opacities: new Float32Array(count).fill(1),
    colors: new Float32Array(colours ?? new Array<number>(count * 3).fill(0.5)),
    shDegree: 0,
  });
}

/**
 * A 1-unit-spaced grid strip of `columns` × `rows` splats in the XY plane, coloured in two
 * vertical halves so there is a colour edge at `columns / 2` to snap to.
 */
function stripe(columns: number, rows: number): SplatStore {
  const centres: number[] = [];
  const colours: number[] = [];
  for (let row = 0; row < rows; row += 1)
    for (let column = 0; column < columns; column += 1) {
      centres.push(column, row, 0);
      if (column < columns / 2) colours.push(0.9, 0.1, 0.1);
      else colours.push(0.1, 0.1, 0.9);
    }
  return storeOf(centres, colours);
}

describe('ScreenMask', () => {
  it('fills a polygon and signs distance from its outline', () => {
    const mask = ScreenMask.fromPolygon(
      [
        { x: 20, y: 20 },
        { x: 80, y: 20 },
        { x: 80, y: 80 },
        { x: 20, y: 80 },
      ],
      100,
      100,
      2,
    );
    expect(mask.isEmpty).toBe(false);
    expect(mask.contains(50, 50)).toBe(true);
    expect(mask.contains(5, 5)).toBe(false);
    // Well inside is negative, well outside positive, and the centre is ~30 px deep.
    expect(mask.signedDistance(50, 50)).toBeLessThan(-25);
    expect(mask.signedDistance(50, 50)).toBeGreaterThan(-35);
    expect(mask.signedDistance(50, 10)).toBeGreaterThan(5);
    expect(Math.abs(mask.signedDistance(50, 21))).toBeLessThan(4);
  });

  it('reports an empty mask for a degenerate shape', () => {
    expect(ScreenMask.fromPolygon([{ x: 1, y: 1 }], 40, 40, 4).isEmpty).toBe(true);
  });
});

describe('VoxelGrid.forEachWithin', () => {
  it('visits exactly the centres inside the radius', () => {
    const centres = new Float32Array([0, 0, 0, 1, 0, 0, 5, 0, 0]);
    const grid = new VoxelGrid(centres, 1);
    const seen: number[] = [];
    grid.forEachWithin(0, 0, 0, 1.5, (index) => seen.push(index));
    expect(seen.sort()).toEqual([0, 1]);
  });
});

describe('neighbour graph', () => {
  it('measures the cloud spacing and links only near neighbours', () => {
    const store = stripe(6, 6);
    const nodes = Uint32Array.from({ length: store.count }, (_, index) => index);
    expect(estimateSpacing(store.centers, store.count)).toBeCloseTo(1, 5);
    const graph = buildNeighbourGraph(store.centers, store.count, nodes);
    expect(graph.count).toBe(36);
    expect(graph.spacing).toBeCloseTo(1, 5);
    // A corner splat keeps its nearest neighbours, all inside the link radius.
    const corner = graph.localOf[0]!;
    expect(graph.degree[corner]).toBe(graph.stride);
    for (let at = 0; at < graph.degree[corner]!; at += 1)
      expect(graph.dist[corner * graph.stride + at]!).toBeLessThanOrEqual(4 * 1.0001);
  });

  it('separates two clouds that never touch', () => {
    const store = storeOf([0, 0, 0, 0.2, 0, 0, 0.4, 0, 0, 20, 0, 0, 20.2, 0, 0]);
    const nodes = Uint32Array.from({ length: store.count }, (_, index) => index);
    const graph = buildNeighbourGraph(store.centers, store.count, nodes);
    const { sizes } = connectedComponents(graph);
    expect(sizes.length).toBe(2);
    expect([...sizes].sort((a, b) => b - a)).toEqual([3, 2]);
  });
});

describe('geodesic selection', () => {
  it('moves a sloppy boundary onto the colour edge', () => {
    const columns = 12;
    const rows = 6;
    const store = stripe(columns, rows);
    const nodes = Uint32Array.from({ length: store.count }, (_, index) => index);
    const graph = buildNeighbourGraph(store.centers, store.count, nodes);
    const columnOf = (local: number): number => graph.nodes[local]! % columns;
    // Seeds are deliberately short of the real edge at column 6 on one side and past it
    // on the other: columns 3..8 are left for the walk to decide.
    const foreground = new Uint8Array(graph.count);
    const background = new Uint8Array(graph.count);
    for (let local = 0; local < graph.count; local += 1) {
      if (columnOf(local) <= 2) foreground[local] = 1;
      if (columnOf(local) >= 9) background[local] = 1;
    }
    const labels = geodesicRefine(
      graph,
      { colours: store.colors, colourWeight: 12 },
      foreground,
      background,
    );
    for (let local = 0; local < graph.count; local += 1)
      expect(labels[local]).toBe(columnOf(local) < columns / 2 ? 1 : 0);
  });

  it('falls back to the given foreground when one side has no seeds', () => {
    const store = stripe(4, 4);
    const nodes = Uint32Array.from({ length: store.count }, (_, index) => index);
    const graph = buildNeighbourGraph(store.centers, store.count, nodes);
    const foreground = new Uint8Array(graph.count);
    foreground[0] = 1;
    const labels = geodesicRefine(
      graph,
      { colours: store.colors, colourWeight: 8 },
      foreground,
      new Uint8Array(graph.count),
    );
    expect([...labels]).toEqual([...foreground]);
  });

  it('floods one side of a colour edge and stops', () => {
    const columns = 12;
    const rows = 6;
    const store = stripe(columns, rows);
    const nodes = Uint32Array.from({ length: store.count }, (_, index) => index);
    const graph = buildNeighbourGraph(store.centers, store.count, nodes);
    const seed = graph.localOf[0]!;
    const reached = geodesicFlood(graph, { colours: store.colors, colourWeight: 40 }, seed, 12);
    let red = 0;
    let blue = 0;
    for (let local = 0; local < graph.count; local += 1) {
      if (reached[local] !== 1) continue;
      if (graph.nodes[local]! % columns < columns / 2) red += 1;
      else blue += 1;
    }
    expect(red).toBeGreaterThan(rows * 3);
    expect(blue).toBe(0);
  });
});

describe('geodesic patches', () => {
  const graphOf = (store: SplatStore) =>
    buildNeighbourGraph(
      store.centers,
      store.count,
      Uint32Array.from({ length: store.count }, (_, index) => index),
    );

  it('splits the cloud between competing seeds at the colour edge', () => {
    const columns = 12;
    const store = stripe(columns, 6);
    const graph = graphOf(store);
    // One seed in each coloured half; the border should land between them, on the edge.
    const seeds = Uint32Array.from([graph.localOf[0]!, graph.localOf[columns - 1]!]);
    const labels = geodesicPartition(graph, { colours: store.colors, colourWeight: 14 }, seeds);
    for (let local = 0; local < graph.count; local += 1)
      expect(labels[local]).toBe(graph.nodes[local]! % columns < columns / 2 ? 0 : 1);
  });

  it('spreads seeds out rather than clustering them', () => {
    const store = stripe(20, 20);
    const seeds = pickSeeds(store.centers, graphOf(store), 9);
    expect(seeds.length).toBeGreaterThanOrEqual(4);
    expect(seeds.length).toBeLessThanOrEqual(20);
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it('covers every reachable splat, unlike the matching bake', () => {
    const store = stripe(20, 20);
    const { ids, groups, assigned } = bakeGeodesicPatches(
      store.centers,
      store.colors,
      store.count,
      graphOf(store),
      9,
    );
    expect(assigned).toBe(store.count);
    expect([...ids].some((id) => id === UNASSIGNED)).toBe(false);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.reduce((total, group) => total + group.count, 0)).toBe(store.count);
    // Ids stay inside the declared range, or the palette would read past its end.
    for (const id of ids) expect(id).toBeLessThan(groups.length);
  });

  it('leaves a far-off floater out rather than giving it a patch of its own', () => {
    const centres: number[] = [];
    for (let row = 0; row < 8; row += 1)
      for (let column = 0; column < 8; column += 1) centres.push(column, row, 0);
    centres.push(500, 0, 0);
    const store = storeOf(centres);
    const { ids, assigned } = bakeGeodesicPatches(
      store.centers,
      store.colors,
      store.count,
      graphOf(store),
      4,
    );
    expect(assigned).toBe(64);
    expect(ids[64]).toBe(UNASSIGNED);
  });
});

describe('FrontDepth', () => {
  it('keeps the front surface and rejects what is behind it', () => {
    // Four splats in one screen cell: three at depth 1 and one far behind.
    const index = {
      px: new Float32Array([4, 5, 6, 5]),
      py: new Float32Array([4, 5, 6, 5]),
      depth: new Float32Array([1, 1, 1, 9]),
    };
    const front = new FrontDepth(index as never, 4, 16, 16);
    expect(front.at(5, 5)).toBeCloseTo(1);
    expect(front.accepts(index as never, 0, 0.5)).toBe(true);
    expect(front.accepts(index as never, 3, 0.5)).toBe(false);
    expect(front.accepts(index as never, 3, 10)).toBe(true);
  });

  it('ignores a single floater in front of the surface', () => {
    const index = {
      px: new Float32Array([4, 5, 6, 5]),
      py: new Float32Array([4, 5, 6, 5]),
      depth: new Float32Array([0.1, 5, 5, 5]),
    };
    const front = new FrontDepth(index as never, 4, 16, 16);
    // The third-nearest, not the nearest, so the floater does not pull the window forward.
    expect(front.at(5, 5)).toBeCloseTo(5);
  });
});

describe('RegionSelection', () => {
  const layerOf = (store: SplatStore): Layer =>
    new Layer({ name: 'test', kind: 'scan', store, sourceName: 'test.ply' });

  it('adds, subtracts and reports what changed', () => {
    const region = new RegionSelection();
    const layer = layerOf(stripe(4, 4));
    const changes: { added: number[]; removed: number[] }[] = [];
    region.addEventListener('region-changed', (event) => {
      const detail = (event as CustomEvent<{ added: Uint32Array; removed: Uint32Array }>).detail;
      changes.push({ added: [...detail.added], removed: [...detail.removed] });
    });
    region.replace(layer, new Uint32Array([0, 1, 2]));
    expect(region.count).toBe(3);
    region.add(new Uint32Array([2, 3]));
    expect(region.count).toBe(4);
    expect(changes.at(-1)).toEqual({ added: [3], removed: [] });
    region.subtract(new Uint32Array([0]));
    expect([...region.indices()]).toEqual([1, 2, 3]);
    expect(changes.at(-1)).toEqual({ added: [], removed: [0] });
    region.clear();
    expect(region.isEmpty).toBe(true);
    expect(changes.at(-1)!.removed).toEqual([1, 2, 3]);
  });

  it('never selects a dead splat', () => {
    const store = stripe(4, 4);
    store.alive[5] = 0;
    const region = new RegionSelection();
    region.replace(layerOf(store), new Uint32Array([4, 5, 6]));
    expect([...region.indices()]).toEqual([4, 6]);
  });

  it('grows into the neighbours of the selected splats', () => {
    const region = new RegionSelection();
    // A 5×5 grid: the centre splat is index 12, and its 8 nearest form the ring around it.
    region.replace(layerOf(stripe(5, 5)), new Uint32Array([12]));
    region.grow(1);
    expect([...region.indices()]).toEqual([6, 7, 8, 11, 12, 13, 16, 17, 18]);
    // Only the centre has all eight of its neighbours inside, so shrinking leaves it alone.
    region.shrink(1);
    expect([...region.indices()]).toEqual([12]);
  });

  it('shrinks a block back to its interior', () => {
    // Columns/rows 1..5 of a 7×7 grid; shrinking should leave the 3×3 core at 2..4.
    const region = new RegionSelection();
    const selected: number[] = [];
    for (let row = 1; row <= 5; row += 1)
      for (let column = 1; column <= 5; column += 1) selected.push(row * 7 + column);
    region.replace(layerOf(stripe(7, 7)), Uint32Array.from(selected));
    region.shrink(1);
    const core: number[] = [];
    for (let row = 2; row <= 4; row += 1)
      for (let column = 2; column <= 4; column += 1) core.push(row * 7 + column);
    expect([...region.indices()]).toEqual(core);
  });

  it('drops islands and keeps the largest piece', () => {
    // A 4×4 block, plus a lone splat 20 units away that a screen selection would drag in.
    const centres: number[] = [];
    for (let row = 0; row < 4; row += 1)
      for (let column = 0; column < 4; column += 1) centres.push(column, row, 0);
    centres.push(20, 0, 0);
    const store = storeOf(centres);
    const region = new RegionSelection();
    region.replace(
      layerOf(store),
      Uint32Array.from({ length: store.count }, (_, index) => index),
    );
    expect(region.count).toBe(17);
    expect(region.removeIslands(4)).toBe(1);
    expect(region.count).toBe(16);
    expect(region.keepLargest()).toBe(0);
  });
});
