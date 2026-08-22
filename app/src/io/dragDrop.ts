import { isGroupsFile } from './loadGroups';

const SUPPORTED_FILE = /\.(?:ply|spz|splat|ksplat|sog)$/i;

export function isSupportedSplat(file: File): boolean {
  return SUPPORTED_FILE.test(file.name);
}

export function wireFileInput(
  input: HTMLInputElement,
  openButton: HTMLButtonElement,
  overlay: HTMLElement,
  onFile: (file: File) => void,
  onError: (message: string) => void,
  onGroupsFile?: (file: File) => void,
): () => void {
  let dragDepth = 0;

  const openPicker = (): void => input.click();
  const accept = (file?: File): void => {
    if (!file) return;
    // A .groups sidecar attaches to the open scene rather than replacing it.
    if (isGroupsFile(file)) {
      if (onGroupsFile) onGroupsFile(file);
      else onError('Open a splat first, then drop its .groups sidecar.');
      return;
    }
    if (!isSupportedSplat(file)) {
      onError('Unsupported file. Choose a PLY, SPZ, SPLAT, KSPLAT, SOG, or .groups file.');
      return;
    }
    onFile(file);
  };
  const onChange = (): void => {
    accept(input.files?.[0]);
    input.value = '';
  };
  const onDragEnter = (event: DragEvent): void => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    dragDepth += 1;
    overlay.hidden = false;
  };
  const onDragOver = (event: DragEvent): void => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
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
    if ((event.dataTransfer?.files.length ?? 0) > 1) {
      onError('Drop one splat at a time.');
      return;
    }
    accept(event.dataTransfer?.files[0]);
  };

  openButton.addEventListener('click', openPicker);
  input.addEventListener('change', onChange);
  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);

  return (): void => {
    openButton.removeEventListener('click', openPicker);
    input.removeEventListener('change', onChange);
    window.removeEventListener('dragenter', onDragEnter);
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('dragleave', onDragLeave);
    window.removeEventListener('drop', onDrop);
  };
}
