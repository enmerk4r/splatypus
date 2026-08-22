import type { GroupOverlay } from '../select/GroupOverlay';
import type { BakeBasis, Segments } from '../select/Segments';
import type { GroupMap } from '../splats/groups';
import type { Viewer } from '../viewer/Viewer';

/**
 * How the scene is divided, and how that division is shown.
 *
 * This sits with the viewport settings rather than with the file, because dividing a
 * scene is something you do to the view of it over and over, not once on the way in.
 * Acting on one segment is the toolbar's job; nothing here touches a single object.
 */
export function createSegmentPanel(
  host: HTMLElement,
  viewer: Viewer,
  segments: Segments,
  overlay: GroupOverlay,
): { dispose: () => void } {
  host.innerHTML = `
    <h2 class="panel-title">Segment</h2>
    <div class="segment-grid">
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
    <button type="button" id="segments-clear" class="segment-clear" hidden>Clear selection</button>
  `;

  const pick = <T extends HTMLElement>(id: string): T => host.querySelector<T>(`#${id}`)!;
  const status = pick<HTMLParagraphElement>('segments-status');
  const clearButton = pick<HTMLButtonElement>('segments-clear');
  const basisSelect = pick<HTMLSelectElement>('segments-basis');
  const sidecarOption = pick<HTMLOptionElement>('segments-basis-sidecar');
  const detailInput = pick<HTMLInputElement>('segments-detail');
  const rebakeButton = pick<HTMLButtonElement>('segments-rebake');
  const overlayButton = pick<HTMLButtonElement>('segments-overlay');
  const blendInput = pick<HTMLInputElement>('segments-blend');

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
    clearButton.hidden = selection === undefined;
    // Reset first: opening a normal scene after a LoD one must re-enable the control.
    rebakeButton.disabled = false;

    if (document && !document.isSegmentable) {
      status.textContent =
        'This scene is rendered with a level-of-detail tree, which renumbers its splats. ' +
        'Segmentation needs file-order splats, so it is unavailable here.';
      rebakeButton.disabled = true;
      return;
    }
    if (!groups) {
      status.textContent = document
        ? 'Not segmented yet. Hit Re-segment, or drop a .groups sidecar onto the scene.'
        : 'Open a splat to segment it.';
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
      return;
    }
    status.textContent = `${selection.info.name} · ${selection.indices.length.toLocaleString()} splats`;
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
