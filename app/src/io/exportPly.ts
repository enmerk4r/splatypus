import { Quaternion, Vector3 } from 'three';
import type { SplatMesh } from '@sparkjsdev/spark';

/**
 * Writes the edited scene back out as a binary 3DGS .ply.
 *
 * The viewer keeps edits as transforms and hidden splats rather than as rewritten data,
 * so this is where they are made real: hidden splats are dropped, and every object's
 * world matrix is folded into the splats it carries. What comes out is a plain splat
 * file that any other tool can open — the segmentation is gone, because a .ply has
 * nowhere to put it, which is exactly why the .groups sidecar exists.
 */

/** Spherical-harmonic DC scale: the constant 3DGS files store colour in. */
const SH_C0 = 0.28209479177387814;
/** Below this a splat is invisible, and invisible is how a deleted object is stored. */
const MIN_OPACITY = 1 / 512;

const FIELDS = [
  'x',
  'y',
  'z',
  'nx',
  'ny',
  'nz',
  'f_dc_0',
  'f_dc_1',
  'f_dc_2',
  'opacity',
  'scale_0',
  'scale_1',
  'scale_2',
  'rot_0',
  'rot_1',
  'rot_2',
  'rot_3',
] as const;
const STRIDE = FIELDS.length * 4;

export interface ExportSource {
  mesh: SplatMesh;
  /** Splat indices to leave out, e.g. those a split layer has taken over. */
  skip?: (index: number) => boolean;
}

/** Splats read out of one mesh, already in world space. */
interface Collected {
  centre: Vector3;
  scales: Vector3;
  quaternion: Quaternion;
  opacity: number;
  r: number;
  g: number;
  b: number;
}

function collect(source: ExportSource, into: Collected[]): void {
  const { mesh, skip } = source;
  mesh.updateWorldMatrix(true, false);
  const matrix = mesh.matrixWorld.clone();
  // Scale rides along the matrix, but rotation has to be applied to each splat's own
  // orientation separately — a matrix cannot carry a quaternion for us.
  const meshRotation = new Quaternion();
  const meshScale = new Vector3();
  matrix.decompose(new Vector3(), meshRotation, meshScale);

  mesh.forEachSplat((index, centre, scales, quaternion, opacity, colour) => {
    if (opacity < MIN_OPACITY) return;
    if (skip?.(index)) return;
    into.push({
      centre: centre.clone().applyMatrix4(matrix),
      scales: scales.clone().multiply(meshScale),
      quaternion: meshRotation.clone().multiply(quaternion),
      opacity,
      r: colour.r,
      g: colour.g,
      b: colour.b,
    });
  });
}

/** Undoes the sigmoid a 3DGS file stores opacity through. */
function logit(value: number): number {
  const clamped = Math.min(Math.max(value, 1e-6), 1 - 1e-6);
  return Math.log(clamped / (1 - clamped));
}

export function exportPly(sources: readonly ExportSource[]): Blob {
  const splats: Collected[] = [];
  for (const source of sources) collect(source, splats);

  const header =
    'ply\nformat binary_little_endian 1.0\n' +
    `element vertex ${splats.length}\n` +
    FIELDS.map((field) => `property float ${field}\n`).join('') +
    'end_header\n';

  const body = new ArrayBuffer(splats.length * STRIDE);
  const view = new DataView(body);
  let at = 0;
  const put = (value: number): void => {
    view.setFloat32(at, value, true);
    at += 4;
  };
  for (const splat of splats) {
    put(splat.centre.x);
    put(splat.centre.y);
    put(splat.centre.z);
    put(0);
    put(0);
    put(0);
    put((splat.r - 0.5) / SH_C0);
    put((splat.g - 0.5) / SH_C0);
    put((splat.b - 0.5) / SH_C0);
    put(logit(splat.opacity));
    // 3DGS stores scales as logs, so a zero scale would be -Infinity; floor it instead.
    put(Math.log(Math.max(splat.scales.x, 1e-9)));
    put(Math.log(Math.max(splat.scales.y, 1e-9)));
    put(Math.log(Math.max(splat.scales.z, 1e-9)));
    put(splat.quaternion.w);
    put(splat.quaternion.x);
    put(splat.quaternion.y);
    put(splat.quaternion.z);
  }

  return new Blob([new TextEncoder().encode(header), body], { type: 'application/octet-stream' });
}

/** Hands a finished export to the browser as a download. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
