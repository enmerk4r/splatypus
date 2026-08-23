import { Vector3 } from 'three';
import type { ModelSettingsStore, ShapeMode } from '../mesh/settings';
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

/** The region-selection methods, in the order they appear in the Select flyout. */
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

/** The brushes behind the Brush flyout: every tool that paints on the active layer. */
const BRUSHES: { tool: ToolMode; iconName: string; label: string; key: string; hint: string }[] = [
  { tool: 'sketch', iconName: 'pen', label: 'Sketch', key: 'S', hint: 'draw gaussian strokes' },
  {
    tool: 'erase',
    iconName: 'eraser',
    label: 'Erase',
    key: 'X',
    hint: 'erase splats under the brush',
  },
  {
    tool: 'recolor',
    iconName: 'recolor',
    label: 'Recolor',
    key: 'C',
    hint: 'tint towards the brush colour',
  },
  { tool: 'fade', iconName: 'fade', label: 'Fade', key: 'D', hint: 'fade splats (Shift restores)' },
  { tool: 'grab', iconName: 'grab', label: 'Grab', key: 'V', hint: 'drag splats along the screen' },
  {
    tool: 'inflate',
    iconName: 'inflate',
    label: 'Inflate',
    key: 'I',
    hint: 'grow splats (Shift shrinks)',
  },
];

/** The outline shapes behind the Model flyout. */
const SHAPES: { shape: ShapeMode; label: string; hint: string }[] = [
  {
    shape: 'polyline',
    label: 'Polyline',
    hint: 'click points; Enter / double-click / first point closes',
  },
  { shape: 'rectangle', label: 'Rectangle', hint: 'two corners' },
  { shape: 'polygon', label: 'Polygon', hint: 'centre + radius, N sides' },
  { shape: 'circle', label: 'Circle', hint: 'centre + radius' },
];

const BRUSH_KEY = 'splatypus.toolbar.brush';

function isBrush(tool: ToolMode): boolean {
  return BRUSHES.some((brush) => brush.tool === tool);
}

/**
 * The bottom bar, split in two: **Tools** on the left (exclusive modes — Select with its
 * Move/Rotate/Scale gumball modes and selection-method flyout, Brush with its flyout of
 * paint tools, Measure, Model with its shape flyout, Crop) and **Actions** on the right
 * (one-shot verbs on the selection — Undo/Redo, Duplicate, Array, Split, Isolate, Floor,
 * Delete). A one-line status strip above names the active tool and its keys. It stays in
 * one fixed place rather than following the selection, so the tools are always where the
 * hand expects them.
 */
export function createToolbar(
  viewer: Viewer,
  segmentation: Segmentation,
  crop: CropBox,
  regionSettings: RegionSettingsStore,
  modelSettings: ModelSettingsStore,
  host: HTMLElement,
  callbacks: ToolbarCallbacks,
): { regionTool: RegionTool; dispose: () => void } {
  const button = (attr: string, name: string, label: string, hint: string, extra = ''): string =>
    `<button type="button" ${attr}="${name}" title="${label} — ${hint}" aria-label="${label}"${extra}>` +
    `${icon(name)}<span class="sr-only">${label}</span></button>`;
  const menuButton = (attr: string, name: string, label: string, hint: string): string =>
    button(attr, name, label, `${hint} (click again for options)`, ' class="has-menu"');

  host.innerHTML = `
    <div class="toolbar-status" id="toolbar-status" aria-live="polite"></div>
    <div class="toolbar-bars">
      <div class="toolbar-bar" role="toolbar" aria-label="Tools">
        <div class="toolbar-group" role="group" aria-label="Select">
          ${menuButton('data-mode', 'select', 'Select (Q)', 'pick layers; drag the gumball to move')}
          <div class="toolbar-segment" role="group" aria-label="Gumball mode">
            ${button('data-mode', 'translate', 'Move (W)', 'drag the gumball to move the selection')}
            ${button('data-mode', 'rotate', 'Rotate (E)', 'spin it in place')}
            ${button('data-mode', 'scale', 'Scale (R)', 'resize it (click again to type a factor)')}
          </div>
        </div>
        <div class="toolbar-rule"></div>
        <div class="toolbar-group" role="group" aria-label="Brushes">
          ${menuButton('data-brush', 'pen', 'Brush', 'paint on the active layer')}
        </div>
        <div class="toolbar-rule"></div>
        <div class="toolbar-group" role="group" aria-label="Measure and model">
          ${button('data-tool', 'measure', 'Measure / scale to reference (M)', 'pick two points on the active layer, type the real distance, the layer is scaled to match')}
          ${menuButton('data-model', 'polyline', 'Model (P)', 'draw a face on a plane, then extrude it')}
          ${button('data-op', 'crop', 'Crop', 'show crop controls')}
        </div>
      </div>
      <div class="toolbar-bar" role="toolbar" aria-label="Actions">
        <div class="toolbar-group" role="group" aria-label="History">
          ${button('data-op', 'undo', 'Undo (⌘Z)', 'undo the last edit')}
          ${button('data-op', 'redo', 'Redo (⇧⌘Z)', 'redo the last undone edit')}
        </div>
        <div class="toolbar-rule"></div>
        <div class="toolbar-group" role="group" aria-label="Layer actions">
          ${button('data-op', 'duplicate', 'Duplicate', 'copy the active layer')}
          ${button('data-op', 'array', 'Array', 'copy the active layer into a columns by rows grid', ' class="has-menu"')}
          ${button('data-op', 'split', 'Split to layer', 'lift the current selection out of its layer')}
          ${button('data-op', 'isolate', 'Isolate', 'show only the active layer')}
          ${button('data-op', 'floor', 'Snap to floor', 'drop it onto the ground plane')}
        </div>
        <div class="toolbar-rule"></div>
        <div class="toolbar-group" role="group" aria-label="Delete">
          ${button('data-op', 'delete', 'Delete', 'remove the selected layers (undoable)')}
        </div>
      </div>
      <form class="toolbar-popover scale-popover" aria-label="Scale factor" hidden>
        <label><span>×</span><input type="number" min="0.001" step="0.1" value="1" aria-label="Scale factor" /></label>
        <button type="button">Apply</button>
      </form>
      <form class="toolbar-popover array-popover" aria-label="Array size" hidden>
        <input type="number" min="1" max="20" step="1" value="5" aria-label="Columns" />
        <span>×</span>
        <input type="number" min="1" max="20" step="1" value="1" aria-label="Rows" />
        <button type="button">Apply</button>
      </form>
      <div class="toolbar-popover toolbar-flyout selection-popover" role="menu" aria-label="Selection method" hidden>
        ${SELECTION_MODES.map(
          ({ mode, label, hint }) =>
            `<button type="button" data-selection-tool="${mode}" role="menuitem" aria-label="${label}" title="${label} — ${hint}">${icon(mode === 'pointer' ? 'select' : mode)}</button>`,
        ).join('')}
      </div>
      <div class="toolbar-popover toolbar-flyout brush-popover" role="menu" aria-label="Brush" hidden>
        ${BRUSHES.map(
          ({ tool, iconName, label, key, hint }) =>
            `<button type="button" data-brush-tool="${tool}" role="menuitem" aria-label="${label} (${key})" title="${label} (${key}) — ${hint}">${icon(iconName)}</button>`,
        ).join('')}
      </div>
      <div class="toolbar-popover toolbar-flyout model-popover" role="menu" aria-label="Outline shape" hidden>
        ${SHAPES.map(
          ({ shape, label, hint }) =>
            `<button type="button" data-shape-tool="${shape}" role="menuitem" aria-label="${label}" title="${label} — ${hint}">${icon(shape)}</button>`,
        ).join('')}
      </div>
      <div class="toolbar-popover toolbar-flyout crop-popover" role="menu" aria-label="Crop controls" hidden>
        ${button('data-crop', 'crop', 'Show crop box', 'toggle the crop box')}
        ${button('data-crop', 'translate', 'Move crop box', 'move the crop box')}
        ${button('data-crop', 'scale', 'Resize crop box', 'resize the crop box')}
        ${button('data-crop', 'cropKeep', 'Keep inside', 'hide splats outside the crop box')}
        ${button('data-crop', 'cropCut', 'Cut inside', 'hide splats inside the crop box')}
      </div>
    </div>
  `;

  const bars = host.querySelector<HTMLElement>('.toolbar-bars')!;
  const status = host.querySelector<HTMLElement>('#toolbar-status')!;
  const op = (name: string): HTMLButtonElement =>
    host.querySelector<HTMLButtonElement>(`[data-op="${name}"]`)!;
  const modeButtons = [...host.querySelectorAll<HTMLButtonElement>('[data-mode]')];
  const selectButton = host.querySelector<HTMLButtonElement>('[data-mode="select"]')!;
  const scaleButton = host.querySelector<HTMLButtonElement>('[data-mode="scale"]')!;
  const brushButton = host.querySelector<HTMLButtonElement>('[data-brush]')!;
  const measureButton = host.querySelector<HTMLButtonElement>('[data-tool="measure"]')!;
  const modelButton = host.querySelector<HTMLButtonElement>('[data-model]')!;
  const arrayButton = op('array');
  const cropButton = op('crop');

  const scalePopover = host.querySelector<HTMLFormElement>('.scale-popover')!;
  const scaleInput = scalePopover.querySelector<HTMLInputElement>('input')!;
  const scaleApply = scalePopover.querySelector<HTMLButtonElement>('button')!;
  const arrayPopover = host.querySelector<HTMLFormElement>('.array-popover')!;
  const arrayInputs = [...arrayPopover.querySelectorAll<HTMLInputElement>('input')];
  const arrayApply = arrayPopover.querySelector<HTMLButtonElement>('button')!;
  const cropPopover = host.querySelector<HTMLElement>('.crop-popover')!;
  const cropToggle = cropPopover.querySelector<HTMLButtonElement>('[data-crop="crop"]')!;
  const cropMove = cropPopover.querySelector<HTMLButtonElement>('[data-crop="translate"]')!;
  const cropResize = cropPopover.querySelector<HTMLButtonElement>('[data-crop="scale"]')!;
  const cropKeep = cropPopover.querySelector<HTMLButtonElement>('[data-crop="cropKeep"]')!;
  const cropCut = cropPopover.querySelector<HTMLButtonElement>('[data-crop="cropCut"]')!;
  const selectionPopover = host.querySelector<HTMLElement>('.selection-popover')!;
  const selectionButtons = [
    ...selectionPopover.querySelectorAll<HTMLButtonElement>('[data-selection-tool]'),
  ];
  const brushPopover = host.querySelector<HTMLElement>('.brush-popover')!;
  const brushButtons = [...brushPopover.querySelectorAll<HTMLButtonElement>('[data-brush-tool]')];
  const modelPopover = host.querySelector<HTMLElement>('.model-popover')!;
  const shapeButtons = [...modelPopover.querySelectorAll<HTMLButtonElement>('[data-shape-tool]')];

  const regionTool = new RegionTool(viewer, segmentation.region, regionSettings, {
    targetLayer: () => segmentation.targetLayer(),
    notify: callbacks.notify,
  });

  /** The brush the Brush button activates: the last one used (remembered across sessions). */
  let lastBrush: ToolMode = 'sketch';
  try {
    const stored = localStorage.getItem(BRUSH_KEY) as ToolMode | null;
    if (stored && isBrush(stored)) lastBrush = stored;
  } catch {
    // private mode
  }
  const rememberBrush = (tool: ToolMode): void => {
    if (!isBrush(tool)) return;
    lastBrush = tool;
    try {
      localStorage.setItem(BRUSH_KEY, tool);
    } catch {
      // private mode
    }
  };

  // ---- popovers: all anchored above their button; only one open at a time.
  const popovers: { element: HTMLElement; anchor: HTMLButtonElement }[] = [
    { element: scalePopover, anchor: scaleButton },
    { element: arrayPopover, anchor: arrayButton },
    { element: cropPopover, anchor: cropButton },
    { element: selectionPopover, anchor: selectButton },
    { element: brushPopover, anchor: brushButton },
    { element: modelPopover, anchor: modelButton },
  ];
  const setPopover = (element: HTMLElement, visible: boolean): void => {
    const entry = popovers.find((candidate) => candidate.element === element)!;
    if (visible)
      for (const other of popovers) if (other.element !== element) setPopover(other.element, false);
    element.hidden = !visible;
    entry.anchor.setAttribute('aria-expanded', String(visible));
    // The status line sits where flyouts open; hide it while one is up.
    host.classList.toggle(
      'has-popover',
      popovers.some((candidate) => !candidate.element.hidden),
    );
    if (!visible) return;
    const barsRect = bars.getBoundingClientRect();
    const buttonRect = entry.anchor.getBoundingClientRect();
    element.style.left = `${buttonRect.left - barsRect.left + buttonRect.width / 2}px`;
  };
  const togglePopover = (element: HTMLElement): void => setPopover(element, element.hidden);
  const closePopovers = (): void => popovers.forEach(({ element }) => setPopover(element, false));

  const setIcon = (target: HTMLButtonElement, name: string, label: string): void => {
    target.innerHTML = `${icon(name)}<span class="sr-only">${label}</span>`;
  };

  const renderSelectionMode = (): void => {
    const mode = regionTool.mode;
    setIcon(selectButton, mode === 'pointer' ? 'select' : mode, 'Select (Q)');
    for (const value of selectionButtons)
      value.setAttribute('aria-pressed', String(value.dataset.selectionTool === mode));
    renderStatus();
  };

  const renderBrush = (): void => {
    const current = isBrush(viewer.tool) ? viewer.tool : lastBrush;
    const brush = BRUSHES.find((candidate) => candidate.tool === current) ?? BRUSHES[0]!;
    setIcon(brushButton, brush.iconName, `Brush: ${brush.label}`);
    brushButton.title = `${brush.label} (${brush.key}) — ${brush.hint} (click again for other brushes)`;
    brushButton.setAttribute('aria-label', `Brush: ${brush.label} (${brush.key})`);
    for (const value of brushButtons)
      value.setAttribute('aria-pressed', String(value.dataset.brushTool === viewer.tool));
  };

  const renderModel = (): void => {
    const shape = SHAPES.find((candidate) => candidate.shape === modelSettings.shape) ?? SHAPES[0]!;
    setIcon(modelButton, shape.shape, `Model: ${shape.label} (P)`);
    modelButton.title = `Model: ${shape.label} (P) — ${shape.hint}; then extrude (click again for other shapes)`;
    for (const value of shapeButtons)
      value.setAttribute('aria-pressed', String(value.dataset.shapeTool === modelSettings.shape));
  };

  /** One line above the bars: the active tool and the keys that matter right now. */
  const renderStatus = (): void => {
    let text: string;
    if (viewer.cameraRig.mode === 'fly') {
      text = 'FLY · WASD + QE · DRAG TO LOOK · TAB / ESC BACK TO ORBIT';
    } else {
      switch (viewer.tool) {
        case 'select': {
          const mode = regionTool.mode;
          if (mode !== 'pointer') {
            const entry = SELECTION_MODES.find((candidate) => candidate.mode === mode);
            text = `${entry?.label.toUpperCase() ?? 'SELECT'} · ${entry?.hint.toUpperCase() ?? ''} · ESC CANCELS`;
          } else {
            const gumball =
              viewer.transformMode === 'translate'
                ? 'MOVE'
                : viewer.transformMode === 'rotate'
                  ? 'ROTATE'
                  : 'SCALE';
            text = `SELECT · ${gumball} · W MOVE · E ROTATE · R SCALE · F FRAME · ⇧ ADDS TO SELECTION`;
          }
          break;
        }
        case 'sketch':
          text = 'SKETCH · DRAG TO PAINT · [ ] SIZE · ⇧[ ] OPACITY · ALT-DRAG ORBITS';
          break;
        case 'erase':
          text = 'ERASE · DRAG OVER SPLATS OF THE ACTIVE LAYER · [ ] SIZE';
          break;
        case 'recolor':
          text = 'RECOLOR · DRAG TO TINT TOWARDS THE BRUSH COLOUR · [ ] SIZE';
          break;
        case 'fade':
          text = 'FADE · DRAG TO FADE · ⇧ RESTORES · [ ] SIZE';
          break;
        case 'grab':
          text = 'GRAB · DRAG SPLATS ALONG THE SCREEN · [ ] SIZE';
          break;
        case 'inflate':
          text = 'INFLATE · DRAG TO GROW · ⇧ SHRINKS · [ ] SIZE';
          break;
        case 'measure':
          text = 'MEASURE · CLICK TWO POINTS · TYPE THE REAL DISTANCE TO SCALE THE LAYER';
          break;
        case 'polyline': {
          const shape = modelSettings.shape.toUpperCase();
          const ortho = modelSettings.orthoActive ? ' · ORTHO' : '';
          text =
            modelSettings.shape === 'polyline'
              ? `MODEL · ${shape}${ortho} · CLICK POINTS · TYPE A LENGTH · ENTER / DOUBLE-CLICK CLOSES · ⇧ FLIPS ORTHO`
              : `MODEL · ${shape}${ortho} · CLICK ANCHOR, THEN SIZE · TYPE A DIMENSION · ENTER ACCEPTS`;
          break;
        }
      }
    }
    if (status.textContent !== text) status.textContent = text;
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
    const inSelect = viewer.tool === 'select';
    for (const modeButton of modeButtons) {
      const mode = modeButton.dataset.mode;
      if (modeButton === selectButton) {
        modeButton.disabled =
          !editable && !allEditable && segmentation.segmentedLayers.length === 0;
        modeButton.setAttribute('aria-pressed', String(inSelect));
      } else {
        // Gumball modes: nested under Select; multi-selections can only move.
        modeButton.disabled = !allEditable || (selected.length > 1 && mode !== 'translate');
        modeButton.setAttribute('aria-pressed', String(inSelect && mode === viewer.transformMode));
      }
    }
    brushButton.setAttribute('aria-pressed', String(isBrush(viewer.tool)));
    measureButton.setAttribute('aria-pressed', String(viewer.tool === 'measure'));
    modelButton.setAttribute('aria-pressed', String(viewer.tool === 'polyline'));
    if (scaleButton.disabled || viewer.transformMode !== 'scale') setPopover(scalePopover, false);
    if (arrayButton.disabled) setPopover(arrayPopover, false);
    if (selectButton.disabled) setPopover(selectionPopover, false);
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
    renderBrush();
    renderModel();
    renderStatus();
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
    op(name).addEventListener('click', () => {
      closePopovers();
      handler();
    });
  arrayButton.addEventListener('click', () => {
    togglePopover(arrayPopover);
    if (!arrayPopover.hidden) arrayInputs[0]?.focus();
  });

  // ---- crop
  cropButton.addEventListener('click', () => togglePopover(cropPopover));
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
  cropToggle.addEventListener('click', onCropToggle);
  cropMove.addEventListener('click', onCropMove);
  cropResize.addEventListener('click', onCropResize);
  cropKeep.addEventListener('click', onCropKeep);
  cropCut.addEventListener('click', onCropCut);

  // ---- select + gumball modes
  for (const modeButton of modeButtons)
    modeButton.addEventListener('click', () => {
      const mode = (
        modeButton === selectButton ? 'translate' : modeButton.dataset.mode
      ) as TransformMode;
      const scaleWasOpen = !scalePopover.hidden;
      viewer.setTool('select');
      viewer.setTransformMode(mode);
      if (modeButton === selectButton) {
        togglePopover(selectionPopover);
      } else {
        closePopovers();
        // Scale: a second click opens the numeric factor field.
        if (modeButton === scaleButton) setPopover(scalePopover, !scaleWasOpen);
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
      closePopovers();
    });

  // ---- brush flyout
  brushButton.addEventListener('click', () => {
    if (!isBrush(viewer.tool)) viewer.setTool(lastBrush);
    togglePopover(brushPopover);
  });
  for (const value of brushButtons)
    value.addEventListener('click', () => {
      const tool = value.dataset.brushTool as ToolMode;
      rememberBrush(tool);
      viewer.setTool(tool);
      closePopovers();
    });

  // ---- measure
  measureButton.addEventListener('click', () => {
    viewer.setTool('measure');
    closePopovers();
  });

  // ---- model flyout
  modelButton.addEventListener('click', () => {
    viewer.setTool('polyline');
    togglePopover(modelPopover);
  });
  for (const value of shapeButtons)
    value.addEventListener('click', () => {
      modelSettings.setShape(value.dataset.shapeTool as ShapeMode);
      viewer.setTool('polyline');
      closePopovers();
    });

  // ---- scale / array forms
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
    setPopover(scalePopover, false);
  };
  const onScaleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyScaleFactor();
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      setPopover(scalePopover, false);
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
    setPopover(arrayPopover, false);
  };
  const onArrayKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyArray();
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      setPopover(arrayPopover, false);
      arrayButton.focus();
    }
  };
  /** Escape closes an open flyout before anything else sees the key. */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'Escape' || popovers.every(({ element }) => element.hidden)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closePopovers();
  };
  const onOutsidePointer = (event: PointerEvent): void => {
    const target = event.target as Node;
    for (const { element, anchor } of popovers)
      if (!element.hidden && !element.contains(target) && !anchor.contains(target))
        setPopover(element, false);
  };
  scaleApply.addEventListener('click', applyScaleFactor);
  scaleInput.addEventListener('keydown', onScaleKeyDown);
  arrayApply.addEventListener('click', applyArray);
  for (const input of arrayInputs) input.addEventListener('keydown', onArrayKeyDown);
  document.addEventListener('pointerdown', onOutsidePointer);
  window.addEventListener('keydown', onKeyDown, true);
  renderSelectionMode();

  const onToolChanged = (): void => {
    rememberBrush(viewer.tool);
    render();
  };

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
  viewer.addEventListener('tool-changed', onToolChanged);
  viewer.cameraRig.addEventListener('mode-changed', renderStatus);
  modelSettings.addEventListener('settings-changed', render);
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
      viewer.removeEventListener('tool-changed', onToolChanged);
      viewer.cameraRig.removeEventListener('mode-changed', renderStatus);
      modelSettings.removeEventListener('settings-changed', render);
      segmentation.removeEventListener('selection-changed', render);
      segmentation.removeEventListener('groups-changed', render);
      crop.removeEventListener('crop-changed', render);
      regionTool.removeEventListener('mode-changed', renderSelectionMode);
      observed?.removeEventListener('layers-changed', render);
      observed?.removeEventListener('layer-changed', render);
      observed?.removeEventListener('selection-changed', render);
      observed?.removeEventListener('history-changed', render);
      document.removeEventListener('pointerdown', onOutsidePointer);
      window.removeEventListener('keydown', onKeyDown, true);
      regionTool.dispose();
      host.replaceChildren();
    },
  };
}
