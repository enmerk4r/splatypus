import type { MaskImage } from '../select/maskLift';

/**
 * Turning SAM's raw output into something the rest of the app understands.
 *
 * Pure on purpose: `samSession.ts` may not run under vitest (it pulls in ONNX Runtime and
 * the network), so every decision that could be wrong — which candidate wins, how a tensor
 * unpacks, where a click lands in image space — lives here instead, where it is testable.
 */

export interface MaskCandidates {
  /** One mask per SAM output channel, at the resolution of the image it was given. */
  masks: MaskImage[];
  scores: number[];
  /** Index of the highest-scoring candidate. */
  best: number;
}

/**
 * Unpacks a post-processed `pred_masks` tensor.
 *
 * `post_process_masks` returns one tensor per batch entry, shaped
 * `[batch, channels, height, width]` and already binarised. SAM predicts several nested
 * interpretations of the same prompt — typically part, subpart and whole — so all channels
 * are kept and the caller decides; that ambiguity is a feature the user should see, not
 * something to average away.
 */
export function decodeMasks(
  data: Uint8Array,
  dims: readonly number[],
  scores: ArrayLike<number>,
): MaskCandidates {
  const [, channels, height, width] = [dims[0] ?? 1, dims[1] ?? 1, dims[2] ?? 0, dims[3] ?? 0];
  const plane = height * width;
  const masks: MaskImage[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    const from = channel * plane;
    masks.push({
      data: data.slice(from, from + plane),
      width,
      height,
    });
  }
  const list = Array.from({ length: Math.min(channels, scores.length) }, (_, i) => scores[i] ?? 0);
  return { masks, scores: list, best: bestCandidate(list) };
}

/** Index of the highest score, or 0 when there is nothing to compare. */
export function bestCandidate(scores: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < scores.length; i += 1) if ((scores[i] ?? 0) > (scores[best] ?? 0)) best = i;
  return best;
}

/** Number of set pixels — used to reject a prompt that collapsed to nothing. */
export function maskArea(mask: MaskImage): number {
  let area = 0;
  for (const pixel of mask.data) if (pixel) area += 1;
  return area;
}

export interface PromptPoint {
  /** Canvas CSS pixels, as pointer events report them. */
  x: number;
  y: number;
  positive: boolean;
}

/**
 * Converts click points from canvas CSS pixels into the captured image's pixel space,
 * which is what the processor expects and what `post_process_masks` maps back to.
 */
export function pointsToImageSpace(
  points: readonly PromptPoint[],
  scaleX: number,
  scaleY: number,
): { points: number[][]; labels: number[] } {
  return {
    points: points.map((point) => [point.x * scaleX, point.y * scaleY]),
    labels: points.map((point) => (point.positive ? 1 : 0)),
  };
}

/**
 * Extracts one candidate from a batched low-resolution logit block, keeping only the
 * image-bearing corner.
 *
 * The decoder writes into a padded square, so a non-square view leaves the right or bottom
 * of the raw mask as padding. Cropping to `valid` makes the result correspond 1:1 to the
 * captured frame again, which is what lets `liftMask` scale it by width alone.
 *
 * A logit above zero is inside the mask — the same threshold `post_process_masks` uses.
 */
export function cropLowResMask(
  logits: Float32Array,
  side: number,
  prompt: number,
  channel: number,
  channels: number,
  valid: { width: number; height: number },
): MaskImage {
  const width = Math.max(1, Math.min(valid.width, side));
  const height = Math.max(1, Math.min(valid.height, side));
  const base = (prompt * channels + channel) * side * side;
  const data = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const from = base + row * side;
    const to = row * width;
    for (let column = 0; column < width; column += 1)
      if (logits[from + column]! > 0) data[to + column] = 1;
  }
  return { data, width, height };
}

/** Index of the best-scoring channel for one prompt in a batched score block. */
export function bestChannel(scores: ArrayLike<number>, prompt: number, channels: number): number {
  let best = 0;
  for (let channel = 1; channel < channels; channel += 1)
    if ((scores[prompt * channels + channel] ?? 0) > (scores[prompt * channels + best] ?? 0))
      best = channel;
  return best;
}
