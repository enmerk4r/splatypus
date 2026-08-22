import { LockedLayerError, RemoveLayers } from '../model/commands';
import type { Viewer } from '../viewer/Viewer';
import type { ToastLevel } from './hud';

export interface ShortcutActions {
  openFile: () => void;
  addFile: () => void;
  exportFile: () => void;
  notify: (message: string, level?: ToastLevel) => void;
}

export function wireShortcuts(viewer: Viewer, actions: ShortcutActions): () => void {
  const execute = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      const locked = error instanceof LockedLayerError;
      actions.notify(locked ? error.message : 'That action failed.', locked ? 'warning' : 'error');
      if (!locked) console.error(error);
    }
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement
    )
      return;
    const command = event.ctrlKey || event.metaKey;
    if (command && !event.altKey) {
      const history = viewer.document?.history;
      if (event.code === 'KeyZ') {
        event.preventDefault();
        execute(() => (event.shiftKey ? history?.redo() : history?.undo()));
      } else if (event.code === 'KeyY') {
        event.preventDefault();
        execute(() => history?.redo());
      } else if (event.code === 'KeyE') {
        event.preventDefault();
        actions.exportFile();
      }
      return;
    }
    if (event.altKey) return;
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
        if (event.shiftKey) actions.addFile();
        else actions.openFile();
        break;
      case 'KeyW':
        if (viewer.cameraRig.mode === 'orbit') viewer.setTransformMode('translate');
        break;
      case 'KeyE':
        if (viewer.cameraRig.mode === 'orbit') viewer.setTransformMode('rotate');
        break;
      case 'KeyR':
        if (viewer.cameraRig.mode === 'orbit') viewer.setTransformMode('scale');
        break;
      case 'Escape':
        if (viewer.cameraRig.mode !== 'fly') viewer.document?.setSelection([]);
        break;
      case 'Delete':
      case 'Backspace': {
        const document = viewer.document;
        if (!document || document.selection.size === 0) break;
        event.preventDefault();
        execute(() => document.history.push(new RemoveLayers(document, [...document.selection])));
        break;
      }
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
