#!/usr/bin/env node
// CLI front end for the connectivity bake: reads a binary 3DGS PLY, runs the shared
// core in app/src/splats/bakeConnectivity.ts, and writes a .groups sidecar.
// Format: docs/GROUPS_FORMAT.md
//
//   node tools/bake-connectivity.mjs scan.ply [scan.groups] [options]
//
//   --voxel N      spatial cell size (default: 1/300 of the largest robust axis)
//   --colour N     colour cell size in 0..1 (default: 0.12; 0 disables the constraint)
//   --slack N      colour cells this far apart still join (default: 0)
//   --min N        smallest group to keep, in splats (default: 0.05% of the scene)
//   --opacity N    ignore splats fainter than this (default: 0.1)
//
// Only the PLY path lives here. The viewer bakes the same way from a loaded mesh, so it
// covers .spz/.sog/.ksplat too; this CLI exists for batch preparation.

import { readFileSync, writeFileSync } from 'node:fs';
import {
  bakeConnectivity,
  encodeGroups,
  robustExtent,
  suggestOptions,
} from '../app/src/splats/bakeConnectivity.ts';

const SH_C0 = 0.28209479177387814;
const SIZES = { char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8 };

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

/** Reads centres, colours and opacities from a binary-little-endian 3DGS PLY, in file order. */
function readPly(path) {
  const bytes = readFileSync(path);
  const probe = bytes.subarray(0, Math.min(bytes.length, 65536)).toString('latin1');
  const terminator = probe.indexOf('end_header\n');
  if (terminator < 0) throw new Error('Not a PLY, or its header is longer than 64KB');
  const headerEnd = terminator + 'end_header\n'.length;
  const header = probe.slice(0, headerEnd);

  if (!/format binary_little_endian/.test(header)) {
    throw new Error('Only binary_little_endian PLY files are supported');
  }
  const count = Number(/element vertex (\d+)/.exec(header)[1]);
  const props = [...header.matchAll(/property (\w+) (\w+)/g)].map(([, type, name]) => ({ type, name }));

  const offsets = {};
  let stride = 0;
  for (const { type, name } of props) {
    if (!(type in SIZES)) throw new Error(`Unsupported PLY property type ${type}`);
    offsets[name] = stride;
    stride += SIZES[type];
  }
  for (const required of ['x', 'y', 'z']) {
    if (!(required in offsets)) throw new Error(`PLY is missing property ${required}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset + headerEnd);
  const centres = new Float32Array(count * 3);
  const colours = new Float32Array(count * 3);
  const opacities = new Float32Array(count);
  const hasOpacity = 'opacity' in offsets;
  const hasColour = 'f_dc_0' in offsets;

  for (let i = 0; i < count; i += 1) {
    const base = i * stride;
    centres[i * 3] = view.getFloat32(base + offsets.x, true);
    centres[i * 3 + 1] = view.getFloat32(base + offsets.y, true);
    centres[i * 3 + 2] = view.getFloat32(base + offsets.z, true);
    for (let c = 0; c < 3; c += 1) {
      // 3DGS stores base colour as the degree-0 spherical harmonic coefficient.
      colours[i * 3 + c] = hasColour
        ? 0.5 + SH_C0 * view.getFloat32(base + offsets[`f_dc_${c}`], true)
        : 0.5;
    }
    // 3DGS stores opacity pre-sigmoid.
    opacities[i] = hasOpacity
      ? 1 / (1 + Math.exp(-view.getFloat32(base + offsets.opacity, true)))
      : 1;
  }
  return { count, centres, colours, opacities };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
if (positional.length === 0) {
  console.error('usage: node tools/bake-connectivity.mjs scan.ply [scan.groups] [--voxel N] [--colour N] [--slack N] [--min N] [--opacity N]');
  process.exit(1);
}
const [input, output = `${input.replace(/\.[^.]+$/, '')}.groups`] = positional;

const scene = readPly(input);
const options = suggestOptions(scene.centres, scene.count);
if (flags.voxel !== undefined) options.voxelSize = Number(flags.voxel);
if (flags.colour !== undefined) options.colourSize = Number(flags.colour);
if (flags.slack !== undefined) options.colourSlack = Number(flags.slack);
if (flags.min !== undefined) options.minSplats = Number(flags.min);
if (flags.opacity !== undefined) options.minOpacity = Number(flags.opacity);

const extent = robustExtent(scene.centres, scene.count);
console.log(`${input}: ${scene.count} splats, robust extent ${extent.map((e) => e.toFixed(2)).join(' x ')}`);
console.log(
  `voxel ${options.voxelSize.toFixed(4)}, colour ${options.colourSize} slack ${options.colourSlack}, ` +
    `min group ${options.minSplats}, min opacity ${options.minOpacity}`,
);

const { ids, groups, stats } = bakeConnectivity(scene, options);
console.log(`${stats.cells} spatial cells, ${stats.rawComponents} components, ${groups.length} kept`);
console.log(
  `${stats.assigned}/${scene.count} splats assigned ` +
    `(${((stats.assigned / scene.count) * 100).toFixed(1)}%) in ${stats.elapsedMs}ms`,
);
console.log('largest: ' + groups.slice(0, 10).map((g) => `${g.id}:${g.count}${g.colour}`).join(' '));

writeFileSync(
  output,
  encodeGroups(ids, {
    numSplats: scene.count,
    numGroups: groups.length,
    source: 'connectivity',
    ...options,
    groups,
  }),
);
console.log(`wrote ${output}`);
