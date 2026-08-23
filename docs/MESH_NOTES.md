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

## Authoring: draw a face, then extrude (`P`)

Drawing and extruding are separate steps.

1. **Outline** (`mesh/PolylineTool.ts`): shapes from the MODEL panel (`mesh/settings.ts`,
   persisted in localStorage) — freeform polyline, rectangle (two corners), regular polygon
   (centre + radius, N sides) and circle (centre + radius, 64 sides). Drawn on a horizontal
   construction plane whose height is taken from the surface under the first click (any visible
   layer), or the grid when nothing is hit. Segment lengths are shown live. **Ortho** keeps
   polyline segments axis-aligned (the larger in-plane delta wins); holding Shift inverts the
   setting while held. Closing the outline (double-click / Enter / first point, or the second
   click of a two-click shape) creates a `mesh` layer whose solid is a flat **face**
   (`makeFace`): `SolidData.face = { polygon, normal }` in layer-local coordinates, re-originned
   on the outline's centroid, rendered translucent and double-sided with lime edges
   (`Layer.setSolid`). The tool then switches to Select with the new face selected.
2. **Extrude** (`mesh/ExtrudeGizmo.ts`): when a single unlocked face layer is selected in the
   Select tool, an arrow sprouts from the face centroid along its **world** normal (the layer's
   rotation applied to `face.normal`). Dragging the arrow extrudes by eye with a live preview;
   releasing commits one `SetSolid` command (`model/meshCommands.ts`) so undo brings the face
   back. The MODEL panel's height field (+ **Extrude face** / Enter) runs the same command
   numerically; negative heights extrude the other way. `extrudeFace(face, height)` builds the
   capped solid along the face normal in layer space — so rotating the face 90° about X first
   gives a horizontal extrusion — and records `source = { kind: 'extrude', face, height }`.
   Caps via ear clipping (`ShapeUtils.triangulateShape`) in the face's plane basis,
   outward-facing for either winding/direction (tested via signed volume).

## Not yet

Editing an existing outline/height after extruding (the source is stored for that),
non-horizontal construction planes (rotate the face instead), snapping to splat surfaces while drawing (lengths are exact, the plane
is horizontal), sketching strokes *on* a mesh surface (the depth image only sees splats).
