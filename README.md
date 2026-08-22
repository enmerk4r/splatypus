# Splatypus

Splatypus is a local-first Gaussian splat editor built for AECtech 2026 Boston. Open a scan, organise files into layers, sketch directly on its surfaces or in 3D, and export a standard 3DGS PLY without uploading data to a server.

Splatypus supports standard and compressed `.ply`, `.spz`, `.splat`, `.ksplat`, and `.sog` files through drag-and-drop or the file picker. It can also open CORS-enabled remote files with `?url=<encoded-url>` and bundled gallery entries with `?sample=<name>`. Decoding runs in a worker, and float32 CPU data—not the quantised render texture—is the source of truth.

## Run locally

Node 20 LTS is the supported runtime.

```sh
cd app
npm ci
npm run dev
```

For a production build and local preview:

```sh
cd app
npm run build
npm run preview
```

Quality checks run with `npm run lint` and `npm test`.

## Controls

| Input                              | Action                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| Left drag                          | Orbit in Select; draw/erase in Sketch/Erase; look around in fly mode                 |
| Right drag                         | Pan in Select; orbit while Sketch/Erase is active                                    |
| Middle drag                        | Dolly while Sketch/Erase is active                                                   |
| `Alt`+left drag                    | Orbit while Sketch/Erase is active                                                   |
| Scroll                             | Zoom to cursor; in fly mode, change speed                                            |
| Double-click                       | Move the orbit target to the splat surface                                           |
| `F`                                | Frame the loaded scene                                                               |
| `Tab`                              | Toggle orbit/fly mode                                                                |
| `W` `A` `S` `D`                    | Move in fly mode                                                                     |
| `Q` / `E`                          | Move down/up in fly mode                                                             |
| `Shift`                            | Fly at 4× speed                                                                      |
| `Esc`                              | Exit fly mode                                                                        |
| `G`                                | Toggle the grid                                                                      |
| `Q` / `S` / `X`                    | Select / Sketch / Erase stroke in orbit mode                                         |
| `[` / `]`                          | Decrease/increase sketch size                                                        |
| `Shift`+`[` / `]`                  | Decrease/increase sketch opacity                                                     |
| `O`                                | Open the file picker                                                                 |
| `Shift+O`                          | Add one or more files as layers                                                      |
| `W` / `E` / `R`                    | Translate / rotate / uniformly scale the active layer                                |
| `Esc`                              | Cancel the active stroke and clear the layer selection; in fly mode, return to orbit |
| `Delete` / `Backspace`             | Delete selected unlocked layers                                                      |
| `Ctrl/Cmd+Z`                       | Undo                                                                                 |
| `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y` | Redo                                                                                 |
| `Ctrl/Cmd+E`                       | Export a standard 3DGS PLY                                                           |
| Click                              | Select the layer under the cursor — and its group, when the layer is segmented       |
| `1` / `3` / `7`                    | Front/right/top view                                                                 |

Shift-drop adds a single file to the current document. Dropping multiple files always adds each as a layer. An ordinary single-file drop or **Open** replaces the scene after an unsaved-changes guard.

## Sketching

Choose **Sketch** in the bottom toolbar or press `S`, then draw with the left button. The **SKETCH** panel controls the preset, colour, world-space size, opacity, pressure response, and placement:

- **Surface** follows scan hits, bridges small gaps at the last depth, and biases the stroke slightly toward the camera so it remains visible on the scan.
- **Lock depth** fixes a camera-facing plane at the first hit, which is useful for drawing Tube strokes in empty space.
- **Plane** draws on the world ground plane (`y = 0`).

**Ink** is a camera-facing ribbon, **Tube** is round and view-independent, **Marker** is wide and translucent, and **Spray** creates deterministic scattered blobs. Mouse input uses full pressure; a pen changes width and opacity when **Pressure** is enabled. Right-drag, middle-drag, or `Alt`+left-drag keeps the camera available while drawing.

The first stroke creates an undoable `Sketch` layer. Later strokes append to the active unlocked sketch layer, or the topmost unlocked sketch layer. Sketch layers use the same visibility, lock, duplicate, merge, delete, solo, floor, transform, undo, and export tools as scan layers. Choose **Erase stroke** or press `X`, then click or drag across strokes; erasing hides each whole vector stroke and is undoable.

PLY export bakes sketch gaussians with their colour, opacity, placement, and layer transform. Re-import preserves their rendered splats, but standard PLY has no vector-stroke metadata, so a re-imported export behaves as a scan rather than retaining stroke-level erase handles.

## Layers and transforms

The **LAYERS** panel lists the topmost layer first. Click to select, Ctrl/Cmd-click to toggle, and Shift-click to select a range. Its toolbar adds, duplicates, merges, deletes, and reorders layers. Double-click a layer name to rename it. Eye, lock, rename, order, transforms, duplicate, merge, delete, and point-cloud parameter changes participate in undo/redo.

The transform gizmo appears when exactly one unlocked layer is selected. In scale mode, dragging one axis handle scales along that axis only, a plane handle scales in two axes, and the centre handle scales uniformly. Uniform scale stays a layer transform; non-uniform scale is baked into the splat data on release (centres scaled, each gaussian's covariance re-diagonalised — Spark only renders uniform object scales), as one undoable step. Export bakes each layer's translate/rotate/uniform-scale transform into its splats but intentionally does not bake the viewer-only up-axis root transform.

The right-hand panels (VIEW, LAYERS, SEGMENT) collapse from their headers; the state is remembered per browser. Notifications are colour-coded: lime = info, yellow = warning, amber = error.

## Segmentation and object tools

Segmentation is per layer and index-aligned with the layer's splats. It comes from either a
`.groups` sidecar (baked offline; format in [docs/GROUPS_FORMAT.md](docs/GROUPS_FORMAT.md)) or the
built-in geometric bake:

```sh
node tools/bake-connectivity.mjs scan.ply scan.groups     # offline, tunable (--voxel --colour --slack --min --opacity)
```

In the app, the **SEGMENT** panel runs the same bake on the active layer (**Segment by**
colour + position / position only, **Detail** 1–5), and **Show labels** paints every group in its
own colour (grey = unassigned) with a **Blend** slider. `scan.groups` next to a `?url=`-loaded
`scan.ply` loads automatically; `?groups=<encoded-url>` names one explicitly; dropping a
`.groups` file attaches it to the active (or only) layer — it must cover exactly that layer's
splat count.

Hover a group to see its name; click to select it (the picker prefers the nearest *assigned*
splat); **Split to layer** lifts it into its own `segment` layer, re-originned on its centroid
so the gizmo sits on the object and rotation spins it in place. Splits, crops and all layer
tools are undoable. The bottom **object toolbar** (icons, hover for labels) holds the per-object
tools: split, move/rotate/scale, duplicate, array ×5, merge, isolate, snap to floor, delete; the
**LAYERS** toolbar mirrors **SOLO** (show only this layer — view state), **FLOOR** (drop onto the
grid plane) and **×5** (four more copies in a row). **CROP** shows a box
gizmo (move/resize); **Keep inside** / **Cut inside** hide everything on the wrong side in every
visible unlocked layer (`Ctrl+Z` restores). Hidden splats are never exported.

Limits: the connectivity bake is a patch segmenter — it cannot split one connected object on
geometry alone, and the colour constraint over-segments (it splits a shadow from its surface);
it runs on the main thread (a second or two per 200 k splats). Tints and labels are not shown on
layers rendered through the LoD tree (≥ 1.5 M splats), though selection and split still work.
Integration background: [docs/SEGMENTATION_NOTES.md](docs/SEGMENTATION_NOTES.md).

## Export

Use **EXPORT .PLY** in the HUD or `Ctrl/Cmd+E`. The dialog can include hidden layers and spherical harmonics. Output is binary little-endian standard 3DGS PLY and includes only live splats. Chrome uses the File System Access API when available; Firefox and Safari use a local download fallback.

## Coordinate convention

3D Gaussian Splatting files are normally Y-down. Splatypus applies a 180° rotation about X after loading so the viewer, grid, and OrbitControls use the three.js Y-up convention. The source coordinates are not modified. Use **Up axis** in the VIEW panel to override: `Y-down (3DGS)` (default for splats), `Y-up`, or `Z-up (scans)` (default for RGB point clouds, which usually come from LiDAR/CloudCompare).

## Large scenes and performance

- **Check the GPU row in the HUD first.** On laptops with two GPUs Chrome often runs on the integrated one (`ANGLE (Intel …)`), which is several times slower for splats. Force the discrete GPU in Windows *Settings → System → Display → Graphics → add Chrome → High performance* (macOS picks automatically), then restart Chrome.
- Splat files above 1.5 M splats are loaded with Spark's load-time **level-of-detail tree** (built in a worker, ~1–3 s per million splats) and rendered as a view-dependent subset, so very large scans stay interactive.
- **RGB point clouds** (`x y z red green blue` PLY from CloudCompare/Open3D/LiDAR) are not Gaussian splats but are supported: each point becomes a small isotropic Gaussian whose radius is estimated from point spacing. They are capped at a **point budget** (default 3 M, stride-decimated) and can be resized/rebudgeted in *VIEW › Point cloud*. Point clouds render without LoD, so frame rate scales with the budget.
- **Render scale** (*VIEW › Performance*) lowers the internal resolution for fill-rate-bound scenes.

## Deploy

Deploy: repo Settings → Pages → Source: GitHub Actions.

Every push to `main` runs the Pages workflow, builds `app/`, and deploys `app/dist`. Vite uses a relative base path, so the same artifact works on a project Pages URL or a custom domain.

## Known issues

- Remote files must be served with CORS headers. If they are not, download the file and drop it into the viewer.
- ASCII and big-endian PLY are unsupported; use binary little-endian PLY.
- KSPLAT/SOG imports start from Spark's quantised representation and are therefore lossy. Splatypus shows a one-time notice when importing them.
- Rotating a layer does not rotate its SH coefficients, so view-dependent colour can differ slightly after export even though geometry, DC colour, and SH values are retained.
- Remote `?url=` files are fully downloaded before parsing (no streaming) so that the same PLY compatibility fixes apply to local and remote files.
- Spark raycasting is synchronous and can take a moment on multi-million-splat scenes; Splatypus uses it only for deliberate canvas selection and double-click retargeting.
- Desktop Chrome, Firefox, and Safari are the targets. Mobile layouts are usable but are not part of the acceptance gate.

The broader roadmap is in [PLAN.md](PLAN.md), with implementation contracts and notes in [`docs/`](docs/).
