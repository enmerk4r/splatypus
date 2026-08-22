import type { LayerGizmo } from '../select/LayerGizmo';
import type { Segments } from '../select/Segments';

type GizmoMode = 'translate' | 'rotate' | 'scale';

/**
 * The bottom bar: everything that acts on the object currently being edited.
 *
 * It stays in one fixed place rather than following the selection, so that the tools
 * are always where the hand expects them and the scene is never covered by them.
 */
export function createToolbar(
  host: HTMLElement,
  segments: Segments,
  gizmo: LayerGizmo,
): { dispose: () => void } {
  host.innerHTML = `
    <div class="toolbar-group" role="group" aria-label="Transform mode">
      <button type="button" data-mode="translate" aria-pressed="true" title="Move (W)">Move</button>
      <button type="button" data-mode="rotate" aria-pressed="false" title="Rotate (E)">Rotate</button>
      <button type="button" data-mode="scale" aria-pressed="false" title="Scale (R)">Scale</button>
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group">
      <button type="button" data-op="duplicate" title="Copy this object">Duplicate</button>
      <button type="button" data-op="array" title="Copy it four more times in a row">Array ×5</button>
      <button type="button" data-op="group" title="Nest the ticked objects under one">Group</button>
      <button type="button" data-op="ungroup" title="Dissolve this grouping">Ungroup</button>
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group">
      <button type="button" data-op="isolate" title="Hide everything else">Isolate</button>
      <button type="button" data-op="floor" title="Drop it onto the ground plane">Snap to floor</button>
      <button type="button" data-op="merge" title="Put its splats back into the scan">Merge back</button>
      <button type="button" data-op="delete" title="Take it out of the scene">Delete</button>
    </div>
  `;

  const op = (name: string): HTMLButtonElement =>
    host.querySelector<HTMLButtonElement>(`[data-op="${name}"]`)!;
  const modeButtons = [...host.querySelectorAll<HTMLButtonElement>('[data-mode]')];

  const render = (): void => {
    const active = segments.activeLayer;
    host.hidden = segments.segmentLayers.length === 0;
    for (const name of ['duplicate', 'array', 'floor', 'merge', 'delete']) {
      op(name).disabled = active === undefined;
    }
    // Only the original lift-out owns splats in the scan, so only it can go back.
    op('merge').disabled = active?.indices === undefined;
    op('ungroup').disabled = !active || active.children.length === 0;
    op('group').disabled = segments.ticked.length < 2;
    op('isolate').disabled = active === undefined && segments.isolated === undefined;
    op('isolate').textContent = segments.isolated ? 'Show all' : 'Isolate';
    op('isolate').setAttribute('aria-pressed', String(segments.isolated !== undefined));
    for (const button of modeButtons) {
      button.disabled = active === undefined;
      button.setAttribute('aria-pressed', String(button.dataset.mode === gizmo.mode));
    }
  };

  const withActive =
    (run: (layer: NonNullable<typeof segments.activeLayer>) => void) => (): void => {
      const active = segments.activeLayer;
      if (active) run(active);
    };

  const handlers: Record<string, () => void> = {
    duplicate: withActive((layer) => segments.activate(segments.duplicate(layer))),
    array: withActive((layer) => void segments.arrayCopies(layer, 4)),
    group: (): void => void segments.groupTicked(),
    ungroup: withActive((layer) => segments.ungroup(layer)),
    isolate: (): void => segments.isolate(segments.isolated ? undefined : segments.activeLayer),
    floor: withActive((layer) => segments.snapToFloor(layer)),
    merge: withActive((layer) => segments.mergeLayer(layer)),
    delete: withActive((layer) => segments.deleteLayer(layer)),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    op(name).addEventListener('click', handler);
  }
  for (const button of modeButtons) {
    button.addEventListener('click', () => {
      gizmo.setMode(button.dataset.mode as GizmoMode);
      render();
    });
  }

  segments.addEventListener('layers-changed', render);
  segments.addEventListener('active-changed', render);
  render();

  return {
    dispose: (): void => {
      segments.removeEventListener('layers-changed', render);
      segments.removeEventListener('active-changed', render);
    },
  };
}
