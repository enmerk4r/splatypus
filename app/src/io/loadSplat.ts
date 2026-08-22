import { Layer } from '../model/Layer';
import { SplatStore } from '../model/SplatStore';
import { decodeFile } from './decode';
import type { DecodeOptions } from './decodeTypes';

export type SplatSource =
  | { kind: 'file'; file: File }
  | { kind: 'url'; url: string; name?: string }
  | { kind: 'bytes'; bytes: ArrayBuffer; fileName: string };

export type LoadOptions = DecodeOptions;
export interface LoadProgress {
  phase: 'loading' | 'parsing';
  loaded?: number;
  total?: number;
}

export interface LoadedSplat {
  layer: Layer;
  name: string;
  byteLength: number;
  lossy?: string;
  warnings: string[];
  decodeMs: number;
  syncMs: number;
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
    return segment ? decodeURIComponent(segment) : 'Remote splat.ply';
  } catch {
    return 'Remote splat.ply';
  }
}

async function resolveBytes(
  source: SplatSource,
  onProgress: (progress: LoadProgress) => void,
): Promise<{ name: string; decodeName: string; bytes: ArrayBuffer }> {
  switch (source.kind) {
    case 'url': {
      const decodeName = nameFromUrl(source.url);
      return {
        name: source.name ?? decodeName,
        decodeName,
        bytes: await fetchBytes(source.url, onProgress),
      };
    }
    case 'file':
      return {
        name: source.file.name,
        decodeName: source.file.name,
        bytes: await readStream(source.file.stream(), source.file.size, onProgress),
      };
    case 'bytes':
      return { name: source.fileName, decodeName: source.fileName, bytes: source.bytes };
  }
}

function layerName(fileName: string): string {
  return fileName.replace(/\.(?:ply|spz|splat|ksplat|sog)$/i, '') || fileName;
}

export async function loadSplat(
  source: SplatSource,
  onProgress: (progress: LoadProgress) => void,
  options: LoadOptions = {},
): Promise<LoadedSplat> {
  try {
    const { name, decodeName, bytes } = await resolveBytes(source, onProgress);
    const startedDecode = performance.now();
    const decoded = await decodeFile(bytes, decodeName, options, (progress) =>
      onProgress(progress),
    );
    const decodeMs = performance.now() - startedDecode;
    const store = new SplatStore(decoded.arrays);
    const layer = new Layer({
      name: layerName(name),
      kind: decoded.kind,
      store,
      sourceName: decodeName,
      ...(decoded.pointCloud ? { pointCloud: decoded.pointCloud, sourceBytes: bytes } : {}),
    });
    const syncMs = await layer.sync();
    return {
      layer,
      name,
      byteLength: bytes.byteLength,
      ...(decoded.lossy ? { lossy: decoded.lossy } : {}),
      warnings: decoded.warnings ?? [],
      decodeMs,
      syncMs,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (source.kind === 'url' && /cors|fetch|network|load failed|HTTP \d+/i.test(detail))
      throw new Error(
        `Couldn't fetch — the host must allow CORS; try downloading and dropping the file. (${detail})`,
        { cause: error },
      );
    throw new Error(`Couldn't open the splat: ${detail}`, { cause: error });
  }
}
