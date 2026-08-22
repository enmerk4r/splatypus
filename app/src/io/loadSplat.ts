import { SplatMesh } from '@sparkjsdev/spark';
import { normalizePlyHeaderInPlace } from './plyCompat';
import { createPointCloudMesh, DEFAULT_POINT_BUDGET, isRgbPointCloudPly } from './pointCloud';
import type { PointCloudInfo } from './pointCloud';

export type SplatSource =
  | { kind: 'file'; file: File }
  | { kind: 'url'; url: string; name?: string }
  | { kind: 'bytes'; bytes: ArrayBuffer; fileName: string };

export interface LoadOptions {
  /** Point clouds only: keep at most this many points (stride-decimated above it). */
  pointBudget?: number;
  /** Point clouds only: multiplier on the estimated per-point radius (1 = estimate). */
  pointSizeMul?: number;
}

export interface LoadProgress {
  phase: 'loading' | 'parsing';
  loaded?: number;
  total?: number;
}

export interface LoadedSplat {
  mesh: SplatMesh;
  name: string;
  byteLength: number;
  kind: 'splat' | 'pointcloud';
  /** Retained for point clouds so the budget can be changed without re-reading the file. */
  bytes?: ArrayBuffer;
  pointCloud?: PointCloudInfo;
}

/**
 * Above this many splats Spark builds a level-of-detail tree in a worker at load time
 * (≈1–3 s per 1M splats) and renders a view-dependent subset. Below it, files render
 * exactly as authored.
 */
export const LOD_ABOVE_SPLATS = 1_500_000;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  total: number | undefined,
  onProgress: (progress: LoadProgress) => void,
): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let result = await reader.read();
  while (!result.done) {
    chunks.push(result.value);
    loaded += result.value.byteLength;
    onProgress({ phase: 'loading', loaded, ...(total !== undefined ? { total } : {}) });
    result = await reader.read();
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function fetchBytes(
  url: string,
  onProgress: (progress: LoadProgress) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  const length = Number(response.headers.get('content-length'));
  const total = Number.isFinite(length) && length > 0 ? length : undefined;
  if (!response.body) return response.arrayBuffer();
  return readStream(response.body, total, onProgress);
}

function nameFromUrl(url: string): string {
  try {
    const segment = new URL(url, window.location.href).pathname.split('/').filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : 'Remote splat';
  } catch {
    return 'Remote splat';
  }
}

async function resolveBytes(
  source: SplatSource,
  onProgress: (progress: LoadProgress) => void,
): Promise<{ name: string; bytes: ArrayBuffer }> {
  switch (source.kind) {
    case 'url':
      return {
        name: source.name ?? nameFromUrl(source.url),
        bytes: await fetchBytes(source.url, onProgress),
      };
    case 'file':
      return {
        name: source.file.name,
        bytes: await readStream(source.file.stream(), source.file.size, onProgress),
      };
    case 'bytes':
      return { name: source.fileName, bytes: source.bytes };
  }
}

export async function loadSplat(
  source: SplatSource,
  onProgress: (progress: LoadProgress) => void,
  options: LoadOptions = {},
): Promise<LoadedSplat> {
  try {
    const { name, bytes } = await resolveBytes(source, onProgress);
    const byteLength = bytes.byteLength;
    onProgress({ phase: 'parsing', loaded: byteLength, total: byteLength });
    await nextFrame();

    const fileBytes = new Uint8Array(bytes);
    normalizePlyHeaderInPlace(fileBytes, name);

    const pointCloudReader = await isRgbPointCloudPly(fileBytes, name);
    if (pointCloudReader) {
      const { mesh, info } = createPointCloudMesh(pointCloudReader, {
        pointBudget: options.pointBudget ?? DEFAULT_POINT_BUDGET,
        ...(options.pointSizeMul !== undefined ? { pointSizeMul: options.pointSizeMul } : {}),
      });
      await mesh.initialized;
      return { mesh, name, byteLength, kind: 'pointcloud', bytes, pointCloud: info };
    }

    const mesh = new SplatMesh({
      fileBytes,
      fileName: name,
      lod: true,
      lodAbove: LOD_ABOVE_SPLATS,
      onLoad: () => undefined,
    });
    await mesh.initialized;
    return { mesh, name, byteLength, kind: 'splat' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (source.kind === 'url' && /cors|fetch|network|load failed|HTTP \d+/i.test(detail)) {
      throw new Error(
        `Couldn't fetch — the host must allow CORS; try downloading and dropping the file. (${detail})`,
        { cause: error },
      );
    }
    throw new Error(`Couldn't open the splat: ${detail}`, { cause: error });
  }
}
