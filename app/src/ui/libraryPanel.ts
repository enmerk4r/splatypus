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
  callbacks: LibraryCallbacks,
): { dispose: () => void } {
  host.innerHTML = `
    <div class="library-file">
      <button type="button" id="library-open">Open file…</button>
      <button type="button" id="library-export">Export .ply</button>
    </div>
    <p class="panel-hint" id="library-file-name">No scene</p>
  `;

  const openButton = host.querySelector<HTMLButtonElement>('#library-open')!;
  const exportButton = host.querySelector<HTMLButtonElement>('#library-export')!;
  const fileName = host.querySelector<HTMLParagraphElement>('#library-file-name')!;

  const render = (): void => {
    const document = viewer.document;
    fileName.textContent = document
      ? `${document.name} · ${document.numSplats.toLocaleString()} splats`
      : 'No scene';
    exportButton.disabled = document === undefined;
  };

  viewer.addEventListener('document-changed', render);
  openButton.addEventListener('click', callbacks.onOpenFile);
  exportButton.addEventListener('click', callbacks.onExport);
  render();

  return {
    dispose: (): void => viewer.removeEventListener('document-changed', render),
  };
}
