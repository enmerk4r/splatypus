import type { GroupOverlay } from '../select/GroupOverlay';
import type { BakeBasis, Segments } from '../select/Segments';
import type { GroupMap } from '../splats/groups';
import type { Viewer } from '../viewer/Viewer';

export interface LibraryCallbacks {
  onOpenFile: () => void;
  onExport: () => void;
}

/**
 * The left window: what scene is loaded, how it is divided, and how to get it back out.
 *
 * Everything here acts on the scene as a whole. Anything acting on one object lives in
 * the inspector or the toolbar, so that the two never have to be told apart by reading.
 */
export function createLibraryPanel(
  host: HTMLElement,
  viewer: Viewer,
  segments: Segments,
  overlay: GroupOverlay,
  callbacks: LibraryCallbacks,
): { dispose: () => void } {
  host.innerHTML = `
    <h2 class="panel-title">Scene</h2>
    <div class="library-file">
      <button type="button" id="library-open">Open file…</button>
      <button type="button" id="library-export">Export .ply</button>
    </div>
    <p class="panel-hint" id="library-file-name">No scene</p>

    <h2 class="panel-title">Segment</h2>
    <div class="library-bake">
      <label for="segments-basis">Segment by</label>
      <select id="segments-basis">
        <option value="colour">Colour + position</option>
        <option value="position">Position only</option>
        <option value="sidecar" id="segments-basis-sidecar" hidden>Loaded .groups file</option>
      </select>
      <label for="segments-detail">Detail</label>
      <input type="range" id="segments-detail" min="1" max="5" step="1" value="4" />
      <button type="button" id="segments-rebake">Re-segment</button>
      <button type="button" id="segments-overlay" aria-pressed="false">Show labels</button>
      <label for="segments-blend">Blend</label>
      <input type="range" id="segments-blend" min="0" max="100" step="5" value="85" />
    </div>
    <p class="panel-status" id="segments-status">Open a splat to segment it.</p>
    <div class="library-actions" hidden id="segments-actions">
      <button type="button" id="segments-split">Split to object</button>
      <button type="button" id="segments-clear">Clear</button>
    </div>
  `;

  const pick = <T extends HTMLElement>(id: string): T => host.querySelector<T>(`#${id}`)!;
  const status = pick<HTMLParagraphElement>('segments-status');
  const fileName = pick<HTMLParagraphElement>('library-file-name');
  const actions = pick<HTMLDivElement>('segments-actions');
  const splitButton = pick<HTMLButtonElement>('segments-split');
  const clearButton = pick<HTMLButtonElement>('segments-clear');
  const basisSelect = pick<HTMLSelectElement>('segments-basis');
  const sidecarOption = pick<HTMLOptionElement>('segments-basis-sidecar');
  const detailInput = pick<HTMLInputElement>('segments-detail');
  const rebakeButton = pick<HTMLButtonElement>('segments-rebake');
  const overlayButton = pick<HTMLButtonElement>('segments-overlay');
  const blendInput = pick<HTMLInputElement>('segments-blend');
  const exportButton = pick<HTMLButtonElement>('library-export');

  /** The sidecar the scene arrived with, kept so a re-bake is not a one-way door. */
  let sidecar: GroupMap | undefined;

  /** How many objects, and how much of the scene they cover. The uncovered share is the
   *  half users never discover on their own, so it is named rather than left implied. */
  const summarise = (groups: GroupMap): string => {
    const covered = Math.round(groups.coverage * 100);
    return `${groups.numGroups} groups · ${covered}% covered · ${100 - covered}% unsegmented`;
  };

  const renderOverlay = (): void => {
    const on = overlay.enabled;
    overlayButton.textContent = on ? 'Hide labels' : 'Show labels';
    overlayButton.setAttribute('aria-pressed', String(on));
    overlayButton.disabled = !overlay.available;
    blendInput.disabled = !on;
    blendInput.value = String(Math.round(overlay.blend * 100));
  };

  const render = (): void => {
    const document = viewer.document;
    const groups = document?.groups;
    const selection = segments.selection;
    fileName.textContent = document ? document.name : 'No scene';
    exportButton.disabled = document === undefined;
    // Reset first: opening a normal scene after a LoD one must re-enable the control.
    rebakeButton.disabled = false;

    if (document && !document.isSegmentable) {
      status.textContent =
        'This scene is rendered with a level-of-detail tree, which renumbers its splats. ' +
        'Segmentation needs file-order splats, so it is unavailable here.';
      actions.hidden = true;
      rebakeButton.disabled = true;
      return;
    }
    if (!groups) {
      status.textContent = document
        ? 'Not segmented yet. Hit Re-segment, or drop a .groups sidecar onto the scene.'
        : 'Open a splat to segment it.';
      actions.hidden = true;
      return;
    }
    if (!selection) {
      const hint =
        segments.outcome === 'missed'
          ? 'Nothing under the cursor — try clicking closer to a surface.'
          : segments.outcome === 'unassigned'
            ? 'That splat is in no group. Re-bake with a coarser colour cell to cover more.'
            : 'Click the scene to select one.';
      status.textContent = `${summarise(groups)}. ${hint}`;
      actions.hidden = true;
      return;
    }
    status.textContent = `${selection.info.name} · ${selection.indices.length.toLocaleString()} splats`;
    actions.hidden = false;
    // A group already split has no splats left in the scan to split again.
    splitButton.disabled = segments.allLayers().some((l) => l.groupId === selection.groupId);
  };

  const syncSidecarOption = (): void => {
    const groups = viewer.document?.groups;
    if (groups && !sidecar && groups.meta.source === 'connectivity') sidecar = groups;
    sidecarOption.hidden = sidecar === undefined;
    detailInput.disabled = basisSelect.value === 'sidecar';
    rebakeButton.textContent = basisSelect.value === 'sidecar' ? 'Restore' : 'Re-segment';
  };

  const onChanged = (): void => {
    syncSidecarOption();
    renderOverlay();
    render();
  };
  const onSplit = (): void => void segments.splitSelection();
  const onClear = (): void => segments.select(undefined);
  const onOverlayToggle = (): void => overlay.setEnabled(!overlay.enabled);
  const onBlend = (): void => overlay.setBlend(Number(blendInput.value) / 100);

  const onRebake = (): void => {
    if (!viewer.document) return;
    if (basisSelect.value === 'sidecar') {
      if (sidecar) segments.applyGroups(sidecar);
      return;
    }
    // The bake runs on the main thread and takes seconds on a large scene, so paint the
    // pending state before starting rather than freezing on the old text.
    status.textContent = 'Segmenting…';
    rebakeButton.disabled = true;
    requestAnimationFrame(() => {
      const result = segments.rebake(basisSelect.value as BakeBasis, Number(detailInput.value));
      rebakeButton.disabled = false;
      const groups = viewer.document?.groups;
      if (result && groups) status.textContent = summarise(groups);
    });
  };

  overlay.addEventListener('overlay-changed', renderOverlay);
  segments.addEventListener('selection-changed', onChanged);
  segments.addEventListener('layers-changed', render);
  viewer.addEventListener('document-changed', onChanged);
  pick<HTMLButtonElement>('library-open').addEventListener('click', callbacks.onOpenFile);
  exportButton.addEventListener('click', callbacks.onExport);
  splitButton.addEventListener('click', onSplit);
  clearButton.addEventListener('click', onClear);
  rebakeButton.addEventListener('click', onRebake);
  basisSelect.addEventListener('change', syncSidecarOption);
  overlayButton.addEventListener('click', onOverlayToggle);
  blendInput.addEventListener('input', onBlend);
  onChanged();

  return {
    dispose: (): void => {
      overlay.removeEventListener('overlay-changed', renderOverlay);
      segments.removeEventListener('selection-changed', onChanged);
      segments.removeEventListener('layers-changed', render);
      viewer.removeEventListener('document-changed', onChanged);
    },
  };
}
