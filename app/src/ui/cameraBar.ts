import type { AxisView } from '../viewer/CameraRig';
import type { Viewer } from '../viewer/Viewer';
import { icon } from './icons';

/**
 * The camera cluster in the bottom-left corner: orbit ⇄ fly, frame the scene, the three
 * axis views and the grid toggle — the navigation controls that used to live only behind
 * keys (Tab, F, 1/3/7, G) and the collapsed VIEW panel. Always visible once a scene is open.
 */
export function createCameraBar(viewer: Viewer, host: HTMLElement): { dispose: () => void } {
  const button = (name: string, label: string, hint: string, inner = icon(name)): string =>
    `<button type="button" data-camera="${name}" title="${label} — ${hint}" aria-label="${label}">` +
    `${inner}<span class="sr-only">${label}</span></button>`;
  const glyph = (text: string): string =>
    `<span class="camera-glyph" aria-hidden="true">${text}</span>`;
  host.innerHTML = `
    <div class="toolbar-group" role="group" aria-label="Camera mode">
      ${button('mode', 'Orbit / Fly (Tab)', 'orbit around the scene, or fly through it with WASD')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group" role="group" aria-label="Views">
      ${button('frame', 'Frame (F)', 'fit the scene (or the selection) in view')}
      ${button('front', 'Front view (1)', 'look along +Z', glyph('F'))}
      ${button('right', 'Right view (3)', 'look along −X', glyph('R'))}
      ${button('top', 'Top view (7)', 'look straight down', glyph('T'))}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group" role="group" aria-label="Grid">
      ${button('grid', 'Grid (G)', 'show or hide the ground grid')}
    </div>`;
  const pick = (name: string): HTMLButtonElement =>
    host.querySelector<HTMLButtonElement>(`[data-camera="${name}"]`)!;
  const modeButton = pick('mode');
  const gridButton = pick('grid');

  const render = (): void => {
    const document = viewer.document;
    host.hidden = !document || document.layers.length === 0;
    const fly = viewer.cameraRig.mode === 'fly';
    modeButton.innerHTML = `${icon(fly ? 'fly' : 'orbit')}<span class="sr-only">Orbit / Fly (Tab)</span>`;
    modeButton.setAttribute('aria-pressed', String(fly));
    modeButton.title = fly
      ? 'Fly (Tab) — WASD + QE to move, drag to look; click or Esc to orbit again'
      : 'Orbit (Tab) — drag to orbit, wheel to zoom, right-drag to pan; click to fly';
    gridButton.setAttribute('aria-pressed', String(viewer.isGridVisible));
    for (const view of ['front', 'right', 'top'] as AxisView[]) pick(view).disabled = fly;
    pick('frame').disabled = fly;
  };

  modeButton.addEventListener('click', () => viewer.cameraRig.toggleMode());
  pick('frame').addEventListener('click', () => viewer.frame());
  for (const view of ['front', 'right', 'top'] as AxisView[])
    pick(view).addEventListener('click', () => viewer.setView(view));
  gridButton.addEventListener('click', () => viewer.toggleGrid());

  let observed = viewer.document;
  const observe = (): void => {
    observed?.removeEventListener('layers-changed', render);
    observed = viewer.document;
    observed?.addEventListener('layers-changed', render);
    render();
  };
  viewer.addEventListener('document-changed', observe);
  viewer.addEventListener('settings-changed', render);
  viewer.cameraRig.addEventListener('mode-changed', render);
  observe();

  return {
    dispose: (): void => {
      viewer.removeEventListener('document-changed', observe);
      viewer.removeEventListener('settings-changed', render);
      viewer.cameraRig.removeEventListener('mode-changed', render);
      observed?.removeEventListener('layers-changed', render);
      host.replaceChildren();
    },
  };
}
