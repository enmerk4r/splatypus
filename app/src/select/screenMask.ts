export interface Point {
  x: number;
  y: number;
}

/** Chamfer weights for the 3×4 distance transform, in cells. */
const ORTHOGONAL = 1;
const DIAGONAL = Math.SQRT2;

/**
 * A drawn selection shape rasterised onto a coarse grid of the canvas, plus its signed
 * distance field in pixels (negative inside).
 *
 * Every tool here needs more than "is this point inside?": the smart snap needs a band of
 * confident interior and a band of confident exterior on either side of the line the hand
 * drew, and a distance field gives both for any shape — lasso, rectangle, polygon or a
 * brush stroke — without offsetting the outline itself.
 */
export class ScreenMask {
  readonly columns: number;
  readonly rows: number;
  private readonly insideCells: Uint8Array;
  private readonly signed: Float32Array;

  private constructor(
    readonly cell: number,
    columns: number,
    rows: number,
    insideCells: Uint8Array,
  ) {
    this.columns = columns;
    this.rows = rows;
    this.insideCells = insideCells;
    this.signed = signedDistanceField(insideCells, columns, rows, cell);
  }

  /** Even-odd fill of a closed polygon, sampled at cell centres. */
  static fromPolygon(
    points: readonly Point[],
    width: number,
    height: number,
    cell = 4,
  ): ScreenMask {
    const columns = Math.max(1, Math.ceil(width / cell));
    const rows = Math.max(1, Math.ceil(height / cell));
    const inside = new Uint8Array(columns * rows);
    if (points.length >= 3) {
      const crossings: number[] = [];
      for (let row = 0; row < rows; row += 1) {
        const y = (row + 0.5) * cell;
        crossings.length = 0;
        for (let at = 0, previous = points.length - 1; at < points.length; previous = at++) {
          const a = points[at]!;
          const b = points[previous]!;
          if (a.y > y === b.y > y) continue;
          crossings.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
        }
        crossings.sort((left, right) => left - right);
        for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
          const from = Math.max(0, Math.ceil(crossings[pair]! / cell - 0.5));
          const to = Math.min(columns - 1, Math.floor(crossings[pair + 1]! / cell - 0.5));
          for (let column = from; column <= to; column += 1) inside[row * columns + column] = 1;
        }
      }
    }
    return new ScreenMask(cell, columns, rows, inside);
  }

  private slot(x: number, y: number): number {
    const column = Math.min(this.columns - 1, Math.max(0, Math.floor(x / this.cell)));
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cell)));
    return row * this.columns + column;
  }

  contains(x: number, y: number): boolean {
    return this.insideCells[this.slot(x, y)] === 1;
  }

  /** Pixels to the outline: negative inside the shape, positive outside. */
  signedDistance(x: number, y: number): number {
    return this.signed[this.slot(x, y)]!;
  }

  /** True when the shape covered no cells at all (a stray click, say). */
  get isEmpty(): boolean {
    return !this.insideCells.includes(1);
  }
}

/**
 * Two chamfer passes per side: distance to the nearest inside cell for outside cells, and
 * the other way round for inside cells, combined into one signed field in pixels.
 */
function signedDistanceField(
  inside: Uint8Array,
  columns: number,
  rows: number,
  cell: number,
): Float32Array {
  const outward = chamfer(inside, columns, rows, 1);
  const inward = chamfer(inside, columns, rows, 0);
  const signed = new Float32Array(inside.length);
  for (let at = 0; at < inside.length; at += 1)
    signed[at] = (inside[at] === 1 ? -inward[at]! : outward[at]!) * cell;
  return signed;
}

/** Distance in cells from every cell to the nearest cell whose mask value is `target`. */
function chamfer(mask: Uint8Array, columns: number, rows: number, target: number): Float32Array {
  const distance = new Float32Array(mask.length);
  for (let at = 0; at < mask.length; at += 1)
    distance[at] = mask[at] === target ? 0 : Number.POSITIVE_INFINITY;
  const relax = (at: number, from: number, weight: number): void => {
    const candidate = distance[from]! + weight;
    if (candidate < distance[at]!) distance[at] = candidate;
  };
  for (let row = 0; row < rows; row += 1)
    for (let column = 0; column < columns; column += 1) {
      const at = row * columns + column;
      if (distance[at] === 0) continue;
      if (column > 0) relax(at, at - 1, ORTHOGONAL);
      if (row > 0) {
        relax(at, at - columns, ORTHOGONAL);
        if (column > 0) relax(at, at - columns - 1, DIAGONAL);
        if (column + 1 < columns) relax(at, at - columns + 1, DIAGONAL);
      }
    }
  for (let row = rows - 1; row >= 0; row -= 1)
    for (let column = columns - 1; column >= 0; column -= 1) {
      const at = row * columns + column;
      if (distance[at] === 0) continue;
      if (column + 1 < columns) relax(at, at + 1, ORTHOGONAL);
      if (row + 1 < rows) {
        relax(at, at + columns, ORTHOGONAL);
        if (column + 1 < columns) relax(at, at + columns + 1, DIAGONAL);
        if (column > 0) relax(at, at + columns - 1, DIAGONAL);
      }
    }
  return distance;
}
