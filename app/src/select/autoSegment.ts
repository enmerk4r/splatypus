import { bestChannel, cropLowResMask } from '../ai/maskDecode';
import type { SamSession } from '../ai/samSession';
import type { Layer } from '../model/Layer';
import { DepthGrid } from '../sketch/depthGrid';
import { ScreenIndex } from '../sketch/screenIndex';
import { GroupMap, UNASSIGNED } from '../splats/groups';
import type { GroupInfo } from '../splats/groups';
import type { Viewer } from '../viewer/Viewer';

/**
 * "Segment everything": decompose the visible scene into objects without the user clicking
 * each one.
 *
 * This is SAM's automatic mask generation, adapted. Instead of one prompt from a click, a
 * grid of points is sampled over the view and every one is run through the mask decoder;
 * whatever survives filtering and deduplication becomes a group. It is affordable only
 * because the decoder is the cheap half of SAM and accepts a batch of prompts against one
 * cached image embedding — see `SamSession.segmentBatch`.
 *
 * Deduplication happens in **3D, not 2D**. Two prompts that landed on the same chair
 * produce different-looking 2D masks but nearly the same splats, and comparing splat sets
 * is both the cheaper test and the one that matches what a group means here. Each proposal
 * claims only splats no earlier one took, so the result is a partition — which is what
 * `GroupMap` can represent.
 */

export interface AutoSegmentSettings {
  /** Points per side of the sampling grid; 16 → 256 prompts. */
  density: number;
  /** Reject a proposal covering more of the layer than this — that is the background. */
  maxCoverage: number;
  /** Drop groups smaller than this many splats. */
  minSplats: number;
  /** Skip a proposal this much of which is already claimed by a bigger one. */
  maxOverlap: number;
  /** Depth-projection tolerance in scene units; `Infinity` for frustum projection. */
  depthTolerance: number;
  minOpacity: number;
}

export const DEFAULT_AUTO_SETTINGS: Omit<AutoSegmentSettings, 'depthTolerance' | 'minOpacity'> = {
  density: 16,
  maxCoverage: 0.5,
  minSplats: 80,
  maxOverlap: 0.5,
};

/** Prompts per decoder call. Bounds peak memory: each holds `channels × 256² floats`. */
const BATCH = 24;

export interface AutoSegmentResult {
  groups: GroupMap;
  /** Masks SAM proposed, before filtering. */
  proposals: number;
  /** Groups kept. */
  kept: number;
  /** Fraction of the layer's live splats that ended up in some group. */
  coverage: number;
}

export interface AutoSegmentProgress {
  done: number;
  total: number;
  message: string;
}

/**
 * Projects every live splat once, resolving it to a cell of the low-resolution mask grid
 * and applying the depth test — so each of the hundreds of candidate masks costs one array
 * lookup per splat instead of a fresh projection.
 *
 * Every candidate shares these dimensions, which is what makes the cache reusable and is
 * the difference between this running in a second and running in a minute.
 */
function projectToMaskCells(
  layer: Layer,
  index: ScreenIndex,
  front: DepthGrid | undefined,
  maskWidth: number,
  maskHeight: number,
  viewWidth: number,
  viewHeight: number,
  depthTolerance: number,
  minOpacity: number,
): Int32Array {
  const { store } = layer;
  const scaleX = maskWidth / Math.max(viewWidth, 1);
  const scaleY = maskHeight / Math.max(viewHeight, 1);
  const testDepth = front !== undefined && Number.isFinite(depthTolerance);
  const cells = new Int32Array(store.count).fill(-1);

  for (let splat = 0; splat < store.count; splat += 1) {
    if (!store.alive[splat]) continue;
    if ((store.opacities[splat] ?? 1) < minOpacity) continue;
    const px = index.px[splat]!;
    if (Number.isNaN(px)) continue;
    const py = index.py[splat]!;
    const column = Math.round(px * scaleX);
    const row = Math.round(py * scaleY);
    if (column < 0 || row < 0 || column >= maskWidth || row >= maskHeight) continue;
    if (testDepth) {
      const surface = front.depthAt(px, py);
      if (surface !== undefined && index.depth[splat]! > surface + depthTolerance) continue;
    }
    cells[splat] = row * maskWidth + column;
  }
  return cells;
}

/** Grid of prompt points in canvas CSS pixels, inset so none sits on the frame edge. */
export function samplePoints(
  width: number,
  height: number,
  density: number,
): { x: number; y: number }[] {
  const side = Math.max(2, Math.round(density));
  const points: { x: number; y: number }[] = [];
  for (let row = 0; row < side; row += 1)
    for (let column = 0; column < side; column += 1)
      points.push({
        x: ((column + 0.5) / side) * width,
        y: ((row + 0.5) / side) * height,
      });
  return points;
}

export interface Proposal {
  indices: Uint32Array;
  score: number;
}

/**
 * Turns overlapping mask proposals into a flat partition of the splats.
 *
 * **Smallest first.** SAM returns part, subpart and whole for the same point, and among
 * hundreds of grid prompts some masks are confidently over-inclusive — a blob spanning two
 * objects and the floor between them. Letting the largest claim first hands those splats to
 * the blob and the real objects never get a chance; letting the tightest mask claim first
 * pins each object, and the blob is left with scraps that `minSplats` then discards.
 *
 * Measured on a four-object test scene: largest-first found 3 groups, one of them 51 % on
 * the wrong object and one object missing entirely. Smallest-first found all 4, each
 * 99–100 % on its own object.
 *
 * The cost is over-segmentation — a chair leg can become its own group before the chair
 * does. That is recoverable (shift-click unions groups); a blob that swallowed two objects
 * is not.
 */
export function partitionProposals(
  proposals: readonly Proposal[],
  count: number,
  live: number,
  settings: Pick<AutoSegmentSettings, 'maxCoverage' | 'minSplats' | 'maxOverlap'>,
): { ids: Uint32Array; groups: GroupInfo[]; assigned: number } {
  const ordered = [...proposals]
    .filter((proposal) => proposal.indices.length / Math.max(live, 1) <= settings.maxCoverage)
    .sort((a, b) => a.indices.length - b.indices.length);

  const ids = new Uint32Array(count).fill(UNASSIGNED);
  const groups: GroupInfo[] = [];
  let assigned = 0;
  for (const proposal of ordered) {
    let taken = 0;
    for (const splat of proposal.indices) if (ids[splat] !== UNASSIGNED) taken += 1;
    if (taken / proposal.indices.length > settings.maxOverlap) continue;
    const free = proposal.indices.length - taken;
    if (free < settings.minSplats) continue;
    const id = groups.length;
    for (const splat of proposal.indices) if (ids[splat] === UNASSIGNED) ids[splat] = id;
    groups.push({ id, name: `Object ${id + 1}`, count: free });
    assigned += free;
  }
  return { ids, groups, assigned };
}

export async function autoSegment(
  layer: Layer,
  viewer: Viewer,
  session: SamSession,
  settings: AutoSegmentSettings,
  onProgress?: (progress: AutoSegmentProgress) => void,
): Promise<AutoSegmentResult | undefined> {
  if (!session.hasImage) return undefined;
  const canvas = viewer.canvasElement;
  const viewWidth = canvas.clientWidth;
  const viewHeight = canvas.clientHeight;
  const valid = session.validMaskSize;
  if (valid.width === 0 || valid.height === 0) return undefined;

  const document = viewer.document;
  const index = new ScreenIndex(layer, viewer, viewWidth, viewHeight);
  const front =
    document && Number.isFinite(settings.depthTolerance)
      ? DepthGrid.build(document, viewer.camera, viewWidth, viewHeight)
      : undefined;
  const cells = projectToMaskCells(
    layer,
    index,
    front,
    valid.width,
    valid.height,
    viewWidth,
    viewHeight,
    settings.depthTolerance,
    settings.minOpacity,
  );

  const live = Math.max(layer.store.liveCount(), 1);
  const points = samplePoints(viewWidth, viewHeight, settings.density);
  const proposals: Proposal[] = [];
  const scratch = new Uint32Array(layer.store.count);

  for (let from = 0; from < points.length; from += BATCH) {
    const batch = points.slice(from, from + BATCH);
    onProgress?.({
      done: from,
      total: points.length,
      message: `Proposing objects… ${Math.round((from / points.length) * 100)}%`,
    });
    const result = await session.segmentBatch(batch);
    if (!result) break;

    for (let prompt = 0; prompt < result.prompts; prompt += 1) {
      const channel = bestChannel(result.scores, prompt, result.channels);
      const score = result.scores[prompt * result.channels + channel] ?? 0;
      const mask = cropLowResMask(
        result.logits,
        result.side,
        prompt,
        channel,
        result.channels,
        valid,
      );
      let found = 0;
      for (let splat = 0; splat < cells.length; splat += 1) {
        const cell = cells[splat]!;
        if (cell >= 0 && mask.data[cell]) {
          scratch[found] = splat;
          found += 1;
        }
      }
      if (found === 0) continue;
      proposals.push({ indices: scratch.slice(0, found), score });
    }
    // Yield so the progress toast actually paints between batches.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  onProgress?.({ done: points.length, total: points.length, message: 'Merging duplicates…' });
  const { ids, groups, assigned } = partitionProposals(
    proposals,
    layer.store.count,
    live,
    settings,
  );

  return {
    groups: GroupMap.fromIds(ids, {
      numSplats: layer.store.count,
      numGroups: groups.length,
      source: 'sam (automatic)',
      groups,
    }),
    proposals: proposals.length,
    kept: groups.length,
    coverage: assigned / live,
  };
}
