import { Vector3 } from 'three';
import type { Document } from '../model/Document';
import type { Layer } from '../model/Layer';
import {
  DuplicateLayer,
  LockedLayerError,
  RemoveLayers,
  SetLayerTransform,
} from '../model/commands';
import { GridArrayLayer, snapToFloorCommand } from '../model/segmentCommands';
import type { Segmentation } from '../select/Segmentation';
import { ScreenSelection } from '../select/ScreenSelection';
import type { ScreenSelectionMode } from '../select/ScreenSelection';
import type { TransformMode } from '../viewer/LayerGizmo';
import type { Viewer } from '../viewer/Viewer';
import type { ToolMode } from '../viewer/Viewer';
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
    <div class="toolbar-group" aria-label="History">
      ${button('data-op', 'undo', 'Undo (⌘Z)', 'undo the last edit')}
      ${button('data-op', 'redo', 'Redo (⇧⌘Z)', 'redo the last undone edit')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group" role="group" aria-label="Sketch tools">
      ${button('data-tool', 'pen', 'Sketch (S)', 'draw gaussian strokes')}
      ${button('data-tool', 'eraser', 'Erase stroke (X)', 'remove whole sketch strokes')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group">
      ${button('data-op', 'split', 'Split to layer', 'lift the selected group out of its layer')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group" role="group" aria-label="Transform mode">
      ${button('data-mode', 'select', 'Select (Q)', 'pick layers; drag the gumball to move')}
      ${button('data-mode', 'rotate', 'Rotate (E)', 'spin it in place')}
      ${button('data-mode', 'scale', 'Scale (R)', 'resize it uniformly')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group">
      ${button('data-op', 'duplicate', 'Duplicate', 'copy the active layer')}
      ${button('data-op', 'array', 'Array', 'copy the active layer into a columns by rows grid')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group">
      ${button('data-op', 'isolate', 'Isolate', 'show only the active layer')}
      ${button('data-op', 'floor', 'Snap to floor', 'drop it onto the ground plane')}
      ${button('data-op', 'delete', 'Delete', 'remove the selected layers (undoable)')}
    </div>
    <form class="scale-popover" aria-label="Scale factor" hidden>
      <label><span>×</span><input type="number" min="0.001" step="0.1" value="1" aria-label="Scale factor" /></label>
      <button type="button">Apply</button>
    </form>
    <form class="array-popover" aria-label="Array size" hidden>
      <input type="number" min="1" max="20" step="1" value="5" aria-label="Columns" />
      <span>×</span>
      <input type="number" min="1" max="20" step="1" value="1" aria-label="Rows" />
      <button type="button">Apply</button>
    </form>
    <div class="selection-popover" role="menu" aria-label="Selection method" hidden>
      ${['pointer', 'rectangle', 'lasso', 'polygon', 'brush']
        .map(
          (mode) =>
            `<button type="button" data-selection-tool="${mode}" role="menuitem" aria-label="${mode[0]!.toUpperCase()}${mode.slice(1)} selection" title="${mode[0]!.toUpperCase()}${mode.slice(1)} selection">${icon(mode === 'pointer' ? 'select' : mode)}</button>`,
        )
        .join('')}
    </div>
  `;

  const op = (name: string): HTMLButtonElement =>
    host.querySelector<HTMLButtonElement>(`[data-op="${name}"]`)!;
  const modeButtons = [...host.querySelectorAll<HTMLButtonElement>('[data-mode]')];
  const toolButtons = [...host.querySelectorAll<HTMLButtonElement>('[data-tool]')];
  const scaleButton = host.querySelector<HTMLButtonElement>('[data-mode="scale"]')!;
  const scalePopover = host.querySelector<HTMLFormElement>('.scale-popover')!;
  const scaleInput = scalePopover.querySelector<HTMLInputElement>('input')!;
  const scaleApply = scalePopover.querySelector<HTMLButtonElement>('button')!;
  const arrayButton = op('array');
  const arrayPopover = host.querySelector<HTMLFormElement>('.array-popover')!;
  const arrayInputs = [...arrayPopover.querySelectorAll<HTMLInputElement>('input')];
  const arrayApply = arrayPopover.querySelector<HTMLButtonElement>('button')!;
  const selectButton = host.querySelector<HTMLButtonElement>('[data-mode="select"]')!;
  const selectionPopover = host.querySelector<HTMLElement>('.selection-popover')!;
  const selectionButtons = [
    ...selectionPopover.querySelectorAll<HTMLButtonElement>('[data-selection-tool]'),
  ];
  const screenSelection = new ScreenSelection(viewer, segmentation);

  const setScalePopover = (visible: boolean): void => {
    scalePopover.hidden = !visible;
    scaleButton.setAttribute('aria-expanded', String(visible));
    if (!visible) return;
    const hostRect = host.getBoundingClientRect();
    const buttonRect = scaleButton.getBoundingClientRect();
    scalePopover.style.left = `${buttonRect.left - hostRect.left + buttonRect.width / 2}px`;
  };

  const setArrayPopover = (visible: boolean): void => {
    arrayPopover.hidden = !visible;
    arrayButton.setAttribute('aria-expanded', String(visible));
    if (!visible) return;
    const hostRect = host.getBoundingClientRect();
    const buttonRect = arrayButton.getBoundingClientRect();
    arrayPopover.style.left = `${buttonRect.left - hostRect.left + buttonRect.width / 2}px`;
  };

  const setSelectionPopover = (visible: boolean): void => {
    selectionPopover.hidden = !visible;
    selectButton.setAttribute('aria-expanded', String(visible));
    if (!visible) return;
    const hostRect = host.getBoundingClientRect();
    const buttonRect = selectButton.getBoundingClientRect();
    selectionPopover.style.left = `${buttonRect.left - hostRect.left + buttonRect.width / 2}px`;
  };

  const renderSelectionMode = (): void => {
    const mode = screenSelection.mode;
    selectButton.innerHTML = `${icon(mode === 'pointer' ? 'select' : mode)}<span class="sr-only">Select (Q)</span>`;
    for (const value of selectionButtons)
      value.setAttribute('aria-pressed', String(value.dataset.selectionTool === mode));
  };

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
    const allEditable = selected.length > 0 && selected.every((layer) => !layer.locked);
    op('undo').disabled = !document.history.canUndo();
    op('redo').disabled = !document.history.canRedo();
    op('split').disabled = !groupSelection || groupSelection.layer.locked;
    op('duplicate').disabled = !editable;
    op('array').disabled = !editable;
    op('floor').disabled = !editable;
    op('delete').disabled = selected.length === 0 || selected.some((layer) => layer.locked);
    const soloed = document.solo !== undefined;
    op('isolate').disabled = !active && !soloed;
    const isolateLabel = soloed ? 'Show all' : 'Isolate';
    op('isolate').title =
      `${isolateLabel} — ${soloed ? 'show every layer again' : 'show only the active layer'}`;
    op('isolate').setAttribute('aria-label', isolateLabel);
    op('isolate').setAttribute('aria-pressed', String(soloed));
    for (const modeButton of modeButtons) {
      const mode = modeButton.dataset.mode === 'select' ? 'translate' : modeButton.dataset.mode;
      modeButton.disabled =
        modeButton === selectButton
          ? !allEditable && segmentation.segmentedLayers.length === 0
          : !allEditable || (selected.length > 1 && mode !== 'translate');
      modeButton.setAttribute(
        'aria-pressed',
        String(viewer.tool === 'select' && mode === viewer.transformMode),
      );
    }
    const toolNames: Record<string, ToolMode> = {
      pen: 'sketch',
      eraser: 'erase',
    };
    for (const toolButton of toolButtons)
      toolButton.setAttribute(
        'aria-pressed',
        String(toolNames[toolButton.dataset.tool ?? ''] === viewer.tool),
      );
    if (scaleButton.disabled || viewer.transformMode !== 'scale') setScalePopover(false);
    if (arrayButton.disabled) setArrayPopover(false);
    if (selectButton.disabled) setSelectionPopover(false);
  };

  const withActive = (run: (document: Document, layer: Layer) => void) => (): void => {
    const document = viewer.document;
    const active = document?.active();
    if (document && active) execute(() => run(document, active));
  };

  const handlers: Record<string, () => void> = {
    undo: (): void => execute(() => viewer.document?.history.undo()),
    redo: (): void => execute(() => viewer.document?.history.redo()),
    split: (): void => execute(() => void segmentation.splitSelection()),
    duplicate: withActive((document, layer) => {
      const command = new DuplicateLayer(document, layer);
      document.history.push(command);
      document.setSelection([command.duplicate.id]);
    }),
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
  arrayButton.addEventListener('click', () => {
    setArrayPopover(arrayPopover.hidden);
    setScalePopover(false);
    setSelectionPopover(false);
    if (!arrayPopover.hidden) arrayInputs[0]?.focus();
  });
  for (const modeButton of modeButtons)
    modeButton.addEventListener('click', () => {
      const mode = modeButton.dataset.mode === 'select' ? 'translate' : modeButton.dataset.mode;
      viewer.setTool('select');
      viewer.setTransformMode(mode as TransformMode);
      setScalePopover(modeButton === scaleButton ? scalePopover.hidden : false);
      setSelectionPopover(modeButton === selectButton ? selectionPopover.hidden : false);
      setArrayPopover(false);
      if (modeButton !== selectButton) {
        screenSelection.setMode('pointer');
        renderSelectionMode();
      }
    });

  for (const value of selectionButtons)
    value.addEventListener('click', () => {
      viewer.setTool('select');
      screenSelection.setMode(value.dataset.selectionTool as ScreenSelectionMode);
      viewer.setTransformMode('translate');
      renderSelectionMode();
      setSelectionPopover(false);
    });

  const applyScaleFactor = (): void => {
    const document = viewer.document;
    const layer = document?.selection.size === 1 ? document.active() : undefined;
    const factor = Number(scaleInput.value);
    if (!document || !layer || layer.locked) return;
    if (!Number.isFinite(factor) || factor <= 0) {
      callbacks.notify('Scale factor must be greater than 0.', 'warning');
      scaleInput.focus();
      return;
    }
    if (factor !== 1) {
      layer.object.updateMatrix();
      const before = layer.object.matrix.clone();
      const after = before.clone().scale(new Vector3(factor, factor, factor));
      execute(() =>
        document.history.push(new SetLayerTransform(document, layer.id, before, after)),
      );
    }
    scaleInput.value = '1';
    setScalePopover(false);
  };
  const onScaleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyScaleFactor();
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      setScalePopover(false);
      scaleButton.focus();
    }
  };

  const applyArray = (): void => {
    const document = viewer.document;
    const layer = document?.selection.size === 1 ? document.active() : undefined;
    const rawColumns = Number(arrayInputs[0]?.value);
    const rawRows = Number(arrayInputs[1]?.value);
    if (!document || !layer || layer.locked) return;
    if (
      !Number.isFinite(rawColumns) ||
      !Number.isFinite(rawRows) ||
      rawColumns < 1 ||
      rawRows < 1
    ) {
      callbacks.notify('Array columns and rows must be at least 1.', 'warning');
      arrayInputs[0]?.focus();
      return;
    }
    const columns = Math.min(20, Math.round(rawColumns));
    const rows = Math.min(20, Math.round(rawRows));
    if (columns * rows > 100) {
      callbacks.notify('Array size is limited to 100 layers.', 'warning');
      arrayInputs[0]?.focus();
      return;
    }
    if (columns * rows > 1) {
      const bounds = layer.store.computeRobustBounds();
      const width = bounds.max[0] - bounds.min[0];
      const depth = Math.max(bounds.max[2] - bounds.min[2], width * 0.5);
      const columnStep = new Vector3(width * 1.2 * layer.object.scale.x, 0, 0);
      const rowStep = new Vector3(0, 0, depth * 1.2 * layer.object.scale.z);
      execute(() =>
        document.history.push(
          new GridArrayLayer(document, layer, columns, rows, columnStep, rowStep),
        ),
      );
    }
    setArrayPopover(false);
  };
  const onArrayKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyArray();
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      setArrayPopover(false);
      arrayButton.focus();
    }
  };
  const onOutsideScale = (event: PointerEvent): void => {
    const target = event.target as Node;
    if (!scalePopover.hidden && !scalePopover.contains(target) && !scaleButton.contains(target))
      setScalePopover(false);
    if (!arrayPopover.hidden && !arrayPopover.contains(target) && !arrayButton.contains(target))
      setArrayPopover(false);
    if (
      !selectionPopover.hidden &&
      !selectionPopover.contains(target) &&
      !selectButton.contains(target)
    )
      setSelectionPopover(false);
  };
  scaleApply.addEventListener('click', applyScaleFactor);
  scaleInput.addEventListener('keydown', onScaleKeyDown);
  arrayApply.addEventListener('click', applyArray);
  for (const input of arrayInputs) input.addEventListener('keydown', onArrayKeyDown);
  document.addEventListener('pointerdown', onOutsideScale);
  renderSelectionMode();

  const toolNames: Record<string, ToolMode> = { pen: 'sketch', eraser: 'erase' };
  for (const toolButton of toolButtons)
    toolButton.addEventListener('click', () => {
      const tool = toolNames[toolButton.dataset.tool ?? ''];
      if (tool) viewer.setTool(tool);
      setScalePopover(false);
      setArrayPopover(false);
      setSelectionPopover(false);
    });

  let observed = viewer.document;
  const observe = (): void => {
    observed?.removeEventListener('layers-changed', render);
    observed?.removeEventListener('layer-changed', render);
    observed?.removeEventListener('selection-changed', render);
    observed?.removeEventListener('history-changed', render);
    observed = viewer.document;
    observed?.addEventListener('layers-changed', render);
    observed?.addEventListener('layer-changed', render);
    observed?.addEventListener('selection-changed', render);
    observed?.addEventListener('history-changed', render);
    render();
  };
  viewer.addEventListener('document-changed', observe);
  viewer.addEventListener('transform-mode-changed', render);
  viewer.addEventListener('tool-changed', render);
  segmentation.addEventListener('selection-changed', render);
  segmentation.addEventListener('groups-changed', render);
  observe();

  return {
    dispose: (): void => {
      viewer.removeEventListener('document-changed', observe);
      viewer.removeEventListener('transform-mode-changed', render);
      viewer.removeEventListener('tool-changed', render);
      segmentation.removeEventListener('selection-changed', render);
      segmentation.removeEventListener('groups-changed', render);
      observed?.removeEventListener('layers-changed', render);
      observed?.removeEventListener('layer-changed', render);
      observed?.removeEventListener('selection-changed', render);
      observed?.removeEventListener('history-changed', render);
      scaleApply.removeEventListener('click', applyScaleFactor);
      scaleInput.removeEventListener('keydown', onScaleKeyDown);
      arrayApply.removeEventListener('click', applyArray);
      for (const input of arrayInputs) input.removeEventListener('keydown', onArrayKeyDown);
      document.removeEventListener('pointerdown', onOutsideScale);
      screenSelection.dispose();
    },
  };
}
