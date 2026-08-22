import { isGroupsFile } from './loadGroups';
import { isProjectFileName } from './projectFormat';

const SUPPORTED_FILE = /\.(?:ply|spz|splat|ksplat|sog)$/i;

export function isSupportedSplat(file: File): boolean {
  return SUPPORTED_FILE.test(file.name);
}

export interface FileInputCallbacks {
  onOpen: (file: File) => void;
  onProject?: (file: File) => void;
  onAdd: (files: File[]) => void;
  /** A `.groups` segmentation sidecar attaches to the open scene instead of replacing it. */
  onGroups?: (file: File) => void;
  onError: (message: string, level?: 'warning' | 'error') => void;
}

export function wireFileInput(
  openInput: HTMLInputElement,
  addInput: HTMLInputElement,
  openButton: HTMLButtonElement,
  overlay: HTMLElement,
  callbacks: FileInputCallbacks,
): () => void {
  let dragDepth = 0;
  const overlayStrong = overlay.querySelector<HTMLElement>('strong');
  const overlayHint = overlay.querySelector<HTMLElement>('span');
  /** Splits a drop into splat files (delivered) and .groups sidecars (attached); warns on the rest. */
  const route = (files: File[], deliver: (splats: File[]) => void): void => {
    const groups = files.filter(isGroupsFile);
    const splats = files.filter(isSupportedSplat);
    const projects = files.filter((file) => isProjectFileName(file.name));
    if (groups.length + splats.length + projects.length !== files.length)
      callbacks.onError(
        'Unsupported file skipped. Choose a .splatypus project, PLY, SPZ, SPLAT, KSPLAT, SOG, or .groups file.',
        'warning',
      );
    if (projects.length) {
      if (projects.length > 1 || splats.length || groups.length)
        callbacks.onError('Open one .splatypus project at a time.', 'warning');
      if (callbacks.onProject) callbacks.onProject(projects[0]!);
      else callbacks.onError('Editable project import is unavailable.', 'error');
      return;
    }
    for (const file of groups) {
      if (callbacks.onGroups) callbacks.onGroups(file);
      else callbacks.onError('Open a splat first, then drop its .groups sidecar.', 'warning');
    }
    if (splats.length) deliver(splats);
  };
  const onOpenChange = (): void => {
    route([...(openInput.files ?? [])], (splats) => callbacks.onOpen(splats[0]!));
    openInput.value = '';
  };
  const onAddChange = (): void => {
    route([...(addInput.files ?? [])], (splats) => callbacks.onAdd(splats));
    addInput.value = '';
  };
  const onDragEnter = (event: DragEvent): void => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    dragDepth += 1;
    overlay.hidden = false;
    if (overlayStrong)
      overlayStrong.textContent = event.shiftKey ? 'Drop to add layer' : 'Drop to open';
    if (overlayHint)
      overlayHint.textContent = event.shiftKey
        ? 'The current scene stays open'
        : 'Multiple files are added as layers';
  };
  const onDragOver = (event: DragEvent): void => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (overlayStrong)
      overlayStrong.textContent = event.shiftKey ? 'Drop to add layer' : 'Drop to open';
  };
  const onDragLeave = (event: DragEvent): void => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.hidden = true;
  };
  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    route([...(event.dataTransfer?.files ?? [])], (splats) => {
      if (event.shiftKey || splats.length > 1) callbacks.onAdd(splats);
      else callbacks.onOpen(splats[0]!);
    });
  };
  const openPicker = (): void => openInput.click();
  openButton.addEventListener('click', openPicker);
  openInput.addEventListener('change', onOpenChange);
  addInput.addEventListener('change', onAddChange);
  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);
  return (): void => {
    openButton.removeEventListener('click', openPicker);
    openInput.removeEventListener('change', onOpenChange);
    addInput.removeEventListener('change', onAddChange);
    window.removeEventListener('dragenter', onDragEnter);
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('dragleave', onDragLeave);
    window.removeEventListener('drop', onDrop);
  };
}
