# Phase 2 implementation notes

Date: 2026-08-22

## Architecture and format coverage

- Every layer owns a float32 `SplatStore`; its Spark `PackedSplats` is a disposable render cache rebuilt by `viewer/sync.ts`.
- Standard binary little-endian 3DGS PLY and RGB point-cloud PLY are decoded by Splatypus's property-table reader. It accepts `comment`, `obj_info`, normals, mixed scalar types, and unrelated elements. ASCII and big-endian PLY fail with explicit messages.
- Compressed SuperSplat PLY and SPZ use Spark's physical-value callbacks inside the Vite decode worker. The production build proves Spark imports and bundles in the worker; the generated worker is 10.06 MB because it contains Spark's WASM/runtime.
- Antimatter15 `.splat` uses the local 32-byte record parser. KSPLAT/SOG use Spark `unpackSplats` plus `unpackSplat`, restore available packed SH bands, and are marked as quantised imports.
- Imported SH is retained in original 3DGS `f_rest` channel-major order. The render sync remaps it to Spark's band-wise RGB arrays and calls `encodeSh1Rgb` / `encodeSh2Rgb` / `encodeSh3Rgb`; the writer restores/pads the original layout. Visual SH sampling could not be inspected because this agent session exposed no in-app browser target.
- Constructed meshes above 1.5 M live splats call `SplatMesh.createLodSplats()` after construction. The browser/GPU LoD result could not be visually inspected in this session.

## Export and round-trip evidence

`plyWriter.ts` emits the specified byte order and property order, bakes the layer-local transform, excludes the viewer-only root/up-axis transform, compacts dead splats, pads lower SH degrees by colour channel, and omits hidden layers unless requested.

Vitest covers:

1. 1,000 degree-0 splats: bit-identical centres; scales, opacity, colour, and quaternion within `1e-5` (quaternion sign ignored).
2. 1,000 SH3 splats: `f_rest` bit-identical.
3. Two-layer semantics and a translation + 90° rotation + uniform scale 2 transform.
4. Dead and hidden splat omission, including `includeHidden`.
5. Byte-exact degree-0 and degree-3 headers.
6. A 10-splat binary fixture with `obj_info` and normals.

The local test fixture `models/splat.ply` is degree 0, so it does not provide a real-file SH visual check. Its untouched export was parsed back by Splatypus's reader in the round-trip pipeline. SuperSplat upload remains a manual check because the in-app browser was unavailable and the browser skill prohibits substituting another automation backend.

Known export limitation: layer rotations are not applied to SH coefficients. This can create a minor view-dependent colour error, while the stored coefficients remain bit-identical for identity transforms.

## Timings

Measured in Node 22.22.2 on the Phase 1 test laptop (RTX 5070 Ti laptop GPU; these CPU timings do not use the GPU). Each result is the second warm local run. "Pack" is the exact live-store loop through Spark `setPackedSplat`, excluding texture upload and LoD construction.

| File | Source / kept | Input | Decode | Pack | PLY export | Output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `models/splat.ply` | 262,144 / 262,144 | 17,826,208 B | 71 ms | 48 ms | 59 ms | 17,826,245 B |
| `models/Matera_Cave_Museum_7M.ply` | 6,916,463 / 6,916,463 | 103,747,188 B | 706 ms | 433 ms | 1,108 ms | 470,319,938 B |

The 6.9 M-point full-budget pack is below the one-second sync-loop target, and its export is well above the 250 MB large-file acceptance case. Normal UI import still defaults that point cloud to a 3 M-point budget.

## Verification still requiring a browser

The in-app browser discovery list was empty in this agent session. The following acceptance evidence therefore remains manual rather than being overstated:

- Canvas layer picking, TransformControls drag ergonomics, and the four-step undo/redo interaction sequence.
- Rendered SH view-dependent colour and constructed LoD visual behaviour.
- Ten reload/merge cycles with a browser memory profile.
- SuperSplat upload/orientation/colour, Chrome file-picker save, Firefox/Safari download fallback, and the three-browser matrix.

Static checks, unit tests, production build, local real-file decode/export benchmarks, and the deployed Pages workflow are recorded separately in the repository and CI.

## Review addendum (2026-08-22, Claude)

Reviewed Codex's Phase 2 against `PHASE2_SPEC.md`; lint, 17 unit tests and the production build were green on arrival. Browser checks ran in Chrome on the RTX 5070 Ti laptop with the Vite dev server. Changes made during review:

- **SH encoding moved into `constructSplats`** (`viewer/sync.ts`). It previously ran after `mesh.initialized`, and per splat called `store.liveCount()` (a full pass over the alive mask) for every band — O(N²) for SH files — and allocated three `Float32Array`s per splat. Spark also builds its SH textures lazily from `extra.sh*` when the generator is first compiled, so encoding after initialisation risked a DC-only first frame. Now one pass, reused band buffers, `setMaxSh` once.
- **Sync race**: `layer.dirty` is cleared at the *start* of a sync and `Layer.sync()` re-runs if the store was dirtied while a rebuild was in flight (previously a second edit during a sync was silently dropped).
- **Point-size fast path**: `SetPointScale` patches packed scales in place (`rescaleLayerInPlace`) when the mesh has no LoD tree; only LoD meshes (≥ 1.5 M) rebuild. The store is updated in both cases so export stays correct.
- **Gizmo drag no longer emits `layer-changed` per frame** — it was triggering a full layers-panel re-render, Tweakpane refresh, HUD refresh and a grid rebuild (with a 200 k-sample percentile sort per layer) every animation frame. The `SetLayerTransform` command on mouse-up notifies once. `SplatStore.computeRobustBounds()` is now cached (`invalidateBounds()` for later phases that mutate centres/alive).
- **Click selection**: Spark's raycast misses sparse point clouds (the ray slips between 1–2 cm gaussians), so `Viewer.onPointerUp` now falls back to the screen-space nearest centre (12 px), like double-click retargeting. A click on a gizmo handle no longer clears the selection (`LayerGizmo.isInteracting`).
- **Point-cloud radius regression**: `readStandardPly` estimated spacing from the *source* count while only the decimated points are kept; with the default 3 M budget on the 6.9 M Matera scan points were √3 too small. Now uses the kept count (Phase 1 behaviour).
- **No auto-selection after Open** (the gizmo appeared on every freshly opened scene). The VIEW › Point cloud folder falls back to the only layer when nothing is selected.
- `DuplicateLayer` shares the immutable source bytes instead of copying them (100 MB per duplicate for point clouds).
- Dev-only console hook: `window.__splatypus = { viewer, imports }` and `Viewer.renderOnce()` (guarded by `import.meta.env.DEV`) — used for headless/background-tab testing.

Browser evidence (Chrome, RTX 5070 Ti):

| Step | Result |
| --- | --- |
| `?sample=Butterfly` (SPZ, SH3) | decode 447 ms in worker, sync 128 ms, view-dependent colour renders, 240 fps |
| Shift-add `models/splat.ply` | 2 layers · 439 k; decode 215 ms, sync 44 ms |
| Gizmo translate drag → Ctrl+Z ×2 → Ctrl+Shift+Z, Ctrl+Y | transform and add undone/redone in order; labels correct |
| DUP → MRG (2 × 262 k) → undo → redo → MRG with Butterfly (SH0 + SH3) → undo | merged counts 524 288 / 701 420, SH padded, originals restored in order |
| Export (fallback `<a download>`, SH on) | 173 953 728 B in ~4 s, header byte-exact, 701 420 vertices |
| Reopen the export | decode 1 122 ms, sync 268 ms, identical look, SH3 retained |
| Matera 6.9 M RGB cloud, 3 M budget | fetch+decode+pack+LoD 6.4 s total (decode 868 ms, pack+LoD 4 978 ms), Z-up, 240 fps |
| Canvas click selects / empty click clears | 14 ms / 33 ms with the screen-space fallback |

Not verified here: Firefox/Safari, SuperSplat import of the export (header and values match the reference 3DGS layout; please drag one export onto https://superspl.at/editor), 10× reload memory profile.
