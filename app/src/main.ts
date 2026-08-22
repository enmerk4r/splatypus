import './style.css';
import { wireFileInput } from './io/dragDrop';
import { loadSplat, LOD_ABOVE_SPLATS } from './io/loadSplat';
import type { LoadOptions, SplatSource } from './io/loadSplat';
import { getInitialSource } from './io/urlParams';
import { Hud } from './ui/hud';
import { createPanel } from './ui/panel';
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
  let loadSequence = 0;

  const openSource = async (source: SplatSource, options: LoadOptions = {}): Promise<void> => {
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
    void openSource({ kind: 'url', url: initial.url });
  } else if (initial.sample) {
    const initialSample = initial.sample.toLowerCase();
    const sample = samples.find((candidate) => candidate.name.toLowerCase() === initialSample);
    if (sample) {
      sampleSelect.value = sample.name;
      void openSource({ kind: 'url', url: sample.url, name: sample.name });
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
      viewer.dispose();
    },
    { once: true },
  );
}

void bootstrap();
