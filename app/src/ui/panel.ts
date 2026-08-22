import { Pane } from 'tweakpane';
import { DEFAULT_POINT_BUDGET } from '../io/pointCloud';
import type { CameraMode } from '../viewer/CameraRig';
import type { SplatDocument } from '../viewer/SplatDocument';
import type { UpAxis, Viewer } from '../viewer/Viewer';

interface PanelSettings {
  background: string;
  grid: boolean;
  axes: boolean;
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
  /** Re-open the current point cloud with a new budget (requires a re-parse). */
  onPointBudgetChange: (budget: number) => void;
}

export function createPanel(
  viewer: Viewer,
  container: HTMLElement,
  callbacks: PanelCallbacks,
): { dispose: () => void; refresh: () => void } {
  const settings: PanelSettings = {
    background: '#111111',
    grid: true,
    axes: true,
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
    .addBinding(settings, 'axes', { label: 'Axes' })
    .on('change', (event) => viewer.setAxesVisible(event.value));
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

  const points = pane.addFolder({ title: 'Point cloud', expanded: true });
  // Relative to the spacing-based estimate so one slider range fits every scene scale.
  points
    .addBinding(settings, 'pointSizeMul', { label: 'Point size ×', min: 0.1, max: 8, step: 0.05 })
    .on('change', (event) => {
      const document = viewer.document;
      if (event.last && document?.pointCloud)
        document.setPointScale(document.pointCloud.basePointScale * event.value);
    });
  const pointBudgetBinding = points.addBinding(settings, 'pointBudgetM', {
    label: 'Budget (M pts)',
    min: 0.25,
    max: 12,
    step: 0.25,
  });
  pointBudgetBinding.on('change', (event) => {
    if (event.last) callbacks.onPointBudgetChange(Math.round(event.value * 1e6));
  });

  const syncDocument = (document?: SplatDocument): void => {
    const isPointCloud = document?.kind === 'pointcloud';
    points.hidden = !isPointCloud;
    settings.upAxis = viewer.upAxis;
    if (isPointCloud && document.pointCloud) {
      const { pointScale, basePointScale } = document.pointCloud;
      settings.pointSizeMul = basePointScale > 0 ? pointScale / basePointScale : 1;
    }
    pane.refresh();
  };

  const sync = (): void => {
    settings.grid = viewer.isGridVisible;
    settings.upAxis = viewer.upAxis;
    settings.cameraMode = viewer.cameraRig.mode;
    settings.flySpeed = viewer.cameraRig.flySpeed;
    settings.renderScale = viewer.currentRenderScale;
    pane.refresh();
  };
  const onDocumentChanged = (event: Event): void =>
    syncDocument((event as CustomEvent<SplatDocument | undefined>).detail);
  viewer.addEventListener('settings-changed', sync);
  viewer.addEventListener('document-changed', onDocumentChanged);
  viewer.cameraRig.addEventListener('mode-changed', sync);
  viewer.cameraRig.addEventListener('speed-changed', sync);
  syncDocument(viewer.document);

  return {
    refresh: sync,
    dispose: (): void => {
      viewer.removeEventListener('settings-changed', sync);
      viewer.removeEventListener('document-changed', onDocumentChanged);
      viewer.cameraRig.removeEventListener('mode-changed', sync);
      viewer.cameraRig.removeEventListener('speed-changed', sync);
      pane.dispose();
    },
  };
}
