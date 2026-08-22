#!/usr/bin/env node
// Generates a synthetic 3DGS PLY whose splat index is recoverable from its position, for
// app/src/probe.ts — the check that Spark's loader preserves splat order, which is what
// makes the index-addressed .groups sidecar safe. See docs/GROUPS_FORMAT.md.
// Splat i sits on a 64x64 grid at (i % 64, floor(i / 64), 0) with spacing 1.0 — far
// coarser than fp16 center precision, so a readback recovers i exactly.
import { writeFileSync } from 'node:fs';

const SIDE = 64;
const N = SIDE * SIDE;
const SH_C0 = 0.28209479177387814;

const props = [
  'x', 'y', 'z',
  'nx', 'ny', 'nz',
  'f_dc_0', 'f_dc_1', 'f_dc_2',
  'opacity',
  'scale_0', 'scale_1', 'scale_2',
  'rot_0', 'rot_1', 'rot_2', 'rot_3',
];

const header =
  'ply\n' +
  'format binary_little_endian 1.0\n' +
  `element vertex ${N}\n` +
  props.map((p) => `property float ${p}`).join('\n') + '\n' +
  'end_header\n';

const headerBytes = new TextEncoder().encode(header);
const body = new ArrayBuffer(N * props.length * 4);
const view = new DataView(body);

const logit = (p) => Math.log(p / (1 - p));

let off = 0;
const put = (v) => { view.setFloat32(off, v, true); off += 4; };

for (let i = 0; i < N; i += 1) {
  put(i % SIDE);            // x
  put(Math.floor(i / SIDE)); // y
  put(0);                    // z
  put(0); put(0); put(0);    // normals (ignored by 3DGS)

  // Colour also encodes the index, as a second independent probe.
  const rgb = [i & 255, (i >> 8) & 255, (i >> 16) & 255];
  for (const c of rgb) put((c / 255 - 0.5) / SH_C0);

  // First 100 splats are near-transparent: probes whether Spark culls them.
  put(logit(i < 100 ? 0.001 : 0.9));

  put(Math.log(0.02)); put(Math.log(0.02)); put(Math.log(0.02));
  put(1); put(0); put(0); put(0); // rot wxyz, identity
}

const out = new Uint8Array(headerBytes.length + body.byteLength);
out.set(headerBytes, 0);
out.set(new Uint8Array(body), headerBytes.length);
writeFileSync(process.argv[2], out);
console.log(`wrote ${process.argv[2]}: ${N} splats, ${out.length} bytes`);
