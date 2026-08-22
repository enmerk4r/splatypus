import { SplatMesh } from '@sparkjsdev/spark';

export type SplatSource =
  | { kind: 'file'; file: File }
  | { kind: 'url'; url: string; name?: string }
  | { kind: 'bytes'; bytes: ArrayBuffer; fileName: string };

export interface LoadProgress {
  phase: 'loading' | 'parsing';
  loaded?: number;
  total?: number;
}

export interface LoadedSplat {
  mesh: SplatMesh;
  name: string;
  byteLength: number;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function readFile(
  file: File,
  onProgress: (progress: LoadProgress) => void,
): Promise<ArrayBuffer> {
  const reader = file.stream().getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let result = await reader.read();
  while (!result.done) {
    chunks.push(result.value);
    loaded += result.value.byteLength;
    onProgress({ phase: 'loading', loaded, total: file.size });
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

function nameFromUrl(url: string): string {
  try {
    const segment = new URL(url, window.location.href).pathname.split('/').filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : 'Remote splat';
  } catch {
    return 'Remote splat';
  }
}

export async function loadSplat(
  source: SplatSource,
  onProgress: (progress: LoadProgress) => void,
): Promise<LoadedSplat> {
  let name: string;
  let byteLength = 0;
  let mesh: SplatMesh;

  try {
    if (source.kind === 'url') {
      name = source.name ?? nameFromUrl(source.url);
      mesh = new SplatMesh({
        url: source.url,
        fileName: name,
        onProgress: (event) => {
          byteLength = Math.max(byteLength, event.loaded);
          const total = event.lengthComputable ? event.total : undefined;
          onProgress({
            phase: event.lengthComputable && event.loaded >= event.total ? 'parsing' : 'loading',
            loaded: event.loaded,
            total,
          });
        },
        onLoad: () => undefined,
      });
    } else {
      name = source.kind === 'file' ? source.file.name : source.fileName;
      const bytes = source.kind === 'file' ? await readFile(source.file, onProgress) : source.bytes;
      byteLength = bytes.byteLength;
      onProgress({ phase: 'parsing', loaded: byteLength, total: byteLength });
      await nextFrame();
      mesh = new SplatMesh({ fileBytes: bytes, fileName: name, onLoad: () => undefined });
    }
    await mesh.initialized;
    return { mesh, name, byteLength };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (source.kind === 'url' && /cors|fetch|network|load failed/i.test(detail)) {
      throw new Error(
        "Couldn't fetch — the host must allow CORS; try downloading and dropping the file.",
        { cause: error },
      );
    }
    throw new Error(`Couldn't open the splat: ${detail}`, { cause: error });
  }
}
