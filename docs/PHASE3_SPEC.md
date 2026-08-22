# Phase 3 Spec — Sketching in the splat

Self-contained brief for an implementing agent/developer. Read `../PLAN.md` §2–§5, `PHASE2_SPEC.md` (data model), `SEGMENTATION_NOTES.md` (picking, paint, commands) and `PHASE2_NOTES.md` first. **This document is authoritative for Phase 3.** If something here conflicts with an assumption you would otherwise make, follow this document; if you hit a genuine blocker, stop and report it with what you tried — do not switch architecture.

## 0. Goal & non-goals

**Goal:** draw 3D strokes directly in the scene — on the surface of a scan, at a locked depth, or on the ground plane — with a Blender-grease-pencil feel. Strokes become gaussians in a `sketch` layer, behave like any other layer (move, hide, merge, delete, undo, export as standard 3DGS PLY) and keep their vector form so they can be erased stroke-by-stroke.

**Definition of done:** a red Ink line drawn on a wall of `Matera_Cave_Museum_7M.ply` (any scan) stays on the wall from every angle, survives undo/redo, export and re-import; a Tube stroke drawn in the void reads as a solid 3D line; the whole §10 checklist passes on the deployed Pages URL in Chrome + Firefox + Safari (desktop), plus one pen/touch device if available.

**Non-goals (do NOT build):** brushes that edit existing splats (erase/recolor/smooth scans — Phase 4), selection lasso, physics, SH on sketches, a stroke-smoothing post-editor, texture/stamp images, any framework.

## 1. Stack — deltas only

Nothing new. Everything from Phase 1/2 stays pinned (`three@0.180.0`, `@sparkjsdev/spark@2.1.0`, `tweakpane@4.0.5`, Vite 8, TS strict + `noUncheckedIndexedAccess`, ESLint/Prettier, Vitest, Node 20 in CI). No new runtime dependencies.

## 2. Files to add / change

```
app/src/
  sketch/presets.ts          # §5  Ink / Tube / Marker / Spray parameters (pure data)
  sketch/stroke.ts           # §4  Stroke type, EMA smoothing, arc-length resampling (pure, tested)
  sketch/stamps.ts           # §5  sample → gaussians (centre/scale/quat/colour/opacity), pure, tested
  sketch/placement.ts        # §6  pointer → world point for surface / depth-locked / plane
  sketch/SketchTool.ts       # §6–7 pointer capture, live preview mesh, commit
  sketch/StrokePreview.ts    # §7  incremental SplatMesh for the stroke in progress
  model/sketchCommands.ts    # §8  AddStroke, EraseStrokes (+ helpers)
  model/Layer.ts             # CHANGE: `strokes` on sketch layers (see §4), `appendStore`
  viewer/Viewer.ts           # CHANGE: tool mode (select | sketch | erase), pointer routing, orbit on right/middle/Alt
  ui/sketchPanel.ts          # §9  SKETCH panel (collapsible, pen icon)
  ui/toolbar.ts              # CHANGE: tool switcher group (Select / Sketch / Erase stroke)
  ui/shortcuts.ts            # CHANGE: Q/S/X tools, [ ] size, Shift+[ ] opacity
  ui/icons.ts                # CHANGE: pen, eraser, select (arrow) icons
tests/                       # stroke.test.ts, stamps.test.ts, sketchCommands.test.ts
docs/PHASE3_NOTES.md         # written at the end (§11)
README.md                    # CHANGE: sketching section, keyboard map
```

Keep files under ~250 lines; split rather than grow. `main.ts` stays a wiring file.

## 3. How the existing pieces are used (read before coding)

- **Layer model** (`model/Layer.ts`, `model/SplatStore.ts`): a layer owns a float32 `SplatStore` (truth) and a Spark mesh rebuilt from it by `viewer/sync.ts` (`layer.dirty = true; void layer.sync()`). Stores are fixed-size; hiding = `alive` mask. `LayerKind` already includes `'sketch'`.
- **Commands/undo** (`model/history.ts`, `commands.ts`, `compoundCommands.ts`, `segmentCommands.ts`): `Command {label, do, undo, dispose?}`, `History.push` executes. `CompositeCommand`, `SetSplatsAlive` exist. Follow their shape (snapshot what undo needs; `LockedLayerError` on locked layers).
- **Document** (`model/Document.ts`): `root` Group carries the up-axis flip; layers' `object`s are its children; events `layers-changed`, `layer-changed`, `selection-changed`, `history-changed`. `document.active()`.
- **Viewer** (`viewer/Viewer.ts`): owns the canvas pointer handlers; emits `canvas-click`/`canvas-hover` {event, hit?}; `addInteractionGuard(fn)` suppresses selection/hover while `fn()` is true; `addHelper/removeHelper` add objects to the scene (world space, *not* under `document.root`); `camera`, `canvasElement`, `cameraRig.controls` (three OrbitControls) and `cameraRig.mode` ('orbit' | 'fly'); `setTransformMode`, `transformMode`, `transform-mode-changed`. Dev hook: `window.__splatypus = { viewer, imports, segmentation, crop }` + `viewer.renderOnce()` (use it for scripted browser checks in a background tab, where rAF is paused).
- **Picking** (`viewer/picking.ts`): `pickLayer(document, camera, ndc)` — Spark raycast over visible layers, returns `{layer, point (world), distance}`; `nearestProjectedPoint(document, camera, ndc, rect, maxPx)` — screen-space fallback; `eventPointer(event, rect)` → NDC. Spark's raycast misses sparse point clouds; always pair it with the fallback for clicks, raycast-only for per-frame hover.
- **Paint** (`viewer/paint.ts`) writes display colours into the packed GPU cache (not needed here, but shows how to touch `mesh.packedSplats.packedArray` + `needsUpdate` + `mesh.updateVersion()` — the same mechanism the live preview uses).
- **Toolbar/panels**: `ui/toolbar.ts` (bottom, icon buttons from `ui/icons.ts`), right-rail panels via `ui/collapse.ts` → `createPanelShell(root, 'TITLE', 'icon')`; toasts `hud.toast(msg, 'info'|'warning'|'error')`; panels notify through `notify(message, level)` callbacks.
- **Gizmo** (`viewer/LayerGizmo.ts`): attached to the single selected unlocked layer; `isInteracting` guards clicks. Sketch layers are ordinary layers — the gizmo works on them unchanged.

## 4. Data model

```ts
// sketch/presets.ts
export type PresetName = 'ink' | 'tube' | 'marker' | 'spray';
export interface Preset {
  name: PresetName;
  /** Arc-length spacing between stamps, as a multiple of the radius. */
  spacing: number;            // ink 0.45, tube 0.5, marker 0.5, spray 0.8
  /** Scale multipliers along (tangent, side, view) in units of radius r. */
  stretch: number;            // ink 1.6, tube 1.4, marker 1.6, spray 1
  side: number;               // ink 1.0, tube 1.0, marker 2.5, spray 1
  flat: number;               // ink 0.15 (ribbon facing the camera), tube 1.0 (round), marker 0.12, spray 1
  opacity: number;            // ink 0.95, tube 0.9, marker 0.35, spray 0.55
  /** Spray only: gaussians per stamp and their radius/scatter as multiples of r. */
  scatter?: { count: number; radius: number; size: number };   // spray {8, 1.0, 0.3}
  /** Whether stamps face the camera (ribbon) or are view-independent (tube, spray). */
  billboard: boolean;         // ink true, marker true, tube false, spray false
}

// sketch/stroke.ts
export interface StrokeSettings {
  preset: PresetName;
  colour: [number, number, number];   // 0..1 linear RGB
  radius: number;                     // metres, world space (see §9 for the slider range)
  opacity: number;                    // 0..1 multiplier on the preset opacity
  pressure: boolean;                  // pointer pressure → radius (0.4..1.0) and opacity (0.6..1.0)
  placement: 'surface' | 'depth' | 'plane';
}
export interface Stroke {
  id: string;
  settings: StrokeSettings;
  /** Resampled path in the sketch layer's LOCAL space, xyz per point. */
  points: Float32Array;
  /** Per point, 0..1 (1 when no pressure). */
  pressures: Float32Array;
  /** Range of store indices this stroke produced: [first, count]. */
  range: [number, number];
}
```
`Layer` gets `readonly strokes: Stroke[]` (only used when `kind === 'sketch'`). Stroke points are stored in **layer-local** coordinates (convert from world with the inverse of `layer.object.matrixWorld` at commit time) so moving the sketch layer later moves its strokes with it, and erasing by picking maps back through the layer's transform.

**Appending to a store.** `SplatStore` is fixed-size. Add `SplatStore.concat` usage via a new `Layer.appendStore(extra: SplatStore): SplatStore` helper? No — keep it in the command: `AddStroke` builds `SplatStore.concat([layer.store, strokeStore], 0)` and calls `layer.replaceStore(next)` (it already resets the pick grid and keeps `dirty/sync`); undo calls `replaceStore(previous)` with the store it captured. Sketch layers are small (thousands to a few hundred thousand splats), so O(N) per stroke is fine. `replaceStore` drops `groups` when the count changes — correct for sketch layers (they never carry a `.groups` map).

## 5. Stroke → gaussians (pure functions, unit-tested)

`sketch/stroke.ts`
- `smoothScreenPoints(points, alpha = 0.5)` — EMA on screen-space (x, y, pressure), applied **before** placement so the world path is smooth even on rough raycast hits.
- `resample(points3d: Float32Array, spacing: number): {points: Float32Array, tangents: Float32Array}` — fixed arc-length resampling along the 3D path; tangent = central difference (unit); a stroke shorter than `spacing` yields one sample (a dot).

`sketch/stamps.ts`
- `stampsFor(sample: {p, t, pressure}, view: {dir: Vector3}, settings, preset, rng) → array of {center, scales[3], quat[4], rgb[3], opacity}`:
  - radius `r = settings.radius × (settings.pressure ? 0.4 + 0.6·pressure : 1)`, opacity `o = preset.opacity × settings.opacity × (settings.pressure ? 0.6 + 0.4·pressure : 1)`.
  - Orientation: build an orthonormal basis `(x, y, z)` with `x = t` (tangent); for `billboard` presets `z = normalize(viewDir)` projected orthogonal to `x`, `y = z × x`; for non-billboard (tube/spray) any stable perpendicular (`y = normalize(t × up)` with `up` swapped when degenerate, `z = x × y`). Quaternion from the basis matrix (columns x, y, z) — Spark's splat frame is (scale.x along column x, …). Scales `(r·stretch, r·side, r·flat)`.
  - Spray: `scatter.count` gaussians per sample, centres jittered uniformly in a sphere of `r·scatter.radius`, isotropic scale `r·scatter.size`, orientation random, opacity `o`. Use a seeded RNG (mulberry32 with the stroke id hash) so tests are deterministic and undo/redo re-creates identical splats.
  - Colour: the stroke colour for all stamps (no SH; `shDegree 0`).
- Everything in metres/world units; the caller converts centres (and the quaternion, via the layer's rotation) into layer-local space on commit. The up-axis root rotation means **world Y-up ≠ layer-local**: transform through `layer.object.matrixWorld` inverse for centres, its rotation inverse for quaternions; the root has unit scale, layers can carry uniform scale → divide scales by the layer's uniform scale.

## 6. Placement (pointer → world point)

`sketch/placement.ts` — `placePoint(viewer, event, mode, state) → Vector3 | undefined`:
- `surface`: `pickLayer` (raycast); if it misses, `nearestProjectedPoint(…, maxPx = 18)`; if both miss, continue at the **previous sample's depth** (plane through the last point, normal = view direction) so a stroke can cross small gaps; if there is no previous point, fall back to `depth` behaviour with the orbit target's distance. Apply a **bias towards the camera of `0.6 · r`** so the stroke sits on, not inside, the surface (otherwise half the ribbon is occluded by the scan's own gaussians).
- `depth` (lock depth): the first sample finds a depth like `surface` (or the orbit target distance if nothing is hit); all further samples intersect the ray with the plane through that first point, normal = camera view direction at pointer-down. Good for writing "in the air" in front of a wall.
- `plane`: ray ∩ the ground plane (world `y = 0`, the grid). If the ray is parallel / behind, skip the sample.
- The view direction used for billboard stamps is the camera's forward at the time of the sample (`camera.getWorldDirection`).
- Samples arrive from `pointermove` with `event.getCoalescedEvents()` (fall back to the event itself); ignore samples closer than 1.5 px to the previous one.

## 7. Tool, preview, commit

`viewer/Viewer.ts` gets a **tool mode**: `'select' | 'sketch' | 'erase'` (`viewer.tool`, `setTool`, event `tool-changed`). Rules:
- `select` = current behaviour.
- `sketch` / `erase`: left button is the tool. OrbitControls must not orbit on left-drag: set `cameraRig.controls.mouseButtons.LEFT = null` (verify three r180 treats a null action as no-op; otherwise set `enabled=false` on pointerdown and restore on pointerup) and keep `MIDDLE = DOLLY`, `RIGHT = ROTATE`; **Alt+left-drag orbits** even in sketch mode (swap LEFT back to ROTATE while Alt is held at pointerdown). Two-finger/pen-barrel behaviour can stay default. Register an interaction guard so clicks/hovers never change the layer selection while a tool other than select is active. Show the cursor as a crosshair in sketch/erase mode (CSS class on the canvas).
- Fly mode (`Tab`) still works; drawing is only possible in orbit mode (toast once if someone tries).

`sketch/SketchTool.ts` (one instance, created in `main.ts`):
- `pointerdown` (button 0, no Alt): `setPointerCapture`, start a stroke: clear EMA, pick the target sketch layer (§8), record camera view dir; create/clear the `StrokePreview`.
- `pointermove`: coalesced samples → EMA → placement → append world points; when the accumulated path advanced ≥ `spacing·r` since the last stamp, resample the tail and **append stamps incrementally** to the preview (never rebuild from scratch per move — a 2 000-sample stroke must stay at 60 fps).
- `pointerup`/`pointercancel`/`lostpointercapture`: finish: resample the whole smoothed path once (this is what gets stored — the preview may differ by a sample at the tail, that is fine), build the stamps, convert into layer-local space, push `AddStroke` (§8), dispose the preview, toast nothing (strokes are frequent).
- `Escape` during a stroke cancels it.
- Erase tool: on click (no drag), `pickLayer` → if the hit layer is a sketch layer, map the hit point into layer space, find the nearest live splat (`layer.pickSplat`), find the stroke whose `range` contains that index, push `EraseStrokes(layer, [strokeId])`; drag-erase: same test on every pointer move, batched into one command on pointerup. Toast "Not a sketch layer" (warning) once per drag when the hit isn't a sketch layer.

`sketch/StrokePreview.ts`: a `SplatMesh` built with `new PackedSplats({ maxSplats: 4096 })` (grow with `ensureSplats(n)` which reallocates — then `packed.numSplats = n; packed.needsUpdate = true; mesh.updateVersion()`), written with `setPackedSplat` (top-level export of `@sparkjsdev/spark`; scales via `utils.setPackedSplatScales` if you ever need to patch). Added with `viewer.addHelper(mesh)` in **world** space (the preview is not a layer). Dispose on commit/cancel (`mesh.dispose()`, `removeHelper`). Verify that growing the packed array after the mesh has rendered re-uploads (Spark's `maybeUpdateSource` replaces the texture when `maxSplats` changes — record what you observe in PHASE3_NOTES; if it does not, recreate the mesh only when capacity is exceeded).

## 8. Commands (`model/sketchCommands.ts`)

- **Target sketch layer:** the active layer if `kind === 'sketch'` and unlocked; else the topmost unlocked sketch layer; else a new layer `Sketch` (kind `'sketch'`, empty store of count 0 — make sure `SplatStore` accepts count 0 and `syncLayer` handles `live === 0` without creating a zero-size texture problem; Phase 2's `new SplatMesh({maxSplats: 0})` already exists for the placeholder) created inside the same undo step as the first stroke (`CompositeCommand('Sketch', [AddLayers, AddStroke])`). New sketch layers sit at identity under `document.root`, inherit nothing.
- `AddStroke(document, layerId, stroke: Stroke, splats: SplatArrays)`: `do` = `layer.replaceStore(SplatStore.concat([layer.store, new SplatStore(splats)], 0))`, set `stroke.range = [previousCount, splats.count]`, `layer.strokes.push(stroke)`, `notifyLayerChanged`; `undo` = `replaceStore(previousStore)`, pop the stroke. Label `Stroke (ink, 312 splats)`.
- `EraseStrokes(document, layerId, strokeIds[])`: hides the strokes' ranges via the `alive` mask (reuse `SetSplatsAlive` semantics), marks strokes `erased` (keep them in the array so ranges stay valid); undo restores. Export drops dead splats already. Label `Erase 2 strokes`.
- Locked sketch layers refuse both (toast via `LockedLayerError`).
- Sketch layers are ordinary layers for everything else (duplicate/merge/delete/move/solo/export). `MergeLayers` of a sketch into a scan bakes it in — fine; the strokes array is not carried over (document this).

## 9. UI

- **Toolbar** (bottom): a new first group `Select (Q)` / `Sketch (S)` / `Erase stroke (X)` with `aria-pressed` reflecting `viewer.tool`; existing groups unchanged. Icons: arrow, pen, eraser (add to `ui/icons.ts` in the same 16×16 line style).
- **SKETCH panel** (right rail, below SEGMENT, `createPanelShell(root, 'SKETCH', 'pen')`), visible when a document is open:
  - Preset buttons Ink / Tube / Marker / Spray (aria-pressed).
  - Colour: `<input type="color">` + 6 swatches (red `#ff3b30`, lime `#b8f34a`, white, cyan `#35d0ff`, yellow `#ffd60a`, magenta `#ff4fd8`); default red.
  - Size: log slider 0.002–0.5 m (default 0.02), shown in cm/mm; `[` / `]` step ×0.8 / ×1.25. Opacity 0–1 (default 1); `Shift+[`/`]`.
  - Placement: Surface / Lock depth / Plane (aria-pressed).
  - Pressure toggle (default on).
  - Status line: target layer name, stroke count, "draw with the left button · right/middle or Alt+drag to orbit".
  - Settings persist in `localStorage` (`splatypus.sketch.*`).
- **Shortcuts**: `Q` select, `S` sketch, `X` erase, `[`/`]` size, `Shift+[`/`]` opacity, `Esc` cancels a stroke in progress (then falls through to the existing Esc behaviour). Don't break Phase 1/2 keys (`F G O Shift+O W E R Tab Del Ctrl+Z/Y/E 1 3 7`, WASD/QE in fly).
- HUD splat count includes sketch splats (automatic). README: sketching section + keyboard map.

## 10. Acceptance checklist
- [ ] Phase 1/2/segmentation behaviour unchanged in `select` mode (orbit, click-select, gizmo, crop, export).
- [ ] Sketch tool: left-drag draws an Ink stroke on the Butterfly sample that follows the surface; orbiting afterwards shows it lying on the surface from every angle; right-drag/Alt+drag orbit while the tool is active.
- [ ] Tube stroke in the void (Lock depth) reads as a solid 3D line from the side; Plane stroke lies on the grid.
- [ ] Marker is wide and translucent; Spray scatters blobs; pressure changes width with a pen (or is simply 1.0 with a mouse).
- [ ] First stroke creates a `Sketch` layer; later strokes append to it; the layer moves with the gizmo and strokes follow; SOLO/hide/duplicate/delete work.
- [ ] Ctrl+Z removes the last stroke (and the layer when it was created by that stroke); redo restores identical splats (seeded spray).
- [ ] Erase tool: click a stroke → it disappears; undo brings it back.
- [ ] Export → reopen: strokes present, correct colour/placement; open in SuperSplat.
- [ ] A 2 000-sample stroke draws at ≥ 50 fps on the Phase 1 test machine; commit < 100 ms for a 100 k-splat sketch layer.
- [ ] `npm test` covers resampling (spacing, dot stroke), stamp orientation (ink faces the view direction; tube is view-independent), AddStroke/EraseStrokes do/undo, target-layer selection.
- [ ] Chrome, Firefox, Safari desktop; `docs/PHASE3_NOTES.md` written (what deviated; measured fps/commit times; Spark preview-growth behaviour; pen pressure device used).

## 11. Pitfalls (verified — don't rediscover)
- `document.root` carries the up-axis flip: anything placed "in world" must be converted into layer space via `layer.object.matrixWorld` inverse before it goes into a store (see `SplitSplats` in `model/segmentCommands.ts` for the pattern).
- Spark renders a layer's Object3D with a **uniform** scale only; sketch layers are created at unit scale, so simply don't put non-uniform scale on them.
- Spark's raycast misses sparse point clouds (and sometimes thin gaussians); always keep the screen-space fallback for clicks.
- `PackedSplats` is quantised (float16 centres, 8-bit scales) — fine for previews and rendering, but strokes must be generated from float32 values you keep (the stroke arrays), not read back from the preview.
- `layer.replaceStore` resets the pick grid and drops a mismatched `.groups` map; it does **not** preserve `pointCloud` unless you pass it (sketch layers have none).
- Hidden/background tabs pause rAF: use `window.setTimeout` for deferred work, and `viewer.renderOnce()` in scripted checks.
- Prettier reformats long lines — write patches against the formatted file; ESLint wants `??=`, `for…of`, no unnecessary `!`.
- TransformControls: `getHelper()` for the scene object; `controls.axis !== null` means the pointer is over a handle.
- Commands must be synchronous; kick `void layer.sync()` and never await inside `do/undo`.

## 12. References
- Existing code: `model/segmentCommands.ts` (SplitSplats/SetSplatsAlive/Composite), `select/Segmentation.ts` (hover/click wiring to Viewer events), `viewer/paint.ts` (packed writes + `updateVersion`), `viewer/sync.ts` (how a store becomes a mesh), `ui/segmentPanel.ts` + `ui/collapse.ts` (panel shape), `ui/toolbar.ts`.
- Spark types: `app/node_modules/@sparkjsdev/spark/dist/types/{PackedSplats,SplatMesh,utils}.d.ts`.
- three.js: `OrbitControls.mouseButtons`, `PointerEvent.getCoalescedEvents`, `Element.setPointerCapture`.
- Grease-pencil feel reference: Blender 4.x Draw mode (stabilise/smooth, surface/3D cursor placement).
