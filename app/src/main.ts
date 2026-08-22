import './style.css';
import { wireFileInput } from './io/dragDrop';
import { exportPly, saveBlob } from './io/exportPly';
import { loadGroups, tryLoadSidecar } from './io/loadGroups';
import { loadSplat, LOD_ABOVE_SPLATS } from './io/loadSplat';
import type { LoadOptions, SplatSource } from './io/loadSplat';
import { getInitialSource } from './io/urlParams';
import { GroupOverlay } from './select/GroupOverlay';
import { LayerGizmo } from './select/LayerGizmo';
import { Segments } from './select/Segments';
import { GroupMapError } from './splats/groups';
import { Hud } from './ui/hud';
import { createPanel } from './ui/panel';
import { createHoverLabel } from './ui/hoverLabel';
import { createInspector } from './ui/inspector';
import { createLibraryPanel } from './ui/libraryPanel';
import { wireCollapse } from './ui/collapse';
import { createToolbar } from './ui/toolbar';
import { wireShortcuts } from './ui/shortcuts';
import { SplatDocument } from './viewer/SplatDocument';
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
  const canvas = element<HTMLCanvasElement>('viewer');
  const hud = new Hud(element('hud'), element('toast-region'));
  let viewer: Viewer;
  try {
    viewer = new Viewer(canvas, (now) => hud.tick(now));
  } catch (error) {
    if (error instanceof WebGLUnavailableError) {
      element('webgl-error').hidden = false;
      return;
    }
    throw error;
  }

  const emptyState = element('empty-state');
  const fileInput = element<HTMLInputElement>('file-input');
  const openButton = element<HTMLButtonElement>('open-file');
  const sampleSelect = element<HTMLSelectElement>('sample-select');
  const flyHint = element('fly-hint');
  hud.setGpu(viewer.gpuName);
  const segments = new Segments(viewer);
  const overlay = new GroupOverlay(viewer, segments);
  const gizmo = new LayerGizmo(viewer);
  // One notion of "the object being edited", shared by the gizmo, the outliner, and the
  // toolbar, so that none of them can disagree about what is selected.
  segments.addEventListener('active-changed', () => gizmo.attach(segments.activeLayer));

  /**
   * Writes the scene as it now stands: the scan without whatever has been split away or
   * deleted, plus every object with its transform folded in.
   */
  const exportScene = (): void => {
    const current = viewer.document;
    if (!current) return;
    const taken = new Set<number>();
    for (const layer of segments.allLayers()) {
      for (const index of layer.indices ?? []) taken.add(index);
    }
    const sources = [
      { mesh: current.mesh, skip: (index: number): boolean => taken.has(index) },
      ...segments
        .allLayers()
        .filter((layer) => layer.mesh && !layer.hidden)
        .map((layer) => ({ mesh: layer.mesh! })),
    ];
    const name = current.name.replace(/\.[^.]+$/, '');
    saveBlob(exportPly(sources), `${name}-edited.ply`);
    hud.toast(`Exported ${name}-edited.ply`);
  };

  const goHome = (): void => {
    viewer.clearDocument();
    hud.setDocument();
    hud.setReady();
    emptyState.hidden = false;
    element('library').hidden = true;
    element('inspector').hidden = true;
    element('toolbar').hidden = true;
    sampleSelect.value = '';
  };

  const libraryPanel = createLibraryPanel(element('library-body'), viewer, segments, overlay, {
    onOpenFile: () => fileInput.click(),
    onExport: exportScene,
  });
  const collapses = [
    wireCollapse(element('hud'), element('hud-collapse'), element('hud-body')),
    wireCollapse(element('library'), element('library-collapse'), element('library-body')),
    wireCollapse(
      element('inspector'),
      element('inspector-collapse'),
      element('inspector').querySelector<HTMLElement>('.panel-body')!,
    ),
  ];
  const toolbar = createToolbar(element('toolbar'), segments, gizmo);
  const inspector = createInspector(
    element('inspector'),
    element('pane-object'),
    { object: element('tab-object'), viewport: element('tab-viewport') },
    { object: element('pane-object'), viewport: element('pane-viewport') },
    segments,
    gizmo,
  );
  element('go-home').addEventListener('click', goHome);
  const hoverLabel = createHoverLabel(element('hover-label'), segments);
  let loadSequence = 0;

  const attachGroupsFile = async (file: File): Promise<void> => {
    const document = viewer.document;
    if (!document) {
      hud.toast('Open a splat first, then drop its .groups sidecar.');
      return;
    }
    try {
      segments.applyGroups(await loadGroups({ kind: 'file', file }, document.numSplats));
      hud.toast(`Loaded ${document.groups?.numGroups ?? 0} groups from ${file.name}.`);
    } catch (error) {
      hud.toast(error instanceof GroupMapError ? error.message : `Couldn't read ${file.name}.`);
    }
  };

  const openSource = async (
    source: SplatSource,
    options: LoadOptions = {},
    groupsUrl?: string,
  ): Promise<void> => {
    const sequence = ++loadSequence;
    viewer.clearDocument();
    hud.setDocument();
    emptyState.classList.add('loading');
    hud.setProgress({ phase: 'loading' });
    try {
      const loaded = await loadSplat(
        source,
        (progress) => {
          if (sequence === loadSequence) hud.setProgress(progress);
        },
        options,
      );
      if (sequence !== loadSequence) {
        loaded.mesh.dispose();
        return;
      }
      const document = new SplatDocument(loaded.mesh, loaded.name, loaded.byteLength, loaded.kind, {
        ...(loaded.bytes ? { bytes: loaded.bytes } : {}),
        ...(loaded.pointCloud ? { pointCloud: loaded.pointCloud } : {}),
      });
      viewer.setDocument(document);
      hud.setDocument(document);
      hud.setReady();
      emptyState.hidden = true;
      element('library').hidden = false;
      element('inspector').hidden = false;
      element('toolbar').hidden = false;
      const info = loaded.pointCloud;
      if (info && info.stride > 1) {
        hud.toast(
          `RGB point cloud: showing ${info.keptPoints.toLocaleString()} of ${info.sourcePoints.toLocaleString()} points (every ${info.stride}th). Raise the budget in VIEW › Point cloud.`,
        );
      } else if (info) {
        hud.toast('RGB point cloud (not a Gaussian splat): point size estimated from spacing.');
      } else if (loaded.mesh.numSplats >= LOD_ABOVE_SPLATS) {
        hud.toast('Large scene: rendering with a level-of-detail tree built at load time.');
      }

      // An explicitly named sidecar must load; one merely implied by the splat URL is
      // optional, so its absence is silent and only a malformed file is reported.
      const groups = groupsUrl
        ? await loadGroups({ kind: 'url', url: groupsUrl }, document.numSplats).catch(
            (error: unknown) => {
              hud.toast(
                error instanceof GroupMapError ? error.message : `Couldn't read ${groupsUrl}.`,
              );
              return undefined;
            },
          )
        : source.kind === 'url'
          ? await tryLoadSidecar(source.url, document.numSplats, (message) => hud.toast(message))
          : undefined;
      if (groups && sequence === loadSequence) segments.applyGroups(groups);
    } catch (error) {
      if (sequence !== loadSequence) return;
      const message = error instanceof Error ? error.message : 'The splat could not be opened.';
      console.error(error);
      hud.setError();
      hud.toast(message);
      emptyState.hidden = false;
    } finally {
      if (sequence === loadSequence) emptyState.classList.remove('loading');
    }
  };

  const panel = createPanel(viewer, element('panel'), {
    onPointBudgetChange: (pointBudget) => {
      const current = viewer.document;
      if (!current?.bytes) return;
      void openSource(
        { kind: 'bytes', bytes: current.bytes, fileName: current.name },
        {
          pointBudget,
          ...(current.pointSizeMul !== undefined ? { pointSizeMul: current.pointSizeMul } : {}),
        },
      );
    },
  });

  const disposeDrop = wireFileInput(
    fileInput,
    openButton,
    element('drag-overlay'),
    (file) => void openSource({ kind: 'file', file }),
    (message) => hud.toast(message),
    (file) => void attachGroupsFile(file),
  );
  const disposeShortcuts = wireShortcuts(viewer, () => fileInput.click());
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
    hud.toast('The sample gallery is unavailable. You can still open a local file.');
  }

  sampleSelect.addEventListener('change', () => {
    const sample = samples.find((candidate) => candidate.name === sampleSelect.value);
    if (sample) void openSource({ kind: 'url', url: sample.url, name: sample.name });
  });

  const initial = getInitialSource();
  if (initial.url) {
    void openSource({ kind: 'url', url: initial.url }, {}, initial.groups);
  } else if (initial.sample) {
    const initialSample = initial.sample.toLowerCase();
    const sample = samples.find((candidate) => candidate.name.toLowerCase() === initialSample);
    if (sample) {
      sampleSelect.value = sample.name;
      void openSource({ kind: 'url', url: sample.url, name: sample.name }, {}, initial.groups);
    } else {
      hud.toast(`Unknown sample “${initial.sample}”.`);
    }
  }

  window.addEventListener(
    'beforeunload',
    () => {
      disposeDrop();
      disposeShortcuts();
      panel.dispose();
      libraryPanel.dispose();
      for (const collapse of collapses) collapse.dispose();
      inspector.dispose();
      toolbar.dispose();
      hoverLabel.dispose();
      gizmo.dispose();
      viewer.dispose();
    },
    { once: true },
  );
}

void bootstrap();
