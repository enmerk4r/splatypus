import type { NeighbourGraph } from './neighbourGraph';

/** Binary min-heap over (cost, node) pairs, in typed arrays so a walk allocates nothing. */
class MinHeap {
  private costs: Float64Array;
  private nodes: Uint32Array;
  private size = 0;

  constructor(capacity: number) {
    this.costs = new Float64Array(Math.max(16, capacity));
    this.nodes = new Uint32Array(Math.max(16, capacity));
  }

  get length(): number {
    return this.size;
  }

  push(cost: number, node: number): void {
    if (this.size === this.costs.length) {
      const costs = new Float64Array(this.size * 2);
      const nodes = new Uint32Array(this.size * 2);
      costs.set(this.costs);
      nodes.set(this.nodes);
      this.costs = costs;
      this.nodes = nodes;
    }
    let at = this.size++;
    this.costs[at] = cost;
    this.nodes[at] = node;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (this.costs[parent]! <= this.costs[at]!) break;
      this.swap(at, parent);
      at = parent;
    }
  }

  /** Pops the cheapest node, or −1 when empty. The cost is left in `topCost`. */
  pop(): number {
    if (this.size === 0) return -1;
    const node = this.nodes[0]!;
    this.topCost = this.costs[0]!;
    this.size -= 1;
    if (this.size > 0) {
      this.costs[0] = this.costs[this.size]!;
      this.nodes[0] = this.nodes[this.size]!;
      let at = 0;
      for (;;) {
        const left = at * 2 + 1;
        const right = left + 1;
        let smallest = at;
        if (left < this.size && this.costs[left]! < this.costs[smallest]!) smallest = left;
        if (right < this.size && this.costs[right]! < this.costs[smallest]!) smallest = right;
        if (smallest === at) break;
        this.swap(at, smallest);
        at = smallest;
      }
    }
    return node;
  }

  topCost = 0;

  private swap(a: number, b: number): void {
    const cost = this.costs[a]!;
    this.costs[a] = this.costs[b]!;
    this.costs[b] = cost;
    const node = this.nodes[a]!;
    this.nodes[a] = this.nodes[b]!;
    this.nodes[b] = node;
  }
}

export interface GeodesicCost {
  /** Store colours as `[r0, g0, b0, ...]`, aligned with the graph's store indices. */
  colours: Float32Array;
  /**
   * How much a colour change costs relative to distance. 0 makes the walk purely
   * geometric; higher values make it hug colour boundaries.
   */
  colourWeight: number;
}

/**
 * Edge cost: a step of one splat spacing across matching colour costs 1, and crossing a
 * colour edge costs more in proportion. Normalising by `spacing` keeps every threshold
 * scale-free.
 */
function edgeCost(
  graph: NeighbourGraph,
  cost: GeodesicCost,
  from: number,
  to: number,
  length: number,
): number {
  const a = graph.nodes[from]! * 3;
  const b = graph.nodes[to]! * 3;
  const dr = cost.colours[a]! - cost.colours[b]!;
  const dg = cost.colours[a + 1]! - cost.colours[b + 1]!;
  const db = cost.colours[a + 2]! - cost.colours[b + 2]!;
  const colourDelta = Math.sqrt(dr * dr + dg * dg + db * db);
  return (length / graph.spacing) * (1 + cost.colourWeight * colourDelta);
}

/**
 * Competing fronts from two seed sets: every node ends up with the label whose seeds it
 * is *geodesically* closest to, where "close" already knows about colour. Nodes seeded on
 * neither side get whichever front reaches them first, so a sloppy hand-drawn boundary
 * ends up wherever the cloud actually changes — the 3D analogue of a magnetic lasso.
 *
 * Returns 1 for foreground, 0 for background, per local node.
 */
export function geodesicRefine(
  graph: NeighbourGraph,
  cost: GeodesicCost,
  foreground: Uint8Array,
  background: Uint8Array,
): Uint8Array {
  const labels = new Uint8Array(graph.count);
  const best = new Float64Array(graph.count).fill(Infinity);
  const settled = new Uint8Array(graph.count);
  const heap = new MinHeap(graph.count);
  let foregroundSeeds = 0;
  let backgroundSeeds = 0;
  for (let node = 0; node < graph.count; node += 1) {
    const isForeground = foreground[node] === 1;
    const isBackground = background[node] === 1;
    if (isForeground === isBackground) continue; // unseeded, or contradictory
    labels[node] = isForeground ? 1 : 0;
    best[node] = 0;
    if (isForeground) foregroundSeeds += 1;
    else backgroundSeeds += 1;
    heap.push(0, node);
  }
  // One front unopposed would swallow the whole graph, which is never what was meant.
  if (foregroundSeeds === 0 || backgroundSeeds === 0) return foreground.slice();
  while (heap.length > 0) {
    const node = heap.pop();
    if (node < 0) break;
    if (settled[node] === 1) continue;
    settled[node] = 1;
    const nodeCost = heap.topCost;
    const base = node * graph.stride;
    for (let at = 0; at < graph.degree[node]!; at += 1) {
      const next = graph.items[base + at]!;
      if (settled[next] === 1) continue;
      const candidate = nodeCost + edgeCost(graph, cost, node, next, graph.dist[base + at]!);
      if (candidate >= best[next]!) continue;
      best[next] = candidate;
      labels[next] = labels[node]!;
      heap.push(candidate, next);
    }
  }
  return labels;
}

/**
 * K-way competing fronts: every node takes the label of whichever seed reaches it most
 * cheaply. With seeds spread evenly through the cloud this carves it into patches whose
 * borders sit on colour and geometry changes — the flat-colour-block view of a
 * segmentation, but derived from the same walk the selection tools use.
 *
 * Returns the seed's ordinal per local node, or −1 for nodes no front could reach (an
 * isolated splat, or a component holding no seed).
 */
export function geodesicPartition(
  graph: NeighbourGraph,
  cost: GeodesicCost,
  seeds: Uint32Array,
): Int32Array {
  const labels = new Int32Array(graph.count).fill(-1);
  const best = new Float64Array(graph.count).fill(Infinity);
  const settled = new Uint8Array(graph.count);
  const heap = new MinHeap(graph.count);
  let next = 0;
  for (const seed of seeds) {
    if (seed >= graph.count || labels[seed]! >= 0) continue;
    labels[seed] = next++;
    best[seed] = 0;
    heap.push(0, seed);
  }
  while (heap.length > 0) {
    const node = heap.pop();
    if (node < 0) break;
    if (settled[node] === 1) continue;
    settled[node] = 1;
    const nodeCost = heap.topCost;
    const base = node * graph.stride;
    for (let at = 0; at < graph.degree[node]!; at += 1) {
      const neighbour = graph.items[base + at]!;
      if (settled[neighbour] === 1) continue;
      const candidate = nodeCost + edgeCost(graph, cost, node, neighbour, graph.dist[base + at]!);
      if (candidate >= best[neighbour]!) continue;
      best[neighbour] = candidate;
      labels[neighbour] = labels[node]!;
      heap.push(candidate, neighbour);
    }
  }
  return labels;
}

/**
 * Magic wand: grows out from one splat while the geodesic cost stays under `tolerance`
 * (in units of "one splat step across matching colour"), so it stops where the surface
 * stops or the colour turns. Returns a mask over local nodes.
 */
export function geodesicFlood(
  graph: NeighbourGraph,
  cost: GeodesicCost,
  seed: number,
  tolerance: number,
): Uint8Array {
  const reached = new Uint8Array(graph.count);
  if (seed < 0 || seed >= graph.count) return reached;
  const best = new Float64Array(graph.count).fill(Infinity);
  const heap = new MinHeap(1024);
  best[seed] = 0;
  heap.push(0, seed);
  while (heap.length > 0) {
    const node = heap.pop();
    if (node < 0) break;
    const nodeCost = heap.topCost;
    if (nodeCost > best[node]!) continue;
    if (nodeCost > tolerance) break;
    reached[node] = 1;
    const base = node * graph.stride;
    for (let at = 0; at < graph.degree[node]!; at += 1) {
      const next = graph.items[base + at]!;
      const candidate = nodeCost + edgeCost(graph, cost, node, next, graph.dist[base + at]!);
      if (candidate > tolerance || candidate >= best[next]!) continue;
      best[next] = candidate;
      heap.push(candidate, next);
    }
  }
  return reached;
}
