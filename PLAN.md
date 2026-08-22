# Splatypus — Sketch, Edit & Play Inside Gaussian Splats

AECtech 2026 Boston hackathon plan.

**One-liner:** A static web app (GitHub Pages) that opens a Gaussian splat, lets you orbit it, **sketch in 3D inside the scene** (Blender grease-pencil / sculpt-brush feel), **edit the scan** (erase, recolor, fade, move), **segment it into objects**, and — if we get there — **drop physics on it**. Exports a standard `.ply` that any splat tool can open.

**Out of scope (see Appendix A):** producing the splat. We assume a `.ply`/`.spz`/`.splat` already exists (from Brush, Polycam, Scaniverse, Luma, Postshot, …). Keeping reconstruction out of the app is what lets the whole thing be a static site.

---

## 1. Demo storyboard (what "done" looks like)

1. Open `splatypus.github.io/…`, drag in a splat of a real Boston space, fly around at 60 fps. *(Phase 1)*
2. Pick a brush, **draw a 3D stroke that lands on the scanned wall**; draw a massing blob in the air. The stroke *is* gaussians — it occludes and blends like the scan. *(Phase 3)*
3. **Erase** a floater / a passer-by; **recolor/fade** a region with a sphere brush; undo. *(Phase 4)*
4. **Click a chair → it's segmented** into its own layer; move it with a gizmo; delete it; duplicate it. *(Phase 5)*
5. **Hit "Physics"**: the segmented chair drops and tumbles on the floor; a sketched blob rolls down the stairs. *(Phase 6)*
6. Export `.ply`, reopen in SuperSplat/Spark to prove it round-trips. *(Phase 2)*

AEC pitch: 3D redlining of existing-conditions scans, sketch-level massing against real context, object-level segmentation of scans (furniture, MEP, clutter removal), and a playful "what-if" physics layer. Stretch: strokes out as polylines (glTF/DXF/Speckle) to Rhino/Revit.

---

## 2. Architecture

### Decision: **static TypeScript web app — Vite + three.js + Spark (`@sparkjsdev/spark`)**

Everything runs client-side. No backend, no accounts, files never leave the machine. Deploys as static assets to GitHub Pages via a GitHub Action.

Why **Spark** as the splat renderer:

| Need | Spark gives us |
|---|---|
| Load scans | PLY / compressed PLY / SPZ / SPLAT / KSPLAT / SOG loaders built in |
| Live brush preview (recolor, fade, displace inside a sphere/capsule) | `SplatEdit` + `SplatEditSdf` — GPU-side, non-destructive, sphere/box/capsule/cylinder shapes, soft edges, blend modes |
| Add new gaussians (sketching) | `PackedSplats.pushSplat()` / `setSplat()` and `construct:` procedural callback |
| Per-splat CPU access (erase, segment, bake, export) | `PackedSplats.getSplat()/forEachSplat()` + `utils.unpackSplat/setPackedSplat` on the raw 16-byte array |
| Segments & layers | Multiple `SplatMesh` in one scene, sorted together; each is an `Object3D` with its own transform → **a segmented object moving under physics is just a `SplatMesh` whose matrix we update** |
| Performance / reach | Millions of splats, LoD in 2.0, WebGL2 → works in every browser incl. Safari/Firefox |
| Ecosystem | three.js `Object3D` → OrbitControls, TransformControls, Raycaster, lines, glTF import all work |
| License | MIT |

Trade-off: **Spark is WebGL2, not WebGPU.** For this project that's fine — rendering isn't the bottleneck, editing UX is, and WebGL2 runs on every judge's laptop. The CPU data model (§4) is renderer-agnostic so the new **three.js r186 native `GaussianSplatMesh`** (WebGPU/TSL, plain `BufferGeometry` with `position`/`covariance`/`color`) remains a fallback / stretch "WebGPU mode".

Alternatives considered: fork **SuperSplat** (PlayCanvas, MIT — already has brush/lasso/sphere select, delete, transform, WebGPU; but big unfamiliar codebase and adding a stroke data model + physics into its pipeline is the hard part) — only if someone knows PlayCanvas; steal its UX regardless. Native desktop (Rust/wgpu, CUDA à la Splatshop) — faster, but kills the zero-install browser demo.

Reference projects for mechanics: NVIDIA **SplatPainting** (SIGGRAPH 2025 — spline from surface hits, stamps along spline), **Splatshop** (brushes, paint, undo, VR), **SuperSplat** (selection UX, Set/Add/Remove modifiers).

---

## 3. Stack

| Layer | Choice | Notes |
|---|---|---|
| Build | Vite + TypeScript (strict) | `npm create vite@latest app -- --template vanilla-ts` |
| 3D | three.js (latest) + `@sparkjsdev/spark` | pin versions day 1 |
| Camera | three.js `OrbitControls` + fly/WASD toggle | orbit target = 3D cursor (Blender style); double-click to re-target on a splat |
| UI | Tweakpane (params) + hand-rolled HTML toolbar | no framework unless someone insists; speed > structure |
| Workers | Comlink | PLY parse/write, spatial index, segmentation, stroke baking off main thread |
| Spatial index | uniform voxel hash grid over splat centers (~100 LOC) | picking, erase, flood/connectivity segmentation |
| Undo | command stack with sparse diffs | `Command { do(); undo() }` |
| Segmentation (ML, stretch) | `@huggingface/transformers` (transformers.js) running **SlimSAM / MobileSAM** via ONNX Runtime Web (WebGPU or WASM) | click/box in 2D → mask → lift to splats by projection |
| Physics | **Rapier** (`@dimforge/rapier3d-compat`, WASM, Rust, three.js-friendly) | colliders are proxies built from splat segments; alt: Jolt-JS, cannon-es |
| Persistence | File System Access API / blob download | `.ply` + `.strokes.json` + (stretch) `.splatypus.json` project file |
| Hosting | GitHub Pages via `actions/deploy-pages` | `base: '/<repo>/'` in `vite.config.ts`; everything static; model weights fetched from HF CDN at runtime |

---

## 4. Data model (renderer-agnostic on purpose)

```
SplatStore (CPU, structure-of-arrays typed arrays) — source of truth
  count, capacity
  pos[3n]  scale[3n] (log)  rot[4n] (quat)  opacity[n]
  rgb[3n] (SH DC → color)   shRest[45n]? (kept only if source had it; never edited)
  alive[n] (Uint8 mask — delete = mask off; compaction on export)
  layerId[n]

Layer = a SplatMesh (own PackedSplats) + metadata
  id, name, visible, locked, kind: 'scan' | 'segment' | 'sketch'
  transform (Object3D matrix)            ← physics/gizmo write here, cheap
  rebuilt from SplatStore slice on commit (only dirty layers)

Stroke (vector form kept alongside the baked gaussians)
  id, layerId, brushPreset, points[{p, n?, pressure, t}], splatRange
  → re-bake with another brush, export as polyline, undo whole stroke in O(1)

Segment
  id, layerId, source: 'sphere' | 'lasso' | 'flood' | 'connectivity' | 'sam', proxy?: Collider

Command (undo/redo)
  AddSplats | RemoveSplats | SetAttrs | StrokeCommit | SplitLayer | MergeLayer | SetTransform
```

Rules: **GPU buffers are a cache of the SplatStore.** Live previews use Spark `SplatEdit` (GPU-only); on pointer-up we bake into the SplatStore and resync only the affected layer. Moving a whole layer/segment never touches splat data — it's a matrix.

---

## 5. Phases

Phase 1 is the only hard gate; after that, phases 3–6 are largely parallelizable by person. Each phase lists **acceptance criteria** so we know when to stop.

### Phase 1 — Viewer: open a splat, orbit it, ship it
*Full handoff spec with exact versions, APIs, pitfalls and acceptance checklist: [`docs/PHASE1_SPEC.md`](docs/PHASE1_SPEC.md).*
- Vite + TS app; three.js scene; Spark `SplatMesh`.
- Open a splat by: drag-and-drop, file picker, `?url=` query param, and a small built-in sample gallery (2–3 public splats in `public/samples/`).
- OrbitControls (damping, zoom-to-cursor), fly mode toggle, `F` to frame scene, double-click to set orbit target on the splat under the cursor (Spark raycast or screen-space nearest center).
- Auto-recenter/scale scene on load (bbox of splat centers, robust to floaters → use 5th–95th percentile).
- HUD: splat count, fps, file name; loading progress bar.
- Grid/axes toggle; background color.
- GitHub Action → Pages; `npm run build` produces a working static site at the repo URL.
- **Done when:** someone on another laptop opens the Pages URL, drops a `.ply` from their phone scan, and flies around it smoothly.

### Phase 2 — Data model, layers, export, undo
*Full handoff spec (store-is-truth rationale, exact PLY header, commands, tests, acceptance): [`docs/PHASE2_SPEC.md`](docs/PHASE2_SPEC.md).*
- Decode files into a CPU `SplatStore` (worker, float32) — **not** from Spark's `PackedSplats`, which is quantised; each layer owns a store and its GPU mesh is rebuilt from it.
- Layers panel (visibility, lock, rename, delete, merge).
- `.ply` writer (binary LE, standard 3DGS header; color → `f_dc = (c-0.5)/0.2820948`, opacity → logit, scale → log, quat wxyz; `f_rest` zeros for new splats; dead splats compacted; layer transforms baked in).
- Round-trip test: export → reload → identical. Open in SuperSplat to confirm.
- Undo/redo skeleton.
- **Done when:** load → delete half the layers → export → reopen elsewhere works.

### Phase 3 — Sketching (the novelty)
*Full handoff spec (placement modes, stamp maths, preview/commit, commands, panel, acceptance): [`docs/PHASE3_SPEC.md`](docs/PHASE3_SPEC.md).*
- **Stroke placement:** (a) surface — ray → nearest splat via voxel grid, tiny depth bias; (b) depth-locked — continue at the depth of the first hit, or a fixed distance if starting in the void; (c) stretch: 3D cursor / construction plane.
- **Stroke → gaussians:** pointer events (pressure, coalesced), EMA smoothing, resample to fixed arc-length spacing, one stamp per sample: oriented gaussian(s) (quat from tangent × view/normal), scale `(r·stretch, r, r·flat)`, jitter.
- Presets: **Ink** (thin ribbon facing camera), **Tube** (round 3D stroke — massing), **Marker** (wide translucent), **Spray** (random gaussians in a sphere — blobs/vegetation).
- Color, opacity, size (`[`/`]`), pressure→size/opacity toggle. Live preview in a temporary "active stroke" `SplatMesh`; commit to a sketch layer on pointer-up.
- **Done when:** a red line drawn on a wall stays on the wall from every angle and survives export.

### Phase 4 — Edit brushes
*Done in `main` (Erase, Recolor, Fade, Grab, Inflate as screen-space brushes on the active layer, one undo step each): [`docs/PHASE4_NOTES.md`](docs/PHASE4_NOTES.md). Remaining: Smooth.*
- Live `SplatEdit` sphere/capsule preview following the cursor; bake on pointer-up via voxel-grid query over the swept capsule.
- **Erase** (soft → opacity, hard → dead), **Recolor** (`MULTIPLY | SET_RGB | ADD`, strength), **Fade**. Stretch: **Grab / Smooth / Inflate** (displace centers), **Scale**.
- **Done when:** remove a floater and recolor a wall with undo.

### Phase 5 — Segmentation ("this splat is a chair")
*Tier 2 (voxel connectivity + colour) and the `.groups` sidecar, group selection/hover/overlay, split-to-layer, crop box, solo/floor/array are in `main` — ported from the `segmentation` branch; see [`docs/SEGMENTATION_NOTES.md`](docs/SEGMENTATION_NOTES.md). Remaining: sphere/lasso/flood selection, ML tier.*
Three tiers, cheapest first; each produces a selection mask → *Split to layer* / delete / recolor / transform with `TransformControls`.
1. **Geometric selection:** sphere / box / screen-space lasso & rect; Set/Add/Remove modifiers (SuperSplat pattern).
2. **Grow-based:** flood by color similarity; **connectivity** (connected components on the voxel grid with a distance threshold — this alone separates a chair from the floor surprisingly often); floor/plane removal via RANSAC (also gives us the physics ground plane).
3. **ML click-to-segment (stretch, high wow):** render current view → run **SlimSAM/MobileSAM** in-browser (transformers.js, ONNX Runtime Web w/ WebGPU) on a click/box → 2D mask → select splats whose projected centers fall in the mask and whose depth is near the front surface → optionally refine from 2–3 viewpoints (intersection) → grow with connectivity. Model weights (~tens of MB) are fetched from the HF CDN, cached by the browser.
- **Done when:** click chair → layer "chair" → move it with the gizmo → export.

### Phase 6 — Physics ("representation-agnostic")
Physics never looks at gaussians; it acts on **proxies**, and visuals (splat layers, sketch strokes, imported glTF meshes) are just followers of rigid-body transforms. That's the "agnostic" part.
- **Rapier** world; fixed-step loop; play/pause/reset (reset = restore layer transforms from the undo snapshot).
- **Ground:** RANSAC plane from the scan (Phase 5) or a manually placed plane; optional static **trimesh/heightfield from scan** — voxelize scan centers → marching cubes / or just a coarse voxel box collider set (cheap & robust).
- **Dynamic bodies:** per segment/sketch layer → collider from its splat centers: compound of spheres (k-means / voxel centers, ~20–50 spheres) or convex hull (Rapier supports convex hulls from point clouds). Mass from volume; center of mass = centroid.
- Each step: `layer.object3d.position/quaternion ← body` — Spark re-sorts, nothing else to do.
- Interactions: drop, throw (drag & release), gravity toggle, "explode" button for the demo; sketched Tube strokes become bodies too ("draw a ball, watch it roll down the stairs").
- Stretch: soft bodies/cloth on sketch strokes, imported glTF meshes as colliders alongside splats (hence agnostic).
- **Done when:** a segmented object falls onto the scanned floor and comes to rest believably.

### Phase 7 — Polish & pitch
- Toolbar with icons, shortcuts (`B` brush, `E` erase, `S` select, `G` grab, `[ ]` size, `Ctrl+Z/Y`, `Space` physics), 3D cursor ring, sample gallery, project save/load JSON, README, 60-sec demo video, deck.
- Stretch: stroke → polyline export (glTF lines / DXF / Speckle), WebXR mode (Spark supports it), WebGPU renderer toggle.

---

## 6. Suggested split (3–4 people)

- **A — Renderer/data:** Phase 1, 2; perf; layer sync; export; then Phase 6 (physics proxies).
- **B — Brushes/UX:** Phase 3, 4, 7 (owns `brush/`, `ui/`).
- **C — Segmentation:** voxel grid + picking (shared with B), Phase 5; SAM track.
- **D (if 4):** undo system, layers panel, physics loop + interactions, demo content.
- Everyone: collect 4–5 good demo splats on day 0 (see Appendix A).

---

## 7. Repo layout

```
splatypus/
  PLAN.md  README.md
  .github/workflows/pages.yml       # build app/ → deploy to Pages
  app/
    vite.config.ts                  # base: '/splatypus/'
    public/samples/                 # 2–3 small splats
    src/
      main.ts                       # boot, loop
      scene/                        # renderer, camera, controls, grid, 3D cursor, framing
      splats/                       # SplatStore, layers, PackedSplats sync, ply read/write (workers)
      spatial/                      # voxel grid, ray pick, connectivity, RANSAC plane
      brush/                        # BrushEngine, sampling, stamps, presets, edit brushes
      select/                       # sphere/box/lasso, flood, SAM bridge
      physics/                      # Rapier world, proxy builders, sync
      commands/                     # undo/redo
      ui/                           # toolbar, panels, shortcuts, HUD
      io/                           # drag-drop, url loading, file save, project json
  docs/                             # notes, pitch
```

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Surface picking in a fuzzy cloud feels wrong | nearest-center-within-radius along ray + depth bias; depth-lock; "surface offset" slider; stretch: GPU depth pick |
| Large scans → slow edits | cap demo scenes ~1–2 M splats (prune in SuperSplat beforehand); workers; bake only dirty layers |
| Spark float16 centers lose precision on big scenes | recenter on import (Phase 1 auto-center) |
| SAM-in-browser too slow / model download on conference Wi-Fi | keep it a stretch; connectivity + flood segmentation is the demo-safe path; pre-cache weights on the demo laptop |
| Physics proxies look wrong (objects sink/float) | sphere-compound colliders slightly shrunk; RANSAC floor; tune restitution low; demo with chunky objects |
| WebGL2 vs "WebGPU" narrative | say it straight: renderer-agnostic data model; WebGPU path = three.js native, roadmap/toggle |
| Scope creep | Phase 1 → 2 → 3 are the gate. Phases 5/6 are only attacked by people not on the critical path |

---

## Appendix A — Getting splats (out of scope for the app, in scope for the demo)

We need 4–5 good `.ply` scenes before demo day. Sources, easiest first:
- **Public samples:** Spark / SuperSplat / Polycam gallery assets; Brush sample scenes.
- **Phone apps that export splat PLY:** Polycam, Scaniverse, Luma — fastest way to capture a Boston scene on day 0.
- **Brush** (Rust, open source, runs on Win/Mac/Linux): needs posed images — `ffmpeg` frames → COLMAP/GLOMAP (or `ns-process-data video`, or VGGT) → `brush train … --with-viewer` → `.ply`. ~5–15 min on a GPU. Also has an in-browser WebGPU build (Chrome 134+) that trains from a zip of posed images — a possible future "no-server pipeline" if poses come from an ARKit/ARCore capture app (NeRFCapture, Polycam raw export).
- Clean up in **SuperSplat** (crop, prune floaters, downsample to ~1–2 M splats) before dropping into Splatypus.

Future product direction (not hackathon): "Import video" button talking to a pluggable reconstruction service — local sidecar on a GPU laptop, or a cloud GPU (Modal/RunPod) — while the editor stays a static site.

---

## Appendix B — Sources

- Spark — https://sparkjs.dev/ · https://github.com/sparkjsdev/spark · editing: https://sparkjs.dev/docs/splat-editing/ · PackedSplats: https://sparkjs.dev/docs/packed-splats/ · Spark 2.0 LoD: https://www.worldlabs.ai/blog/spark-2.0
- three.js native Gaussian splats (r186) — https://ben3d.ca/blog/gaussian-splatting-for-threejs · https://github.com/mrdoob/three.js/pull/33950
- SuperSplat — https://github.com/playcanvas/supersplat · editing docs: https://developer.playcanvas.com/user-manual/supersplat/editor/editing-splats/
- Viewer comparison 2026 — https://swyvl.io/blog/best-gaussian-splat-viewers/
- SplatPainting (SIGGRAPH 2025) — https://splatpainting.github.io/ · Splatshop — https://github.com/m-schuetz/Splatshop
- Brush — https://github.com/ArthurBrussee/brush · 0.2 notes: https://radiancefields.com/brush-0-2-released
- Rapier — https://rapier.rs/ (JS: `@dimforge/rapier3d-compat`)
- transformers.js (SAM in browser) — https://huggingface.co/docs/transformers.js
