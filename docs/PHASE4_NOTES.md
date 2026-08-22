# Phase 4 — Edit brushes (2026-08-22, Claude)

Brushes edit the **active layer** (falls back to the only layer) through the same
screen-space ring as the pen and eraser: the cursor size is in pixels (`[`/`]`), the view is
locked while the mouse is down, and one gesture is one undo step.

| Tool | Key | What one pass does to a splat under the ring (weight = falloff × pressure) |
| --- | --- | --- |
| Erase | `X` | hides it (alive = 0) — see the eraser note in PHASE3_NOTES |
| Recolor | `C` | colour ← lerp(colour, brush colour, strength × weight) — brush colour = SKETCH colour |
| Fade | `D` | opacity ← opacity × (1 − strength × weight); **Shift** restores towards 1 |
| Grab | `V` | splats captured under the ring at pointer-down follow the pointer along the screen plane; displacement = pixels × world-per-pixel at the splat's depth × strength × weight |
| Inflate | `I` | scales ← scales × (1 + strength × weight); **Shift** shrinks (÷) |

Strength (5–100 %, default 50 %) and **Soft brush edge** (quadratic falloff vs hard disc) live
in the SKETCH panel next to the shared colour/size.

## How it works

- `sketch/screenIndex.ts` — at pointer-down the active layer's live centres are projected
  once (pixels + view depth) into a 16 px bucket grid; each pointer segment only sweeps the
  cells it crosses (`sweep`), reporting the normalised distance for the falloff. Shared by
  the eraser (`EraseBrush`) and the attribute brushes (`SplatBrush`).
- Live preview writes straight into the packed GPU cache (`utils.setPackedSplatRgb /
  Opacity / Scales / Center`, then `needsUpdate` + `mesh.updateVersion()`); the store is
  untouched until release.
- Release pushes `EditSplats` (`model/brushCommands.ts`): new values for the touched indices,
  previous values captured on first `do`, exact undo; centre edits invalidate bounds and the
  pick grid; the layer resyncs.
- Weights: a splat is edited once per gesture with the strongest weight seen (sweeping back
  over it does not compound). Grab applies the current pointer delta to the captured set.

## Measured (Chrome, RTX 5070 Ti, butterfly 177 k, 80 px ring)

Recolor / Fade / Inflate swipe of ~50 k splats: ~220–260 ms for the whole gesture incl. the
20 ms index and the commit resync; Grab of 30 k splats: 54 ms capture, 40 moves in 103 ms,
109 ms commit. Five undos restore colours, opacities, centres and scales bit-exactly.

## Not in this phase

Smooth (Laplacian on neighbours — needs the 3D voxel grid per pass), depth-aware brushes
(everything under the ring is hit regardless of depth — intentionally Photoshop-like),
brushes on LoD layers preview only after commit (Spark renders its LoD copy).

## Measure / scale-to-reference (same day)

`sketch/MeasureTool.ts` (`M`): two picks on the active layer (`pickLayer` restricted to that
layer, nearest-projected fallback), a live overlay line/label (re-projected every frame via
the new Viewer `frame` event, so orbiting between clicks is fine), a popover prefilled with
the measured distance; submitting pushes one `SetLayerTransform` — uniform scale about the
first point (`scaleAboutWorldPoint`, unit-tested under the rotated root). Units are scene
units shown as mm/cm/m.
