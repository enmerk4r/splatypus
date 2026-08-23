import { VoxelGrid } from '../spatial/VoxelGrid';

/**
 * A k-nearest-neighbour graph over a subset of a layer's splats, held in fixed-stride
 * arrays: local node `i` is store index `nodes[i]`, and its neighbours are the first
 * `degree[i]` entries of `items[i * stride ...]`, sorted nearest first.
 *
 * This is what turns "a bag of splats" into something with a notion of *adjacent*, which
 * is what every boundary-aware tool here needs: the geodesic snap walks it, connected
 * components ride it, and island removal counts on it.
 */
export interface NeighbourGraph {
  readonly count: number;
  readonly stride: number;
  /** Local node → store index. */
  readonly nodes: Uint32Array;
  /** Store index → local node, or −1 when the splat is not in the graph. */
  readonly localOf: Int32Array;
  readonly degree: Uint8Array;
  readonly items: Uint32Array;
  readonly dist: Float32Array;
  /** Median nearest-neighbour distance — the cloud's own unit of "one splat apart". */
  readonly spacing: number;
}

export interface GraphOptions {
  /** Neighbours kept per node. */
  stride?: number;
  /** Link radius as a multiple of the measured spacing. */
  radiusScale?: number;
}

/**
 * Link radius as a multiple of the median splat spacing.
 *
 * Real scans are nowhere near uniform, so a radius close to the median leaves a large
 * minority of splats with no neighbours at all and the graph in thousands of pieces —
 * measured on the 262 k butterfly, 2.2 left 11 % of splats isolated and the biggest
 * component at 22 %, where 4 leaves 1.7 % isolated and 96 % in one piece for ~25 % more
 * build time. Anything that walks the graph is useless on a shattered one.
 */
const DEFAULT_RADIUS_SCALE = 4;

/** Bounding-box diagonal of the given centres, used to size the first (coarse) grid. */
function extentOf(centres: Float32Array, count: number): number {
  if (count === 0) return 1;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let index = 0; index < count; index += 1) {
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
  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  return diagonal > 0 ? diagonal : 1;
}

/**
 * Median distance to the nearest other centre, over an evenly spaced sample. Every
 * threshold downstream is expressed as a multiple of this, so the tools behave the same
 * on a phone scan in metres and on a synthetic scene in arbitrary units.
 */
export function estimateSpacing(centres: Float32Array, count: number, samples = 512): number {
  const extent = extentOf(centres, count);
  if (count < 2) return extent;
  const grid = VoxelGrid.forCentres(centres, extent);
  const step = Math.max(1, Math.floor(count / samples));
  const distances: number[] = [];
  for (let index = 0; index < count; index += step) {
    // The grid is sized from the extent, which on a sparse cloud is much finer than the
    // spacing being measured, so widen the search until something turns up.
    let nearest = -1;
    for (let radius = grid.cellSize * 2; nearest < 0 && radius <= extent * 2; radius *= 8)
      nearest = grid.nearest(
        centres[index * 3]!,
        centres[index * 3 + 1]!,
        centres[index * 3 + 2]!,
        radius,
        (candidate) => candidate !== index,
      );
    if (nearest < 0) continue;
    distances.push(
      Math.hypot(
        centres[nearest * 3]! - centres[index * 3]!,
        centres[nearest * 3 + 1]! - centres[index * 3 + 1]!,
        centres[nearest * 3 + 2]! - centres[index * 3 + 2]!,
      ),
    );
  }
  if (distances.length === 0) return extent / Math.cbrt(count);
  distances.sort((a, b) => a - b);
  const median = distances[Math.floor(distances.length / 2)]!;
  return median > 0 ? median : extent / Math.cbrt(count);
}

/**
 * Builds the neighbour graph over `nodes` (store indices). The link radius is measured
 * from the data rather than configured, and the grid is rebuilt at that radius so each
 * query only touches a handful of splats per cell.
 */
export function buildNeighbourGraph(
  centres: Float32Array,
  storeCount: number,
  nodes: Uint32Array,
  options: GraphOptions = {},
): NeighbourGraph {
  const stride = options.stride ?? 8;
  const radiusScale = options.radiusScale ?? DEFAULT_RADIUS_SCALE;
  const count = nodes.length;
  const localCentres = new Float32Array(count * 3);
  const localOf = new Int32Array(storeCount).fill(-1);
  for (let local = 0; local < count; local += 1) {
    const index = nodes[local]!;
    localOf[index] = local;
    localCentres[local * 3] = centres[index * 3]!;
    localCentres[local * 3 + 1] = centres[index * 3 + 1]!;
    localCentres[local * 3 + 2] = centres[index * 3 + 2]!;
  }
  const spacing = estimateSpacing(localCentres, count);
  const radius = Math.max(spacing * radiusScale, 1e-6);
  const grid = new VoxelGrid(localCentres, radius);
  const degree = new Uint8Array(count);
  const items = new Uint32Array(count * stride);
  const dist = new Float32Array(count * stride);

  for (let local = 0; local < count; local += 1) {
    const base = local * stride;
    let filled = 0;
    grid.forEachWithin(
      localCentres[local * 3]!,
      localCentres[local * 3 + 1]!,
      localCentres[local * 3 + 2]!,
      radius,
      (candidate, distanceSq) => {
        if (candidate === local) return;
        // Keep the `stride` nearest by insertion: the list is tiny, so this beats a heap.
        if (filled === stride && distanceSq >= dist[base + filled - 1]!) return;
        let at = Math.min(filled, stride - 1);
        while (at > 0 && dist[base + at - 1]! > distanceSq) {
          dist[base + at] = dist[base + at - 1]!;
          items[base + at] = items[base + at - 1]!;
          at -= 1;
        }
        dist[base + at] = distanceSq;
        items[base + at] = candidate;
        if (filled < stride) filled += 1;
      },
    );
    degree[local] = filled;
    for (let at = 0; at < filled; at += 1) dist[base + at] = Math.sqrt(dist[base + at]!);
  }
  return { count, stride, nodes, localOf, degree, items, dist, spacing };
}

/**
 * Connected components over the graph, restricted to nodes the predicate accepts.
 * Returns a label per local node (−1 for rejected nodes) and each component's size.
 */
export function connectedComponents(
  graph: NeighbourGraph,
  accepts: (local: number) => boolean = () => true,
): { labels: Int32Array; sizes: Uint32Array } {
  const labels = new Int32Array(graph.count).fill(-1);
  const sizes: number[] = [];
  const stack = new Uint32Array(graph.count);
  for (let seed = 0; seed < graph.count; seed += 1) {
    if (labels[seed] !== -1 || !accepts(seed)) continue;
    const label = sizes.length;
    let size = 0;
    let top = 0;
    stack[top++] = seed;
    labels[seed] = label;
    while (top > 0) {
      const node = stack[--top]!;
      size += 1;
      const base = node * graph.stride;
      for (let at = 0; at < graph.degree[node]!; at += 1) {
        const next = graph.items[base + at]!;
        if (labels[next] !== -1 || !accepts(next)) continue;
        labels[next] = label;
        stack[top++] = next;
      }
    }
    sizes.push(size);
  }
  return { labels, sizes: Uint32Array.from(sizes) };
}
