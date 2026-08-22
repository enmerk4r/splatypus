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

## Coordinate convention

3D Gaussian Splatting files are normally Y-down. Splatypus applies a 180° rotation about X after loading so the viewer, grid, and OrbitControls use the three.js Y-up convention. The source coordinates are not modified. Disable **Flip Y** in the View panel for files that are already Y-up.

## Deploy

Deploy: repo Settings → Pages → Source: GitHub Actions.

Every push to `main` runs the Pages workflow, builds `app/`, and deploys `app/dist`. Vite uses a relative base path, so the same artifact works on a project Pages URL or a custom domain.

## Known issues

- Remote files must be served with CORS headers. If they are not, download the file and drop it into the viewer.
- Large PLY files are parsed on the main thread in Phase 1, so interaction may pause briefly during the visible **Parsing…** state.
- Spark raycasting is synchronous and can take a moment on multi-million-splat scenes; it only runs on double-click.
- Desktop Chrome, Firefox, and Safari are the Phase 1 targets. Mobile layouts are usable but are not part of the acceptance gate.

The broader roadmap is in [PLAN.md](PLAN.md), with the Phase 1 implementation contract in [docs/PHASE1_SPEC.md](docs/PHASE1_SPEC.md).
