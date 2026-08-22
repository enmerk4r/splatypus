import type { BakeBasis, SegmentLayer, Segments } from '../select/Segments';
import type { GroupMap } from '../splats/groups';
import type { Viewer } from '../viewer/Viewer';

/**
 * Panel for the segmentation workflow: what is selected, what has been split into its
 * own layer, and the actions between the two.
 */
export function createSegmentsPanel(
  host: HTMLElement,
  viewer: Viewer,
  segments: Segments,
  onSelectLayer: (layer: SegmentLayer | undefined) => void,
): { dispose: () => void } {
  host.innerHTML = `
    <h2 class="segments-title">Segments</h2>
    <div class="segments-bake">
      <label for="segments-basis">Segment by</label>
      <select id="segments-basis">
        <option value="colour">Colour + position</option>
        <option value="position">Position only</option>
        <option value="sidecar" id="segments-basis-sidecar" hidden>Loaded .groups file</option>
      </select>
      <label for="segments-detail">Detail</label>
      <input type="range" id="segments-detail" min="1" max="5" step="1" value="4" />
      <button type="button" id="segments-rebake">Re-segment</button>
    </div>
    <p class="segments-status" id="segments-status">No segmentation loaded.</p>
    <div class="segments-actions" hidden id="segments-actions">
      <button type="button" id="segments-split">Split to layer</button>
      <button type="button" id="segments-clear">Clear</button>
    </div>
    <ul class="segments-layers" id="segments-layers"></ul>
  `;

  const status = host.querySelector<HTMLParagraphElement>('#segments-status')!;
  const actions = host.querySelector<HTMLDivElement>('#segments-actions')!;
  const splitButton = host.querySelector<HTMLButtonElement>('#segments-split')!;
  const clearButton = host.querySelector<HTMLButtonElement>('#segments-clear')!;
  const layerList = host.querySelector<HTMLUListElement>('#segments-layers')!;
  const basisSelect = host.querySelector<HTMLSelectElement>('#segments-basis')!;
  const sidecarOption = host.querySelector<HTMLOptionElement>('#segments-basis-sidecar')!;
  const detailInput = host.querySelector<HTMLInputElement>('#segments-detail')!;
  const rebakeButton = host.querySelector<HTMLButtonElement>('#segments-rebake')!;

  /** The sidecar that came with the scene, kept so the user can go back to it. */
  let sidecar: GroupMap | undefined;

  const renderSelection = (): void => {
    const document = viewer.document;
    const groups = document?.groups;
    const selection = segments.selection;
    // Reset first: loading a normal scene after a LoD one must re-enable the control.
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
      status.textContent = viewer.document
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
            ? 'That splat is not in any group. Re-bake with a coarser colour cell to cover more of the scene.'
            : 'Click the scene to select one.';
      status.textContent = `${groups.numGroups} groups from “${groups.meta.source}”. ${hint}`;
      actions.hidden = true;
      return;
    }
    status.textContent = `${selection.info.name} · ${selection.indices.length.toLocaleString()} splats`;
    actions.hidden = false;
    // A group already split has no splats left in the scan to split again.
    splitButton.disabled = segments.segmentLayers.some(
      (layer) => layer.groupId === selection.groupId,
    );
  };

  const renderLayers = (): void => {
    layerList.replaceChildren();
    for (const layer of segments.segmentLayers) {
      const item = document.createElement('li');

      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'segments-layer-name';
      select.textContent = `${layer.name} · ${layer.indices.length.toLocaleString()}`;
      select.addEventListener('click', () => onSelectLayer(layer));

      const merge = document.createElement('button');
      merge.type = 'button';
      merge.title = 'Put these splats back into the scan';
      merge.textContent = 'Merge';
      merge.addEventListener('click', () => {
        onSelectLayer(undefined);
        segments.mergeLayer(layer);
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.title = 'Take these splats out of the scene';
      remove.textContent = 'Delete';
      remove.addEventListener('click', () => {
        onSelectLayer(undefined);
        segments.deleteLayer(layer);
      });

      item.append(select, merge, remove);
      layerList.append(item);
    }
  };

  const syncSidecarOption = (): void => {
    const groups = viewer.document?.groups;
    // The first segmentation a scene arrives with is its sidecar; remember it so a
    // re-bake is not a one-way door.
    if (groups && !sidecar && groups.meta.source === 'connectivity') sidecar = groups;
    sidecarOption.hidden = sidecar === undefined;
    detailInput.disabled = basisSelect.value === 'sidecar';
    rebakeButton.textContent = basisSelect.value === 'sidecar' ? 'Restore' : 'Re-segment';
  };

  const onSelectionChanged = (): void => {
    syncSidecarOption();
    renderSelection();
    renderLayers();
  };
  const onLayersChanged = (): void => {
    renderSelection();
    renderLayers();
  };
  const onSplit = (): void => {
    const layer = segments.splitSelection();
    if (layer) onSelectLayer(layer);
  };
  const onClear = (): void => segments.select(undefined);

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
      if (!result) return;
      const total = viewer.document?.numSplats ?? 1;
      status.textContent =
        `${result.numGroups} groups · ` +
        `${Math.round((result.assigned / total) * 100)}% of splats covered`;
    });
  };

  const onLayerPicked = (event: Event): void => {
    onSelectLayer((event as CustomEvent<SegmentLayer>).detail);
  };

  segments.addEventListener('layer-picked', onLayerPicked);
  segments.addEventListener('selection-changed', onSelectionChanged);
  segments.addEventListener('layers-changed', onLayersChanged);
  viewer.addEventListener('document-changed', onSelectionChanged);
  splitButton.addEventListener('click', onSplit);
  clearButton.addEventListener('click', onClear);
  rebakeButton.addEventListener('click', onRebake);
  basisSelect.addEventListener('change', syncSidecarOption);
  onSelectionChanged();

  return {
    dispose: (): void => {
      segments.removeEventListener('layer-picked', onLayerPicked);
      segments.removeEventListener('selection-changed', onSelectionChanged);
      segments.removeEventListener('layers-changed', onLayersChanged);
      viewer.removeEventListener('document-changed', onSelectionChanged);
      splitButton.removeEventListener('click', onSplit);
      clearButton.removeEventListener('click', onClear);
      rebakeButton.removeEventListener('click', onRebake);
      basisSelect.removeEventListener('change', syncSidecarOption);
    },
  };
}
