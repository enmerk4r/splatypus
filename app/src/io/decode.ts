import type { DecodedSplats, DecodeOptions, DecodeProgress } from './decodeTypes';

interface WorkerMessage {
  id: number;
  type: 'progress' | 'result' | 'error';
  progress?: DecodeProgress;
  decoded?: DecodedSplats;
  message?: string;
}

let nextId = 1;

export function decodeFile(
  bytes: ArrayBuffer,
  name: string,
  options: DecodeOptions = {},
  onProgress?: (progress: DecodeProgress) => void,
): Promise<DecodedSplats> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const worker = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerMessage>): void => {
      if (event.data.id !== id) return;
      if (event.data.type === 'progress' && event.data.progress) onProgress?.(event.data.progress);
      if (event.data.type === 'result' && event.data.decoded) {
        worker.terminate();
        resolve(event.data.decoded);
      }
      if (event.data.type === 'error') {
        worker.terminate();
        reject(new Error(event.data.message ?? 'Decode worker failed'));
      }
    };
    worker.onerror = (event): void => {
      worker.terminate();
      reject(new Error(event.message || 'Decode worker failed'));
    };
    // Keep the source bytes on the main thread for point-cloud re-budgeting; decoded arrays transfer back.
    worker.postMessage({ id, bytes, name, options });
  });
}
