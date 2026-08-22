# Mesh layers (2026-08-22, Claude)

Meshes and splats share the scene: Spark's splat pass depth-tests against the three.js
depth buffer (and writes none), so opaque meshes occlude splats behind them and splats
in front blend over them. A mesh tucked behind a thin splat surface can bleed through a
little — acceptable for "the new duct under this ceiling".

## Model

- `LayerKind` gains `mesh`. A mesh layer keeps an **empty** `SplatStore` (so every
  store-based path — picking grid, brushes, segmentation, stats — degrades to "nothing")
  plus `Layer.solid: SolidData { positions, indices, colour, source? }` rendered as a
  `MeshLambertMaterial` (flat shaded, edge lines) child of `layer.object`. The Viewer now
  has a hemisphere + key light (lights don't affect splats).
- `Layer.localBounds()` returns the solid's box for mesh layers; `Document.getRobustBounds`,
  snap-to-floor, array step and framing use it. `Layer.setShown()` drives visibility/solo for
  both render objects. `pickLayer` raycasts solids too, so click-select, the gizmo (incl.
  non-uniform scale — meshes don't have Spark's uniform-scale limit), duplicate, delete,
  solo, floor and undo all work unchanged.
- **Export**: the standard PLY writer samples each solid's surface into flat gaussians
  (`mesh/solid.ts` → `meshToSplats`: one per ~spacing², σ = 0.6 × spacing, thin axis along
  the face normal, spacing ≈ size/120 ≥ 5 mm, seeded so exports are repeatable).
  **Merge** into a splat layer converts the same way. The Splatypus project format stores
  the triangle mesh itself (positions, indices, colour, authoring source) so meshes stay
  meshes across save/load.

## Authoring: Polyline → extrude (`P`)

Click an outline on a horizontal construction plane — its height is taken from the surface
under the first click (any visible layer), or the grid when nothing is hit. Segment lengths
are shown live; Shift snaps segments to 45° steps; Backspace removes the last point; close
with a double-click, Enter, or a click on the first point; then type the height (negative
extrudes downwards) → a capped `mesh` layer in the SKETCH colour, re-originned on the
outline's centroid, one undo step. Caps via ear clipping (`ShapeUtils.triangulateShape`),
outward-facing for either winding/direction (tested via signed volume).

## Not yet

Editing an existing outline/height (the source is stored for that), non-horizontal
construction planes, snapping to splat surfaces while drawing (lengths are exact, the plane
is horizontal), sketching strokes *on* a mesh surface (the depth image only sees splats).
