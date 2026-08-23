import type { Segmentation } from '../select/Segmentation';
import { GraphTooLargeError } from '../select/RegionSelection';
import type { RegionSettingsStore } from '../select/regionSettings';
import type { Viewer } from '../viewer/Viewer';
import { createPanelShell } from './collapse';
import type { ToastLevel } from './hud';

export interface RegionPanelCallbacks {
  notify: (message: string, level?: ToastLevel) => void;
}

/**
 * SELECT panel: how the free-form region tools behave, and what to do with the region
 * once it exists. The tools themselves live in the toolbar's Select popover; this is
 * where a rough selection is turned into a clean one.
 */
export function createRegionPanel(
  viewer: Viewer,
  segmentation: Segmentation,
  settings: RegionSettingsStore,
  root: HTMLElement,
  callbacks: RegionPanelCallbacks,
): { dispose: () => void } {
  const shell = createPanelShell(root, 'SELECT', 'lasso');
  shell.body.innerHTML = `
    <div class="segment-body region-body">
      <label class="sketch-toggle"><input type="checkbox" id="region-depth" /> Depth gate</label>
      <div class="segment-row">
        <label for="region-depth-range">Depth</label>
        <input type="range" id="region-depth-range" min="1" max="60" step="1" value="6" />
      </div>
      <label class="sketch-toggle"><input type="checkbox" id="region-snap" /> Snap to edges</label>
      <div class="segment-row">
        <label for="region-snap-strength">Colour</label>
        <input type="range" id="region-snap-strength" min="0" max="30" step="1" value="8" />
      </div>
      <div class="segment-row">
        <label for="region-band">Band</label>
        <input type="range" id="region-band" min="4" max="120" step="2" value="24" />
      </div>
      <div class="segment-row">
        <label for="region-brush">Brush</label>
        <input type="range" id="region-brush" min="2" max="200" step="1" value="24" />
      </div>
      <div class="segment-row">
        <label for="region-wand">Wand</label>
        <input type="range" id="region-wand" min="10" max="1500" step="10" value="250" />
      </div>
      <p class="segment-status" id="region-status"></p>
      <div class="segment-actions">
        <button type="button" id="region-grow" title="Add a ring of neighbouring splats">Grow</button>
        <button type="button" id="region-shrink" title="Peel the outermost splats off">Shrink</button>
      </div>
      <div class="segment-actions">
        <button type="button" id="region-clean" title="Drop small disconnected pieces">Clean up</button>
        <button type="button" id="region-largest" title="Keep only the biggest connected piece">Keep largest</button>
      </div>
      <div class="segment-actions">
        <button type="button" id="region-split" class="primary">Split to layer</button>
        <button type="button" id="region-clear">Clear</button>
      </div>
    </div>
  `;
  const pick = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  const depth = pick<HTMLInputElement>('region-depth');
  const depthRange = pick<HTMLInputElement>('region-depth-range');
  const snap = pick<HTMLInputElement>('region-snap');
  const snapStrength = pick<HTMLInputElement>('region-snap-strength');
  const band = pick<HTMLInputElement>('region-band');
  const brush = pick<HTMLInputElement>('region-brush');
  const wand = pick<HTMLInputElement>('region-wand');
  const status = pick<HTMLParagraphElement>('region-status');
  const grow = pick<HTMLButtonElement>('region-grow');
  const shrink = pick<HTMLButtonElement>('region-shrink');
  const clean = pick<HTMLButtonElement>('region-clean');
  const largest = pick<HTMLButtonElement>('region-largest');
  const split = pick<HTMLButtonElement>('region-split');
  const clear = pick<HTMLButtonElement>('region-clear');

  const render = (): void => {
    const document = viewer.document;
    // Contextual: the selection settings only matter while the Select tool is active.
    root.hidden = !document || document.layers.length === 0 || viewer.tool !== 'select';
    if (!document) return;
    depth.checked = settings.depthGate;
    depthRange.value = String(Math.round(settings.depthTolerance * 100));
    depthRange.disabled = !settings.depthGate;
    snap.checked = settings.smartSnap;
    snapStrength.value = String(settings.snapStrength);
    snapStrength.disabled = !settings.smartSnap;
    band.value = String(settings.bandPx);
    band.disabled = !settings.smartSnap;
    brush.value = String(settings.brushRadiusPx);
    wand.value = String(settings.wandTolerance);

    const region = segmentation.region;
    const layer = region.layer;
    const has = !region.isEmpty && layer !== undefined;
    const editable = has && !layer.locked;
    grow.disabled = shrink.disabled = clean.disabled = largest.disabled = !has;
    split.disabled = !editable;
    clear.disabled = !has;
    if (has)
      status.textContent = `${region.count.toLocaleString()} splats selected in “${layer.name}”. Shift adds, Alt removes.`;
    else
      status.textContent =
        'Pick a selection method under Select in the toolbar, then draw over the object.';
  };

  /**
   * Graph-backed refinements share two things: indexing the layer the first time blocks
   * for a moment, and the cloud can simply be too big to index at all.
   */
  const refine = (label: string, run: () => number | undefined, deferred = false): void => {
    const region = segmentation.region;
    const layer = region.layer;
    // `run` is what builds the graph, so the retry must go ahead whatever hasGraph says.
    if (!deferred && layer && !region.hasGraph(layer)) {
      callbacks.notify(`Indexing “${layer.name}” for the smart tools…`);
      window.setTimeout(() => refine(label, run, true), 30);
      return;
    }
    try {
      const changed = run();
      render();
      if (changed === 0) callbacks.notify(`${label}: nothing to change.`);
    } catch (error) {
      if (error instanceof GraphTooLargeError) callbacks.notify(error.message, 'warning');
      else {
        console.error(error);
        callbacks.notify(`${label} failed.`, 'error');
      }
    }
  };

  const onDepth = (): void => {
    settings.setDepthGate(depth.checked);
    render();
  };
  const onDepthRange = (): void => settings.setDepthTolerance(Number(depthRange.value) / 100);
  const onSnap = (): void => {
    settings.setSmartSnap(snap.checked);
    render();
  };
  const onSnapStrength = (): void => settings.setSnapStrength(Number(snapStrength.value));
  const onBand = (): void => settings.setBandPx(Number(band.value));
  const onBrush = (): void => settings.setBrushRadiusPx(Number(brush.value));
  const onWand = (): void => settings.setWandTolerance(Number(wand.value));
  const onGrow = (): void =>
    refine('Grow', () => {
      segmentation.region.grow(1);
      return undefined;
    });
  const onShrink = (): void =>
    refine('Shrink', () => {
      segmentation.region.shrink(1);
      return undefined;
    });
  const onClean = (): void =>
    refine('Clean up', () => segmentation.region.removeIslands(settings.minIslandSplats));
  const onLargest = (): void => refine('Keep largest', () => segmentation.region.keepLargest());
  const onSplit = (): void => {
    try {
      const layer = segmentation.splitSelection();
      if (layer) callbacks.notify(`“${layer.name}” split out (⌘Z to undo).`);
    } catch (error) {
      callbacks.notify(
        error instanceof Error ? error.message : 'Could not split the selection.',
        'error',
      );
    }
  };
  const onClear = (): void => segmentation.region.clear();

  let observed = viewer.document;
  const observe = (): void => {
    observed?.removeEventListener('layers-changed', render);
    observed?.removeEventListener('layer-changed', render);
    observed = viewer.document;
    observed?.addEventListener('layers-changed', render);
    observed?.addEventListener('layer-changed', render);
    render();
  };

  viewer.addEventListener('document-changed', observe);
  segmentation.addEventListener('region-changed', render);
  settings.addEventListener('settings-changed', render);
  viewer.addEventListener('tool-changed', render);
  depth.addEventListener('change', onDepth);
  depthRange.addEventListener('input', onDepthRange);
  snap.addEventListener('change', onSnap);
  snapStrength.addEventListener('input', onSnapStrength);
  band.addEventListener('input', onBand);
  brush.addEventListener('input', onBrush);
  wand.addEventListener('input', onWand);
  grow.addEventListener('click', onGrow);
  shrink.addEventListener('click', onShrink);
  clean.addEventListener('click', onClean);
  largest.addEventListener('click', onLargest);
  split.addEventListener('click', onSplit);
  clear.addEventListener('click', onClear);
  observe();

  return {
    dispose: (): void => {
      viewer.removeEventListener('document-changed', observe);
      observed?.removeEventListener('layers-changed', render);
      observed?.removeEventListener('layer-changed', render);
      segmentation.removeEventListener('region-changed', render);
      settings.removeEventListener('settings-changed', render);
      viewer.removeEventListener('tool-changed', render);
      shell.dispose();
    },
  };
}
