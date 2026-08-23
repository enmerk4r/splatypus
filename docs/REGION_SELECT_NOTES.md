# Region selection — free-form, depth-aware, boundary-snapping (2026-08-22)

## Why

The connectivity bake is a **patch** segmenter (see `SEGMENTATION_NOTES.md`): on the butterfly
it labels 55 groups covering 12 % of the splats. Every screen-space selection went through it —
`ScreenSelection.finish()` called `Segmentation.selectProjected()`, which asked *"which groups
own the splats under this shape?"* and then selected those groups whole. So a lasso could only
ever return baked patches: it missed the 88 % of splats no group owned, and whatever it did
catch dragged a whole patch in with it. The boundary was never the object's boundary.

The fix is to stop routing hand-drawn selections through the bake, and to give the shape the
two things a screen shape cannot know on its own: **which splats are in front**, and **where
the object actually ends**.

## The three stages

A drawn shape (lasso, rectangle, polygon) runs:

1. **Gather** — the layer's live centres are projected once (`sketch/screenIndex.ts`, shared
   with the brushes) and tested against the shape.
2. **Depth gate** (`select/frontDepth.ts`) — an 8 px-cell depth buffer over the projected
   splats; a splat is kept only if it is within a tolerance of its cell's front surface. A cell
   with enough splats reports its **third** nearest rather than its nearest, so one floater
   cannot pull the window towards the camera. Measured on the sample scene: a 120 px lasso
   selects 116 049 splats ungated and 71 698 gated — the 38 % difference is the background
   behind the object, which is the single biggest reason a selection would not cut out cleanly.
3. **Snap** (`select/geodesic.ts`) — splats more than `band` px inside the shape are held as
   foreground, more than `band` px outside as background, and the strip between goes to
   whichever side is closer *through the cloud*. Distance is
   `(edge length / spacing) × (1 + colourWeight × Δcolour)`, so crossing a colour edge is
   expensive and the boundary settles on it: a magnetic lasso in 3D. Both sides must be seeded
   or the function returns the foreground untouched — one front unopposed would swallow
   everything.

**Magic wand** skips the tracing: one click seeds `geodesicFlood`, which grows while the budget
lasts. On the sample scene, budget 30 → 0.2 % of the cloud, 250 → 8 % (the default, about one
object), 1500 → 96 %.

## The graph

Everything boundary-aware walks a k-nearest-neighbour graph (`select/neighbourGraph.ts`,
fixed stride 8, CSR-ish typed arrays). The link radius is **measured, not configured**: the
median nearest-neighbour distance over an even sample is the cloud's own unit of "one splat
apart", and every threshold is a multiple of it, so the tools behave the same in metres or in
arbitrary units.

The radius multiple matters more than it looks. Measured on 262 k splats:

| radiusScale | build | avg degree | isolated | components | biggest |
| --- | --- | --- | --- | --- | --- |
| 2.2 | 451 ms | 4.23 | 11.1 % | 41 801 | 21.8 % |
| **4** | **578 ms** | **7.36** | **1.7 %** | **6 471** | **95.9 %** |
| 6 | 814 ms | 7.87 | 0.5 % | 3 343 | 98.3 % |

At 2.2 the graph is shattered and every walk on it is useless — the first wand click grew to a
single splat. 4 is the default. The full-layer graph is cached on `RegionSelection` and dropped
on the layer's `synced`; building it is announced with a toast and deferred by a timeout, the
same pattern the bake uses. Above 600 k live splats the smart tools decline
(`GraphTooLargeError`) rather than freeze the tab.

The snap builds a *subset* graph over just the band, which is why it stays interactive; the
wand and the refinements need the whole layer.

## Refining

`RegionSelection` is a mask over store indices, not a set of groups. On top of it:

- **Selection brush** — paints splats in live (Alt paints them out), depth-gated, no snap: it
  is the tool you reach for to fix what the clever ones got wrong, so it does exactly what the
  hand says. Shift adds and Alt subtracts on every method.
- **One-shot tools** — a method drops back to the pointer as soon as a selection lands
  (`RegionTool.revert()`, announced as `mode-changed` so the toolbar follows). While a method is
  armed it swallows left-drag, so without this you cannot look at what you just selected without
  first disarming the tool by hand. A gesture that selects nothing leaves the tool armed.
- **Grow / Shrink** — one graph hop. Both walk *out* from the selected nodes: nearest-neighbour
  links are not symmetric, and reading the rim from the other side would let a distant splat
  that merely happens to list a selected one as its neighbour jump in.
- **Clean up** / **Keep largest** — connected components over the selection, dropping pieces
  below `minIslandSplats` (40) or all but the biggest. This is how the floaters a screen-space
  selection inevitably drags in are shed in one click.
- **Split to layer** — the existing `SplitSplats`, which already took arbitrary indices;
  `Segmentation.splitSelection()` prefers the region over a group selection when both exist.
  Undoable, and the new layer is where the eraser and the brushes then work.

## Surface patches (the segmentation mask view)

Being able to *see* where the boundaries are matters as much as snapping to them, but turning
the existing overlay on gave a scatter of coloured specks: the connectivity bake matches cells
that happen to agree, so it leaves 88 % of the butterfly in no group.

`select/superpixels.ts` partitions instead. Seeds are spread evenly through the cloud (uniform
grid buckets, cell size found by bisection because occupancy grows differently on a surface
than in a volume), `geodesicPartition` runs K competing fronts over the same graph and the same
colour-aware cost, one Lloyd step recentres the seeds on their patch centroids, and the whole
thing runs again. Components no seed reached become their own patches; then one rule applies to
all of them — under 8 splats is not a patch, its splats stay unassigned — which drops both the
unreached fragments and the lone floaters that grabbed a seed of their own.

Butterfly, 177 k splats: **185 patches at 99.8 % coverage in 232–855 ms** (Detail 2; the spread
is whether the graph was already built), versus 55 groups at 11.7 % in 2 614 ms for the
connectivity bake. It is exposed as a `BakeBasis` rather than a new subsystem, so the overlay,
the blend slider, group click-select and split all work on it unchanged.

With a region selected the mask dims to 35 % outside it (`UNSELECTED_DIM`): a lime tint is
invisible against random patch colours, and dimming keeps the patch borders readable, which is
the whole reason to have the mask up while selecting. The dim rule only changes when a selection
appears or disappears, so only those transitions repaint the whole layer — a growing selection
still repaints just the splats that moved.

## Measured in Chrome (headless, ANGLE Metal, 262 k splats)

Wand 23 492 splats; lasso 120 px radius: 71 698 gated / 70 647 gated + snapped / 116 049 raw;
brush subtract ~12 k in one stroke; Clean up 4 749 islands dropped in 9 ms; Grow/Shrink 4–5 ms;
Keep largest 8 ms; Split 167 ms; undo restores the layer exactly. Flood itself is 3–83 ms
depending on budget — the 578 ms one-off graph build dominates the first interaction.

## Not done

- The graph build is main-thread. A worker would remove the only visible stall.
- No SAM2 (or other ML) bridge: `PLAN.md` lists it as a stretch, and the geometric path needs
  no model download. Its mask would drop into the same `RegionSelection`, gated by the same
  `FrontDepth`, so the plumbing is already the right shape.
- The region is a view-level selection with no undo of its own (matching group selection);
  only the split it feeds is undoable.
- Layers rendered through the LoD tree (≥ 1.5 M splats) do not show the highlight, as with
  every other tint — and they are over the graph limit anyway.
