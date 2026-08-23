import { LockedLayerError, RemoveLayers } from '../model/commands';
import type { Viewer } from '../viewer/Viewer';
import type { ToastLevel } from './hud';

export interface ShortcutActions {
  openFile: () => void;
  addFile: () => void;
  exportFile: () => void;
  notify: (message: string, level?: ToastLevel) => void;
  cancelStroke: () => boolean;
  adjustSketchSize: (factor: number) => void;
  adjustSketchOpacity: (delta: number) => void;
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
    // A stroke in progress owns the view: no reframing/view switches until it is committed.
    if (
      viewer.cameraLocked &&
      ['KeyF', 'Tab', 'Digit1', 'Numpad1', 'Digit3', 'Numpad3', 'Digit7', 'Numpad7'].includes(
        event.code,
      )
    )
      return;
    switch (event.code) {
      case 'KeyF':
        viewer.frame();
        break;
      case 'KeyQ':
        if (viewer.cameraRig.mode === 'orbit') {
          viewer.setTool('select');
          viewer.setTransformMode('translate');
        }
        break;
      case 'KeyS':
        if (viewer.cameraRig.mode === 'orbit') viewer.setTool('sketch');
        break;
      case 'KeyX':
        if (viewer.cameraRig.mode === 'orbit') viewer.setTool('erase');
        break;
      case 'KeyC':
        if (viewer.cameraRig.mode === 'orbit') viewer.setTool('recolor');
        break;
      case 'KeyD':
        if (viewer.cameraRig.mode === 'orbit') viewer.setTool('fade');
        break;
      case 'KeyV':
        if (viewer.cameraRig.mode === 'orbit') viewer.setTool('grab');
        break;
      case 'KeyI':
        if (viewer.cameraRig.mode === 'orbit') viewer.setTool('inflate');
        break;
      case 'KeyM':
        if (viewer.cameraRig.mode === 'orbit') viewer.setTool('measure');
        break;
      case 'KeyP':
        if (viewer.cameraRig.mode === 'orbit') viewer.setTool('polyline');
        break;
      case 'KeyA':
        if (viewer.cameraRig.mode === 'orbit') viewer.setTool('aiselect');
        break;
      case 'KeyK': {
        // Toggle the work plane; showing it also brings its gizmo up, since placing it is
        // the only reason to show it.
        const plane = viewer.workPlane;
        const next = !plane.enabled;
        plane.setEnabled(next);
        plane.setEditing(next);
        break;
      }
      case 'BracketLeft':
      case 'BracketRight': {
        // The AI selection tool owns the brackets while it is active: they step through
        // SAM's alternative masks, and there is no brush to resize.
        if (viewer.tool === 'aiselect') break;
        event.preventDefault();
        const increase = event.code === 'BracketRight';
        if (event.shiftKey) actions.adjustSketchOpacity(increase ? 0.1 : -0.1);
        else actions.adjustSketchSize(increase ? 1.25 : 0.8);
        break;
      }
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
        actions.cancelStroke();
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
