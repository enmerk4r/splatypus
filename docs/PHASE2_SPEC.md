# Phase 2 Spec — Data model, layers, PLY export, undo

Self-contained brief for an implementing agent/developer. Read `../PLAN.md` §2–§5 for context and `PHASE1_SPEC.md` + `PHASE1_NOTES.md` for what exists. **This document is authoritative for Phase 2.** Where it conflicts with `PLAN.md` §4, this document wins (the data model below is a deliberate refinement). If you hit a genuine blocker, stop and report it with what you tried — don't switch architecture.

## 0. Goal & non-goals

**Goal:** the app owns the splat data on the CPU (not just a GPU texture), organises it in **layers**, can **import additional files as layers**, **move/hide/merge/delete** layers with **undo/redo**, and **export a standard 3DGS `.ply`** that reopens correctly in Splatypus *and* in SuperSplat (https://superspl.at/editor).

**Non-goals (do NOT build):** sketching/strokes, brushes, per-splat selection, segmentation, physics, React/any framework, a backend, a plugin system, IndexedDB persistence. No "for later" abstractions beyond what §4 names.

**Definition of done:** §10 passes on the deployed Pages URL in Chrome + Firefox + Safari (desktop). Phase 1 behaviour must not regress (§10 re-runs the Phase 1 checklist items that touch loading).

## 1. Stack — deltas only

Everything from Phase 1 stays pinned (`three@0.180.0`, `@sparkjsdev/spark@2.1.0`, `tweakpane@4.0.5`, Vite 8, TS strict + `noUncheckedIndexedAccess`, Node 20 in CI).

Add:
| | |
|---|---|
| Tests | `vitest` (dev dep) — `npm test` runs unit tests in Node (no browser). Round-trip tests in §7 are mandatory. |
| Gizmo | `three/addons/controls/TransformControls.js` (already shipped with three; no new package) |
| Workers | Vite native: `new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' })` |

No other runtime dependencies.

## 2. Files to add / change

```
app/src/
  model/SplatStore.ts        # §4.1 CPU structure-of-arrays, alive mask, append/remove/slice/concat
  model/Layer.ts             # §4.2 Layer = SplatStore + SplatMesh + metadata + transform
  model/Document.ts          # §4.3 ordered layers, selection, root group (up-axis), events
  model/commands.ts          # §5 Command interface + History (undo/redo) + the Phase 2 commands
  io/decode.worker.ts        # §6.1 file bytes → SplatStore arrays (transferables)
  io/decode.ts               # main-thread wrapper: decodeFile(bytes, name, opts) → Promise<DecodedSplats>
  io/plyReader.ts            # §6.1 our own binary PLY property-table reader (runs in worker AND in vitest)
  io/plyWriter.ts            # §7  standard 3DGS binary PLY writer (pure function; runs in worker AND in vitest)
  io/export.worker.ts        # §7  runs plyWriter off the main thread
  io/saveFile.ts             # showSaveFilePicker → fallback <a download>
  io/loadSplat.ts            # CHANGE: returns DecodedSplats + builds Layer(s); keeps Phase 1 progress/CORS UX
  viewer/SplatDocument.ts    # CHANGE: becomes a thin facade over model/Document (see §4.3) — or delete and
                             #         re-point Viewer/Hud/panel at Document; either way main.ts stays a wiring file
  viewer/Viewer.ts           # CHANGE: scene.add(document.root); up-axis on root group; gizmo; selection raycast
  viewer/sync.ts             # §4.4 SplatStore → PackedSplats (mesh rebuild), incl. SH
  ui/layersPanel.ts          # §8  hand-rolled DOM list (no Tweakpane) — eye/lock/name/count/tag, toolbar
  ui/exportDialog.ts         # §8  small <dialog> with options + progress
  ui/shortcuts.ts            # CHANGE: add undo/redo, gizmo modes, delete, add-file
  ui/hud.ts                  # CHANGE: "N layers · X splats (Y hidden)"
tests/  (vitest)             # plyReader/plyWriter round trip, SplatStore ops, History
docs/PHASE2_NOTES.md         # written at the end (§9)
README.md                    # CHANGE: layers, export, keyboard map, limitations
```

Keep files under ~250 lines; split rather than grow.

## 3. Why the CPU store is the source of truth (read this before coding)

Spark's `PackedSplats` (what `SplatMesh` renders from) is **lossy**: centers are float16, log-scales are 8-bit over [−12, 9], RGBA is 8-bit, quaternions are 24-bit (`setPackedSplat`/`unpackSplat` in `@sparkjsdev/spark/dist/spark.module.js`). `mesh.forEachSplat(...)` returns those quantised values. A writer fed from `PackedSplats` would produce a file that visibly differs from the input (positions jitter at cm scale on a 50 m scene, scales step). Therefore:

- **Decode from the file bytes directly into `SplatStore` (float32, physical units).** Never read data back from `PackedSplats` except for the `.ksplat`/`.sog` fallback in §6.1.
- **GPU buffers are a cache.** Every layer's `SplatMesh` is rebuilt from its store via `constructSplats` (§4.4). Spark's own `fileBytes` loader is no longer used for the main document (it's fine to keep it for the Phase 1 `?url=` sample-gallery path only if that saves time — but the sample must then also be decoded into a store, so simpler: one path for everything).
- Memory: 14 float32 per splat (+45 with SH3) — 1 M splats ≈ 56 MB (+180 MB). Acceptable. Point clouds keep the Phase 1 budget/decimation (only kept points enter the store).

## 4. Data model

### 4.1 `SplatStore` (pure data, no three.js, testable in Node)

```ts
export interface SplatArrays {
  count: number;
  centers: Float32Array;    // 3n, file coordinates of the layer (local space)
  scales: Float32Array;     // 3n, LINEAR (metres) — not log
  rotations: Float32Array;  // 4n, quaternion x,y,z,w — NORMALISED on import
  opacities: Float32Array;  // n, 0..1 (sigmoid already applied)
  colors: Float32Array;     // 3n, 0..1 (f_dc*SH_C0 + 0.5 already applied; RGB clouds: 0..1)
  shDegree: 0 | 1 | 2 | 3;
  shRest?: Float32Array;    // n * (9 | 24 | 45), original f_rest order (3DGS layout: all coeffs of R, then G, then B)
}
export class SplatStore {
  constructor(arrays: SplatArrays);
  readonly count: number;            // capacity actually used (includes dead)
  readonly alive: Uint8Array;        // 1 = live; delete = 0 (no compaction until export/merge)
  liveCount(): number;
  // typed-array views (no copies) for the sync + writer:
  readonly centers/scales/rotations/opacities/colors/shRest/shDegree
  static concat(stores: SplatStore[], shDegree: 0|1|2|3): SplatStore;  // compacts dead, pads SH with zeros
  slice(indices: Uint32Array): SplatStore;                              // compacting copy
  compacted(): SplatStore;                                              // drops dead
  computeRobustBounds(stride?: number): { min, max, center, radius }    // percentile 2–98 over live centres (local space)
}
```
No per-splat `layerId` array: **each layer owns one store** (refinement of PLAN §4). Resync and undo become O(layer), not O(document).

### 4.2 `Layer`
```ts
export type LayerKind = 'scan' | 'pointcloud' | 'sketch' | 'segment';   // only 'scan' | 'pointcloud' created in Phase 2
export class Layer {
  readonly id: string;               // crypto.randomUUID()
  name: string;
  readonly kind: LayerKind;
  visible: boolean; locked: boolean;
  readonly store: SplatStore;
  readonly mesh: SplatMesh;          // rebuilt from store by sync(); mesh.visible mirrors `visible`
  readonly object: Object3D;         // parent of mesh; TransformControls attaches HERE; its matrix = layer transform
  dirty: boolean;                    // store changed since last sync
  pointCloud?: PointCloudInfo;       // Phase 1 info when kind === 'pointcloud'
  sourceName: string;                // file it came from (for HUD/export naming)
}
```
Layer transform lives on `layer.object` (position/quaternion/scale). Phase 2 allows translate, rotate, **uniform** scale (TransformControls `scale` mode — enforce uniform by copying the dragged axis to all three on `objectChange`).

### 4.3 `Document`
```ts
export class Document extends EventTarget {
  readonly root: Group;              // added to scene once; up-axis quaternion lives HERE (was mesh.quaternion in Phase 1)
  readonly layers: readonly Layer[]; // bottom→top order
  readonly history: History;
  name: string;                      // first imported file name
  selection: ReadonlySet<string>;    // layer ids; at most one "active" (last selected) for the gizmo
  addLayer(layer, index?), removeLayer(id), moveLayer(id, index), getLayer(id)
  setSelection(ids: string[]), active(): Layer | undefined
  totalLive(): number; hiddenCount(): number
  getRobustBounds(): RobustBounds    // union over VISIBLE layers in WORLD space (apply layer.object matrix + root)
  dispose()
  // events: 'layers-changed' (structure/order), 'layer-changed' {id} (name/visible/locked/transform), 'selection-changed', 'history-changed'
}
```
`Viewer.setDocument(doc)`: `scene.add(doc.root)`; `applyOrientation()` sets `doc.root.quaternion` (same three cases as Phase 1); grid placed from `doc.getRobustBounds()`. **Export writes layer-local coordinates with the layer transform baked but NOT the root/up-axis transform**, so a file exported from a Y-down 3DGS scene is still Y-down (reopens identically everywhere). The HUD/panel/Viewer consumers of the Phase 1 `SplatDocument` (`numSplats`, `getRobustBounds`, `kind`, `pointCloud`, `setPointScale`) must keep working — either keep `SplatDocument` as a facade over `Document` or update the three call sites; do not leave two competing document classes.

Point-cloud controls (Phase 1 panel "Point cloud" folder) now act on the **active point-cloud layer** (hidden if the active layer isn't one). `setPointScale` writes `store.scales` then marks the layer dirty (the Phase 1 in-place `rescalePointCloud` fast path may be kept as an optimisation, but the store must be updated too or export is wrong). Budget change re-decodes that layer only.

### 4.4 `sync(layer)` — store → GPU
- Create/replace `layer.mesh` with `new SplatMesh({ maxSplats: live, constructSplats: (splats) => {...}, lod: live >= LOD_ABOVE_SPLATS, lodAbove: LOD_ABOVE_SPLATS })`. Inside `constructSplats`: `const arr = splats.ensureSplats(live)`; loop live splats → `setPackedSplat(arr, packedIndex, x,y,z, sx,sy,sz, qx,qy,qz,qw, opacity, r,g,b)`; set `splats.numSplats = live; splats.needsUpdate = true`. Keep a `Uint32Array packedToStore` on the layer (needed by later phases for picking).
- **SH:** if `store.shDegree > 0`, after `ensureSplats` call `splats.ensureSplatsSh(level, live)` for each level 1..degree and encode per splat with `utils.encodeSh1Rgb(sh1Array, packedIndex, Float32Array(9))`, `encodeSh2Rgb(…, Float32Array(15))`, `encodeSh3Rgb(…, Float32Array(21))` (coeff layout per Spark's `PlyReader.parseSplats` `shCallback`: `[k*3+d]`… read `ssShCallback`/`prepareSh` in `spark.module.js` to get the index mapping exactly — it is **not** the raw f_rest order); then `splats.setMaxSh(degree)` if required for the mesh to sample it. **If SH rendering can't be made to work in a reasonable time, render DC-only and say so in PHASE2_NOTES — SH must still round-trip through the store and the writer regardless.**
- Verify LoD still builds for a constructed `PackedSplats` (Phase 1 used the `fileBytes` path). If `lod: true` + `constructSplats` doesn't build the tree, call `await mesh.createLodSplats()` after `mesh.initialized`. Record what worked.
- Rebuild only dirty layers; 1 M splats must sync in < 1 s on the Phase 1 test machine (measure, note it).
- Dispose the previous mesh (`mesh.dispose()`, remove from `layer.object`). Reloading/merging 10× must not leak.

## 5. Commands & history

```ts
export interface Command { readonly label: string; do(): void; undo(): void; }
export class History extends EventTarget {
  push(cmd: Command): void;   // executes cmd.do() then records; clears redo stack
  undo(): void; redo(): void; canUndo(): boolean; canRedo(): boolean; clear(): void;
  readonly limit = 100;       // oldest commands are dropped; dropped RemoveLayer commands dispose their layer's mesh
}
```
Phase 2 commands (one class or factory each, in `model/commands.ts`): `AddLayers(layers[])`, `RemoveLayers(ids[])` (keeps Layer objects alive for undo; mesh stays allocated but detached), `RenameLayer`, `SetLayerVisible`, `SetLayerLocked`, `MoveLayer`, `DuplicateLayer` (copies the store — `store.compacted()` — and the transform), `MergeLayers(ids[], targetName)` (result = `SplatStore.concat` of the stores **with each layer's transform baked into centres/rotations/scales first**, placed at identity transform; undo restores the originals), `SetLayerTransform(id, before: Matrix4, after: Matrix4)` (pushed once on gizmo `mouseUp`, not per frame), `SetPointScale`/`SetPointBudget` for point-cloud layers. Toggling visibility via the eye icon IS undoable (cheap, keeps the model consistent). Camera moves are not commands.

Merge rule: result SH degree = max over inputs; layers with lower degree are zero-padded. Locked layers can't be deleted, merged, transformed or edited (UI disables + command refuses with a toast).

## 6. Import

### 6.1 Decoding (worker)
`decodeFile({ bytes, name, pointBudget?, pointSizeMul? }) → DecodedSplats { arrays: SplatArrays, kind: 'scan'|'pointcloud', pointCloud?: PointCloudInfo, lossy?: string }`, run in `decode.worker.ts`, all big arrays transferred (not copied). Progress messages at least every ~250 ms (`{phase:'parsing', loaded, total}`) — reuse the Phase 1 HUD progress.

| Format | How |
|---|---|
| `.ply` binary_little_endian, 3DGS layout (`x y z [nx ny nz] f_dc_0..2 [f_rest_0..N] opacity scale_0..2 rot_0..3`) | **Our `plyReader.ts`**: parse header (handle `comment`, `obj_info` — no more in-place rewriting needed, keep `plyCompat.ts` only if something else still uses it), build a property table (name → offset/type), stride = sum of sizes; read vertices with a `DataView` (or a `Float32Array` view when every property is float32 and the body is 4-byte aligned — fast path). Convert: `scale = exp(scale_i)`, `opacity = sigmoid(opacity)`, `color = f_dc*SH_C0 + 0.5`, `q = normalize(rot_1, rot_2, rot_3, rot_0)`, `shRest` = raw f_rest in file order, `shDegree` from count (0/9/24/45; other counts → treat as 0 and warn). Missing `scale_*`/`rot_*`/`opacity` + present `red green blue` → **RGB point cloud** path: apply the Phase 1 spacing estimate + stride decimation (`pointCloud.ts` logic moves into the reader/worker; `kind:'pointcloud'`). `binary_big_endian` → error "big-endian PLY not supported"; `ascii` → error. Element `vertex` only; ignore other elements. |
| `.ply` compressed (SuperSplat `chunk` + `packed_*` layout) | Spark `PlyReader` (`new PlyReader({fileBytes}); await parseHeader(); parseSplats(cb, shCb)`) — it already decodes this; callbacks give physical values. Run it in the worker if `@sparkjsdev/spark` imports cleanly there; **if the module touches `window`/`document` at import time in a Worker, run this format on the main thread** (Phase 1 already accepts main-thread parsing for rare paths). Record which in PHASE2_NOTES. |
| `.spz` | Spark `SpzReader` (`parseHeader()`, then `parseSplats(centerCb, alphaCb, rgbCb, scalesCb, quatCb, shCb)`) — float callbacks, lossless w.r.t. the file. Same worker/main-thread rule as above. |
| `.splat` (antimatter15) | Own parser: 32-byte records — `pos f32×3, scale f32×3, rgba u8×4, rot u8×4` (quat = `(u8-128)/128` in **w,x,y,z** order; verify against one file). |
| `.ksplat`, `.sog` | Spark `unpackSplats({ input, fileType, pathOrUrl })` then `unpackSplat(packedArray, i)` per splat → store. **Lossy** (float16 etc.): set `lossy: 'quantised import (ksplat/sog)'` and toast it once. |

Vitest covers `plyReader` with tiny fixtures generated in the test (write with `plyWriter`, read back), plus a 10-splat hand-built ASCII→binary fixture with `obj_info` and normals.

### 6.2 UX
- **Open** (drop / `O` / button / `?url=` / sample) **replaces** the document (Phase 1 behaviour, plus a confirm toast-with-button if history is non-empty: "Replace scene? You have unsaved changes · Replace / Cancel" — avoid `window.confirm`).
- **Add as layer**: Shift+drop, `Shift+O`, the layers-panel "+" button, or dropping **multiple files** (each becomes a layer; if no document exists the first one creates it). New layers get the file name (without extension), are selected, and the camera does **not** reframe if a document already exists (toast "Added layer X · press F to frame").
- Everything imported goes through `History.push(AddLayers)` except the initial open (history cleared).

## 7. Export — standard 3DGS binary PLY

`plyWriter.ts`: `writeGaussianPly(layers: ExportLayer[], opts) → ArrayBuffer` where `ExportLayer = { store, matrix: Matrix4 | number[16] }`. Pure; no three.js at runtime in the worker if avoidable (a 4×4 multiply + quaternion-from-rotation is 30 lines; or import three's math classes — they work in workers). Header exactly:

```
ply
format binary_little_endian 1.0
comment Generated by Splatypus <git sha or version>
element vertex <N>
property float x
property float y
property float z
property float nx
property float ny
property float nz
property float f_dc_0
property float f_dc_1
property float f_dc_2
property float f_rest_0 … f_rest_{K-1}        (K = 9/24/45 for degree 1/2/3; omitted entirely when degree 0)
property float opacity
property float scale_0
property float scale_1
property float scale_2
property float rot_0
property float rot_1
property float rot_2
property float rot_3
end_header
```
Per splat (float32 LE, that property order): `x y z` = layer matrix × centre; `nx ny nz = 0`; `f_dc = (color − 0.5) / SH_C0` (`SH_C0 = 0.28209479177387814`); `f_rest` = stored shRest (zeros for layers without SH when degree > 0); `opacity = logit(clamp(a, 1e-6, 1 − 1e-6))`; `scale_i = ln(max(s_i · uniformScale, 1e-9))`; `rot_0..3 = qw qx qy qz` of `normalize(R_layer ⊗ q)`. Only live splats (`alive = 1`), only **visible** layers by default (option to include hidden), skip locked? — no, locked layers export. Point-cloud layers export as gaussians with their current point radius (that's what the user sees). Known limitation, document it: SH coefficients are **not** rotated when a layer is rotated (minor view-dependent colour error).

Pipeline: export dialog → collect `{store arrays (transfer a compacted copy? no — transfer nothing: post the typed arrays; structured clone copies them, acceptable) , matrices}` → `export.worker.ts` builds the buffer with progress → `saveFile(blob, `${doc.name}-splatypus.ply`)`: `showSaveFilePicker` when available (Chrome), else `<a download>` with an object URL (Firefox/Safari). Files up to ~1 GB must work in Chrome.

**Stretch (only if everything else is done):** "Export .spz" via Spark `SpzWriter` (`setCenter/setAlpha/setRgb/setScale/setQuat/setSh → finalize()`).

### 7.1 Round-trip tests (vitest, mandatory)
1. Build a store with 1 000 random splats (degree 0) → write → `plyReader` → compare: centres **bit-identical**; scales/opacity/colours/quats within `1e-5` relative (float32 exp/log/sigmoid round trip). Quats compared up to sign.
2. Same with degree 3 SH: `f_rest` bit-identical.
3. Two layers, one with a non-identity matrix (translation + 90° rotation + uniform scale 2) → write → read → compare to CPU-transformed expectations.
4. Dead splats are omitted; hidden layers omitted unless `includeHidden`.
5. Header string matches the template above byte-for-byte for degree 0 and 3.
Manual: export `models/splat.ply` untouched → reopen in Splatypus → identical look; open in SuperSplat (drag onto https://superspl.at/editor) → loads, correct orientation/colours. Note the file sizes (input vs output) in PHASE2_NOTES.

## 8. UI

- **Layers panel** (right side, below/next to the Tweakpane VIEW panel; collapsible; same visual language as the HUD — mono font, lime accents): rows top→bottom = topmost layer first. Row: eye (visibility), lock, colour tag (small square; `kind` colour), name (double-click → inline rename, Enter/Esc), live count (`1.2M`), and a "has SH" dot if degree > 0. Click selects; Ctrl/Cmd+click toggles; Shift+click ranges. Toolbar: `+` add from file, duplicate, merge (enabled when ≥ 2 selected, unlocked), delete, ↑/↓ move. Footer: "N layers · X splats · Y hidden". Empty document → panel hidden.
- **Gizmo:** `TransformControls` attached to the active layer's `object` when exactly one unlocked layer is selected; `W/E/R` = translate/rotate/scale (uniform), `Esc` clears selection (when not in fly mode). Disable OrbitControls while dragging (`dragging-changed`); push `SetLayerTransform` on `mouseUp`. Gizmo size readable at scene scale (`controls.setSize`). Clicking on the canvas with no drag and no modifier: pick the layer under the cursor (Spark `raycast` on each visible layer mesh — `raycastable: true` — or screen-space nearest-centre fallback like Phase 1's double-click), select it; click on nothing → clear.
- **Export**: button in the HUD ("EXPORT .PLY") + `Ctrl/Cmd+E` → `<dialog>`: include hidden layers (off), include SH (on when any layer has it), estimated size, Export/Cancel, progress bar, "Saved as …" toast.
- **Undo/redo**: `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` and `Ctrl/Cmd+Y`; HUD shows the last command label briefly ("Undo: Merge 2 layers"). `Delete`/`Backspace` removes selected unlocked layers.
- **Unsaved-changes guard**: `beforeunload` prompt when `history.canUndo()`.
- Keyboard map additions go in README; don't break Phase 1 keys (`F G O Tab 1 3 7`, WASD/QE in fly).

## 9. Deliverables
1. Everything in §2; `npm run dev | build | lint | test | preview` clean; CI runs `npm test` before build.
2. README updated (layers, add-as-layer, gizmo, export, limitations: SH not rotated, big-endian/ascii PLY unsupported, ksplat/sog lossy).
3. `docs/PHASE2_NOTES.md`: what deviated and why; whether Spark imports in a Worker; SH rendering status (works / DC-only); LoD on constructed PackedSplats; sync + decode + export timings for `models/splat.ply` (262 k) and a ≥ 1 M-splat file; memory after 10× reload/merge; SuperSplat round-trip result with screenshots if possible.

## 10. Acceptance checklist
- [ ] Phase 1 still passes: samples, drop `.ply/.spz/.splat`, `?url=`, orbit/fly/frame/dblclick, HUD, point-cloud budget & size.
- [ ] Open A, Shift+drop B → 2 layers; move B with the gizmo; hide A; rename B; undo ×4 restores everything; redo ×4 replays.
- [ ] Duplicate a layer, merge the two, delete the result, undo → both back, in original order.
- [ ] Export with a transformed layer → reopen in Splatypus: identical placement; open in SuperSplat: loads, correct orientation/colour.
- [ ] `npm test` round-trip tests (§7.1) pass; header byte-exact.
- [ ] Export of a file with SH3 keeps `f_rest` bit-identical (test 2) and renders view-dependent colour in the viewer (or PHASE2_NOTES says DC-only and why).
- [ ] A 1 M+ splat file: decode in worker (UI stays responsive, progress moves), sync < 1 s, export completes with progress, Chrome saves a ~250+ MB file.
- [ ] Reload/merge 10× — no unbounded memory growth, no console errors; locked layers can't be deleted/merged/moved.
- [ ] Chrome, Firefox, Safari desktop; Safari/Firefox download fallback works.
- [ ] `docs/PHASE2_NOTES.md` written.

## 11. Pitfalls (verified — don't rediscover)
- `PackedSplats`/`forEachSplat` are quantised (§3). `getRobustBounds` must now use store centres, not `forEachSplat`.
- Phase 1 put the up-axis flip on `mesh.quaternion`; Phase 2 moves it to `Document.root`. If you leave it on meshes, layer transforms and exports end up in the wrong frame.
- `utils.setPackedSplatScales` etc. live under the `utils` namespace export; `setPackedSplat`/`unpackSplat` are top-level. SH encoders: `utils.encodeSh1Rgb/encodeSh2Rgb/encodeSh3Rgb`.
- `PlyReader.parseSplats` passes `rot_*` through unnormalised and in `(rot_1, rot_2, rot_3, rot_0)` order; our reader must normalise.
- Spark's PLY header parser rejects unknown keywords (`obj_info`) — our reader must accept them (Phase 1 patched bytes in place; not needed once our reader handles it).
- `TransformControls` must be added to the scene (`scene.add(controls.getHelper())` in three ≥ 0.169 — the control itself is no longer an `Object3D`) and OrbitControls disabled while dragging.
- Structured-cloning a 200 MB `Float32Array` to a worker copies it; transfer (`postMessage(msg, [buf])`) when the main thread doesn't need it afterwards. The store's arrays must stay on the main thread (they are the truth) → for export, copy; for decode, transfer worker→main.
- `<a download>` object URLs must be revoked after click; Safari needs the anchor in the DOM.
- Don't `window.confirm`/`alert` (blocks the render loop and automation).

## 12. References
- Spark docs: https://sparkjs.dev/docs/ (PackedSplats, SplatMesh options, SplatEdit for Phase 4)
- Spark types: `app/node_modules/@sparkjsdev/spark/dist/types/*.d.ts` — `PackedSplats.d.ts`, `ply.d.ts`, `spz.d.ts`, `utils.d.ts`, `defines.d.ts` (`SH_C0`, `LN_SCALE_MIN/MAX`)
- 3DGS PLY layout (reference implementation): https://github.com/graphdeco-inria/gaussian-splatting (scene/gaussian_model.py `save_ply`)
- antimatter15 `.splat` format: https://github.com/antimatter15/splat
- SuperSplat editor (round-trip check): https://superspl.at/editor
- three.js TransformControls: https://threejs.org/docs/#examples/en/controls/TransformControls
