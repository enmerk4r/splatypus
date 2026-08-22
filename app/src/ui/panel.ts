import { Pane } from 'tweakpane';
import type { CameraMode } from '../viewer/CameraRig';
import type { Viewer } from '../viewer/Viewer';

interface PanelSettings {
  background: string;
  grid: boolean;
  axes: boolean;
  flipY: boolean;
  cameraMode: CameraMode;
  fov: number;
  flySpeed: number;
  maxStdDev: number;
}

export function createPanel(
  viewer: Viewer,
  container: HTMLElement,
): { dispose: () => void; refresh: () => void } {
  const settings: PanelSettings = {
    background: '#111111',
    grid: true,
    axes: true,
    flipY: true,
    cameraMode: viewer.cameraRig.mode,
    fov: 60,
    flySpeed: viewer.cameraRig.flySpeed,
    maxStdDev: viewer.spark.maxStdDev,
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
    .addBinding(settings, 'flipY', { label: 'Flip Y' })
    .on('change', (event) => viewer.setFlipY(event.value));
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
  pane
    .addBinding(settings, 'maxStdDev', { label: 'Splat extent', min: 2, max: 3.2, step: 0.05 })
    .on('change', (event) => {
      viewer.spark.maxStdDev = event.value;
    });

  const sync = (): void => {
    settings.grid = viewer.isGridVisible;
    settings.cameraMode = viewer.cameraRig.mode;
    settings.flySpeed = viewer.cameraRig.flySpeed;
    pane.refresh();
  };
  viewer.addEventListener('settings-changed', sync);
  viewer.cameraRig.addEventListener('mode-changed', sync);
  viewer.cameraRig.addEventListener('speed-changed', sync);

  return {
    refresh: sync,
    dispose: (): void => {
      viewer.removeEventListener('settings-changed', sync);
      viewer.cameraRig.removeEventListener('mode-changed', sync);
      viewer.cameraRig.removeEventListener('speed-changed', sync);
      pane.dispose();
    },
  };
}
