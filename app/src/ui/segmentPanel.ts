import type { CropBox, CropMode } from '../select/CropBox';
import type { BakeBasis, Segmentation } from '../select/Segmentation';
import type { GroupMap } from '../splats/groups';
import type { Viewer } from '../viewer/Viewer';

export interface SegmentPanelCallbacks {
  onError: (message: string) => void;
}

/**
 * SEGMENT panel: how the active layer is divided into groups (sidecar or in-app bake),
 * the group overlay, the current group selection with "Split to layer", and the crop box.
 */
export function createSegmentPanel(
  viewer: Viewer,
  segmentation: Segmentation,
  crop: CropBox,
  root: HTMLElement,
  callbacks: SegmentPanelCallbacks,
): { dispose: () => void } {
  root.innerHTML = `
    <div class="layers-header">SEGMENT</div>
    <div class="segment-body">
      <div class="segment-row">
        <label for="segment-basis">By</label>
        <select id="segment-basis">
          <option value="colour">Colour + position</option>
          <option value="position">Position only</option>
        </select>
      </div>
      <div class="segment-row">
        <label for="segment-detail">Detail</label>
        <input type="range" id="segment-detail" min="1" max="5" step="1" value="4" />
      </div>
      <div class="segment-actions">
        <button type="button" id="segment-rebake">Segment</button>
        <button type="button" id="segment-overlay" aria-pressed="false">Show labels</button>
      </div>
      <div class="segment-row">
        <label for="segment-blend">Blend</label>
        <input type="range" id="segment-blend" min="0" max="100" step="5" value="85" />
      </div>
      <p class="segment-status" id="segment-status"></p>
      <div class="segment-actions">
        <button type="button" id="segment-split" class="primary">Split to layer</button>
        <button type="button" id="segment-clear">Clear</button>
      </div>
      <div class="layers-header segment-subhead">CROP</div>
      <div class="segment-actions">
        <button type="button" id="crop-toggle">Show crop box</button>
        <button type="button" id="crop-move" aria-pressed="true">Move</button>
        <button type="button" id="crop-resize" aria-pressed="false">Resize</button>
      </div>
      <div class="segment-actions">
        <button type="button" id="crop-keep">Keep inside</button>
        <button type="button" id="crop-cut">Cut inside</button>
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
  const cropToggle = pick<HTMLButtonElement>('crop-toggle');
  const cropMove = pick<HTMLButtonElement>('crop-move');
  const cropResize = pick<HTMLButtonElement>('crop-resize');
  const cropKeep = pick<HTMLButtonElement>('crop-keep');
  const cropCut = pick<HTMLButtonElement>('crop-cut');

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
    overlay.textContent = segmentation.overlay ? 'Hide labels' : 'Show labels';
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
            : 'Click a group in the scene to select it.';
      status.textContent = `${summarise(groups)}. ${hint}`;
    } else if (target) {
      status.textContent = `“${target.name}” is not segmented. Press Segment, or drop a .groups sidecar.`;
    } else {
      status.textContent = 'Select a layer to segment it.';
    }
    cropToggle.textContent = crop.isActive ? 'Hide crop box' : 'Show crop box';
    cropToggle.setAttribute('aria-pressed', String(crop.isActive));
    for (const [button, mode] of [
      [cropMove, 'translate'],
      [cropResize, 'scale'],
    ] as [HTMLButtonElement, CropMode][]) {
      button.disabled = !crop.isActive;
      button.setAttribute('aria-pressed', String(crop.mode === mode));
    }
    cropKeep.disabled = cropCut.disabled = !crop.isActive;
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
        callbacks.onError(
          `${result.numGroups} groups · ${result.assigned.toLocaleString()} of ${target.store.count.toLocaleString()} splats assigned.`,
        );
      } catch (error) {
        callbacks.onError(error instanceof Error ? error.message : 'Segmentation failed.');
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
      callbacks.onError(error instanceof Error ? error.message : 'Could not split the selection.');
    }
  };
  const onClear = (): void => segmentation.select(undefined);
  const onCropToggle = (): void => (crop.isActive ? crop.cancel() : crop.begin());
  const onCropMove = (): void => crop.setMode('translate');
  const onCropResize = (): void => crop.setMode('scale');
  const runCrop = (keep: 'inside' | 'outside') => (): void => {
    const hidden = crop.apply(keep);
    callbacks.onError(
      hidden ? `${hidden.toLocaleString()} splats hidden (Ctrl+Z to undo).` : 'Nothing to crop.',
    );
  };
  const onKeep = runCrop('inside');
  const onCut = runCrop('outside');

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
  crop.addEventListener('crop-changed', render);
  rebake.addEventListener('click', onRebake);
  overlay.addEventListener('click', onOverlay);
  blend.addEventListener('input', onBlend);
  split.addEventListener('click', onSplit);
  clear.addEventListener('click', onClear);
  cropToggle.addEventListener('click', onCropToggle);
  cropMove.addEventListener('click', onCropMove);
  cropResize.addEventListener('click', onCropResize);
  cropKeep.addEventListener('click', onKeep);
  cropCut.addEventListener('click', onCut);
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
      crop.removeEventListener('crop-changed', render);
    },
  };
}
