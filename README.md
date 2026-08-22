# Splatypus

Splatypus is a local-first Gaussian splat viewer built for AECtech 2026 Boston. Open a scan, orbit or fly through it, and inspect it without uploading the file to a server.

Phase 1 supports `.ply`, compressed `.ply`, `.spz`, `.splat`, `.ksplat`, and `.sog` files through drag-and-drop or the file picker. It can also open CORS-enabled remote files with `?url=<encoded-url>` and bundled gallery entries with `?sample=<name>`.

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

Quality checks run with `npm run lint`.

## Segmentation

Splatypus does not segment a scene itself — segmentation is **baked offline** into a
`.groups` sidecar that sits next to the splat file, and the viewer treats it as a lookup
table. Clicking an object is then an array read, so selection is instant no matter how
expensive the segmentation was to produce, and a scene can be re-baked with a better
segmenter without touching the viewer. The format is in
[docs/GROUPS_FORMAT.md](docs/GROUPS_FORMAT.md).

Bake a scene with the built-in geometric segmenter:

```sh
node tools/bake-connectivity.mjs scan.ply scan.groups
```

The viewer loads `scan.groups` automatically beside a `?url=`-loaded splat. You can also
drop a `.groups` file onto an open scene, or point at one explicitly with
`?groups=<encoded-url>`.

Then: click an object to select its group, **Split to layer** to lift it out of the scan
into its own mesh, and drag the gizmo to move it. A split segment is re-originned on its
own centroid, so the gizmo sits on the segment and rotation turns it about itself; moving
it is a transform on an `Object3D`, and the splat data is never touched. Clicking a
segment in the scene re-selects it, so it stays reachable after being moved away.

The **Segment by** control re-runs the geometric bake in the viewer, without the
round trip through the CLI. *Colour + position* is the useful mode; *Position only* is
there to show what geometry alone can do, which on a single connected object is nothing.
*Detail* trades coverage against separation — coarser cells put more of the scene into
fewer, larger groups. If the scene arrived with a `.groups` sidecar you can always go
back to it, so re-segmenting is not a one-way door. The CLI still has the full parameter
set; the panel exposes the two knobs worth sweeping interactively.

`tools/bake-connectivity.mjs` runs connected components over splat centres, constrained
by colour similarity. It is fast and needs no models, but it is a local heuristic: it
cannot split a single connected object on geometry alone, and the colour constraint that
rescues that case over-segments, splitting a shadow from the surface it falls on. Tune it
with `--voxel`, `--colour`, `--slack`, `--min` and `--opacity`; splats it cannot
confidently label are left unassigned and are not selectable.

## Controls

| Input | Action |
| --- | --- |
| Left drag | Orbit; in fly mode, look around |
| Right drag | Pan |
| Scroll | Zoom to cursor; in fly mode, change speed |
| Double-click | Move the orbit target to the splat surface |
| `F` | Frame the loaded scene |
| `Tab` | Toggle orbit/fly mode |
| `W` `A` `S` `D` | Move in fly mode |
| `Q` / `E` | Move down/up in fly mode |
| `Shift` | Fly at 4× speed |
| `Esc` | Exit fly mode |
| `G` | Toggle the grid |
| `O` | Open the file picker |
| `1` / `3` / `7` | Front/right/top view |
| Click | Select the group under the cursor (needs a `.groups` sidecar) |

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
- Large PLY files are parsed on the main thread in Phase 1, so interaction may pause briefly during the visible **Parsing…** state (several seconds for a 100 MB point cloud).
- Remote `?url=` files are fully downloaded before parsing (no streaming) so that the same PLY compatibility fixes apply to local and remote files.
- Spark raycasting is synchronous and can take a moment on multi-million-splat scenes; it only runs on double-click.
- Desktop Chrome, Firefox, and Safari are the Phase 1 targets. Mobile layouts are usable but are not part of the acceptance gate.
- Deleting a split layer hides its splats rather than removing them. There is no undo yet, so a delete stands until the scene is reloaded.
- The connectivity bake runs on the main thread and takes a second or two on a 260k-splat scene, during which the page is unresponsive.
- Groups carry no semantic labels — a group is a connected patch, not a named object. Labels would come from an ML bake such as Gaga.
- Segmentation is unavailable on scenes large enough to trigger the level-of-detail tree (`LOD_ABOVE_SPLATS`), because LoD renumbers splats and `.groups` is addressed by splat index. The panel says so rather than failing silently.

The broader roadmap is in [PLAN.md](PLAN.md), with the Phase 1 implementation contract in [docs/PHASE1_SPEC.md](docs/PHASE1_SPEC.md).
