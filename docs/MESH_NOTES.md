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
   layer), or the grid when nothing is hit. Segment lengths are shown live. **Ortho**
   (`ModelSettingsStore.orthoActive` = the setting XOR Shift held) keeps polyline segments
   axis-aligned (the larger in-plane delta wins) and snaps gizmo rotations to 15° steps
   (`Viewer.setRotationSnap`). **Typed dimensions** (Rhino-style): after the first point, digits
   go into a buffer shown next to the cursor; `constrain()` then uses the cursor only for the
   direction (polyline: segment length; circle/polygon: radius; rectangle: width then depth —
   `Enter` between them or `2,1.5`, the cursor picks the quadrant and any untyped dimension).
   Enter accepts the buffer and places the point once every dimension is known; Backspace edits
   the buffer before it removes points; Escape clears it. The key handler runs in the capture
   phase so digits never reach the 1/3/7 view shortcuts. Closing the outline (double-click /
   Enter / first point, or the second click of a two-click shape) creates a `mesh` layer whose
   solid is a flat **face** (`makeFace`): `SolidData.face = { polygon, normal }` in layer-local
   coordinates, re-originned on the outline's centroid, rendered translucent and double-sided
   with lime edges (`Layer.setSolid`). The tool then switches to Select with the new face selected.
2. **Extrude** (`mesh/ExtrudeGizmo.ts`): when a single unlocked face layer is selected in the
   Select tool, an arrow sits on the face (or on top of its pending extrusion) along its
   **world** normal (the layer's rotation applied to `face.normal`). Dragging pulls the
   extrusion with a live preview; releasing records one `SetSolid` step
   (`model/meshCommands.ts`) that leaves the face *unconfirmed*: `SolidData.face` stays set and
   `faceHeight` holds the pulled height (`pendingExtrusion`), so the arrow stays attached and
   further pulls / the MODEL height field adjust it (each an undo step; the pending state is
   saved in the project). **Confirm** (button or Enter) replaces it with `extrudeFace(face,
   height)` — a final mesh with `source = { kind: 'extrude', face, height }` and no `face`;
   **Reset** flattens it. Extrusion is along the face normal in layer space, so rotating the
   face 90° about X first gives a horizontal extrusion. Caps via ear clipping
   (`ShapeUtils.triangulateShape`) in the face's plane basis, outward-facing for either
   winding/direction (tested via signed volume).
3. **Scaling** a mesh layer with the gizmo's axis handles (non-uniform) previews on the
   three.js object and is baked by `ScaleSplats` → `scaleSolid`: faces and pending extrusions
   are rebuilt from their scaled outline (normal via the inverse transpose, height scaled along
   the normal) so they stay editable; confirmed meshes get their vertices scaled (winding fixed
   for mirroring; the extrude `source` survives only uniform scales). Uniform scales stay on
   the object transform like any layer. The gizmo shows the angle / factor / distance while
   dragging (`LayerGizmo.onReadout` → `gizmo-readout` → overlay badge).

## Not yet

Editing an existing outline/height after extruding (the source is stored for that),
non-horizontal construction planes (rotate the face instead), snapping to splat surfaces while drawing (lengths are exact, the plane
is horizontal), sketching strokes *on* a mesh surface (the depth image only sees splats).
