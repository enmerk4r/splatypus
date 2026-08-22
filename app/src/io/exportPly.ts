import type { Layer } from '../model/Layer';
import { SplatStore } from '../model/SplatStore';
import { defaultSplatSpacing, meshToSplats } from '../mesh/solid';
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
        // Mesh layers have no splats of their own: sample their surface for the PLY.
        const store = layer.solid
          ? new SplatStore(meshToSplats(layer.solid, defaultSplatSpacing(layer.solid)))
          : layer.store;
        return {
          store: {
            count: store.count,
            alive: store.alive,
            centers: store.centers,
            scales: store.scales,
            rotations: store.rotations,
            opacities: store.opacities,
            colors: store.colors,
            shDegree: store.shDegree,
            ...(store.shRest ? { shRest: store.shRest } : {}),
          },
          matrix: layer.object.matrix.toArray(),
          visible: layer.visible,
        };
      }),
      options,
    });
  });
}
