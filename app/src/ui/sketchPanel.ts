import { targetSketchLayer } from '../model/sketchCommands';
import type { PresetName } from '../sketch/presets';
import type { SketchSettingsStore } from '../sketch/settings';
import type { PlacementMode } from '../sketch/stroke';
import type { Viewer } from '../viewer/Viewer';
import { createPanelShell } from './collapse';

const SWATCHES = ['#ff3b30', '#b8f34a', '#ffffff', '#35d0ff', '#ffd60a', '#ff4fd8'];

function sizeLabel(metres: number): string {
  return metres < 0.01 ? `${Math.round(metres * 1000)} mm` : `${(metres * 100).toFixed(1)} cm`;
}

export function createSketchPanel(
  viewer: Viewer,
  settings: SketchSettingsStore,
  root: HTMLElement,
): { dispose: () => void } {
  const shell = createPanelShell(root, 'SKETCH', 'pen');
  shell.body.innerHTML = `
    <div class="sketch-body">
      <div class="sketch-buttons" role="group" aria-label="Brush preset">
        ${(['ink', 'tube', 'marker', 'spray'] as PresetName[]).map((name) => `<button type="button" data-preset="${name}">${name[0]!.toUpperCase() + name.slice(1)}</button>`).join('')}
      </div>
      <div class="sketch-row"><label for="sketch-colour">Colour</label>
        <div class="sketch-colours"><input id="sketch-colour" type="color" aria-label="Stroke colour" />
          ${SWATCHES.map((colour) => `<button type="button" data-colour="${colour}" style="--swatch:${colour}" aria-label="Use ${colour}"></button>`).join('')}
        </div>
      </div>
      <div class="sketch-row"><label for="sketch-size">Size <output id="sketch-size-value"></output></label>
        <input id="sketch-size" type="range" min="${Math.log(0.002)}" max="${Math.log(0.5)}" step="0.01" />
      </div>
      <div class="sketch-row"><label for="sketch-opacity">Opacity <output id="sketch-opacity-value"></output></label>
        <input id="sketch-opacity" type="range" min="0" max="1" step="0.01" />
      </div>
      <div class="sketch-buttons" role="group" aria-label="Stroke placement">
        <button type="button" data-placement="surface">Surface</button>
        <button type="button" data-placement="depth">Lock depth</button>
        <button type="button" data-placement="plane">Plane</button>
      </div>
      <label class="sketch-toggle"><input id="sketch-pressure" type="checkbox" /> Pressure controls size + opacity</label>
      <p class="sketch-status" id="sketch-status"></p>
      <p class="sketch-hint">draw with the left button · right/middle or Alt+drag to orbit</p>
    </div>`;
  const pick = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
  const colour = pick<HTMLInputElement>('#sketch-colour');
  const size = pick<HTMLInputElement>('#sketch-size');
  const sizeValue = pick<HTMLOutputElement>('#sketch-size-value');
  const opacity = pick<HTMLInputElement>('#sketch-opacity');
  const opacityValue = pick<HTMLOutputElement>('#sketch-opacity-value');
  const pressure = pick<HTMLInputElement>('#sketch-pressure');
  const status = pick<HTMLParagraphElement>('#sketch-status');
  const presetButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-preset]')];
  const placementButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-placement]')];
  const swatches = [...root.querySelectorAll<HTMLButtonElement>('[data-colour]')];

  const render = (): void => {
    const document = viewer.document;
    root.hidden = !document || document.layers.length === 0;
    colour.value = settings.colour;
    size.value = String(Math.log(settings.radius));
    sizeValue.value = sizeLabel(settings.radius);
    opacity.value = String(settings.opacity);
    opacityValue.value = `${Math.round(settings.opacity * 100)}%`;
    pressure.checked = settings.pressure;
    presetButtons.forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.preset === settings.preset)),
    );
    placementButtons.forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.placement === settings.placement)),
    );
    const target = document ? targetSketchLayer(document) : undefined;
    const count = target?.strokes.filter((stroke) => !stroke.erased).length ?? 0;
    status.textContent = target
      ? `Target · ${target.name} · ${count} stroke${count === 1 ? '' : 's'}`
      : 'Target · new Sketch layer';
  };

  presetButtons.forEach((button) =>
    button.addEventListener('click', () => settings.setPreset(button.dataset.preset as PresetName)),
  );
  placementButtons.forEach((button) =>
    button.addEventListener('click', () =>
      settings.setPlacement(button.dataset.placement as PlacementMode),
    ),
  );
  swatches.forEach((button) =>
    button.addEventListener('click', () => settings.setColour(button.dataset.colour!)),
  );
  colour.addEventListener('input', () => settings.setColour(colour.value));
  size.addEventListener('input', () => settings.setRadius(Math.exp(Number(size.value))));
  opacity.addEventListener('input', () => settings.setOpacity(Number(opacity.value)));
  pressure.addEventListener('change', () => settings.setPressure(pressure.checked));

  let observed = viewer.document;
  const observe = (): void => {
    observed?.removeEventListener('layers-changed', render);
    observed?.removeEventListener('layer-changed', render);
    observed?.removeEventListener('selection-changed', render);
    observed = viewer.document;
    observed?.addEventListener('layers-changed', render);
    observed?.addEventListener('layer-changed', render);
    observed?.addEventListener('selection-changed', render);
    render();
  };
  viewer.addEventListener('document-changed', observe);
  settings.addEventListener('settings-changed', render);
  observe();

  return {
    dispose: (): void => {
      viewer.removeEventListener('document-changed', observe);
      settings.removeEventListener('settings-changed', render);
      observed?.removeEventListener('layers-changed', render);
      observed?.removeEventListener('layer-changed', render);
      observed?.removeEventListener('selection-changed', render);
      shell.dispose();
    },
  };
}
