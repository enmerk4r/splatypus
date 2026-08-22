# Segmentation & editing tools — integration notes (2026-08-22)

## Where this came from

A teammate built segmentation and object-editing tools on `origin/segmentation`
(12 commits, ~3,900 lines) on top of the **Phase 1** code: a single Spark `SplatMesh`
wrapped by `SplatDocument`, with edits written into Spark's packed (quantised) arrays
and split objects held as separate `SplatMesh`es outside the document.

`main` had meanwhile landed Phase 2, which replaced exactly that layer: `Document` /
`Layer` / float32 `SplatStore` as the source of truth, commands with undo, a layers
panel, a gizmo, and a PLY writer that reads the store. A trial merge produced 9
conflicting files, including a delete/modify conflict on `SplatDocument.ts`, and — more
to the point — her runtime code (`Segments.ts`, `CropBox`, `GroupOverlay`, her
`main.ts`/`Viewer.ts`/UI shell, ~2,500 lines) calls APIs that no longer exist
(`document.mesh`, `document.centres`, `pickSplat`, `tint/hide/restore`,
`viewer.attach/detach`). Resolving the merge would have meant rewriting most of it, so
the branch was **not merged**. Instead the functionality was re-implemented on the
Phase 2 model, and the pure modules were taken verbatim.

## What was taken verbatim

| File | Role |
| --- | --- |
| `app/src/splats/groupsFormat.ts`, `groups.ts` | `.groups` sidecar constants and `GroupMap` (parse, inverted index, coverage) |
| `app/src/splats/bakeConnectivity.ts` | voxel connected components constrained by colour similarity (shared by the CLI and the in-app bake) |
| `app/src/spatial/VoxelGrid.ts` | CSR voxel hash grid for nearest-centre picking (+ an `accept` predicate added so dead splats are skipped) |
| `app/src/select/groupPalette.ts` | golden-ratio group palette, unassigned colour |
| `app/src/io/loadGroups.ts` | sidecar loading (`file`/`url`, implied `scan.groups` next to `scan.ply`) |
| `tools/bake-connectivity.mjs` | CLI baker over a binary 3DGS PLY |
| `docs/GROUPS_FORMAT.md` | format spec (index-alignment section rewritten for the store model) |

## What was re-implemented, and how it maps

| Her branch (Phase 1 model) | `main` (Phase 2 model) |
| --- | --- |
| `SplatDocument.centres/colours/opacities` mirrored from `forEachSplat` (quantised) | the layer's `SplatStore` (float32, already the truth) — no mirror needed |
| `SplatDocument.pickSplat` (VoxelGrid over the mirror) | `Layer.pickGrid` / `Layer.pickSplat` (lazy grid over store centres, skips dead splats, prefers assigned splats when picking a group) |
| `tint` / `hide` / `restore` / `paintBy` writing Spark packed data with snapshots | `viewer/paint.ts`: display colours written into the packed GPU cache only, via `Layer.storeToPacked()`; the store is never touched, so "restore" is just repainting from the store. Hiding is the existing `alive` mask → resync |
| `Segments` (selection, hover, split into a separate `SplatMesh`, nested groups, isolate, snap to floor, duplicate/array, merge back, delete) | `select/Segmentation.ts` (selection/hover/overlay/bake per layer) + commands in `model/segmentCommands.ts`: `SplitSplats` (re-originned on the centroid, undoable), `SetSplatsAlive`, `CompositeCommand`, `ArrayLayer`, `snapToFloorCommand`; `Document.setSolo` for isolate. Duplicate/merge/delete/rename/hide were already Phase 2 commands — "merge back" is `MergeLayers` of the segment with its source |
| `GroupOverlay` (whole-scene label paint, blend) | `Segmentation.setOverlay/setBlend`, re-applied on each layer's `synced` event |
| `CropBox` hiding via opacity snapshots | `select/CropBox.ts`: same unit-cube gizmo; applying pushes one `CompositeCommand` of `SetSplatsAlive` across visible unlocked layers (Ctrl+Z undoes) |
| her `exportPly` (forEachSplat, lossy, drops hidden) | Phase 2 writer already drops dead splats and bakes transforms, full precision |
| `library` / `inspector` / bottom `toolbar` shell | bottom object toolbar (`ui/toolbar.ts`, her icons verbatim: split, move/rotate/scale, duplicate, array, merge, isolate, floor, delete), SEGMENT panel in the right rail (segment by, detail, labels, blend, status, split/clear, crop), `SOLO`/`FLOOR`/`×5` in the LAYERS toolbar, hover label next to the cursor |
| `.groups` sidecar on `?url=`, `?groups=`, drop | same; a dropped `.groups` attaches to the active (or only) layer and must match its store count |
| `probe.html` / `make-index-probe.mjs` (does Spark preserve file order?) | not needed: our decoder defines the order, so index alignment holds by construction |

**Not ported:** nested groupings (`Group`/`Ungroup` — our layer list is flat; `MergeLayers`
covers "move together" by baking), the inspector's numeric position fields, the
collapsible library/inspector panel shell. `.groups` export from an in-app bake is a small follow-up
(`encodeGroups` is already there).

## Behaviour notes

- Picking: a click raycasts the layer (Spark), falls back to the nearest projected centre,
  then asks the layer's voxel grid for the nearest live splat; if that one is unassigned it
  takes the nearest *assigned* splat within the pick radius — with a geometric bake most
  splats are unassigned, and clicking a coloured patch should select that patch.
- Hover tint runs at most once per frame (pointer moves are coalesced) and uses the raycast
  only; ~15 ms/frame on the 177 k butterfly including the render.
- The bake is main-thread (~1–2 s on 177 k with detail 4; 55 groups, 12 % coverage on the
  butterfly sample — it is a patch segmenter, not an object segmenter; see
  `GROUPS_FORMAT.md` on why an ML bake such as Gaga is the real answer).
- LoD layers (≥ 1.5 M splats) render from Spark's LoD copy, so tints/overlay are not
  visible on them; selection and split still work because they act on the store.
- Export: a split segment is re-originned, so its store centres are relative to the
  centroid and its layer matrix carries the offset — the Phase 2 writer bakes that in.

## Verified in Chrome (RTX 5070 Ti)

Butterfly sample: Segment → 55 groups; Show labels paints the overlay; click selects a
group (hover label follows the cursor where the raycast hits); Split to layer → new
`segment` layer (198 splats, SH kept, gizmo on its centroid); FLOOR, ×5 array, SOLO on/off;
Ctrl+Z ×3 restores the single 177,132-splat layer, redo re-splits. Crop box shrunk to half
→ Keep inside hides 138 k splats, Ctrl+Z restores. 22 unit tests (`npm test`) cover the
sidecar round-trip, the bake on two clusters, the voxel grid, and the split/alive/floor/array
commands.
