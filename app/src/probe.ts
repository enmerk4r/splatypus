// Verifies the assumption the .groups sidecar rests on: that Spark's PLY loader keeps
// splats in file order and drops none, so a group id can be addressed by splat index.
// Checked twice — against a synthetic file whose index is encoded in each splat's
// position, and against a real scan parsed independently here.
//
// Run it by generating the synthetic file and opening /probe.html on the dev server:
//   node tools/make-index-probe.mjs app/public/samples/_index_probe.ply
import { PackedSplats, SplatMesh } from '@sparkjsdev/spark';

const out = document.querySelector<HTMLPreElement>('#out')!;
const log = (line: string): void => {
  out.textContent += `\n${line}`;
  console.log(line);
};

/** Parses the xyz of every vertex in a binary-little-endian PLY, in file order. */
function parsePlyPositions(bytes: ArrayBuffer): { count: number; xyz: Float32Array } {
  const text = new TextDecoder().decode(new Uint8Array(bytes, 0, 65536));
  const headerEnd = text.indexOf('end_header\n') + 'end_header\n'.length;
  const lines = text.slice(0, headerEnd).split('\n');
  const count = Number(lines.find((l) => l.startsWith('element vertex'))!.split(' ')[2]);
  const props = lines.filter((l) => l.startsWith('property float')).map((l) => l.split(' ')[2]);
  const stride = props.length * 4;
  const axes = ['x', 'y', 'z'] as const;
  const view = new DataView(bytes, headerEnd);
  const xyz = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    for (let a = 0; a < 3; a += 1) {
      xyz[i * 3 + a] = view.getFloat32(i * stride + props.indexOf(axes[a]) * 4, true);
    }
  }
  return { count, xyz };
}

async function probeSynthetic(): Promise<void> {
  const bytes = await (await fetch('/samples/_index_probe.ply')).arrayBuffer();
  const packed = new PackedSplats({ fileBytes: bytes, fileName: '_index_probe.ply' });
  await packed.initialized;

  let outOfOrder = 0;
  packed.forEachSplat((index, center) => {
    if (Math.round(center.x) + 64 * Math.round(center.y) !== index) outOfOrder += 1;
  });
  log(`synthetic: ${packed.numSplats}/4096 splats, ${outOfOrder} out of order`);
}

async function probeReal(): Promise<void> {
  // A real scan is the case that matters, but it is too large to keep in the repo.
  // Drop one at app/public/samples/_real.ply to include it in the check.
  const response = await fetch('/samples/_real.ply');
  if (!response.ok) {
    log('real: skipped — put a scan at app/public/samples/_real.ply to check it too');
    return;
  }
  const bytes = await response.arrayBuffer();
  const { count, xyz } = parsePlyPositions(bytes);
  const packed = new PackedSplats({ fileBytes: bytes, fileName: '_real.ply' });
  await packed.initialized;
  log(`real: file says ${count} splats, Spark loaded ${packed.numSplats}`);
  if (packed.numSplats !== count) {
    log('real: COUNT MISMATCH — index alignment is unsafe');
    return;
  }

  // fp16 centres, so compare with a tolerance scaled to the magnitude.
  let mismatched = 0;
  let worst = 0;
  packed.forEachSplat((index, center) => {
    for (const [a, got] of [center.x, center.y, center.z].entries()) {
      const want = xyz[index * 3 + a]!;
      const tol = Math.max(Math.abs(want) * 1e-2, 1e-3);
      const error = Math.abs(got - want);
      worst = Math.max(worst, error / tol);
      if (error > tol) mismatched += 1;
    }
  });
  log(
    `real: ${mismatched} coordinates outside fp16 tolerance (worst = ${worst.toFixed(2)}x tolerance)`,
  );
  log(mismatched === 0 ? 'RESULT: ORDER PRESERVED ON REAL DATA' : 'RESULT: ORDER NOT PRESERVED');
}

/**
 * loadSplat enables Spark's level-of-detail tree above LOD_ABOVE_SPLATS. LoD carries an
 * index remap, so it could renumber splats and silently invalidate every .groups file on
 * a large scene. Forcing it on with lodAbove: 0 checks that on a file small enough to
 * verify exhaustively.
 */
async function probeLod(): Promise<void> {
  const bytes = await (await fetch('/samples/_index_probe.ply')).arrayBuffer();
  const mesh = new SplatMesh({
    fileBytes: bytes,
    fileName: '_index_probe.ply',
    lod: true,
    lodAbove: 0,
  });
  await mesh.initialized;

  let outOfOrder = 0;
  let visited = 0;
  mesh.forEachSplat((index, center) => {
    visited += 1;
    if (Math.round(center.x) + 64 * Math.round(center.y) !== index) outOfOrder += 1;
  });
  log(
    `lod forced on: mesh.numSplats=${mesh.numSplats}, forEachSplat visited ${visited}, ` +
      `packedSplats=${mesh.packedSplats?.numSplats ?? 'none'}, ` +
      `lodSplats=${mesh.packedSplats?.lodSplats?.numSplats ?? 'none'}, ` +
      `paged=${mesh.paged ? 'yes' : 'no'}, out of order ${outOfOrder}`,
  );
  log(
    mesh.numSplats === 4096 && outOfOrder === 0
      ? 'lod: order preserved'
      : 'lod: file-order indexing does not survive — .groups cannot apply to a LoD scene',
  );
  mesh.dispose();
}

void (async () => {
  await probeSynthetic();
  await probeReal();
  await probeLod();
})().catch((error: unknown) => log(`ERROR: ${String(error)}`));
