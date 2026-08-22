import { Pane } from 'tweakpane';
import type { Layer } from '../model/Layer';
import { DEFAULT_POINT_BUDGET } from '../io/pointCloud';
import type { CameraMode } from '../viewer/CameraRig';
import type { UpAxis, Viewer } from '../viewer/Viewer';

interface PanelSettings {
  background: string;
  grid: boolean;
  upAxis: UpAxis;
  cameraMode: CameraMode;
  fov: number;
  flySpeed: number;
  renderScale: number;
  maxStdDev: number;
  pointSizeMul: number;
  pointBudgetM: number;
}

export interface PanelCallbacks {
  onPointScaleChange: (layer: Layer, scale: number) => void;
  onPointBudgetChange: (layer: Layer, budget: number) => void;
}

export function createPanel(
  viewer: Viewer,
  container: HTMLElement,
  callbacks: PanelCallbacks,
): { dispose: () => void; refresh: () => void } {
  const settings: PanelSettings = {
    background: '#111111',
    grid: true,
    upAxis: viewer.upAxis,
    cameraMode: viewer.cameraRig.mode,
    fov: 60,
    flySpeed: viewer.cameraRig.flySpeed,
    renderScale: viewer.currentRenderScale,
    maxStdDev: viewer.spark.maxStdDev,
    pointSizeMul: 1,
    pointBudgetM: DEFAULT_POINT_BUDGET / 1e6,
  };
  const pane = new Pane({ title: 'VIEW', expanded: false, container });
  pane
    .addBinding(settings, 'background', { label: 'Background', view: 'color' })
    .on('change', (event) => viewer.setBackground(event.value));
  pane
    .addBinding(settings, 'grid', { label: 'Grid' })
    .on('change', (event) => viewer.setGridVisible(event.value));
  pane
    .addBinding(settings, 'upAxis', {
      label: 'Up axis',
      options: { 'Y-down (3DGS)': 'y-down', 'Y-up': 'y-up', 'Z-up (scans)': 'z-up' },
    })
    .on('change', (event) => viewer.setUpAxis(event.value));
  pane
    .addBinding(settings, 'cameraMode', {
      label: 'Camera',
      options: { Orbit: 'orbit', Fly: 'fly' },
    })
    .on('change', (event) => viewer.setCameraMode(event.value));
  pane
    .addBinding(settings, 'fov', { label: 'FOV', min: 25, max: 100, step: 1 })
    .on('change', (event) => viewer.setFov(event.value));
  pane
    .addBinding(settings, 'flySpeed', { label: 'Fly speed', min: 0.05, max: 8, step: 0.05 })
    .on('change', (event) => viewer.cameraRig.setFlySpeed(event.value));

  const perf = pane.addFolder({ title: 'Performance', expanded: true });
  perf
    .addBinding(settings, 'renderScale', { label: 'Render scale', min: 0.25, max: 2, step: 0.05 })
    .on('change', (event) => viewer.setRenderScale(event.value));
  perf
    .addBinding(settings, 'maxStdDev', { label: 'Splat extent', min: 2, max: 3.2, step: 0.05 })
    .on('change', (event) => {
      viewer.spark.maxStdDev = event.value;
    });

  // The active layer, or the only layer when nothing is selected (e.g. right after opening a scan).
  const pointCloudLayer = (): Layer | undefined => {
    const document = viewer.document;
    if (!document) return undefined;
    return document.active() ?? (document.layers.length === 1 ? document.layers[0] : undefined);
  };
  const points = pane.addFolder({ title: 'Point cloud', expanded: true });
  points
    .addBinding(settings, 'pointSizeMul', { label: 'Point size ×', min: 0.1, max: 8, step: 0.05 })
    .on('change', (event) => {
      const layer = pointCloudLayer();
      if (event.last && layer?.pointCloud)
        callbacks.onPointScaleChange(layer, layer.pointCloud.basePointScale * event.value);
    });
  points
    .addBinding(settings, 'pointBudgetM', {
      label: 'Budget (M pts)',
      min: 0.25,
      max: 12,
      step: 0.25,
    })
    .on('change', (event) => {
      const layer = pointCloudLayer();
      if (event.last && layer?.pointCloud)
        callbacks.onPointBudgetChange(layer, Math.round(event.value * 1e6));
    });

  let observed = viewer.document;
  const sync = (): void => {
    const document = viewer.document;
    if (document !== observed) {
      observed?.removeEventListener('selection-changed', sync);
      observed?.removeEventListener('layer-changed', sync);
      observed = document;
      observed?.addEventListener('selection-changed', sync);
      observed?.addEventListener('layer-changed', sync);
    }
    const info = pointCloudLayer()?.pointCloud;
    points.hidden = !info;
    settings.grid = viewer.isGridVisible;
    settings.upAxis = viewer.upAxis;
    settings.cameraMode = viewer.cameraRig.mode;
    settings.flySpeed = viewer.cameraRig.flySpeed;
    settings.renderScale = viewer.currentRenderScale;
    if (info) {
      settings.pointSizeMul = info.basePointScale > 0 ? info.pointScale / info.basePointScale : 1;
      settings.pointBudgetM = info.pointBudget / 1e6;
    }
    pane.refresh();
  };
  viewer.addEventListener('settings-changed', sync);
  viewer.addEventListener('document-changed', sync);
  viewer.cameraRig.addEventListener('mode-changed', sync);
  viewer.cameraRig.addEventListener('speed-changed', sync);
  sync();

  return {
    refresh: sync,
    dispose: (): void => {
      observed?.removeEventListener('selection-changed', sync);
      observed?.removeEventListener('layer-changed', sync);
      viewer.removeEventListener('settings-changed', sync);
      viewer.removeEventListener('document-changed', sync);
      viewer.cameraRig.removeEventListener('mode-changed', sync);
      viewer.cameraRig.removeEventListener('speed-changed', sync);
      pane.dispose();
    },
  };
}
