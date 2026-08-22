import { writeGaussianPly } from './plyWriter';
import type { ExportLayer, PlyWriteOptions } from './plyWriter';

interface ExportRequest {
  id: number;
  layers: ExportLayer[];
  options: PlyWriteOptions;
}
interface WorkerScope {
  onmessage: ((event: MessageEvent<ExportRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event): void => {
  const { id, layers, options } = event.data;
  try {
    const buffer = writeGaussianPly(layers, options, (written, total) => {
      scope.postMessage({ id, type: 'progress', written, total });
    });
    scope.postMessage({ id, type: 'result', buffer }, [buffer]);
  } catch (error) {
    scope.postMessage({
      id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
