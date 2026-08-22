import type { CropBox } from '../select/CropBox';
import type { Segments } from '../select/Segments';
import type { Viewer } from '../viewer/Viewer';

export interface LibraryCallbacks {
  onOpenFile: () => void;
  onExport: () => void;
}

/**
 * The left window: what file is open, and how to get one in or out.
 *
 * It holds only the two ends of the pipeline. How the scene is divided moved in with
 * the viewport settings, and everything acting on one object is on the toolbar, so this
 * stays the one place that is about files rather than about the scene.
 */
export function createLibraryPanel(
  host: HTMLElement,
  viewer: Viewer,
  segments: Segments,
  crop: CropBox,
  callbacks: LibraryCallbacks,
): { dispose: () => void } {
  host.innerHTML = `
    <div class="library-file">
      <button type="button" id="library-open">Open file…</button>
      <button type="button" id="library-export">Export .ply</button>
    </div>
    <p class="panel-hint" id="library-file-name">No scene</p>

    <h2 class="panel-title">Crop</h2>
    <button type="button" id="crop-start" class="crop-start">Show crop box</button>
    <div class="crop-tools" id="crop-tools" hidden>
      <button type="button" id="crop-move" aria-pressed="true">Move box</button>
      <button type="button" id="crop-resize" aria-pressed="false">Resize box</button>
      <button type="button" id="crop-keep">Keep inside</button>
      <button type="button" id="crop-cut">Cut inside</button>
    </div>
    <p class="panel-status" id="crop-status" hidden></p>
    <button type="button" id="crop-undo" class="crop-start" hidden>Undo crop</button>
  `;

  const pick = <T extends HTMLElement>(id: string): T => host.querySelector<T>(`#${id}`)!;
  const openButton = pick<HTMLButtonElement>('library-open');
  const exportButton = pick<HTMLButtonElement>('library-export');
  const fileName = pick<HTMLParagraphElement>('library-file-name');
  const startButton = pick<HTMLButtonElement>('crop-start');
  const cropTools = pick<HTMLDivElement>('crop-tools');
  const moveButton = pick<HTMLButtonElement>('crop-move');
  const resizeButton = pick<HTMLButtonElement>('crop-resize');
  const keepButton = pick<HTMLButtonElement>('crop-keep');
  const cutButton = pick<HTMLButtonElement>('crop-cut');
  const undoButton = pick<HTMLButtonElement>('crop-undo');
  const cropStatus = pick<HTMLParagraphElement>('crop-status');

  const render = (): void => {
    const document = viewer.document;
    fileName.textContent = document
      ? `${document.name} · ${document.numSplats.toLocaleString()} splats`
      : 'No scene';
    exportButton.disabled = document === undefined;
    startButton.disabled = document === undefined;
    startButton.textContent = crop.isActive ? 'Hide crop box' : 'Show crop box';
    cropTools.hidden = !crop.isActive;
    moveButton.setAttribute('aria-pressed', String(crop.mode === 'translate'));
    resizeButton.setAttribute('aria-pressed', String(crop.mode === 'scale'));
    undoButton.hidden = !crop.isApplied;
    cropStatus.hidden = !crop.isApplied;
  };

  /** Splats a layer has already taken over; a crop must leave those to their layer. */
  const claimed = (): Set<number> => {
    const taken = new Set<number>();
    for (const layer of segments.allLayers()) {
      for (const index of layer.indices ?? []) taken.add(index);
    }
    return taken;
  };

  const runCrop = (keep: 'inside' | 'outside') => (): void => {
    const removed = crop.apply(keep, claimed());
    const total = viewer.document?.numSplats ?? 1;
    cropStatus.textContent = `${removed.toLocaleString()} splats hidden · ${Math.round(
      (removed / total) * 100,
    )}% of the scene`;
    render();
  };

  const onStart = (): void => {
    if (crop.isActive) crop.cancel();
    else crop.begin();
  };
  const onUndo = (): void => crop.restore();
  const onMove = (): void => crop.setMode('translate');
  const onResize = (): void => crop.setMode('scale');
  const onKeep = runCrop('inside');
  const onCut = runCrop('outside');

  viewer.addEventListener('document-changed', render);
  crop.addEventListener('crop-changed', render);
  openButton.addEventListener('click', callbacks.onOpenFile);
  exportButton.addEventListener('click', callbacks.onExport);
  startButton.addEventListener('click', onStart);
  moveButton.addEventListener('click', onMove);
  resizeButton.addEventListener('click', onResize);
  keepButton.addEventListener('click', onKeep);
  cutButton.addEventListener('click', onCut);
  undoButton.addEventListener('click', onUndo);
  render();

  return {
    dispose: (): void => {
      viewer.removeEventListener('document-changed', render);
      crop.removeEventListener('crop-changed', render);
    },
  };
}
