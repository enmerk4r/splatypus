import { UNASSIGNED } from '../splats/groups';
import type { GroupInfo } from '../splats/groups';
import { geodesicPartition } from './geodesic';
import { connectedComponents } from './neighbourGraph';
import type { NeighbourGraph } from './neighbourGraph';

/**
 * How much a colour change costs relative to distance when carving patches. Higher than
 * the selection default: patches exist to *show* where the colour turns, so the borders
 * should be drawn to it hard.
 */
const PATCH_COLOUR_WEIGHT = 14;
/** A patch below this many splats is not a patch: its splats are left unassigned. */
const MIN_PATCH_SPLATS = 8;

export interface PatchBake {
  /** Patch id per **store** index, `UNASSIGNED` where nothing claimed the splat. */
  ids: Uint32Array;
  groups: GroupInfo[];
  assigned: number;
}

/** Packs signed cell coordinates the way `VoxelGrid` does — a hash, resolved by the caller. */
function cellKey(cx: number, cy: number, cz: number): number {
  return (cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791);
}

interface Bounds {
  min: [number, number, number];
  extent: number;
}

function boundsOf(centres: Float32Array, nodes: Uint32Array): Bounds {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (const index of nodes) {
    const x = centres[index * 3]!,
      y = centres[index * 3 + 1]!,
      z = centres[index * 3 + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  return { min: [minX, minY, minZ], extent };
}

/**
 * Roughly `target` seeds spread evenly through the cloud: bucket the nodes on a uniform
 * grid and keep the node nearest each occupied cell's centre.
 *
 * The cell size is found by bisection rather than computed, because how occupancy grows
 * with cell size depends on whether the cloud is a surface or a volume, and a scan is
 * some of both.
 */
export function pickSeeds(
  centres: Float32Array,
  graph: NeighbourGraph,
  target: number,
): Uint32Array {
  const nodes = graph.nodes;
  if (target >= nodes.length) return Uint32Array.from(nodes, (_, local) => local);
  const { extent } = boundsOf(centres, nodes);
  const occupied = new Map<number, number>();
  const fill = (cell: number): Map<number, number> => {
    occupied.clear();
    for (let local = 0; local < nodes.length; local += 1) {
      const index = nodes[local]!;
      const key = cellKey(
        Math.floor(centres[index * 3]! / cell),
        Math.floor(centres[index * 3 + 1]! / cell),
        Math.floor(centres[index * 3 + 2]! / cell),
      );
      const held = occupied.get(key);
      if (held === undefined) {
        occupied.set(key, local);
        continue;
      }
      // Keep whichever of the two sits lower in the cell, so seeds are not all on one face.
      if (index < nodes[held]!) occupied.set(key, local);
    }
    return occupied;
  };
  let low = graph.spacing;
  let high = extent;
  let best = fill(extent / Math.cbrt(target));
  for (let step = 0; step < 12 && Math.abs(best.size - target) > target * 0.15; step += 1) {
    const cell = Math.sqrt(low * high);
    best = fill(cell);
    if (best.size > target) low = cell;
    else high = cell;
  }
  return Uint32Array.from(best.values());
}

/** Moves each seed to the member nearest its patch's centroid (one Lloyd step). */
function recentre(
  centres: Float32Array,
  graph: NeighbourGraph,
  labels: Int32Array,
  count: number,
): Uint32Array {
  const sums = new Float64Array(count * 3);
  const sizes = new Uint32Array(count);
  for (let local = 0; local < graph.count; local += 1) {
    const label = labels[local]!;
    if (label < 0) continue;
    const index = graph.nodes[local]! * 3;
    sums[label * 3] = sums[label * 3]! + centres[index]!;
    sums[label * 3 + 1] = sums[label * 3 + 1]! + centres[index + 1]!;
    sums[label * 3 + 2] = sums[label * 3 + 2]! + centres[index + 2]!;
    sizes[label] = sizes[label]! + 1;
  }
  const best = new Int32Array(count).fill(-1);
  const bestDistance = new Float64Array(count).fill(Infinity);
  for (let local = 0; local < graph.count; local += 1) {
    const label = labels[local]!;
    if (label < 0 || sizes[label] === 0) continue;
    const index = graph.nodes[local]! * 3;
    const size = sizes[label]!;
    const dx = centres[index]! - sums[label * 3]! / size;
    const dy = centres[index + 1]! - sums[label * 3 + 1]! / size;
    const dz = centres[index + 2]! - sums[label * 3 + 2]! / size;
    const distance = dx * dx + dy * dy + dz * dz;
    if (distance >= bestDistance[label]!) continue;
    bestDistance[label] = distance;
    best[label] = local;
  }
  return Uint32Array.from([...best].filter((local) => local >= 0));
}

/**
 * Carves a layer into flat patches that follow the cloud's own edges.
 *
 * The connectivity bake answers a different question — it looks for cells that happen to
 * match — and leaves most splats in no group at all (12 % coverage on the butterfly), so
 * turning its overlay on shows a scatter of coloured specks rather than a segmentation
 * mask. This partitions instead of matching, so essentially every splat lands in a patch
 * and the overlay reads as flat blocks you can actually judge a boundary against.
 */
export function bakeGeodesicPatches(
  centres: Float32Array,
  colours: Float32Array,
  storeCount: number,
  graph: NeighbourGraph,
  target: number,
): PatchBake {
  const cost = { colours, colourWeight: PATCH_COLOUR_WEIGHT };
  let seeds = pickSeeds(centres, graph, target);
  let labels = geodesicPartition(graph, cost, seeds);
  let count = 0;
  for (const label of labels) if (label + 1 > count) count = label + 1;
  if (count > 0) {
    seeds = recentre(centres, graph, labels, count);
    labels = geodesicPartition(graph, cost, seeds);
    count = 0;
    for (const label of labels) if (label + 1 > count) count = label + 1;
  }

  // Components holding no seed were never reached by any front; each becomes its own patch.
  const leftovers = connectedComponents(graph, (local) => labels[local]! < 0);
  const leftoverBase = count;
  count += leftovers.sizes.length;
  for (let local = 0; local < graph.count; local += 1) {
    if (labels[local]! >= 0) continue;
    const component = leftovers.labels[local]!;
    if (component >= 0) labels[local] = leftoverBase + component;
  }

  // Then one rule for every patch: too small to see is not a patch. That covers both the
  // fragments no front reached and the lone floaters that grabbed a seed of their own —
  // without it, a scan's scattered specks eat the seed budget and the palette.
  const sizes = new Uint32Array(count);
  for (let local = 0; local < graph.count; local += 1) {
    const label = labels[local]!;
    if (label >= 0) sizes[label] = sizes[label]! + 1;
  }
  const remap = new Int32Array(count).fill(-1);
  let kept = 0;
  for (let label = 0; label < count; label += 1)
    if (sizes[label]! >= MIN_PATCH_SPLATS) remap[label] = kept++;

  const ids = new Uint32Array(storeCount).fill(UNASSIGNED);
  const keptSizes = new Uint32Array(kept);
  let assigned = 0;
  for (let local = 0; local < graph.count; local += 1) {
    const label = labels[local]!;
    if (label < 0) continue;
    const id = remap[label]!;
    if (id < 0) continue;
    ids[graph.nodes[local]!] = id;
    keptSizes[id] = keptSizes[id]! + 1;
    assigned += 1;
  }
  const groups: GroupInfo[] = Array.from({ length: kept }, (_, id) => ({
    id,
    name: `patch ${id + 1}`,
    count: keptSizes[id] ?? 0,
  }));
  return { ids, groups, assigned };
}
