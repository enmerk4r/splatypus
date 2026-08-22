# Phase 1 Spec — Splat Viewer (open a splat, orbit it, ship it to GitHub Pages)

This is a self-contained brief for an implementing agent/developer. Read `../PLAN.md` §2–§4 for context; **this document is authoritative for Phase 1.** If something here conflicts with an assumption you'd otherwise make, follow this document. If you hit a genuine blocker, stop and report it (with what you tried) rather than working around it with a different architecture.

## 0. Goal & non-goals

**Goal:** a static web app in `app/` that opens a Gaussian splat file, lets the user orbit/fly around it smoothly, and is deployed to GitHub Pages by a GitHub Action on push to `main`.

**Non-goals (do NOT build in Phase 1):** editing, brushes, undo, layers panel, PLY writing, segmentation, physics, React or any UI framework, a backend. Do not add abstractions for future phases beyond the one seam named in §5.

**Definition of done:** everything in §9 passes, on the deployed Pages URL, in Chrome + Firefox + Safari (desktop).

## 1. Stack — exact

| | |
|---|---|
| Node | 20 LTS |
| Scaffold | `npm create vite@latest app -- --template vanilla-ts` |
| three.js | `three@^0.180.0` (Spark requires `>=0.180.0`; pin the exact version you install) + `@types/three` |
| Splat renderer | `@sparkjsdev/spark@^2.1.0` — ESM, `import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark"` |
| UI panel | `tweakpane@^4` (settings only) |
| Lint/format | ESLint (typescript-eslint, flat config) + Prettier; `npm run lint` must pass |
| TS | `strict: true`, `noUncheckedIndexedAccess: true` |

No other runtime dependencies. No stats.js (write a ~20-line fps counter). No GSAP/tween libs.

## 2. Repo layout to create

```
.github/workflows/pages.yml
app/
  index.html
  vite.config.ts
  package.json  tsconfig.json  eslint.config.js  .prettierrc
  public/samples/samples.json        # gallery manifest (URLs, not binaries — see §4.1)
  src/
    main.ts                          # boot only: create Viewer, wire UI
    viewer/Viewer.ts                 # renderer, scene, camera, SparkRenderer, loop, resize
    viewer/CameraRig.ts              # OrbitControls + fly mode + framing + retarget
    viewer/SplatDocument.ts          # §5 — the one seam for later phases
    viewer/framing.ts                # robust bounds (percentiles) → center/radius/frame
    io/loadSplat.ts                  # File | URL | ArrayBuffer → SplatMesh, progress, errors
    io/dragDrop.ts                   # drop zone + file picker
    io/urlParams.ts                  # ?url=…  ?sample=…
    ui/hud.ts                        # fps, splat count, filename, status line
    ui/panel.ts                      # Tweakpane: background, grid, flip-Y, camera mode, fov, speed
    ui/shortcuts.ts                  # keyboard map (§3.4)
    style.css
README.md (root): how to run, how to deploy, keyboard map, coordinate convention, known issues
```

Keep files small; no file over ~250 lines.

## 3. Behavior spec

### 3.1 Loading (all four must work)
1. **Drag-and-drop** anywhere on the window (full-window overlay that appears on `dragenter`, hides on drop/leave). Accept one file: `.ply`, `.compressed.ply`, `.spz`, `.splat`, `.ksplat`, `.sog`. Reject others with a toast.
2. **File picker** button (`<input type=file>`), same formats.
3. **`?url=<encoded URL>`** query param on page load. Remote host must send CORS; on failure show a clear error: "Couldn't fetch — the host must allow CORS; try downloading and dropping the file."
4. **Sample gallery**: a small dropdown/list read from `public/samples/samples.json` (`[{name, url, credit}]`). `?sample=<name>` also works.

Loading one file **replaces** the current one: `dispose()` the previous `SplatMesh`, remove it from the scene, reset camera. Show a progress bar (Spark `onProgress` gives `{loaded,total}`; when `total` is unknown show indeterminate). Show a "Parsing…" state between download complete and `onLoad`. All errors go to a non-blocking toast + `console.error`; never a broken blank canvas.

### 3.2 Scene & rendering
- `new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" })`, `setPixelRatio(Math.min(devicePixelRatio, 2))`, handle resize.
- `const spark = new SparkRenderer({ renderer }); scene.add(spark);` — **required**; Spark sorts/updates through this object.
- Load with `new SplatMesh({ fileBytes, fileName, onProgress, onLoad })` for local files / `{ url }` for remote; `await mesh.initialized`.
- **Coordinate convention (write this in README):** 3DGS files are Y-down. After load apply `mesh.quaternion.set(1, 0, 0, 0)` (180° about X) so the scene is Y-up, matching three.js/OrbitControls. Provide a panel toggle "Flip Y" for files that are already Y-up.
- Camera: `PerspectiveCamera(60, aspect, 0.01, 1000)`; after framing set `near = radius/1000`, `far = radius*100` (radius from §3.3).
- Background color setting (default dark `#111`); grid helper + axes helper sized from scene bounds (default on); toggleable.

### 3.3 Framing & robust bounds
Splats have floaters; the raw AABB is useless. `viewer/framing.ts`:
- Sample up to 200k splat centers via `mesh.forEachSplat` / `mesh.packedSplats.forEachSplat` (stride if more).
- Per axis take the 2nd and 98th percentile → robust bbox; `center` = its center; `radius` = half its diagonal.
- On load: **do not move the splat**; set the orbit target to `center` and place the camera at `center + radius*2.2` along a pleasant diagonal (e.g. `(1, 0.6, 1)` normalized), looking at center. `F` reframes. (Leaving the mesh transform untouched except the Y-flip keeps exported coordinates honest in Phase 2.)
- Expose `getRobustBounds()` on `SplatDocument`.

### 3.4 Camera rig
- Default: three.js `OrbitControls` with `enableDamping`, `zoomToCursor: true`, `screenSpacePanning: true`.
- **Double-click** on the splat → retarget the orbit center to the hit point (`THREE.Raycaster.intersectObjects([mesh])` — Spark supports raycasting; fall back to the nearest projected center within 12 px if no hit). Animate the target over ~250 ms.
- **Fly mode** toggle (`Tab`): WASD + QE (up/down), mouse-look on left-drag or pointer lock; `Shift` = 4× speed; speed scales with scene radius; scroll adjusts speed. Own small implementation — don't use `FlyControls`/`PointerLockControls` if they fight OrbitControls. Switching controllers must preserve the camera pose (no jumps).
- Keyboard: `F` frame, `Tab` toggle fly, `G` grid, `O` open file, `1/3/7` front/right/top views (Blender numpad style; ortho not required), `Esc` exits fly.

### 3.5 HUD & panel
- HUD (top-left, monospace, unobtrusive): fps (1 s moving average), splat count (`mesh.numSplats`, thousands separators), file name + size, status (Loading 43% / Parsing / Ready / Error).
- Tweakpane (top-right, collapsible): background, grid/axes, Flip Y, camera mode, FOV, fly speed, and `SparkRenderer` `maxStdDev` if it's settable at runtime.
- Empty state: centered "Drop a .ply / .spz / .splat here — or pick a sample" with the sample list.

## 4. Assets & hosting

### 4.1 Samples
Do **not** commit binaries > 2 MB. `samples.json` points at remote URLs. Known-good: `https://sparkjs.dev/assets/splats/butterfly.spz`. Find 2–3 more from Spark's examples (https://github.com/sparkjsdev/spark/tree/main/examples) or other CORS-enabled hosts; verify each actually loads cross-origin from `localhost` **and** from the Pages origin before listing it. If a URL doesn't send CORS, don't list it.

### 4.2 GitHub Pages
- `vite.config.ts`: `base: './'` (relative) so the build works at `https://<user>.github.io/<repo>/` and locally; `build.target: 'es2022'`.
- `.github/workflows/pages.yml`: on push to `main` → `actions/setup-node@v4` (Node 20, npm cache) → `npm ci` + `npm run build` in `app/` → `actions/upload-pages-artifact@v3` (path `app/dist`) → `actions/deploy-pages@v4`. Permissions `pages: write`, `id-token: write`. Include a `.nojekyll` in `app/public/`.
- Spark inlines its WASM in the ESM bundle; if Vite dev-server pre-bundling chokes on it, add `optimizeDeps: { exclude: ['@sparkjsdev/spark'] }` — try the default first.
- Root `README.md` must say: "Deploy: repo Settings → Pages → Source: GitHub Actions".

## 5. The one seam: `SplatDocument`

Phase 2 will add a CPU-side `SplatStore`, layers, and export. Phase 1 only needs a thin class so Phase 2 doesn't have to refactor `main.ts`:

```ts
export class SplatDocument {
  readonly mesh: SplatMesh;          // the single loaded mesh for now
  readonly name: string;
  readonly byteLength: number;
  get numSplats(): number;
  getRobustBounds(): { center: Vector3; radius: number; min: Vector3; max: Vector3 };
  dispose(): void;
}
```
`Viewer` owns at most one `SplatDocument` and emits a `document-changed` event. Nothing else: no interfaces "for later", no plugin system, no event-bus library.

## 6. Code-quality guardrails
- TypeScript strict, no `any` except at the Spark boundary if its types are incomplete (comment why).
- No global mutable state; `main.ts` wires things and nothing else.
- Render via `renderer.setAnimationLoop`; pause the loop when the tab is hidden.
- Dispose everything on reload (mesh, controls, listeners). Loading the same file 10× in a row must not leak (check DevTools → Memory; note the result in the PR/notes).
- WebGL2 unavailable → friendly full-screen message.
- Comments only where the *why* isn't obvious (coordinate flip, percentile framing, near/far).

## 7. Pitfalls (verified — don't rediscover these)
- Forgetting `scene.add(new SparkRenderer({ renderer }))` → nothing renders / no sorting.
- Missing `mesh.quaternion.set(1,0,0,0)` → scene upside down.
- `antialias: true` on the WebGLRenderer hurts splat performance; keep it off.
- Raw-bbox framing orbits around a floater 50 m away; use percentiles.
- Remote `?url=` without CORS fails in `fetch`; surface the error.
- Vite `base` must be relative or `/<repo>/` or Pages serves a blank page.
- A large `.ply` (hundreds of MB) parsed on the main thread freezes the UI for seconds; acceptable in Phase 1 **but** render the "Parsing…" state first (yield a frame before constructing `SplatMesh`).

## 8. Deliverables
1. Working app in `app/`; `npm run dev` / `npm run build` / `npm run lint` / `npm run preview` all clean.
2. Pages workflow + root `README.md` (run, deploy, keyboard map, coordinate convention, known issues).
3. `docs/PHASE1_NOTES.md` written at the end: exact versions installed; anything in this spec that couldn't be done and why; Spark API surprises (what `forEachSplat` actually exposes, whether raycasting worked, whether `maxStdDev` is runtime-settable); measured fps + load time per sample on your machine (name the GPU).

## 9. Acceptance checklist (tick each; include in the PR/notes)
- [ ] `npm ci && npm run build` succeeds from a clean clone; `npm run lint` has 0 errors.
- [ ] Pages URL loads; empty state shows samples; picking a sample renders within a few seconds.
- [ ] Drag-and-drop of a local `.ply` (3DGS), a `.spz`, and a `.splat` each render correctly oriented (Y-up).
- [ ] `?url=` with a CORS-enabled URL works; with a non-CORS URL shows the friendly error.
- [ ] Orbit is smooth (damping, zoom-to-cursor); double-click retargets to the splat surface; `F` reframes; `Tab` fly mode works (WASD/QE + mouse-look) and toggling back causes no camera jump.
- [ ] HUD shows fps, splat count, file name; progress bar during load; toast on errors.
- [ ] Grid/axes/background/Flip-Y toggles work.
- [ ] Replacing the loaded file 10× does not grow memory unboundedly; no console errors.
- [ ] Works in Chrome, Firefox, Safari (desktop). Note mobile results but they're not required.
- [ ] `docs/PHASE1_NOTES.md` written.

## 10. References
- Spark docs: https://sparkjs.dev/docs/ (SplatMesh: https://sparkjs.dev/docs/splat-mesh/ · PackedSplats: https://sparkjs.dev/docs/packed-splats/) · repo + examples: https://github.com/sparkjsdev/spark
- Spark hello-world (verified): `const spark = new SparkRenderer({ renderer }); scene.add(spark); const m = new SplatMesh({ url }); m.quaternion.set(1,0,0,0); scene.add(m);`
- three.js OrbitControls: https://threejs.org/docs/#examples/en/controls/OrbitControls
- Vite static deploy to GitHub Pages: https://vite.dev/guide/static-deploy.html#github-pages
