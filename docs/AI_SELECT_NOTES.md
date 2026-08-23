# AI select — SAM click-to-segment

Implements tier 3 of `PLAN.md` Phase 5, following
[ArtisanGS: Interactive Tools for Gaussian Splat Selection with AI and Human in the Loop](https://arxiv.org/abs/2602.10173)
(NVIDIA + University of Toronto).

## What the paper does, and what this does

ArtisanGS keeps a **2D mask per view** and a **3D mask over all Gaussians**, and projects
between them. Two of its four pieces port to a browser; two do not.

| ArtisanGS | Here |
|---|---|
| Frustum projection — take every Gaussian whose centre projects inside the mask | `liftMask` with `depthTolerance: Infinity` |
| Depth projection — the same, minus what hides behind the front surface | `liftMask` with a finite tolerance |
| SAM positive/negative clicks | SlimSAM-77 via transformers.js on ONNX Runtime Web |
| Cutie video-object tracking across ~50 views | **Not implemented.** No browser port exists. |
| 3D aggregation by optimising a per-Gaussian feature through a differentiable rasteriser | **Not implemented.** Spark is a forward WebGL2 renderer. |

So this is **single-view selection with human-in-the-loop correction**, which is the half of
the paper that a static web app can actually deliver. The correction loop is not a
consolation prize — it is most of what makes the paper's tool usable, and SAM's own
negative-point prompts provide it without any mask algebra of our own.

Multi-view aggregation is deliberately out of scope. Substitutes exist (re-project the 3D
mask into each new view as a SAM prompt; aggregate by per-Gaussian weighted voting instead
of gradient descent) but they are a separate piece of work with a real performance budget.

## Design decision: no new selection primitive

The paper needs a free per-splat binary mask with New/Add/Subtract/Intersect. This app's
selection is group-id based (`GroupSelection`). Rather than build a parallel `SplatMask`
type, a SAM result lands as **a new group** in the layer's `GroupMap`, via
`withAddedGroup` → `Segmentation.selectIndices` → `SetGroups` (undoable).

That was affordable because every downstream command — `SplitSplats`, `SetSplatsAlive`,
`EditSplats` — already takes a `Uint32Array` of indices. The whole existing pipeline (green
tint, hover labels, overlay palette, split-to-layer, `.groups` export, `.splatypus`
persistence) therefore works on a SAM selection with **no format change and no version bump**.

What it costs: no 3D-set Subtract/Intersect. Negative clicks cover the same need in 2D, and
shift-click already unions groups. If a later phase needs true mask algebra, `SplatMask`
can be added alongside `GroupSelection` without disturbing this path.

## Why the interaction is shaped this way

SAM splits into a slow image encoder and a fast mask decoder. `SamSession` caches
`get_image_embeddings` per view, so entering the tool pays the encode once and every click
after that is decoder-only. This is why the camera is locked while the tool is active:
moving it invalidates the embedding.

`AiSelectTool.sequence` guards against a slow decode landing after a newer one — clicks
arrive faster than inference returns.

## Implementation notes worth keeping

- **`Viewer.captureFrame` renders at the canvas drawing-buffer size, deliberately.** A
  `SparkRenderer` with no `target` of its own reads `renderSize` from
  `renderer.getDrawingBufferSize()` regardless of which framebuffer is bound
  (`spark.module.js`, `onBeforeRender`), so a render target of any other size computes every
  splat's pixel radius for the wrong resolution. Downscaling to SAM's input happens
  afterwards on the CPU, where it is only a resampling.
- The canvas has no `preserveDrawingBuffer`, so the frame cannot simply be read off the
  canvas after a render — hence the render target.
- The grid and the gizmo are hidden for the capture. SAM will happily segment the gizmo arrows.
- **`env.backends.onnx.wasm.numThreads = 1` is required, not an optimisation.** GitHub Pages
  cannot send COOP/COEP, so `SharedArrayBuffer` is unavailable and ORT cannot spawn workers.
  Every ORT wasm binary is named `*-threaded*` — that is the build, not the mode; threading
  is a runtime choice, and this is how it is turned off.
- transformers.js points `wasmPaths` at jsDelivr by default, but Vite also emits a local
  copy of the ORT wasm (~23 MB) as a fallback. It is referenced, not dead, but it is most of
  the deploy's size growth. Worth revisiting if the Pages artefact becomes a problem.
- `DepthGrid` covers the **whole document**, so an occluder in another layer correctly
  rejects a splat. That came free and is the right semantics.

## Segment everything (automatic mask generation)

`select/autoSegment.ts`. A grid of points is sampled over the view and every one is prompted;
survivors become groups. Three things make it affordable and correct:

- **Batched prompts.** The decoder takes a `point_batch` dimension: `input_points` shaped
  `[1, P, 1, 2]` returns `pred_masks [1, P, 3, 256, 256]`. P prompts cost roughly one call.
- **Raw logits, not `post_process_masks`.** That helper upsamples every candidate to full
  resolution — hundreds of MB for a grid. The 256×256 logits are cropped to the
  image-bearing corner (`cropLowResMask`) and used directly; `liftMask` already scales a
  mask of any resolution.
- **One projection cache.** `projectToMaskCells` resolves every splat to a mask cell and
  applies the depth test once, so each of the hundreds of candidates costs one array lookup
  per splat rather than a fresh projection. This is the difference between seconds and minutes.

### Ordering is the whole ball game

`partitionProposals` takes proposals **smallest first**. This was measured, not assumed — an
earlier largest-first version was wrong. On a synthetic four-object scene (64 prompts):

| Order | Result |
|---|---|
| Largest first | 3 groups; one 51 % on the wrong object; one object missing |
| By predicted IoU | 3 groups; same blob failure |
| **Smallest first** | **4 groups, each 99–100 % on its own object** |

SAM returns confidently over-inclusive masks — a blob spanning two objects and the floor
between them, with a stability score (0.97) as high as the good masks, so stability filtering
does *not* separate them. Only claim order does. The cost is over-segmentation, which
shift-click fixes; a blob that swallowed two objects cannot be fixed.

## Bug found by probing: prompt coordinate space

`pointsToImageSpace` originally sent capture-pixel coordinates straight to the model. The
processor normally applies `reshape_input_points`, scaling by `reshaped/original` — bypassing
the processor means carrying that factor yourself. Symptom: clicks land short of where the
user pointed, by `reshapedLongEdge / captureLongEdge`.

It hid well: `captureFrame` caps the long edge at 1024 and the processor resizes to 1024, so
the factor is exactly 1 whenever the canvas drawing buffer is ≥ 1024 on its long edge — most
desktop windows at DPR 2. It only misbehaves on small windows or DPR 1. `promptScale` now
composes both resizes.

This is worth knowing because the same trap applies to any future prompt type (boxes, masks):
anything handed directly to the model, rather than through the processor, is in reshaped space.

## Known sharp edges

- **LoD layers (≥ 1.5 M splats) show no tint** — Spark renders its own LoD copy, so
  `paintSplats` into the base packed array is invisible. The selection is real but the user
  cannot see it, on exactly the scenes where they need it most. Pre-existing; group selection
  has always had this. Fixing it means a throwaway overlay `SplatMesh` built from the
  selection.
- Depth projection bins splat *centres* at 6 px, so thin or porous surfaces leak. The
  paper's differentiable aggregation handles this properly and we cannot.
- A sparse enough surface is genuinely see-through, and the depth test then correctly keeps
  what is visible behind it. This surprises people; it is not a bug. `tests/maskLift.test.ts`
  documents it.
- `SplitSplats` still does not set the split indices to `UNASSIGNED` in the source's
  `GroupMap` (pre-existing).

## Tests

`tests/maskLift.test.ts` is the one that matters: two dense planes, one behind the other, and
the assertion that frustum projection takes both while depth projection takes only the front.
`tests/maskDecode.test.ts`, `tests/framePixels.test.ts` and `tests/aiGroups.test.ts` cover
tensor unpacking, the WebGL row flip and downscale, and the group commit with undo.

Not unit-tested, and kept deliberately thin for that reason: `SamSession` (network + ORT) and
`Viewer.captureFrame` (WebGL). All logic they would otherwise hold lives in `ai/maskDecode.ts`
and `ai/framePixels.ts`.
