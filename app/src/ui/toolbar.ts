import type { LayerGizmo } from '../select/LayerGizmo';
import type { Segments } from '../select/Segments';
import { icon } from './icons';

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
  /** label doubles as the tooltip and the screen-reader name; the icon carries neither. */
  const button = (attr: string, name: string, label: string, hint: string): string =>
    `<button type="button" ${attr}="${name}" title="${label} — ${hint}" aria-label="${label}">` +
    `${icon(name)}<span class="sr-only">${label}</span></button>`;

  host.innerHTML = `
    <div class="toolbar-group">
      ${button('data-op', 'split', 'Split to object', 'lift the selected group out of the scan')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group" role="group" aria-label="Transform mode">
      ${button('data-mode', 'translate', 'Move', 'drag the object')}
      ${button('data-mode', 'rotate', 'Rotate', 'spin it in place')}
      ${button('data-mode', 'scale', 'Scale', 'resize it')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group">
      ${button('data-op', 'duplicate', 'Duplicate', 'copy this object')}
      ${button('data-op', 'array', 'Array ×5', 'copy it four more times in a row')}
      ${button('data-op', 'group', 'Group', 'nest the ticked objects under one')}
      ${button('data-op', 'ungroup', 'Ungroup', 'dissolve this grouping')}
    </div>
    <div class="toolbar-rule"></div>
    <div class="toolbar-group">
      ${button('data-op', 'isolate', 'Isolate', 'hide everything else')}
      ${button('data-op', 'floor', 'Snap to floor', 'drop it onto the ground plane')}
      ${button('data-op', 'merge', 'Merge back', 'put its splats back into the scan')}
      ${button('data-op', 'delete', 'Delete', 'take it out of the scene')}
    </div>
  `;

  const op = (name: string): HTMLButtonElement =>
    host.querySelector<HTMLButtonElement>(`[data-op="${name}"]`)!;
  const modeButtons = [...host.querySelectorAll<HTMLButtonElement>('[data-mode]')];

  const render = (): void => {
    const active = segments.activeLayer;
    const selection = segments.selection;
    // Splitting needs a group selected in the scan that has not already been lifted out.
    op('split').disabled =
      selection === undefined ||
      segments.allLayers().some((layer) => layer.groupId === selection.groupId);
    for (const name of ['duplicate', 'array', 'floor', 'merge', 'delete']) {
      op(name).disabled = active === undefined;
    }
    // Only the original lift-out owns splats in the scan, so only it can go back.
    op('merge').disabled = active?.indices === undefined;
    op('ungroup').disabled = !active || active.children.length === 0;
    op('group').disabled = segments.ticked.length < 2;
    op('isolate').disabled = active === undefined && segments.isolated === undefined;
    const isolateLabel = segments.isolated ? 'Show all' : 'Isolate';
    op('isolate').title = `${isolateLabel} — hide everything else`;
    op('isolate').setAttribute('aria-label', isolateLabel);
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
    split: (): void => void segments.splitSelection(),
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
  segments.addEventListener('selection-changed', render);
  render();

  return {
    dispose: (): void => {
      segments.removeEventListener('layers-changed', render);
      segments.removeEventListener('active-changed', render);
      segments.removeEventListener('selection-changed', render);
    },
  };
}
