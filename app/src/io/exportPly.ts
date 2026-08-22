import type { Layer } from '../model/Layer';
import type { PlyWriteOptions } from './plyWriter';

interface ExportMessage {
  type: 'progress' | 'result' | 'error';
  written?: number;
  total?: number;
  buffer?: ArrayBuffer;
  message?: string;
}

export function exportPly(
  layers: readonly Layer[],
  options: PlyWriteOptions,
  onProgress?: (written: number, total: number) => void,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<ExportMessage>): void => {
      if (event.data.type === 'progress')
        onProgress?.(event.data.written ?? 0, event.data.total ?? 0);
      if (event.data.type === 'result' && event.data.buffer) {
        worker.terminate();
        resolve(event.data.buffer);
      }
      if (event.data.type === 'error') {
        worker.terminate();
        reject(new Error(event.data.message ?? 'Export worker failed'));
      }
    };
    worker.onerror = (event): void => {
      worker.terminate();
      reject(new Error(event.message || 'Export worker failed'));
    };
    worker.postMessage({
      id: 1,
      layers: layers.map((layer) => {
        layer.object.updateMatrix();
        return {
          store: {
            count: layer.store.count,
            alive: layer.store.alive,
            centers: layer.store.centers,
            scales: layer.store.scales,
            rotations: layer.store.rotations,
            opacities: layer.store.opacities,
            colors: layer.store.colors,
            shDegree: layer.store.shDegree,
            ...(layer.store.shRest ? { shRest: layer.store.shRest } : {}),
          },
          matrix: layer.object.matrix.toArray(),
          visible: layer.visible,
        };
      }),
      options,
    });
  });
}
