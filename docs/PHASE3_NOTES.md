# Phase 3 implementation notes

Date: 2026-08-22

## Architecture

- Sketch settings and vector `Stroke` records are kept in float32 CPU data. Every committed stroke also produces degree-0 gaussian arrays which are appended to the sketch layer's `SplatStore`; Spark remains a render cache.
- Screen input is EMA-smoothed before placement, then the world path is resampled at fixed arc length. Surface placement pairs Spark raycasting with the 18 px projected-point fallback and continues across gaps at the previous depth. Lock-depth and world-ground-plane placement share the same camera ray path.
- Preview splats live in a world-space `SplatMesh` outside `Document.root`. The preview appends only new stamps. Commit performs one final resample, converts centres and rotations through the inverse layer world transform, divides scales by uniform layer scale, and stores path points in layer-local space.
- Ink and Marker build a tangent/view basis. Tube uses a stable tangent/up basis and is independent of view. Spray uses a hash of the stroke id plus `mulberry32`, so its gaussian positions, rotations, and redo output are deterministic.
- The active unlocked sketch layer is preferred, then the topmost unlocked sketch layer. Otherwise the first stroke runs `AddLayers` plus `AddStroke` inside one `CompositeCommand('Sketch', ...)`, so one undo removes both stroke and layer.
- Erasing keeps vector records and hides their store ranges through `alive`. A drag can cross multiple sketch layers and commits one composite undo step. Adding after an erase rebases surviving ranges because `SplatStore.concat` compacts dead splats.
- Duplicating a sketch copies its live vector strokes with independent ids; merging a sketch into another layer bakes only its live gaussians and intentionally drops vector metadata.

## Preview growth

`StrokePreview` starts with `PackedSplats({ maxSplats: 4096 })`, calls `ensureSplats` only when appending, and sets both `needsUpdate` and `mesh.updateVersion()` after writes. Spark 2.1's shipped implementation doubles capacity, copies the previous packed array, and `maybeUpdateSource()` disposes/recreates the data-array texture when `maxSplats` changes. This path is covered by source/API inspection and the production build. A rendered growth past 4,096 splats could not be observed in this session because no in-app browser target was available.

## Automated evidence

- `npm test`: 13 files, 50 tests. Phase 3 coverage includes EMA smoothing; arc-length spacing and dot strokes; pressure interpolation across corners; ground-plane, depth fallback, and surface-gap placement; Ink view-facing and per-sample camera orientation; Tube view independence; pressure scaling; deterministic Spray; linear UI colour conversion; preview-capacity growth and data retention; zero-splat layer sync; AddStroke and EraseStrokes do/undo/redo and lock refusal; target selection; first-layer atomic undo; attached and not-yet-attached root/layer local-space conversion; post-erase range rebasing; independent sketch duplication; vector alignment through baked gizmo scale; and PLY export/re-import of sketch geometry, colour, opacity, and transform.
- `npm run lint`: ESLint and Prettier clean.
- `npm run build`: strict TypeScript and Vite production build clean, with no new runtime dependency.
- Local Node benchmark on the Phase 1 laptop: appending a 1,000-splat stroke to an already-synced 100,000-splat sketch layer with vector metadata took **31.41 ms** synchronously; resampling and stamping a 2,000-input-point Ink path took **1.44 ms**. These are CPU/store timings, not rendered frame-rate measurements.

## Browser and device verification status

Browser discovery returned no in-app target in this implementation session. The following acceptance items remain manual and are not claimed as completed evidence:

- Chrome, Firefox, and Safari desktop interaction and fallback behavior.
- Surface appearance while orbiting, Tube side view, Plane alignment, Marker/Spray appearance, right/middle/Alt orbit gestures, gizmo-follow behavior, and rendered preview growth.
- A 2,000-sample rendered stroke at 50 fps and browser-side commit timing.
- Pen pressure on a physical pen/touch device (no device was available).
- Visual export/re-import in Splatypus and import into SuperSplat. The binary round-trip is covered in Vitest.

## Known limits

- Standard 3DGS PLY contains gaussian data but no vector-stroke schema. Export/re-import preserves the visible strokes, while stroke-level erase metadata remains session-local. Project persistence is outside Phase 3.
- As in Phase 2, rotations are not applied to imported SH coefficients. Sketches have no SH, so this does not affect their own colour.

## Review addendum (2026-08-22, Claude)

Codex's Phase 3 was functionally complete (50 tests, lint/build green) but unusable in
practice: no visible feedback until the stroke committed, multi-second lag, and brush
defaults of 2 mm / 0 % opacity. Causes and fixes:

- **Defaults**: `numberSetting` treated an unset key as `0` (`Number(null)`), so a fresh
  browser got the minimum size and zero opacity. Unset now falls back properly; opacity is
  clamped to ≥ 5 %.
- **Lag**: surface placement ran a Spark raycast (plus the 200 k-sample projected-centre
  fallback) for **every coalesced pointer event** — seconds per stroke on a scan. Placement
  now uses a screen-space **depth image** (`sketch/depthGrid.ts`): all live splat centres of
  visible layers are projected once at pointer-down (70 ms for the 2.3 M Matera cloud, ~15 ms
  for the butterfly; cached while camera and scene are unchanged) and each sample is an
  array lookup. No raycasts while drawing: 80 pointer moves cost ~7 ms.
- **Feedback**: a 2D overlay canvas (`sketch/SketchOverlay.ts`) draws the stroke under the
  pointer immediately (width = brush diameter, colour/opacity of the brush) plus the brush
  cursor ring; the cheap 3D preview is kept. The view is **locked while a stroke is drawn**
  (`Viewer.lockCamera`: orbit controls and F/1/3/7/Tab ignored) and released after commit.
- **Brush size is in screen pixels** (1–80 px, default 10): the cursor ring keeps its screen
  size while zooming, and the world radius is derived per sample from its depth
  (`radius = px × σ-factor × worldPerPixel(depth)`, σ-factor 0.5 so a gaussian looks as thick
  as the ring). Zoom in for fine marks, out for thick ones. `Stroke.settings` keeps both
  `radiusPx` and the world `radius` at the first sample (used for spacing).
- Synthetic pointers (automation) lack pointer capture; capture/release are now guarded.

Measured (Chrome, RTX 5070 Ti): butterfly stroke — pointer-down 19 ms, 60 moves 4 ms,
commit 16 ms; Matera (2.3 M) — 70 ms / 7 ms / 142 ms.
