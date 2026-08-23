import type { AiSelectTool } from '../select/AiSelectTool';
import { FRUSTUM_TOLERANCE } from '../select/AiSelectTool';
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
  ai: AiSelectTool,
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
      <hr class="segment-divider" />
      <div class="segment-row segment-ai-head">
        <span>AI select (J)</span>
        <span class="segment-ai-state" id="ai-state"></span>
      </div>
      <div class="segment-row">
        <label for="ai-depth">Depth</label>
        <input type="range" id="ai-depth" min="1" max="100" step="1" value="2" />
      </div>
      <div class="segment-row">
        <label for="ai-grow">Grow</label>
        <input type="range" id="ai-grow" min="0" max="4" step="1" value="1" />
      </div>
      <div class="segment-row">
        <label for="ai-density">Detail</label>
        <input type="range" id="ai-density" min="6" max="28" step="2" value="16" />
      </div>
      <div class="segment-row">
        <label for="ai-name">Name objects</label>
        <input type="checkbox" id="ai-name" checked />
      </div>
      <div class="segment-actions">
        <button type="button" id="ai-all" class="primary">Segment everything</button>
      </div>
      <div class="segment-row" id="ai-candidate-row">
        <label>Mask</label>
        <div class="segment-candidate">
          <button type="button" id="ai-prev" aria-label="Previous mask">&lsaquo;</button>
          <span id="ai-candidate">–</span>
          <button type="button" id="ai-next" aria-label="Next mask">&rsaquo;</button>
        </div>
      </div>
      <p class="segment-status" id="ai-status"></p>
      <div class="segment-actions">
        <button type="button" id="ai-commit" class="primary">Commit selection</button>
        <button type="button" id="ai-reset">Clear clicks</button>
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
  const aiState = pick<HTMLSpanElement>('ai-state');
  const aiDepth = pick<HTMLInputElement>('ai-depth');
  const aiGrow = pick<HTMLInputElement>('ai-grow');
  const aiCandidate = pick<HTMLSpanElement>('ai-candidate');
  const aiPrev = pick<HTMLButtonElement>('ai-prev');
  const aiNext = pick<HTMLButtonElement>('ai-next');
  const aiStatus = pick<HTMLParagraphElement>('ai-status');
  const aiDensity = pick<HTMLInputElement>('ai-density');
  const aiAll = pick<HTMLButtonElement>('ai-all');
  const aiName = pick<HTMLInputElement>('ai-name');
  const aiCommit = pick<HTMLButtonElement>('ai-commit');
  const aiReset = pick<HTMLButtonElement>('ai-reset');

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
    renderAi();
  };

  /** The depth slider is logarithmic: 1 % of the layer radius up to "no occlusion test". */
  const depthFromSlider = (value: number): number =>
    value >= 100 ? FRUSTUM_TOLERANCE : 0.002 * Math.pow(1.05, value);

  const renderAi = (): void => {
    const active = viewer.tool === 'aiselect';
    const state = ai.session.state;
    aiState.textContent =
      state === 'loading'
        ? 'loading model…'
        : state === 'encoding'
          ? 'reading the view…'
          : state === 'error'
            ? 'unavailable'
            : state === 'ready'
              ? `ready (${ai.session.backend === 'webgpu' ? 'WebGPU' : 'CPU — slow'})`
              : 'not loaded';
    aiState.classList.toggle('is-error', state === 'error');

    const count = ai.candidateCount;
    aiCandidate.textContent = count ? `${ai.candidateIndex + 1} / ${count}` : '–';
    aiPrev.disabled = count < 2;
    aiNext.disabled = count < 2;
    aiDepth.disabled = !active;
    aiGrow.disabled = !active;
    aiDensity.disabled = !active;
    aiName.checked = ai.nameObjects;
    aiAll.disabled = ai.busy || !segmentation.targetLayer();
    aiAll.title = segmentation.targetLayer()
      ? `Sample a ${aiDensity.value}×${aiDensity.value} grid of points and turn every object it finds into a group`
      : 'Select a layer first';
    aiCommit.disabled = !ai.hasProposal || ai.busy;
    aiReset.disabled = ai.promptPoints.length === 0;

    const positives = ai.promptPoints.filter((point) => point.positive).length;
    const negatives = ai.promptPoints.length - positives;
    const tolerance = depthFromSlider(Number(aiDepth.value));
    aiStatus.textContent = !active
      ? 'Press J, or pick the tool, to select an object by clicking it.'
      : ai.busy
        ? ai.progress || 'Working…'
        : state === 'error'
          ? (ai.session.error ?? 'The model could not be loaded.')
          : ai.promptPoints.length === 0
            ? 'Click the object. Alt-click to remove a region.'
            : `${positives} positive, ${negatives} negative · ${
                tolerance >= FRUSTUM_TOLERANCE
                  ? 'frustum projection (takes what is behind it too)'
                  : 'depth projection'
              } · Enter to commit`;
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
  const onAiSettings = (): void => {
    ai.setSettings({
      depthTolerance: depthFromSlider(Number(aiDepth.value)),
      growSteps: Number(aiGrow.value),
      density: Number(aiDensity.value),
    });
  };
  const onAiCommit = (): void => {
    try {
      ai.commit();
    } catch (error) {
      callbacks.notify(
        error instanceof Error ? error.message : 'Could not commit the selection.',
        'error',
      );
    }
  };

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
  viewer.addEventListener('tool-changed', renderAi);
  ai.addEventListener('changed', renderAi);
  aiDepth.addEventListener('input', onAiSettings);
  aiDensity.addEventListener('input', onAiSettings);
  aiAll.addEventListener('click', () => void ai.segmentAll());
  aiName.addEventListener('change', () => {
    ai.nameObjects = aiName.checked;
  });
  aiGrow.addEventListener('input', onAiSettings);
  aiPrev.addEventListener('click', () => ai.cycleCandidate(-1));
  aiNext.addEventListener('click', () => ai.cycleCandidate(1));
  aiCommit.addEventListener('click', onAiCommit);
  aiReset.addEventListener('click', () => ai.clearPrompt());
  onAiSettings();
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
      viewer.removeEventListener('tool-changed', renderAi);
      ai.removeEventListener('changed', renderAi);
      shell.dispose();
    },
  };
}
