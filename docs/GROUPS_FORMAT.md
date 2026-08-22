# `.groups` — per-splat segmentation sidecar

A `.groups` file assigns every splat in a scene to at most one group ("this splat is
part of the chair"). It sits next to the splat file and is loaded alongside it:

```
scan.ply
scan.groups
```

Segmentation is **baked offline**. The viewer never runs a segmenter — it loads the
sidecar and treats it as a lookup table, so clicking an object is an array read and
selection is instant regardless of how expensive the segmentation was to produce.

## Why a sidecar and not extra PLY properties

Gaga writes its identity features into the PLY as `obj_dc_0..15`, but every other tool
in the pipeline (Spark's loaders, SuperSplat, viewers) either ignores or chokes on
unknown vertex properties, and `.spz`/`.sog` have no room for them at all. A sidecar
keeps the splat file standard and round-trippable.

## Index alignment

Group ids are addressed by **splat index**: `groupId[i]` describes the `i`-th splat in
the splat file. This is only safe because Spark's loader preserves file order and drops
nothing — verified against both a synthetic index-encoded PLY and a real 262k-splat
scan, where every centre round-tripped within fp16 tolerance and no splat was culled
(including splats quantised to zero opacity).

A loader **must** reject a sidecar whose `numSplats` disagrees with the loaded mesh
rather than silently misaligning the whole scene.

**This does not hold when Spark's level-of-detail tree is active.** `loadSplat` turns LoD
on above `LOD_ABOVE_SPLATS` (1.5M splats); Spark then moves the splats into a separate
`lodSplats` array and renumbers them, and `forEachSplat` walks nothing. A `.groups` file
cannot address such a scene at all, so the viewer reports segmentation as unavailable
rather than misapplying the sidecar. Segmenting a scene that large means loading it
without LoD, or baking against a decimated copy.

To re-check the assumption after a Spark upgrade:

```sh
node tools/make-index-probe.mjs app/public/samples/_index_probe.ply
cd app && npm run dev      # then open /probe.html
```

## Layout

A text header (so the file is self-describing and trivial to write from Python or
Node) followed by a raw little-endian `Uint32Array`:

```
SPGRP1\n
{"numSplats":262144,"numGroups":37,"source":"connectivity","unassigned":4294967295,...}\n
<numSplats * 4 bytes, little-endian uint32>
```

- Line 1 is the magic `SPGRP1`. A different version string means do not attempt to parse.
- Line 2 is a single-line JSON object. Required keys: `numSplats`, `numGroups`, `source`.
  Optional: `groups` (per-group `{id, name, count}`), plus whatever the baker wants to
  record about its parameters — readers ignore keys they do not know.
- The binary payload begins immediately after the second `\n` and is `numSplats`
  uint32s. `0xFFFFFFFF` means **unassigned** (background, or a splat no view could
  confidently label). Group ids are otherwise dense in `0..numGroups-1`.

## Bakers

Any process that can produce a group id per splat can write this file. Two are planned:

- **`tools/bake-connectivity.mjs`** — voxel connected components over splat centres.
  Pure geometry, no ML, runs in seconds. Separates free-standing objects well and is
  the demo-safe fallback.
- **Gaga-lite** — render views of the scene, run SAM on them, associate masks across
  views with Gaga's 3D-aware memory bank (`mask/projector.py`, which is pure projection
  and needs no CUDA), then propagate to unlabelled splats by nearest-neighbour vote.

Both emit this same file, so the viewer does not care which produced it, and a scene can
be re-baked with a better segmenter without touching the viewer.
