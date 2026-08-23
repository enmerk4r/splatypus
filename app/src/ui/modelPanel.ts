import type { ExtrudeGizmo } from '../mesh/ExtrudeGizmo';
import type { ModelSettingsStore, ShapeMode } from '../mesh/settings';
import type { Viewer } from '../viewer/Viewer';
import { createPanelShell } from './collapse';
import type { ToastLevel } from './hud';

export interface ModelPanelCallbacks {
  notify: (message: string, level?: ToastLevel) => void;
}

/**
 * MODEL panel: outline shape (polyline / rectangle / polygon / circle), polygon sides,
 * ortho drawing, and numeric extrusion of the selected face (the arrow gizmo does the same
 * by dragging).
 */
export function createModelPanel(
  viewer: Viewer,
  settings: ModelSettingsStore,
  gizmo: ExtrudeGizmo,
  root: HTMLElement,
  callbacks: ModelPanelCallbacks,
): { dispose: () => void } {
  const shell = createPanelShell(root, 'MODEL', 'polyline');
  shell.body.innerHTML = `
    <div class="sketch-body">
      <div class="sketch-buttons" role="group" aria-label="Outline shape">
        ${(['polyline', 'rectangle', 'polygon', 'circle'] as ShapeMode[])
          .map(
            (name) =>
              `<button type="button" data-shape="${name}">${name[0]!.toUpperCase() + name.slice(1)}</button>`,
          )
          .join('')}
      </div>
      <div class="sketch-row"><label for="model-sides">Sides <output id="model-sides-value"></output></label>
        <input id="model-sides" type="range" min="3" max="24" step="1" />
      </div>
      <label class="sketch-toggle"><input id="model-ortho" type="checkbox" /> Ortho (axis-aligned segments) — hold Shift to toggle while drawing</label>
      <p class="sketch-hint">P: click an outline on a plane (height from the surface under the first click). Enter / double-click / first point closes a polyline; Backspace removes a point. The result is a translucent face — rotate it, then extrude along its normal.</p>
      <div class="layers-header segment-subhead">EXTRUDE</div>
      <div class="sketch-row"><label for="model-height">Height <output id="model-height-live"></output></label>
        <input id="model-height" type="number" step="any" aria-label="Extrusion height in metres (negative = opposite direction)" />
      </div>
      <div class="segment-actions">
        <button type="button" id="model-extrude" class="primary">Extrude face</button>
      </div>
      <p class="sketch-status" id="model-status"></p>
    </div>`;
  const pick = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
  const shapeButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-shape]')];
  const sides = pick<HTMLInputElement>('#model-sides');
  const sidesValue = pick<HTMLOutputElement>('#model-sides-value');
  const ortho = pick<HTMLInputElement>('#model-ortho');
  const height = pick<HTMLInputElement>('#model-height');
  const heightLive = pick<HTMLOutputElement>('#model-height-live');
  const extrude = pick<HTMLButtonElement>('#model-extrude');
  const status = pick<HTMLParagraphElement>('#model-status');

  const render = (): void => {
    const model = viewer.document;
    root.hidden = !model || model.layers.length === 0;
    shapeButtons.forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.shape === settings.shape)),
    );
    sides.value = String(settings.sides);
    sidesValue.value = String(settings.sides);
    sides.disabled = settings.shape !== 'polygon';
    ortho.checked = settings.ortho;
    if (globalThis.document.activeElement !== height) height.value = String(settings.height);
    const target = gizmo.target;
    extrude.disabled = !target;
    height.disabled = !target;
    status.textContent = target
      ? `Face “${target.name}” selected — drag the lime arrow or enter a height.`
      : 'Select a face layer (Select tool) to extrude it.';
  };

  shapeButtons.forEach((button) =>
    button.addEventListener('click', () => settings.setShape(button.dataset.shape as ShapeMode)),
  );
  sides.addEventListener('input', () => settings.setSides(Number(sides.value)));
  ortho.addEventListener('change', () => settings.setOrtho(ortho.checked));
  height.addEventListener('change', () => settings.setHeight(Number(height.value)));
  const onExtrude = (): void => {
    const value = Number(height.value);
    settings.setHeight(value);
    if (!gizmo.extrudeBy(value)) callbacks.notify('Select a face layer first.', 'warning');
  };
  extrude.addEventListener('click', onExtrude);
  height.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onExtrude();
    }
  });
  const onPreview = (event: Event): void => {
    const value = (event as CustomEvent<{ height?: number }>).detail.height;
    heightLive.value =
      value === undefined ? '' : `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(3)} m`;
    if (value !== undefined) height.value = value.toFixed(3);
  };

  let observed = viewer.document;
  const observe = (): void => {
    observed?.removeEventListener('layers-changed', render);
    observed?.removeEventListener('selection-changed', render);
    observed = viewer.document;
    observed?.addEventListener('layers-changed', render);
    observed?.addEventListener('selection-changed', render);
    render();
  };
  viewer.addEventListener('document-changed', observe);
  settings.addEventListener('settings-changed', render);
  gizmo.addEventListener('target-changed', render);
  gizmo.addEventListener('preview', onPreview);
  observe();

  return {
    dispose: (): void => {
      viewer.removeEventListener('document-changed', observe);
      settings.removeEventListener('settings-changed', render);
      gizmo.removeEventListener('target-changed', render);
      gizmo.removeEventListener('preview', onPreview);
      observed?.removeEventListener('layers-changed', render);
      observed?.removeEventListener('selection-changed', render);
      shell.dispose();
    },
  };
}
