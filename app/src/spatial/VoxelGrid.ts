/**
 * Uniform voxel hash grid over splat centres, stored as a CSR-style pair of flat typed
 * arrays rather than a Map of arrays so that lookups stay allocation-free.
 *
 * Spark's raycast reports where a ray hit the cloud but not which splat it hit, so
 * picking a splat means asking this grid for the centre nearest the hit point. The same
 * structure is what brush and flood-fill tools will need later.
 */
export class VoxelGrid {
  readonly cellSize: number;
  private readonly slotOfCell = new Map<number, number>();
  private readonly starts: Int32Array;
  private readonly items: Int32Array;

  /**
   * @param centres Splat centres as `[x0, y0, z0, x1, ...]`, in splat-index order.
   * @param cellSize Edge length of a voxel, in scene units.
   */
  constructor(
    private readonly centres: Float32Array,
    cellSize: number,
  ) {
    this.cellSize = cellSize;
    const count = Math.floor(centres.length / 3);

    // Pass 1: assign each occupied cell a dense slot and count its members.
    const counts: number[] = [];
    const slotOfSplat = new Int32Array(count);
    for (let i = 0; i < count; i += 1) {
      const key = this.cellKeyOf(centres[i * 3]!, centres[i * 3 + 1]!, centres[i * 3 + 2]!);
      let slot = this.slotOfCell.get(key);
      if (slot === undefined) {
        slot = counts.length;
        this.slotOfCell.set(key, slot);
        counts.push(0);
      }
      counts[slot] = counts[slot]! + 1;
      slotOfSplat[i] = slot;
    }

    // Pass 2: prefix-sum the counts into bucket starts, then scatter the splat indices.
    this.starts = new Int32Array(counts.length + 1);
    for (let slot = 0; slot < counts.length; slot += 1) {
      this.starts[slot + 1] = this.starts[slot]! + counts[slot]!;
    }
    this.items = new Int32Array(count);
    const cursor = this.starts.slice(0, counts.length);
    for (let i = 0; i < count; i += 1) {
      const slot = slotOfSplat[i]!;
      this.items[cursor[slot]!] = i;
      cursor[slot] = cursor[slot]! + 1;
    }
  }

  /** Builds a grid sized so cells hold a handful of splats each. */
  static forCentres(centres: Float32Array, extent: number): VoxelGrid {
    const count = Math.max(1, Math.floor(centres.length / 3));
    // ~64 cells along the longest axis keeps occupancy low without exploding the map.
    const cellSize = Math.max(extent / 64, 1e-6);
    return new VoxelGrid(centres, count > 0 ? cellSize : 1);
  }

  /**
   * Index of the splat whose centre is closest to the point, or -1 if nothing lies
   * within `maxRadius`. `accept` filters candidates (e.g. to skip deleted splats). Searches outward one shell of cells at a time and stops as soon
   * as the best hit is closer than the nearest possible point in the next shell.
   */
  nearest(
    x: number,
    y: number,
    z: number,
    maxRadius: number,
    accept: (index: number) => boolean = () => true,
  ): number {
    const maxShell = Math.ceil(maxRadius / this.cellSize);
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const cz = Math.floor(z / this.cellSize);

    let best = -1;
    let bestDistanceSq = maxRadius * maxRadius;

    for (let shell = 0; shell <= maxShell; shell += 1) {
      // Everything in this shell is at least (shell - 1) cells away, so once the best
      // hit beats that bound no outer shell can improve on it.
      if (best >= 0) {
        const bound = (shell - 1) * this.cellSize;
        if (bound > 0 && bestDistanceSq < bound * bound) break;
      }

      for (let dx = -shell; dx <= shell; dx += 1) {
        for (let dy = -shell; dy <= shell; dy += 1) {
          for (let dz = -shell; dz <= shell; dz += 1) {
            // Only the surface of the cube is new; the interior was covered already.
            const onShell =
              Math.abs(dx) === shell || Math.abs(dy) === shell || Math.abs(dz) === shell;
            if (!onShell) continue;

            const slot = this.slotOfCell.get(this.cellKey(cx + dx, cy + dy, cz + dz));
            if (slot === undefined) continue;
            const end = this.starts[slot + 1]!;
            for (let at = this.starts[slot]!; at < end; at += 1) {
              const index = this.items[at]!;
              if (!accept(index)) continue;
              const ex = this.centres[index * 3]! - x;
              const ey = this.centres[index * 3 + 1]! - y;
              const ez = this.centres[index * 3 + 2]! - z;
              const distanceSq = ex * ex + ey * ey + ez * ez;
              if (distanceSq < bestDistanceSq) {
                bestDistanceSq = distanceSq;
                best = index;
              }
            }
          }
        }
      }
    }
    return best;
  }

  private cellKeyOf(x: number, y: number, z: number): number {
    return this.cellKey(
      Math.floor(x / this.cellSize),
      Math.floor(y / this.cellSize),
      Math.floor(z / this.cellSize),
    );
  }

  /**
   * Packs signed cell coordinates into one number. 21 bits per axis exceeds the 53-bit
   * mantissa when combined, so this hashes instead — collisions are resolved by the
   * distance check in `nearest`, which rejects splats that are genuinely far away.
   */
  private cellKey(cx: number, cy: number, cz: number): number {
    return (cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791);
  }
}
