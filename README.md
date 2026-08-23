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
| `Tab`                              | Toggle orbit/fly mode (also the first button of the bottom-left camera cluster)      |
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

Choose **Brush ▸ Sketch** in the bottom toolbar (the Brush button opens a flyout of all the paint tools: Sketch, Erase, Recolor, Fade, Grab, Inflate) or press `S`, then draw with the left button. The **SKETCH** panel controls the preset, colour, world-space size, opacity, pressure response, and placement:

- **Surface** follows scan hits, bridges small gaps at the last depth, and biases the stroke slightly toward the camera so it remains visible on the scan.
- **Lock depth** fixes a camera-facing plane at the first hit, which is useful for drawing Tube strokes in empty space.
- **Plane** draws on the world ground plane (`y = 0`).

**Ink** is a camera-facing ribbon, **Tube** is round and view-independent, **Marker** is wide and translucent, and **Spray** creates deterministic scattered blobs. Mouse input uses full pressure; a pen changes width and opacity when **Pressure** is enabled. Right-drag, middle-drag, or `Alt`+left-drag keeps the camera available while drawing.

The first stroke creates an undoable `Sketch` layer. Later strokes append to the active unlocked sketch layer, or the topmost unlocked sketch layer. Sketch layers use the same visibility, lock, duplicate, merge, delete, solo, floor, transform, undo, and export tools as scan layers. Choose **Erase** or press `X`, then drag over the scene: like Photoshop's eraser it hides every splat of the **active layer** under the brush (the brush uses the SKETCH size in screen pixels), sketch or scan alike, as one undoable step.

PLY export bakes sketch gaussians with their colour, opacity, placement, and layer transform. Re-import preserves their rendered splats, but standard PLY has no vector-stroke metadata, so a re-imported export behaves as a scan rather than retaining stroke-level erase handles.

## Layers and transforms

The **LAYERS** panel lists the topmost layer first. Click to select, Ctrl/Cmd-click to toggle, and Shift-click to select a range. Its toolbar adds, duplicates, merges, deletes, and reorders layers. Double-click a layer name to rename it. Eye, lock, rename, order, transforms, duplicate, merge, delete, and point-cloud parameter changes participate in undo/redo.

The transform gizmo appears when exactly one unlocked layer is selected. In scale mode, dragging one axis handle scales along that axis only, a plane handle scales in two axes, and the centre handle scales uniformly. Uniform scale stays a layer transform; non-uniform scale is baked into the splat data on release (centres scaled, each gaussian's covariance re-diagonalised — Spark only renders uniform object scales), as one undoable step. Export bakes each layer's translate/rotate/uniform-scale transform into its splats but intentionally does not bake the viewer-only up-axis root transform.

The right-hand panels (VIEW, LAYERS, SEGMENT) collapse from their headers; the state is remembered per browser. Notifications are colour-coded: lime = info, yellow = warning, amber = error.

## Region selection

Draw over the object and get *those splats* — no bake involved. Pick a method under **Select**
in the bottom toolbar: **Magic wand**, **Rectangle**, **Lasso**, **Polygon** (click corners,
double-click or Enter to close) or **Selection brush**. **Shift** adds to the selection,
**Alt** removes; `Esc` cancels the shape, or clears the selection when there is none in progress.

Each method is **one-shot**: as soon as a selection lands the tool hands the pointer back, so
the next drag orbits the camera instead of starting another shape. A click that selects nothing
leaves the tool armed.

Two things run behind every gesture, both in the **SELECT** panel:

- **Depth gate** — keeps only the splats on the front surface under the shape, so a lasso does
  not also grab the wall behind the object. **Depth** sets how deep the window reaches.
  (On the sample scene this is the difference between 116 k and 72 k splats for the same lasso.)
- **Snap to edges** — lets the boundary settle onto a real edge in the cloud instead of the line
  the hand drew: splats well inside the shape and well outside it compete across the uncertain
  **Band**, along a path that pays to cross a colour change (**Colour** sets how much).

The **Magic wand** skips the tracing entirely — click the object and the selection grows out to
its edges; **Wand** is the budget it has to spend.

Then clean the selection up: **Grow** / **Shrink** by one splat's spacing, **Clean up** to drop
small disconnected pieces, **Keep largest** for just the biggest one, the **Selection brush**
(Alt) to rub out what is left over. **Split to layer** lifts it into its own layer, where the
eraser (`X`) and the edit brushes take over. Everything is one undo step.

The smart tools index the layer the first time they are used (~0.6 s per 250 k splats, announced
by a toast, then cached) and decline above 600 k live splats. Details and measurements:
[docs/REGION_SELECT_NOTES.md](docs/REGION_SELECT_NOTES.md).

## Segmentation and object tools

Segmentation is per layer and index-aligned with the layer's splats. It comes from either a
`.groups` sidecar (baked offline; format in [docs/GROUPS_FORMAT.md](docs/GROUPS_FORMAT.md)) or the
built-in geometric bake:

```sh
node tools/bake-connectivity.mjs scan.ply scan.groups     # offline, tunable (--voxel --colour --slack --min --opacity)
```

In the app, the **SEGMENT** panel runs a bake on the active layer and **Show segmentation**
paints every group in its own flat colour, with a **Blend** slider. **Segment by** picks how:

- **Surface patches** (default) — *partitions* the layer by walking the same colour-aware
  neighbour graph the selection tools use, from seeds spread evenly through the cloud. Every
  splat lands in a patch, so the overlay reads as a real segmentation mask: on the butterfly,
  185 patches at Detail 2 covering **99.8 %**, in ~0.2 s once the layer is indexed.
- **Colour + position** / **Colour only** / **Position only** — the connectivity bake, which
  looks for cells that *match* rather than partitioning, so most splats end up in no group at
  all (55 groups, **11.7 %** covered on the same scene). Still the right tool when you want only
  the confidently-uniform regions, and the only one that works above the 600 k graph limit.

**Detail** sets the patch count (30 → 3000) for Surface patches, and the cell size for the
others. The overlay works while you are selecting: with a region selected everything outside it
is dimmed, so the selection reads against the mask and you can see the patch borders you are
trying to follow. `scan.groups` next to a `?url=`-loaded
`scan.ply` loads automatically; `?groups=<encoded-url>` names one explicitly; dropping a
`.groups` file attaches it to the active (or only) layer — it must cover exactly that layer's
splat count.

Hover a group to see its name; click to select it (the picker prefers the nearest *assigned*
splat); **Split to layer** lifts it into its own `segment` layer, re-originned on its centroid
so the gizmo sits on the object and rotation spins it in place. Splits, crops and all layer
tools are undoable. The bottom toolbar (icons, hover for labels) is split in two: **Tools** on
the left — Select with its Move | Rotate | Scale gumball modes and selection-method flyout,
Brush (flyout of paint tools), Measure, Model (flyout of outline shapes), Crop — and
**Actions** on the right — Undo/Redo, Duplicate, Array, Split to layer, Isolate, Snap to floor,
Delete. A status line above it names the active tool and its keys. The camera cluster in the
bottom-left corner toggles orbit/fly, frames the scene, jumps to the front/right/top views and
toggles the grid (the VIEW panel keeps FOV, fly speed and up axis). The right-hand SELECT,
SKETCH and MODEL panels appear only while their tool is in use; the
**LAYERS** toolbar mirrors **SOLO** (show only this layer — view state), **FLOOR** (drop onto the
grid plane) and **×5** (four more copies in a row). **CROP** shows a box
gizmo (move/resize); **Keep inside** / **Cut inside** hide everything on the wrong side in every
visible unlocked layer (`Ctrl+Z` restores). Hidden splats are never exported.

### AI select (`A`)

Click an object and it is selected — the approach of
[ArtisanGS](https://arxiv.org/abs/2602.10173) (NVIDIA + U Toronto), which segments splats by
propagating a 2D selection mask into 3D rather than by clustering geometry.

Picking the tool locks the camera, renders the view offscreen and runs it through **SAM**
(`Xenova/slimsam-77-uniform`, via transformers.js on ONNX Runtime Web — WebGPU where available,
CPU otherwise). Then: **click** the object, **Alt-click** a region SAM wrongly included, `[` / `]`
to step through the three masks SAM offers for the same clicks, **Enter** (or **Commit
selection**) to lift the mask to 3D. The result becomes an ordinary group, so hover, **Split to
layer**, `.groups` export and project save all work on it unchanged. `Ctrl+Z` undoes it.

Only the first click pays for the image encoder; the embedding is cached for the view, so
refining with negative clicks is near-instant. Moving the camera invalidates it and re-encodes.

**Segment everything** does the whole scene at once, without you clicking each object: it
samples a grid of points over the view (**Detail** sets the grid; 16 → 256 prompts), runs them
all through the mask decoder in batches against the one cached embedding, lifts each mask to 3D
and merges duplicates. Every surviving object becomes a group, the label overlay comes on, and
you click one to select it — the same as after a geometric bake. A few seconds for a typical
view. Undoable.

Deduplication happens in 3D rather than 2D, because two prompts landing on the same chair give
different-looking masks but nearly identical splats. Proposals claim splats **tightest first**:
SAM confidently returns over-inclusive masks among hundreds of prompts, and letting the biggest
claim first hands whole objects to a blob. On a four-object test scene, largest-first found 3
groups — one 51 % on the wrong object, one object missing entirely — while tightest-first found
all 4, each 99–100 % on its own object. The cost is over-segmentation: a chair leg may become
its own group. Shift-click unions groups, which is the cheaper problem to have.

Two controls in the SEGMENT panel decide what "behind" means — the paper's two operators:

- **Depth** — how far behind the front surface a splat may sit and still be taken. This is
  *depth projection*: click a chair, get the chair. At the slider's top stop the test is off and
  it becomes *frustum projection*, taking the whole depth column under the mask, wall included.
- **Grow** — flood-fill hops that repair the silhouette, where a gaussian's centre falls just
  outside a mask its own footprint plainly covers. Too many hops walk from the chair onto the floor.

The model (tens of MB) is fetched from the Hugging Face CDN on first use and cached by the
browser; nothing downloads until you pick the tool, and every other tool works offline.

Limits: this is **single-view**. The far side of the chair is not selected, because nothing here
reasons about geometry the camera cannot see — that is what the paper's multi-view aggregation
does, and it is not implemented (its two components, Cutie mask tracking and a differentiable
rasteriser, have no browser equivalent). Occlusion is approximate: `DepthGrid` bins splat
*centres* at 6 px, so thin or porous surfaces leak. Without WebGPU (Safari, Firefox) inference
falls back to single-threaded CPU wasm and takes seconds per view — GitHub Pages cannot send
COOP/COEP, so `SharedArrayBuffer` and ORT's worker threads are unavailable by construction.

Limits: the connectivity bake is a patch segmenter — it cannot split one connected object on
geometry alone, and the colour constraint over-segments (it splits a shadow from its surface);
it runs on the main thread (a second or two per 200 k splats). Tints and labels are not shown on
layers rendered through the LoD tree (≥ 1.5 M splats), though selection and split still work.
Integration background: [docs/SEGMENTATION_NOTES.md](docs/SEGMENTATION_NOTES.md).

## Edit brushes

Brushes edit the **active layer** under the same pixel-size ring as the pen: **Recolor** (`C`,
tints towards the SKETCH colour), **Fade** (`D`, lowers opacity; Shift restores), **Grab** (`V`,
drags the splats captured under the ring along the screen), **Inflate** (`I`, grows splats; Shift
shrinks), plus the **Eraser** (`X`). Strength and soft/hard edge are in the SKETCH panel; pressure
scales the effect. Each gesture is one undo step; the view is locked while the mouse is down.
Details: [docs/PHASE4_NOTES.md](docs/PHASE4_NOTES.md).

## Measure / scale to reference

Press `M` (ruler in the toolbar), click two points on the active layer — the live readout shows
their distance — then type the real distance and **Scale layer**: the layer is scaled uniformly
about the first point so the two points are that far apart (one undoable transform). Use it to
bring phone scans, point clouds and imported objects to true size before sketching or measuring.

## Mesh layers (draw a face → extrude)

Press `P` and pick a shape in the **MODEL** panel — freeform **polyline** (Enter / double-click /
a click on the first point closes it, Backspace removes a point), **rectangle** (two corners),
regular **polygon** (centre + radius, 3–24 sides) or **circle** (centre + radius). Outlines are
drawn on a horizontal plane whose height comes from the surface under the first click, else the
grid; segment lengths are shown live. Rhino-style numeric entry: once the first point is down,
type a dimension (e.g. `2.25`) and the next click only sets the direction — segment length for a
polyline, radius for a circle/polygon, width `Enter` depth (or `2,1.5`) for a rectangle; Enter
accepts it, Backspace edits it, Escape clears it. **Ortho** mode keeps polyline segments
axis-aligned and snaps gizmo rotations to 15° steps — holding Shift temporarily flips it either
way; the gizmo shows the angle (or scale factor / distance) while you drag. Closing the outline
creates a translucent, unextruded **face** layer in the SKETCH colour: move, rotate or scale it
like any layer (e.g. 90° about X to stand it up), then — with the face selected in the Select
tool — pull the lime arrow that sprouts from its centroid, or type a height in MODEL. Pull as
many times as you like (each pull is an undo step), then **Confirm** (or Enter) to finalise the
mesh, or **Reset** to flatten it. Extrusion is always along the face's own normal, so a rotated
face extrudes sideways. The result is a capped **mesh layer** — moved, rotated, scaled
(non-uniformly too), duplicated, hidden, soloed and undone like any layer, and click-selectable.
Meshes are stored as meshes in the Splatypus project and sampled into flat gaussians when you
export a PLY or merge into a splat layer. Details: [docs/MESH_NOTES.md](docs/MESH_NOTES.md).

Selected layers are easy to spot: a selected mesh draws thick glowing lime edges, and a selected
splat layer is nudged slightly towards lime and brightened (a per-layer shader uniform, so it
costs nothing and the detail stays legible); both revert the moment the layer is deselected.

## Export

Use **EXPORT** in the HUD or `Ctrl/Cmd+E`. The dialog offers two clearly separate choices:

- **PLY** (`.ply`, standard 3D Gaussian Splat) — for other viewers and tools. All visible layers are merged into one splat cloud and meshes are converted to splats; hidden splats, layer structure and edit history are not kept. Options: include hidden layers, include spherical harmonics; the estimated size updates live.
- **Splatypus project** (`.splatypus`, editable) — keeps everything editable: the layer stack, meshes as meshes, transforms, visibility and lock state, live/deleted splats, segmentation groups, sketch strokes, selection, and camera/view state. Opening that file restores the editing workspace; undo/redo history starts empty. Only Splatypus reads it.

Choose **PLY** when you need a standard interoperable file. The dialog can include hidden layers and spherical harmonics. PLY output is binary little-endian standard 3DGS PLY and includes only live splats, so it intentionally flattens the editable project structure. Chrome uses the File System Access API when available; Firefox and Safari use a local download fallback.

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
