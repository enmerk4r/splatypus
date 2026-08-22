const SUPPORTED_FILE = /\.(?:ply|spz|splat|ksplat|sog)$/i;

export function isSupportedSplat(file: File): boolean {
  return SUPPORTED_FILE.test(file.name);
}

export interface FileInputCallbacks {
  onOpen: (file: File) => void;
  onAdd: (files: File[]) => void;
  onError: (message: string) => void;
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
  const valid = (files: File[]): File[] => {
    const supported = files.filter(isSupportedSplat);
    if (supported.length !== files.length)
      callbacks.onError('Unsupported file skipped. Choose PLY, SPZ, SPLAT, KSPLAT, or SOG files.');
    return supported;
  };
  const onOpenChange = (): void => {
    const file = valid([...(openInput.files ?? [])])[0];
    if (file) callbacks.onOpen(file);
    openInput.value = '';
  };
  const onAddChange = (): void => {
    const files = valid([...(addInput.files ?? [])]);
    if (files.length) callbacks.onAdd(files);
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
    const files = valid([...(event.dataTransfer?.files ?? [])]);
    if (!files.length) return;
    if (event.shiftKey || files.length > 1) callbacks.onAdd(files);
    else callbacks.onOpen(files[0]!);
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
