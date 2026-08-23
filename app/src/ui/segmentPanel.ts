import type { BakeBasis, Segmentation } from '../select/Segmentation';
import type { GroupMap } from '../splats/groups';
import type { Viewer } from '../viewer/Viewer';
import { createPanelShell } from './collapse';
import type { ToastLevel } from './hud';

export interface SegmentPanelCallbacks {
  notify: (message: string, level?: ToastLevel) => void;
}

/**
 * SEGMENT panel: how the active layer is divided into groups (sidecar or in-app bake),
 * the group overlay, and the current group selection with "Split to layer".
 */
export function createSegmentPanel(
  viewer: Viewer,
  segmentation: Segmentation,
  root: HTMLElement,
  callbacks: SegmentPanelCallbacks,
): { dispose: () => void } {
  const shell = createPanelShell(root, 'SEGMENT', 'segment');
  shell.body.innerHTML = `
    <div class="segment-body">
      <div class="segment-row">
        <label for="segment-basis">By</label>
        <select id="segment-basis">
          <option value="patches">Surface patches</option>
          <option value="colour">Colour + position</option>
          <option value="colour-only">Colour only</option>
          <option value="position">Position only</option>
        </select>
      </div>
      <div class="segment-row">
        <label for="segment-detail">Detail</label>
        <input type="range" id="segment-detail" min="0" max="5" step="1" value="4" />
      </div>
      <div class="segment-actions">
        <button type="button" id="segment-rebake">Segment</button>
        <button type="button" id="segment-overlay" aria-pressed="false">Show segmentation</button>
      </div>
      <div class="segment-row">
        <label for="segment-blend">Blend</label>
        <input type="range" id="segment-blend" min="0" max="100" step="5" value="100" />
      </div>
      <p class="segment-status" id="segment-status"></p>
      <div class="segment-actions">
        <button type="button" id="segment-split" class="primary">Split to layer</button>
        <button type="button" id="segment-clear">Clear</button>
      </div>
    </div>
  `;
  const pick = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  const basis = pick<HTMLSelectElement>('segment-basis');
  const detail = pick<HTMLInputElement>('segment-detail');
  const rebake = pick<HTMLButtonElement>('segment-rebake');
  const overlay = pick<HTMLButtonElement>('segment-overlay');
  const blend = pick<HTMLInputElement>('segment-blend');
  const status = pick<HTMLParagraphElement>('segment-status');
  const split = pick<HTMLButtonElement>('segment-split');
  const clear = pick<HTMLButtonElement>('segment-clear');

  const summarise = (groups: GroupMap): string => {
    const covered = Math.round(groups.coverage * 100);
    return `${groups.numGroups} groups · ${covered}% covered · ${100 - covered}% unsegmented`;
  };

  const render = (): void => {
    const document = viewer.document;
    root.hidden = !document || document.layers.length === 0;
    if (!document) return;
    const target = segmentation.targetLayer();
    const groups = target?.groups;
    const selection = segmentation.selection;
    rebake.disabled = !target || target.locked;
    rebake.textContent = groups ? 'Re-segment' : 'Segment';
    rebake.title = target
      ? `Run the connectivity bake on “${target.name}”`
      : 'Select a layer to segment';
    const anySegmented = segmentation.segmentedLayers.length > 0;
    overlay.disabled = !anySegmented;
    overlay.textContent = segmentation.overlay ? 'Hide segmentation' : 'Show segmentation';
    overlay.setAttribute('aria-pressed', String(segmentation.overlay));
    blend.disabled = !segmentation.overlay;
    blend.value = String(Math.round(segmentation.blend * 100));
    split.disabled = !selection || selection.layer.locked;
    clear.disabled = !selection;
    if (selection) {
      status.textContent = `${selection.info.name} · ${selection.indices.length.toLocaleString()} splats in “${selection.layer.name}”`;
    } else if (groups) {
      const hint =
        segmentation.outcome === 'missed'
          ? 'Nothing under the cursor — click closer to a surface.'
          : segmentation.outcome === 'unassigned'
            ? 'That splat is in no group; lower Detail to cover more.'
            : 'Click a group to select it; Shift-click to select more.';
      status.textContent = `${summarise(groups)}. ${hint}`;
    } else if (target) {
      status.textContent = `“${target.name}” is not segmented. Press Segment, or drop a .groups sidecar.`;
    } else {
      status.textContent = 'Select a layer to segment it.';
    }
  };

  const onRebake = (): void => {
    const target = segmentation.targetLayer();
    if (!target) return;
    status.textContent = 'Segmenting…';
    rebake.disabled = true;
    // The bake runs on the main thread; let the pending state paint before it starts
    // (setTimeout rather than rAF so it also runs in a background tab).
    window.setTimeout(() => {
      try {
        const result = segmentation.rebake(target, basis.value as BakeBasis, Number(detail.value));
        callbacks.notify(
          `${result.numGroups} groups · ${result.assigned.toLocaleString()} of ${target.store.count.toLocaleString()} splats assigned.`,
        );
      } catch (error) {
        callbacks.notify(error instanceof Error ? error.message : 'Segmentation failed.', 'error');
      }
      render();
    }, 30);
  };
  const onOverlay = (): void => segmentation.setOverlay(!segmentation.overlay);
  const onBlend = (): void => segmentation.setBlend(Number(blend.value) / 100);
  const onSplit = (): void => {
    try {
      segmentation.splitSelection();
    } catch (error) {
      callbacks.notify(
        error instanceof Error ? error.message : 'Could not split the selection.',
        'error',
      );
    }
  };
  const onClear = (): void => segmentation.select(undefined);

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
  segmentation.addEventListener('selection-changed', render);
  segmentation.addEventListener('groups-changed', render);
  segmentation.addEventListener('overlay-changed', render);
  rebake.addEventListener('click', onRebake);
  overlay.addEventListener('click', onOverlay);
  blend.addEventListener('input', onBlend);
  split.addEventListener('click', onSplit);
  clear.addEventListener('click', onClear);
  observe();

  return {
    dispose: (): void => {
      viewer.removeEventListener('document-changed', observe);
      observed?.removeEventListener('layers-changed', render);
      observed?.removeEventListener('layer-changed', render);
      observed?.removeEventListener('selection-changed', render);
      segmentation.removeEventListener('selection-changed', render);
      segmentation.removeEventListener('groups-changed', render);
      segmentation.removeEventListener('overlay-changed', render);
      shell.dispose();
    },
  };
}
