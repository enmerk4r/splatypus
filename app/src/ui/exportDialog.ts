import type { Document } from '../model/Document';
import { exportPly } from '../io/exportPly';
import { estimateGaussianPlyBytes } from '../io/plyWriter';
import { prepareSaveFile } from '../io/saveFile';

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(
    Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent] ?? 'B'}`;
}

function exportName(document: Document): string {
  const base = document.name.replace(/\.(?:ply|spz|splat|ksplat|sog)$/i, '') || 'scene';
  return `${base}-splatypus.ply`;
}

export function createExportDialog(
  dialog: HTMLDialogElement,
  button: HTMLButtonElement,
  getDocument: () => Document | undefined,
  toast: (message: string) => void,
): { open: () => void; dispose: () => void } {
  const form = dialog.querySelector<HTMLFormElement>('form')!;
  const hidden = dialog.querySelector<HTMLInputElement>('#export-hidden')!;
  const sh = dialog.querySelector<HTMLInputElement>('#export-sh')!;
  const estimate = dialog.querySelector<HTMLElement>('#export-estimate')!;
  const progress = dialog.querySelector<HTMLProgressElement>('#export-progress')!;
  const submit = dialog.querySelector<HTMLButtonElement>('#export-submit')!;
  const cancel = dialog.querySelector<HTMLButtonElement>('#export-cancel')!;

  const layersForEstimate = (document: Document) =>
    document.layers.map((layer) => {
      layer.object.updateMatrix();
      return { store: layer.store, matrix: layer.object.matrix.toArray(), visible: layer.visible };
    });
  const refresh = (): void => {
    const document = getDocument();
    if (!document) return;
    const hasSh = document.layers.some((layer) => layer.store.shDegree > 0);
    sh.disabled = !hasSh;
    if (!hasSh) sh.checked = false;
    estimate.textContent = `Estimated size · ${formatBytes(estimateGaussianPlyBytes(layersForEstimate(document), { includeHidden: hidden.checked, includeSh: sh.checked }))}`;
  };
  const open = (): void => {
    const document = getDocument();
    if (!document || document.layers.length === 0) {
      toast('Open a scene before exporting.');
      return;
    }
    hidden.checked = false;
    sh.checked = document.layers.some((layer) => layer.store.shDegree > 0);
    progress.hidden = true;
    progress.value = 0;
    refresh();
    if (!dialog.open) dialog.showModal();
  };
  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    const document = getDocument();
    if (!document) return;
    submit.disabled = true;
    cancel.disabled = true;
    progress.hidden = false;
    progress.removeAttribute('value');
    const name = exportName(document);
    const destination = prepareSaveFile(name);
    const exported = exportPly(
      document.layers,
      { includeHidden: hidden.checked, includeSh: sh.checked, version: '0.1.0' },
      (written, total) => {
        progress.max = Math.max(total, 1);
        progress.value = written;
      },
    );
    void Promise.all([destination, exported])
      .then(async ([saveTo, buffer]) => {
        await saveTo.save(new Blob([buffer], { type: 'application/octet-stream' }));
        dialog.close();
        toast(`Saved as ${name}`);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error(error);
        toast(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        submit.disabled = false;
        cancel.disabled = false;
      });
  };
  const close = (): void => dialog.close();
  button.addEventListener('click', open);
  form.addEventListener('submit', onSubmit);
  cancel.addEventListener('click', close);
  hidden.addEventListener('change', refresh);
  sh.addEventListener('change', refresh);
  return {
    open,
    dispose: () => {
      button.removeEventListener('click', open);
      form.removeEventListener('submit', onSubmit);
      cancel.removeEventListener('click', close);
      hidden.removeEventListener('change', refresh);
      sh.removeEventListener('change', refresh);
    },
  };
}
