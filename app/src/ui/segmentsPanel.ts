import type { GroupOverlay } from '../select/GroupOverlay';
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
  overlay: GroupOverlay,
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
    <div class="segments-view">
      <button type="button" id="segments-overlay" aria-pressed="false">Show labels</button>
      <label for="segments-blend">Blend</label>
      <input type="range" id="segments-blend" min="0" max="100" step="5" value="85" />
    </div>
    <p class="segments-status" id="segments-status">No segmentation loaded.</p>
    <div class="segments-actions" hidden id="segments-actions">
      <button type="button" id="segments-split">Split to layer</button>
      <button type="button" id="segments-clear">Clear</button>
    </div>
    <div class="segments-tools" hidden id="segments-tools">
      <button type="button" id="tool-duplicate" title="Copy this object">Duplicate</button>
      <button type="button" id="tool-array" title="Copy it four more times in a row">
        Array ×5
      </button>
      <button type="button" id="tool-isolate" title="Hide everything else">Isolate</button>
      <button type="button" id="tool-floor" title="Drop it onto the ground plane">
        Snap to floor
      </button>
      <button type="button" id="tool-group" title="Nest the ticked objects under one">
        Group
      </button>
      <button type="button" id="tool-ungroup" title="Dissolve this grouping">Ungroup</button>
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
  const overlayButton = host.querySelector<HTMLButtonElement>('#segments-overlay')!;
  const blendInput = host.querySelector<HTMLInputElement>('#segments-blend')!;
  const tools = host.querySelector<HTMLDivElement>('#segments-tools')!;
  const tool = (name: string): HTMLButtonElement =>
    host.querySelector<HTMLButtonElement>(`#tool-${name}`)!;
  const isolateButton = tool('isolate');

  /** Objects ticked in the outliner, by id — what Group acts on. */
  const ticked = new Set<number>();

  /** The sidecar that came with the scene, kept so the user can go back to it. */
  let sidecar: GroupMap | undefined;

  /** One line about the segmentation as a whole: how many objects, and how much of the
   *  scene they actually cover. The uncovered share is the half users never discover on
   *  their own, so it is named rather than left as the remainder. */
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
      status.textContent = `${summarise(groups)}. ${hint}`;
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

  /** One row per object, nested to show groupings, with the active one marked. */
  const renderLayers = (): void => {
    layerList.replaceChildren();
    const active = segments.activeLayer;
    const rows = (layers: readonly SegmentLayer[], depth: number): void => {
      for (const layer of layers) {
        const item = document.createElement('li');
        item.style.paddingLeft = `${depth * 12}px`;
        if (layer === active) item.classList.add('is-active');

        const tick = document.createElement('input');
        tick.type = 'checkbox';
        tick.title = 'Include in the next Group';
        tick.checked = ticked.has(layer.id);
        tick.addEventListener('change', () => {
          if (tick.checked) ticked.add(layer.id);
          else ticked.delete(layer.id);
          renderTools();
        });

        const select = document.createElement('button');
        select.type = 'button';
        select.className = 'segments-layer-name';
        const size = layer.children.length
          ? `${layer.children.length} objects`
          : layer.splatCount.toLocaleString();
        select.textContent = `${layer.name} · ${size}`;
        select.addEventListener('click', () => segments.activate(layer));
        // Renaming in place; the outliner is where an object gets an identity.
        select.addEventListener('dblclick', () => {
          const name = window.prompt('Rename object', layer.name);
          if (name !== null) segments.rename(layer, name);
        });

        const eye = document.createElement('button');
        eye.type = 'button';
        eye.title = layer.hidden ? 'Show' : 'Hide';
        eye.textContent = layer.hidden ? '○' : '●';
        eye.addEventListener('click', () => segments.setHidden(layer, !layer.hidden));

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.title = 'Take these splats out of the scene';
        remove.textContent = '✕';
        remove.addEventListener('click', () => segments.deleteLayer(layer));

        item.append(tick, select, eye, remove);
        layerList.append(item);
        rows(layer.children, depth + 1);
      }
    };
    rows(segments.segmentLayers, 0);
  };

  const tickedLayers = (): SegmentLayer[] =>
    segments.allLayers().filter((layer) => ticked.has(layer.id));

  const renderTools = (): void => {
    const active = segments.activeLayer;
    tools.hidden = segments.segmentLayers.length === 0;
    for (const name of ['duplicate', 'array', 'isolate', 'floor', 'ungroup']) {
      tool(name).disabled = active === undefined;
    }
    tool('ungroup').disabled = !active || active.children.length === 0;
    tool('group').disabled = tickedLayers().length < 2;
    isolateButton.textContent = segments.isolated ? 'Show all' : 'Isolate';
    isolateButton.setAttribute('aria-pressed', String(segments.isolated !== undefined));
    isolateButton.disabled = active === undefined && segments.isolated === undefined;
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
    renderOverlay();
    renderSelection();
    renderLayers();
    renderTools();
  };
  const onOverlayToggle = (): void => overlay.setEnabled(!overlay.enabled);
  const onBlendInput = (): void => overlay.setBlend(Number(blendInput.value) / 100);
  const onLayersChanged = (): void => {
    renderSelection();
    renderLayers();
    renderTools();
  };
  const onSplit = (): void => {
    segments.splitSelection();
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
      const groups = viewer.document?.groups;
      if (!result || !groups) return;
      status.textContent = summarise(groups);
    });
  };

  const onLayerPicked = (event: Event): void => {
    segments.activate((event as CustomEvent<SegmentLayer>).detail);
  };

  const onDuplicate = (): void => {
    const active = segments.activeLayer;
    if (active) segments.activate(segments.duplicate(active));
  };
  const onArray = (): void => {
    const active = segments.activeLayer;
    if (active) segments.arrayCopies(active, 4);
  };
  const onIsolate = (): void => {
    segments.isolate(segments.isolated ? undefined : segments.activeLayer);
  };
  const onFloor = (): void => {
    const active = segments.activeLayer;
    if (active) segments.snapToFloor(active);
  };
  const onGroup = (): void => {
    const made = segments.groupLayers(tickedLayers());
    if (made) ticked.clear();
  };
  const onUngroup = (): void => {
    const active = segments.activeLayer;
    if (active) segments.ungroup(active);
  };

  overlay.addEventListener('overlay-changed', renderOverlay);
  overlayButton.addEventListener('click', onOverlayToggle);
  blendInput.addEventListener('input', onBlendInput);
  tool('duplicate').addEventListener('click', onDuplicate);
  tool('array').addEventListener('click', onArray);
  tool('isolate').addEventListener('click', onIsolate);
  tool('floor').addEventListener('click', onFloor);
  tool('group').addEventListener('click', onGroup);
  tool('ungroup').addEventListener('click', onUngroup);
  segments.addEventListener('active-changed', onLayersChanged);
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
      overlay.removeEventListener('overlay-changed', renderOverlay);
      overlayButton.removeEventListener('click', onOverlayToggle);
      blendInput.removeEventListener('input', onBlendInput);
      tool('duplicate').removeEventListener('click', onDuplicate);
      tool('array').removeEventListener('click', onArray);
      tool('isolate').removeEventListener('click', onIsolate);
      tool('floor').removeEventListener('click', onFloor);
      tool('group').removeEventListener('click', onGroup);
      tool('ungroup').removeEventListener('click', onUngroup);
      segments.removeEventListener('active-changed', onLayersChanged);
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
