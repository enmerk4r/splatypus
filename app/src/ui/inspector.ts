import type { LayerGizmo } from '../select/LayerGizmo';
import type { SegmentLayer, Segments } from '../select/Segments';

const AXES = ['x', 'y', 'z'] as const;
type Axis = (typeof AXES)[number];

/**
 * The right panel: the outliner and whatever the selected object's properties are, with
 * the viewport settings behind a second tab.
 *
 * They share one column because they answer the same question — "what am I looking at,
 * and what can I change about it" — at two different scopes, and only one is ever needed
 * at a time.
 */
export function createInspector(
  host: HTMLElement,
  pane: HTMLElement,
  tabs: { object: HTMLButtonElement; viewport: HTMLButtonElement },
  panes: { object: HTMLElement; viewport: HTMLElement },
  segments: Segments,
  gizmo: LayerGizmo,
): { dispose: () => void } {
  pane.innerHTML = `
    <ul class="outliner" id="outliner"></ul>
    <div class="properties" id="properties" hidden>
      <label class="properties-name">
        <span>Name</span>
        <input type="text" id="prop-name" />
      </label>
      <p class="panel-hint" id="prop-splats"></p>
      <div class="properties-vector">
        <span>Position</span>
        ${AXES.map(
          (axis) =>
            `<label><span>${axis.toUpperCase()}</span>` +
            `<input type="number" step="0.01" id="prop-${axis}" /></label>`,
        ).join('')}
      </div>
      <button type="button" id="prop-reset">Reset transform</button>
    </div>
    <p class="panel-hint" id="outliner-empty">
      Nothing split out yet. Click a group in the scene, then Split to object.
    </p>
  `;

  const pick = <T extends HTMLElement>(id: string): T => pane.querySelector<T>(`#${id}`)!;
  const outliner = pick<HTMLUListElement>('outliner');
  const properties = pick<HTMLDivElement>('properties');
  const emptyHint = pick<HTMLParagraphElement>('outliner-empty');
  const nameInput = pick<HTMLInputElement>('prop-name');
  const splatsText = pick<HTMLParagraphElement>('prop-splats');
  const resetButton = pick<HTMLButtonElement>('prop-reset');
  const axisInputs = Object.fromEntries(
    AXES.map((axis) => [axis, pick<HTMLInputElement>(`prop-${axis}`)]),
  ) as Record<Axis, HTMLInputElement>;

  const showTab = (which: 'object' | 'viewport'): void => {
    for (const key of ['object', 'viewport'] as const) {
      const chosen = key === which;
      tabs[key].setAttribute('aria-selected', String(chosen));
      panes[key].hidden = !chosen;
    }
  };

  /** One row per object, nested to show groupings, with the active one marked. */
  const renderOutliner = (): void => {
    outliner.replaceChildren();
    const active = segments.activeLayer;
    const rows = (layers: readonly SegmentLayer[], depth: number): void => {
      for (const layer of layers) {
        const item = document.createElement('li');
        item.style.paddingLeft = `${depth * 12}px`;
        if (layer === active) item.classList.add('is-active');

        const tick = document.createElement('input');
        tick.type = 'checkbox';
        tick.title = 'Include in the next Group';
        tick.checked = segments.isTicked(layer);
        tick.addEventListener('change', () => segments.setTicked(layer, tick.checked));

        const select = document.createElement('button');
        select.type = 'button';
        select.className = 'outliner-name';
        select.textContent = layer.children.length
          ? `${layer.name} · ${layer.children.length} objects`
          : `${layer.name} · ${layer.splatCount.toLocaleString()}`;
        select.addEventListener('click', () => segments.activate(layer));

        const eye = document.createElement('button');
        eye.type = 'button';
        eye.title = layer.hidden ? 'Show' : 'Hide';
        eye.textContent = layer.hidden ? '○' : '●';
        eye.addEventListener('click', () => segments.setHidden(layer, !layer.hidden));

        item.append(tick, select, eye);
        outliner.append(item);
        rows(layer.children, depth + 1);
      }
    };
    rows(segments.segmentLayers, 0);
    emptyHint.hidden = segments.segmentLayers.length > 0;
  };

  const renderProperties = (): void => {
    const active = segments.activeLayer;
    properties.hidden = active === undefined;
    if (!active) return;
    // Skip the field the user is typing in, or the caret jumps on every keystroke.
    if (document.activeElement !== nameInput) nameInput.value = active.name;
    splatsText.textContent = active.children.length
      ? `${active.children.length} objects · ${active.splatCount.toLocaleString()} splats`
      : `${active.splatCount.toLocaleString()} splats`;
    for (const axis of AXES) {
      const input = axisInputs[axis];
      if (document.activeElement !== input) {
        input.value = active.object.position[axis].toFixed(3);
      }
    }
  };

  const render = (): void => {
    renderOutliner();
    renderProperties();
  };

  const onName = (): void => {
    const active = segments.activeLayer;
    if (active) segments.rename(active, nameInput.value);
  };
  const onAxis = (axis: Axis) => (): void => {
    const active = segments.activeLayer;
    const value = Number(axisInputs[axis].value);
    if (!active || Number.isNaN(value)) return;
    active.object.position[axis] = value;
    active.object.updateMatrixWorld(true);
  };
  const onReset = (): void => {
    const active = segments.activeLayer;
    if (active) segments.resetTransform(active);
  };
  const onObjectTab = (): void => showTab('object');
  const onViewportTab = (): void => showTab('viewport');

  nameInput.addEventListener('input', onName);
  for (const axis of AXES) axisInputs[axis].addEventListener('change', onAxis(axis));
  resetButton.addEventListener('click', onReset);
  tabs.object.addEventListener('click', onObjectTab);
  tabs.viewport.addEventListener('click', onViewportTab);
  segments.addEventListener('layers-changed', render);
  segments.addEventListener('active-changed', render);
  // Dragging the gizmo has to write back into the position fields, or they lie.
  gizmo.addEventListener('transform-changed', renderProperties);
  host.hidden = false;
  render();

  return {
    dispose: (): void => {
      segments.removeEventListener('layers-changed', render);
      segments.removeEventListener('active-changed', render);
      gizmo.removeEventListener('transform-changed', renderProperties);
    },
  };
}
