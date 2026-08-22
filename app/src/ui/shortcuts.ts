import type { Viewer } from '../viewer/Viewer';

export function wireShortcuts(viewer: Viewer, openFile: () => void): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement
    )
      return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    switch (event.code) {
      case 'KeyF':
        viewer.frame();
        break;
      case 'Tab':
        event.preventDefault();
        viewer.cameraRig.toggleMode();
        break;
      case 'KeyG':
        viewer.toggleGrid();
        break;
      case 'KeyO':
        openFile();
        break;
      case 'Digit1':
      case 'Numpad1':
        viewer.setView('front');
        break;
      case 'Digit3':
      case 'Numpad3':
        viewer.setView('right');
        break;
      case 'Digit7':
      case 'Numpad7':
        viewer.setView('top');
        break;
    }
  };
  window.addEventListener('keydown', onKeyDown);
  return (): void => window.removeEventListener('keydown', onKeyDown);
}
