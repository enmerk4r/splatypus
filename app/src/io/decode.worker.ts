import { decodeBytes } from './decodeCore';
import type { DecodeOptions } from './decodeTypes';

interface DecodeRequest {
  id: number;
  bytes: ArrayBuffer;
  name: string;
  options: DecodeOptions;
}
interface WorkerScope {
  onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event): void => {
  const { id, bytes, name, options } = event.data;
  void decodeBytes(new Uint8Array(bytes), name, options, (loaded, total) => {
    scope.postMessage({ id, type: 'progress', progress: { phase: 'parsing', loaded, total } });
  })
    .then((decoded) => {
      const transfer: Transferable[] = [
        decoded.arrays.centers.buffer,
        decoded.arrays.scales.buffer,
        decoded.arrays.rotations.buffer,
        decoded.arrays.opacities.buffer,
        decoded.arrays.colors.buffer,
      ];
      if (decoded.arrays.shRest) transfer.push(decoded.arrays.shRest.buffer);
      scope.postMessage({ id, type: 'result', decoded }, transfer);
    })
    .catch((error: unknown) => {
      scope.postMessage({
        id,
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    });
};
