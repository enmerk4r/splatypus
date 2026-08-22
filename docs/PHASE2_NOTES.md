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
