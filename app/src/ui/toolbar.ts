import { Vector3 } from 'three';
import type { Document } from '../model/Document';
import type { Layer } from '../model/Layer';
import { DuplicateLayer, LockedLayerError, MergeLayers, RemoveLayers } from '../model/commands';
import { ArrayLayer, snapToFloorCommand } from '../model/segmentCommands';
import type { Segmentation } from '../select/Segmentation';
import type { TransformMode } from '../viewer/LayerGizmo';
import type { Viewer } from '../viewer/Viewer';
import type { ToastLevel } from './hud';
import { icon } from './icons';

export interface ToolbarCallbacks {
  notify: (message: string, level?: ToastLevel) => void;
}

/**
 * The bottom bar: everything that acts on the object being edited (the active layer)
 * or on the current group selection. It stays in one fixed place rather than following
 * the selection, so the tools are always where the hand expects them.
 */
export function createToolbar(
  viewer: Viewer,
  segmentation: Segmentation,
  host: HTMLElement,
  callbacks: ToolbarCallbacks,
): { dispose: () => void } {
  const button = (attr: string, name: string, label: string, hint: string): string =>
    `<button type="button" ${attr}="${name}" title="${label} — ${hint}" aria-label="${label}">` +
    `${icon(name)}<span class="sr-only">${label}</span></button>`;

  host.innerHTML = `
    <div class="toolbar-group">
      ${button('data-op', 'split', 'Split to layer', 'lift the selected group out of its layer')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group" role="group" aria-label="Transform mode">
      ${button('data-mode', 'translate', 'Move (W)', 'drag the active layer')}
      ${button('data-mode', 'rotate', 'Rotate (E)', 'spin it in place')}
      ${button('data-mode', 'scale', 'Scale (R)', 'resize it uniformly')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group">
      ${button('data-op', 'duplicate', 'Duplicate', 'copy the active layer')}
      ${button('data-op', 'array', 'Array ×5', 'copy it four more times in a row')}
      ${button('data-op', 'merge', 'Merge', 'merge the selected layers into one')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group">
      ${button('data-op', 'isolate', 'Isolate', 'show only the active layer')}
      ${button('data-op', 'floor', 'Snap to floor', 'drop it onto the ground plane')}
      ${button('data-op', 'delete', 'Delete', 'remove the selected layers (undoable)')}
    </div>
  `;

  const op = (name: string): HTMLButtonElement =>
    host.querySelector<HTMLButtonElement>(`[data-op="${name}"]`)!;
  const modeButtons = [...host.querySelectorAll<HTMLButtonElement>('[data-mode]')];

  const execute = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      const locked = error instanceof LockedLayerError;
      callbacks.notify(
        locked ? error.message : 'That action failed.',
        locked ? 'warning' : 'error',
      );
      if (!locked) console.error(error);
    }
  };

  const selectedLayers = (document: Document): Layer[] =>
    [...document.selection]
      .map((id) => document.getLayer(id))
      .filter((layer): layer is Layer => Boolean(layer));

  const render = (): void => {
    const document = viewer.document;
    host.hidden = !document || document.layers.length === 0;
    if (!document) return;
    const active = document.active();
    const selected = selectedLayers(document);
    const groupSelection = segmentation.selection;
    const editable = active !== undefined && !active.locked;
    op('split').disabled = !groupSelection || groupSelection.layer.locked;
    op('duplicate').disabled = !editable;
    op('array').disabled = !editable;
    op('floor').disabled = !editable;
    op('merge').disabled = selected.length < 2 || selected.some((layer) => layer.locked);
    op('delete').disabled = selected.length === 0 || selected.some((layer) => layer.locked);
    const soloed = document.solo !== undefined;
    op('isolate').disabled = !active && !soloed;
    const isolateLabel = soloed ? 'Show all' : 'Isolate';
    op('isolate').title =
      `${isolateLabel} — ${soloed ? 'show every layer again' : 'show only the active layer'}`;
    op('isolate').setAttribute('aria-label', isolateLabel);
    op('isolate').setAttribute('aria-pressed', String(soloed));
    for (const modeButton of modeButtons) {
      modeButton.disabled = !editable;
      modeButton.setAttribute(
        'aria-pressed',
        String(modeButton.dataset.mode === viewer.transformMode),
      );
    }
  };

  const withActive = (run: (document: Document, layer: Layer) => void) => (): void => {
    const document = viewer.document;
    const active = document?.active();
    if (document && active) execute(() => run(document, active));
  };

  const handlers: Record<string, () => void> = {
    split: (): void => execute(() => void segmentation.splitSelection()),
    duplicate: withActive((document, layer) => {
      const command = new DuplicateLayer(document, layer);
      document.history.push(command);
      document.setSelection([command.duplicate.id]);
    }),
    array: withActive((document, layer) => {
      const bounds = layer.store.computeRobustBounds();
      const step = new Vector3((bounds.max[0] - bounds.min[0]) * 1.2 * layer.object.scale.x, 0, 0);
      document.history.push(new ArrayLayer(document, layer, 4, step));
    }),
    merge: (): void => {
      const document = viewer.document;
      if (!document) return;
      const selected = selectedLayers(document);
      if (selected.length < 2) return;
      execute(() => {
        const command = new MergeLayers(
          document,
          selected.map((layer) => layer.id),
          `${selected[0]?.name ?? 'Layer'} merge`,
        );
        document.history.push(command);
        document.setSelection([command.merged.id]);
      });
    },
    isolate: (): void => {
      const document = viewer.document;
      if (!document) return;
      document.setSolo(document.solo === undefined ? document.active()?.id : undefined);
    },
    floor: withActive((document, layer) => {
      const command = snapToFloorCommand(document, layer);
      if (command) document.history.push(command);
    }),
    delete: (): void => {
      const document = viewer.document;
      if (!document || document.selection.size === 0) return;
      execute(() => document.history.push(new RemoveLayers(document, [...document.selection])));
    },
  };
  for (const [name, handler] of Object.entries(handlers))
    op(name).addEventListener('click', handler);
  for (const modeButton of modeButtons)
    modeButton.addEventListener('click', () =>
      viewer.setTransformMode(modeButton.dataset.mode as TransformMode),
    );

  let observed = viewer.document;
  const observe = (): void => {
    observed?.removeEventListener('layers-changed', render);
    observed?.removeEventListener('layer-changed', render);
    observed?.removeEventListener('selection-changed', render);
    observed = viewer.document;
    observed?.addEventListener('layers-changed', render);
    observed?.addEventListener('layer-changed', render);
    observed?.addEventListener('selection-changed', render);
    render();
  };
  viewer.addEventListener('document-changed', observe);
  viewer.addEventListener('transform-mode-changed', render);
  segmentation.addEventListener('selection-changed', render);
  observe();

  return {
    dispose: (): void => {
      viewer.removeEventListener('document-changed', observe);
      viewer.removeEventListener('transform-mode-changed', render);
      segmentation.removeEventListener('selection-changed', render);
      observed?.removeEventListener('layers-changed', render);
      observed?.removeEventListener('layer-changed', render);
      observed?.removeEventListener('selection-changed', render);
    },
  };
}
