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
import type { CropBox, CropMode } from '../select/CropBox';
import type { Segmentation } from '../select/Segmentation';
import { RegionTool } from '../select/RegionTool';
import type { RegionToolMode } from '../select/RegionTool';
import type { RegionSettingsStore } from '../select/regionSettings';
import type { TransformMode } from '../viewer/LayerGizmo';
import type { Viewer } from '../viewer/Viewer';
import type { ToolMode } from '../viewer/Viewer';
import type { ToastLevel } from './hud';
import { icon } from './icons';

export interface ToolbarCallbacks {
  notify: (message: string, level?: ToastLevel) => void;
}

/** The region-selection methods, in the order they appear in the Select popover. */
const SELECTION_MODES: { mode: RegionToolMode; label: string; hint: string }[] = [
  { mode: 'pointer', label: 'Pointer', hint: 'pick layers and baked groups' },
  { mode: 'wand', label: 'Magic wand', hint: 'click an object; the selection grows to its edges' },
  { mode: 'rectangle', label: 'Rectangle select', hint: 'drag a box over the splats to select' },
  { mode: 'lasso', label: 'Lasso select', hint: 'draw around the splats to select' },
  {
    mode: 'polygon',
    label: 'Polygon select',
    hint: 'click corners, double-click or Enter to close',
  },
  { mode: 'brush', label: 'Selection brush', hint: 'paint splats in; Alt paints them out' },
];

/**
 * The bottom bar: everything that acts on the object being edited (the active layer)
 * or on the current group selection. It stays in one fixed place rather than following
 * the selection, so the tools are always where the hand expects them.
 */
export function createToolbar(
  viewer: Viewer,
  segmentation: Segmentation,
  crop: CropBox,
  regionSettings: RegionSettingsStore,
  host: HTMLElement,
  callbacks: ToolbarCallbacks,
): { regionTool: RegionTool; dispose: () => void } {
  const button = (attr: string, name: string, label: string, hint: string): string =>
    `<button type="button" ${attr}="${name}" title="${label} — ${hint}" aria-label="${label}">` +
    `${icon(name)}<span class="sr-only">${label}</span></button>`;

  host.innerHTML = `
    <div class="toolbar-group" role="group" aria-label="Sketch tools">
      ${button('data-tool', 'pen', 'Sketch (S)', 'draw gaussian strokes')}
      ${button('data-tool', 'eraser', 'Erase (X)', 'erase splats of the active layer under the brush')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group" role="group" aria-label="Brushes">
      ${button('data-tool', 'recolor', 'Recolor (C)', 'tint the active layer towards the brush colour')}
      ${button('data-tool', 'fade', 'Fade (D)', 'fade splats of the active layer (Shift restores)')}
      ${button('data-tool', 'grab', 'Grab (V)', 'drag splats of the active layer along the screen')}
      ${button('data-tool', 'inflate', 'Inflate (I)', 'grow splats of the active layer (Shift shrinks)')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group">
      ${button('data-tool', 'aiselect', 'AI select (J)', 'click an object; SAM proposes a mask, Alt-click removes a region, Enter commits')}
      ${button('data-op', 'split', 'Split to layer', 'lift the current selection out of its layer')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group" role="group" aria-label="Transform mode">
      ${button('data-mode', 'select', 'Select (Q)', 'pick layers; drag the gumball to move')}
      ${button('data-mode', 'rotate', 'Rotate (E)', 'spin it in place')}
      ${button('data-mode', 'scale', 'Scale (R)', 'resize it uniformly')}
      ${button('data-tool', 'measure', 'Measure / scale to reference (M)', 'pick two points on the active layer, type the real distance, the layer is scaled to match')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group" role="group" aria-label="Modelling">
      ${button('data-tool', 'polyline', 'Polyline → extrude (P)', 'click an outline on a plane, double-click or Enter to close, type a height: a capped mesh layer')}
      ${button('data-op', 'plane', 'Work plane (K)', 'place the plane that sketching and polylines draw on')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group">
      ${button('data-op', 'duplicate', 'Duplicate', 'copy the active layer')}
      ${button('data-op', 'array', 'Array', 'copy the active layer into a columns by rows grid')}
      ${button('data-op', 'crop', 'Crop', 'show crop controls')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group">
      ${button('data-op', 'isolate', 'Isolate', 'show only the active layer')}
      ${button('data-op', 'floor', 'Snap to floor', 'drop it onto the ground plane')}
      ${button('data-op', 'undo', 'Undo (⌘Z)', 'undo the last edit')}
      ${button('data-op', 'redo', 'Redo (⇧⌘Z)', 'redo the last undone edit')}
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
      ${SELECTION_MODES.map(
        ({ mode, label, hint }) =>
          `<button type="button" data-selection-tool="${mode}" role="menuitem" aria-label="${label}" title="${label} — ${hint}">${icon(mode === 'pointer' ? 'select' : mode)}</button>`,
      ).join('')}
    </div>
    <div class="plane-popover" role="menu" aria-label="Work plane controls" hidden>
      ${button('data-plane', 'workplane', 'Show work plane', 'draw on a plane you place yourself')}
      ${button('data-plane', 'planeMove', 'Move plane', 'drag the plane along its axes')}
      ${button('data-plane', 'planeRotate', 'Rotate plane', 'tilt the plane')}
      <span class="toolbar-rule"></span>
      ${button('data-plane', 'planeGround', 'Ground (XZ)', 'lay the plane flat')}
      ${button('data-plane', 'planeFront', 'Front (XY)', 'stand the plane up, facing front')}
      ${button('data-plane', 'planeSide', 'Side (YZ)', 'stand the plane up, facing side')}
      ${button('data-plane', 'planeView', 'Face view', 'square the plane to the camera')}
      ${button('data-plane', 'planeReset', 'Reset plane', 'back to the horizontal plane through the origin')}
    </div>
    <div class="crop-popover" role="menu" aria-label="Crop controls" hidden>
      ${button('data-crop', 'crop', 'Show crop box', 'toggle the crop box')}
      ${button('data-crop', 'translate', 'Move crop box', 'move the crop box')}
      ${button('data-crop', 'scale', 'Resize crop box', 'resize the crop box')}
      ${button('data-crop', 'cropKeep', 'Keep inside', 'hide splats outside the crop box')}
      ${button('data-crop', 'cropCut', 'Cut inside', 'hide splats inside the crop box')}
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
  const cropButton = op('crop');
  const planeButton = op('plane');
  const planePopover = host.querySelector<HTMLElement>('.plane-popover')!;
  const planeItem = (name: string): HTMLButtonElement =>
    planePopover.querySelector<HTMLButtonElement>(`[data-plane="${name}"]`)!;
  const planeShow = planeItem('workplane');
  const planeMove = planeItem('planeMove');
  const planeRotate = planeItem('planeRotate');
  const cropPopover = host.querySelector<HTMLElement>('.crop-popover')!;
  const cropToggle = cropPopover.querySelector<HTMLButtonElement>('[data-crop="crop"]')!;
  const cropMove = cropPopover.querySelector<HTMLButtonElement>('[data-crop="translate"]')!;
  const cropResize = cropPopover.querySelector<HTMLButtonElement>('[data-crop="scale"]')!;
  const cropKeep = cropPopover.querySelector<HTMLButtonElement>('[data-crop="cropKeep"]')!;
  const cropCut = cropPopover.querySelector<HTMLButtonElement>('[data-crop="cropCut"]')!;
  const selectButton = host.querySelector<HTMLButtonElement>('[data-mode="select"]')!;
  const selectionPopover = host.querySelector<HTMLElement>('.selection-popover')!;
  const selectionButtons = [
    ...selectionPopover.querySelectorAll<HTMLButtonElement>('[data-selection-tool]'),
  ];
  const regionTool = new RegionTool(viewer, segmentation.region, regionSettings, {
    targetLayer: () => segmentation.targetLayer(),
    notify: callbacks.notify,
  });

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

  const setPlanePopover = (visible: boolean): void => {
    planePopover.hidden = !visible;
    planeButton.setAttribute('aria-expanded', String(visible));
    if (!visible) return;
    const hostRect = host.getBoundingClientRect();
    const buttonRect = planeButton.getBoundingClientRect();
    planePopover.style.left = `${buttonRect.left - hostRect.left + buttonRect.width / 2}px`;
  };

  const setCropPopover = (visible: boolean): void => {
    cropPopover.hidden = !visible;
    cropButton.setAttribute('aria-expanded', String(visible));
    if (!visible) return;
    const hostRect = host.getBoundingClientRect();
    const buttonRect = cropButton.getBoundingClientRect();
    cropPopover.style.left = `${buttonRect.left - hostRect.left + buttonRect.width / 2}px`;
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
    const mode = regionTool.mode;
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
    const regionLayer = segmentation.region.layer;
    const splitLayer = !segmentation.region.isEmpty ? regionLayer : groupSelection?.layer;
    op('split').disabled = !splitLayer || splitLayer.locked;
    op('duplicate').disabled = !editable;
    op('array').disabled = !editable;
    op('crop').disabled = document.layers.length === 0;
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
          ? !editable && !allEditable && segmentation.segmentedLayers.length === 0
          : !allEditable || (selected.length > 1 && mode !== 'translate');
      modeButton.setAttribute(
        'aria-pressed',
        String(viewer.tool === 'select' && mode === viewer.transformMode),
      );
    }
    const toolNames: Record<string, ToolMode> = {
      pen: 'sketch',
      eraser: 'erase',
      recolor: 'recolor',
      fade: 'fade',
      grab: 'grab',
      inflate: 'inflate',
      measure: 'measure',
      polyline: 'polyline',
      aiselect: 'aiselect',
    };
    for (const toolButton of toolButtons)
      toolButton.setAttribute(
        'aria-pressed',
        String(toolNames[toolButton.dataset.tool ?? ''] === viewer.tool),
      );
    if (scaleButton.disabled || viewer.transformMode !== 'scale') setScalePopover(false);
    if (arrayButton.disabled) setArrayPopover(false);
    planeButton.setAttribute('aria-pressed', String(viewer.workPlane.enabled));
    planeShow.setAttribute('aria-pressed', String(viewer.workPlane.enabled));
    planeShow.setAttribute(
      'aria-label',
      viewer.workPlane.enabled ? 'Hide work plane' : 'Show work plane',
    );
    planeMove.setAttribute(
      'aria-pressed',
      String(viewer.workPlane.editing && viewer.workPlane.mode === 'translate'),
    );
    planeRotate.setAttribute(
      'aria-pressed',
      String(viewer.workPlane.editing && viewer.workPlane.mode === 'rotate'),
    );
    cropButton.setAttribute('aria-pressed', String(crop.isActive));
    cropToggle.setAttribute('aria-pressed', String(crop.isActive));
    cropToggle.setAttribute('aria-label', crop.isActive ? 'Hide crop box' : 'Show crop box');
    cropToggle.title = crop.isActive ? 'Hide crop box' : 'Show crop box';
    for (const [value, mode] of [
      [cropMove, 'translate'],
      [cropResize, 'scale'],
    ] as [HTMLButtonElement, CropMode][]) {
      value.disabled = !crop.isActive;
      value.setAttribute('aria-pressed', String(crop.isActive && crop.mode === mode));
    }
    cropKeep.disabled = cropCut.disabled = !crop.isActive;
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
    setCropPopover(false);
    if (!arrayPopover.hidden) arrayInputs[0]?.focus();
  });
  const workPlane = viewer.workPlane;
  const onPlaneButton = (): void => {
    setPlanePopover(planePopover.hidden);
    setScalePopover(false);
    setArrayPopover(false);
    setSelectionPopover(false);
    setCropPopover(false);
  };
  const onPlaneShow = (): void => {
    const next = !workPlane.enabled;
    workPlane.setEnabled(next);
    // Showing it is almost always followed by placing it, so bring the gizmo up too.
    workPlane.setEditing(next);
  };
  const onPlaneMove = (): void => {
    workPlane.setEditing(true);
    workPlane.setMode('translate');
  };
  const onPlaneRotate = (): void => {
    workPlane.setEditing(true);
    workPlane.setMode('rotate');
  };
  const usePlane = (run: () => void) => (): void => {
    if (!workPlane.enabled) {
      workPlane.setEnabled(true);
      workPlane.setEditing(true);
    }
    run();
  };
  const onPlaneGround = usePlane(() => workPlane.setPreset('ground'));
  const onPlaneFront = usePlane(() => workPlane.setPreset('front'));
  const onPlaneSide = usePlane(() => workPlane.setPreset('side'));
  const onPlaneView = usePlane(() => workPlane.alignToView(viewer.camera));
  const onPlaneReset = usePlane(() => workPlane.reset());

  const onCropButton = (): void => {
    setCropPopover(cropPopover.hidden);
    setScalePopover(false);
    setArrayPopover(false);
    setSelectionPopover(false);
  };
  const onCropToggle = (): void => (crop.isActive ? crop.cancel() : crop.begin());
  const onCropMove = (): void => crop.setMode('translate');
  const onCropResize = (): void => crop.setMode('scale');
  const runCrop = (keep: 'inside' | 'outside') => (): void => {
    const hidden = crop.apply(keep);
    if (hidden) callbacks.notify(`${hidden.toLocaleString()} splats hidden (⌘Z to undo).`);
    else callbacks.notify('Nothing to crop.', 'warning');
  };
  const onCropKeep = runCrop('inside');
  const onCropCut = runCrop('outside');
  planeButton.addEventListener('click', onPlaneButton);
  planeShow.addEventListener('click', onPlaneShow);
  planeMove.addEventListener('click', onPlaneMove);
  planeRotate.addEventListener('click', onPlaneRotate);
  planeItem('planeGround').addEventListener('click', onPlaneGround);
  planeItem('planeFront').addEventListener('click', onPlaneFront);
  planeItem('planeSide').addEventListener('click', onPlaneSide);
  planeItem('planeView').addEventListener('click', onPlaneView);
  planeItem('planeReset').addEventListener('click', onPlaneReset);
  workPlane.addEventListener('changed', render);
  cropButton.addEventListener('click', onCropButton);
  cropToggle.addEventListener('click', onCropToggle);
  cropMove.addEventListener('click', onCropMove);
  cropResize.addEventListener('click', onCropResize);
  cropKeep.addEventListener('click', onCropKeep);
  cropCut.addEventListener('click', onCropCut);
  for (const modeButton of modeButtons)
    modeButton.addEventListener('click', () => {
      const mode = modeButton.dataset.mode === 'select' ? 'translate' : modeButton.dataset.mode;
      viewer.setTool('select');
      viewer.setTransformMode(mode as TransformMode);
      setScalePopover(modeButton === scaleButton ? scalePopover.hidden : false);
      setSelectionPopover(modeButton === selectButton ? selectionPopover.hidden : false);
      setArrayPopover(false);
      setCropPopover(false);
      if (modeButton !== selectButton) {
        regionTool.setMode('pointer');
        renderSelectionMode();
      }
    });

  for (const value of selectionButtons)
    value.addEventListener('click', () => {
      viewer.setTool('select');
      regionTool.setMode(value.dataset.selectionTool as RegionToolMode);
      viewer.setTransformMode('translate');
      renderSelectionMode();
      setSelectionPopover(false);
      setCropPopover(false);
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
      const bounds = layer.localBounds();
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
    if (!cropPopover.hidden && !cropPopover.contains(target) && !cropButton.contains(target))
      setCropPopover(false);
    if (!planePopover.hidden && !planePopover.contains(target) && !planeButton.contains(target))
      setPlanePopover(false);
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

  const toolNames: Record<string, ToolMode> = {
    pen: 'sketch',
    eraser: 'erase',
    recolor: 'recolor',
    fade: 'fade',
    grab: 'grab',
    inflate: 'inflate',
    measure: 'measure',
    polyline: 'polyline',
    aiselect: 'aiselect',
  };
  for (const toolButton of toolButtons)
    toolButton.addEventListener('click', () => {
      const tool = toolNames[toolButton.dataset.tool ?? ''];
      if (tool) viewer.setTool(tool);
      setScalePopover(false);
      setArrayPopover(false);
      setSelectionPopover(false);
      setCropPopover(false);
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
  crop.addEventListener('crop-changed', render);
  // The selection tools are one-shot and drop back to the pointer themselves.
  regionTool.addEventListener('mode-changed', renderSelectionMode);
  observe();

  return {
    regionTool,
    dispose: (): void => {
      viewer.removeEventListener('document-changed', observe);
      viewer.removeEventListener('transform-mode-changed', render);
      viewer.removeEventListener('tool-changed', render);
      segmentation.removeEventListener('selection-changed', render);
      segmentation.removeEventListener('groups-changed', render);
      crop.removeEventListener('crop-changed', render);
      regionTool.removeEventListener('mode-changed', renderSelectionMode);
      observed?.removeEventListener('layers-changed', render);
      observed?.removeEventListener('layer-changed', render);
      observed?.removeEventListener('selection-changed', render);
      observed?.removeEventListener('history-changed', render);
      scaleApply.removeEventListener('click', applyScaleFactor);
      scaleInput.removeEventListener('keydown', onScaleKeyDown);
      arrayApply.removeEventListener('click', applyArray);
      for (const input of arrayInputs) input.removeEventListener('keydown', onArrayKeyDown);
      viewer.workPlane.removeEventListener('changed', render);
      document.removeEventListener('pointerdown', onOutsideScale);
      cropButton.removeEventListener('click', onCropButton);
      cropToggle.removeEventListener('click', onCropToggle);
      cropMove.removeEventListener('click', onCropMove);
      cropResize.removeEventListener('click', onCropResize);
      cropKeep.removeEventListener('click', onCropKeep);
      cropCut.removeEventListener('click', onCropCut);
      regionTool.dispose();
    },
  };
}
