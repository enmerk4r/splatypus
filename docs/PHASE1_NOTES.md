# Phase 1 implementation notes

Date: 2026-08-22

## Installed versions

The app targets Node 20 LTS in GitHub Actions. Local checks ran with Node 22.22.2 because Node 20 is not installed on the development machine; the Pages workflow is the authoritative Node 20 build.

### Runtime

- `@sparkjsdev/spark` 2.1.0
- `three` 0.180.0
- `tweakpane` 4.0.5

### Development

- `@types/three` 0.180.0
- `@tweakpane/core` 2.0.5 (Tweakpane's official TypeScript declarations dependency)
- TypeScript 5.9.2
- Vite 8.2.2
- ESLint 9.34.0, `@eslint/js` 9.34.0, `typescript-eslint` 8.41.0
- Prettier 3.6.2

Vite 8.2.2 replaced the initially tested 7.1.3 because the latter produced high-severity dev-server advisories. Vite 8.2.2 supports Node `^20.19.0 || >=22.12.0`; `npm audit` reports zero vulnerabilities.

## Spark API findings

- `SplatMesh.forEachSplat` exposes `(index, center, scales, quaternion, opacity, color)`. The vector/color objects are reused between callbacks, so framing copies the center before transforming it.
- `SplatMesh.raycast` implements the standard synchronous three.js raycast contract. It can be slow on very large scenes, so Splatypus invokes it only on double-click and has a screen-space nearest-center fallback.
- `SparkRenderer.maxStdDev` is public and runtime-settable. The View panel exposes it as **Splat extent**.
- `onProgress` receives a browser `ProgressEvent`; `lengthComputable` controls determinate versus indeterminate progress.
- Spark 2.x requires an explicit `SparkRenderer` in the scene. The viewer creates exactly one and disposes each replaced `SplatMesh`.
- Spark 2.1.0 includes a fix that clears texture references during disposal. This is relevant to repeated reloads, but it does not replace the manual memory test below.

## Samples and network measurements

All gallery entries are from Spark's official asset manifest. On 2026-08-22, each URL returned HTTP 200, `Content-Type: application/octet-stream`, byte ranges, and `Access-Control-Allow-Origin: *`, which permits loading from localhost and GitHub Pages.

Download-only timings from this development machine (not load-to-render timings):

| Sample | Size | Transfer time |
| --- | ---: | ---: |
| Butterfly | 4,025,604 bytes | 1.080 s |
| Penguin | 2,520,338 bytes | 0.628 s |
| Fireplace | 4,377,719 bytes | 1.207 s |

Hardware: NVIDIA GeForce RTX 5070 Ti Laptop GPU (driver 32.0.15.9201) with Intel Graphics (driver 32.0.101.8331).

FPS and browser load-to-render measurements could not be collected in this agent session because the in-app browser exposed no browser target. The browser-control instructions prohibit substituting a separate automation backend. This is recorded as missing acceptance evidence rather than presenting transfer time as render performance.

## Acceptance checklist

- [x] `npm ci` succeeds from `app/`; `npm run build` succeeds; `npm run lint` has zero errors; `npm audit` reports zero vulnerabilities.
- [ ] The [Pages URL](https://enmerk4r.github.io/splatypus/) and all three gallery entries are deployed and HTTP-reachable; selecting each sample and confirming WebGL rendering within a few seconds still needs an in-app browser/manual check.
- [ ] Drag-and-drop of a local 3DGS `.ply`, `.spz`, and `.splat` each renders Y-up. All paths are implemented; representative local files and a browser target were unavailable for manual confirmation.
- [ ] `?url=` renders a CORS-enabled URL, and a non-CORS URL shows the friendly error. Both paths are implemented; the three configured URLs have verified wildcard CORS, but browser behavior needs manual confirmation.
- [ ] Orbit damping/zoom-to-cursor, double-click retarget, `F`, and fly mode (WASD/QE, mouse-look, no camera jump) need manual browser confirmation.
- [ ] HUD rendering, progress animation, and error toast need manual browser confirmation.
- [ ] Grid, axes, background, and Flip-Y settings need manual browser confirmation.
- [ ] Ten consecutive reloads need a browser memory-profile check. The viewer removes and disposes the old mesh on replacement and stale async loads dispose immediately.
- [ ] Chrome, Firefox, and Safari desktop matrix needs manual confirmation. Mobile is not required.
- [x] `docs/PHASE1_NOTES.md` is present.

## Automated/runtime evidence

- A production build generated relative asset URLs and served `index.html`, the application module, and the three-entry sample manifest over Vite preview with HTTP 200.
- `npm run dev` and `npm run preview` both started successfully on localhost.
- Each implementation file is approximately 250 lines or fewer; UI styles are split into focused files.
- GitHub Actions run [32587017700](https://github.com/enmerk4r/splatypus/actions/runs/32587017700) passed both the clean build and deploy jobs.
- The live Pages index, relative JavaScript and CSS bundles, three-entry sample manifest, and `.nojekyll` each returned HTTP 200 after deployment.
- GitHub Pages is configured with `build_type: workflow`, HTTPS enforcement, and the public URL `https://enmerk4r.github.io/splatypus/`.

## Known limitations

- Phase 1 parsing remains on the main thread. The UI yields one animation frame to show **Parsing…** before constructing a local-file `SplatMesh`.
- Remote URLs require CORS. A failed network/CORS fetch directs the user to download and drop the file.
- Browser/GPU/manual checks above remain required for full Phase 1 acceptance if no in-app browser target is available during deployment verification.
