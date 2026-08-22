import './style.css';
import { AppImports } from './AppImports';
import type { Document as SplatDocument } from './model/Document';
import { LockedLayerError, SetPointScale } from './model/commands';
import { wireFileInput } from './io/dragDrop';
import { loadGroups, tryLoadSidecar } from './io/loadGroups';
import type { SplatSource } from './io/loadSplat';
import { getInitialSource } from './io/urlParams';
import { CropBox } from './select/CropBox';
import { Segmentation } from './select/Segmentation';
import { GroupMapError } from './splats/groups';
import { SketchSettingsStore } from './sketch/settings';
import { SketchOverlay } from './sketch/SketchOverlay';
import { SketchTool } from './sketch/SketchTool';
import { createExportDialog } from './ui/exportDialog';
import { createHoverLabel } from './ui/hoverLabel';
import { Hud } from './ui/hud';
import { createLayersPanel } from './ui/layersPanel';
import { createPanel } from './ui/panel';
import { createSegmentPanel } from './ui/segmentPanel';
import { createSketchPanel } from './ui/sketchPanel';
import { createToolbar } from './ui/toolbar';
import { wireShortcuts } from './ui/shortcuts';
import { Viewer, WebGLUnavailableError } from './viewer/Viewer';

interface Sample {
  name: string;
  url: string;
  credit: string;
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.querySelector<T>(`#${id}`);
  if (!value) throw new Error(`Missing required element #${id}`);
  return value;
}

async function fetchSamples(): Promise<Sample[]> {
  const response = await fetch(`${import.meta.env.BASE_URL}samples/samples.json`);
  if (!response.ok) throw new Error(`Sample manifest returned ${response.status}`);
  return (await response.json()) as Sample[];
}

async function bootstrap(): Promise<void> {
  const hud = new Hud(element('hud'), element('toast-region'));
  let viewer: Viewer;
  try {
    viewer = new Viewer(element('viewer'), (now) => hud.tick(now));
  } catch (error) {
    if (error instanceof WebGLUnavailableError) {
      element('webgl-error').hidden = false;
      return;
    }
    throw error;
  }
  hud.setGpu(viewer.gpuName);
  const emptyState = element('empty-state');
  const openInput = element<HTMLInputElement>('file-input');
  const addInput = element<HTMLInputElement>('add-file-input');
  const sampleSelect = element<HTMLSelectElement>('sample-select');
  const flyHint = element('fly-hint');
  const imports = new AppImports(viewer, hud, emptyState);
  const segmentation = new Segmentation(viewer);
  const crop = new CropBox(viewer);
  const sketchSettings = new SketchSettingsStore();
  const sketchOverlay = new SketchOverlay(
    element<HTMLCanvasElement>('sketch-overlay'),
    viewer.canvasElement,
  );
  const sketchTool = new SketchTool(viewer, {
    settings: () => sketchSettings.snapshot(),
    colourCss: () => sketchSettings.colour,
    overlay: sketchOverlay,
    notify: (message, level) => hud.toast(message, level),
  });
  viewer.addInteractionGuard(() => crop.isInteracting);

  /** Attaches a dropped `.groups` sidecar to the layer segmentation currently targets. */
  const attachGroups = async (file: File): Promise<void> => {
    const target = segmentation.targetLayer();
    if (!target) {
      hud.toast(
        'Open a splat (and select a layer) first, then drop its .groups sidecar.',
        'warning',
      );
      return;
    }
    try {
      segmentation.applyGroups(
        target,
        await loadGroups({ kind: 'file', file }, target.store.count),
      );
      hud.toast(`Loaded ${target.groups?.numGroups ?? 0} groups onto “${target.name}”.`);
    } catch (error) {
      hud.toast(
        error instanceof GroupMapError ? error.message : `Couldn't read ${file.name}.`,
        'error',
      );
    }
  };

  /**
   * Opens a URL source and then its `.groups` sidecar: an explicit `?groups=` must load,
   * the one implied by the splat URL (`scan.ply` → `scan.groups`) is optional.
   */
  const openWithSidecar = async (source: SplatSource, groupsUrl?: string): Promise<void> => {
    const before = viewer.document;
    await imports.open(source);
    const document = viewer.document;
    const layer = document?.layers[0];
    if (!document || document === before || !layer || source.kind !== 'url') return;
    const groups = groupsUrl
      ? await loadGroups({ kind: 'url', url: groupsUrl }, layer.store.count).catch(
          (error: unknown) => {
            hud.toast(
              error instanceof GroupMapError ? error.message : `Couldn't read ${groupsUrl}.`,
              'error',
            );
            return undefined;
          },
        )
      : await tryLoadSidecar(source.url, layer.store.count, (message) =>
          hud.toast(message, 'error'),
        );
    if (groups && viewer.document === document) {
      segmentation.applyGroups(layer, groups);
      hud.toast(`Loaded ${groups.numGroups} groups from the .groups sidecar.`);
    }
  };

  const execute = (action: () => void): boolean => {
    try {
      action();
      return true;
    } catch (error) {
      const locked = error instanceof LockedLayerError;
      hud.toast(locked ? error.message : 'That action failed.', locked ? 'warning' : 'error');
      if (!locked) console.error(error);
      return false;
    }
  };
  const panel = createPanel(viewer, element('panel'), {
    onPointScaleChange: (layer, scale) => {
      const model = viewer.document;
      if (!model || !layer.pointCloud) return;
      execute(() =>
        model.history.push(new SetPointScale(model, layer.id, layer.pointCloud!.pointScale, scale)),
      );
    },
    onPointBudgetChange: (layer, budget) => void imports.changePointBudget(layer.id, budget),
  });
  const layersPanel = createLayersPanel(viewer, element('layers-panel'), {
    onAdd: () => addInput.click(),
    notify: (message, level) => hud.toast(message, level),
  });
  const segmentPanel = createSegmentPanel(viewer, segmentation, crop, element('segment-panel'), {
    notify: (message, level) => hud.toast(message, level),
  });
  const sketchPanel = createSketchPanel(viewer, sketchSettings, element('sketch-panel'));
  const hoverLabel = createHoverLabel(element('hover-label'), segmentation);
  const toolbar = createToolbar(viewer, segmentation, element('toolbar'), {
    notify: (message, level) => hud.toast(message, level),
  });
  const exportDialog = createExportDialog(
    element<HTMLDialogElement>('export-dialog'),
    element<HTMLButtonElement>('export-file'),
    () => viewer.document,
    (message, level) => hud.toast(message, level),
  );
  const disposeDrop = wireFileInput(
    openInput,
    addInput,
    element('open-file'),
    element('drag-overlay'),
    {
      onOpen: (file) => void imports.open({ kind: 'file', file }),
      onAdd: (files) => void imports.add(files),
      onGroups: (file) => void attachGroups(file),
      onError: (message, level) => hud.toast(message, level ?? 'error'),
    },
  );
  const disposeShortcuts = wireShortcuts(viewer, {
    openFile: () => openInput.click(),
    addFile: () => addInput.click(),
    exportFile: exportDialog.open,
    cancelStroke: () => sketchTool.cancelStroke(),
    adjustSketchSize: (factor) => sketchSettings.adjustRadius(factor),
    adjustSketchOpacity: (delta) => sketchSettings.adjustOpacity(delta),
    notify: (message, level) => hud.toast(message, level),
  });

  viewer.addEventListener('document-changed', (event) => {
    hud.setDocument((event as CustomEvent<SplatDocument | undefined>).detail);
  });
  const updateFlyHint = (): void => {
    flyHint.hidden = viewer.cameraRig.mode !== 'fly';
  };
  viewer.cameraRig.addEventListener('mode-changed', updateFlyHint);

  let samples: Sample[] = [];
  try {
    samples = await fetchSamples();
    for (const sample of samples) {
      const option = document.createElement('option');
      option.value = sample.name;
      option.textContent = `${sample.name} — ${sample.credit}`;
      option.title = `Credit: ${sample.credit}`;
      sampleSelect.append(option);
    }
  } catch (error) {
    console.error(error);
    hud.toast('The sample gallery is unavailable. You can still open a local file.', 'warning');
  }
  sampleSelect.addEventListener('change', () => {
    const sample = samples.find((candidate) => candidate.name === sampleSelect.value);
    if (sample) void openWithSidecar({ kind: 'url', url: sample.url, name: sample.name });
  });
  const initial = getInitialSource();
  if (initial.url) void openWithSidecar({ kind: 'url', url: initial.url }, initial.groups);
  else if (initial.sample) {
    const sample = samples.find(
      (candidate) => candidate.name.toLowerCase() === initial.sample!.toLowerCase(),
    );
    if (sample) {
      sampleSelect.value = sample.name;
      void openWithSidecar({ kind: 'url', url: sample.url, name: sample.name }, initial.groups);
    } else hud.toast(`Unknown sample “${initial.sample}”.`, 'warning');
  }

  // Dev-only console hook: `__splatypus.viewer.document`, `__splatypus.viewer.renderOnce()`.
  if (import.meta.env.DEV)
    (window as unknown as { __splatypus?: unknown }).__splatypus = {
      viewer,
      imports,
      segmentation,
      crop,
      sketchTool,
      sketchSettings,
    };

  window.addEventListener('beforeunload', (event) => {
    if (viewer.document?.history.canUndo()) event.preventDefault();
  });
  window.addEventListener(
    'pagehide',
    () => {
      disposeDrop();
      disposeShortcuts();
      panel.dispose();
      layersPanel.dispose();
      segmentPanel.dispose();
      sketchPanel.dispose();
      hoverLabel.dispose();
      toolbar.dispose();
      exportDialog.dispose();
      segmentation.dispose();
      crop.dispose();
      sketchTool.dispose();
      sketchOverlay.dispose();
      viewer.dispose();
    },
    { once: true },
  );
}

void bootstrap();
