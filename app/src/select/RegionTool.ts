import { Vector3 } from 'three';
import type { Layer } from '../model/Layer';
import { ScreenIndex } from '../sketch/screenIndex';
import type { ToastLevel } from '../ui/hud';
import type { Viewer } from '../viewer/Viewer';
import { FrontDepth } from './frontDepth';
import { geodesicFlood, geodesicRefine } from './geodesic';
import { buildNeighbourGraph } from './neighbourGraph';
import { GraphTooLargeError } from './RegionSelection';
import type { RegionSelection } from './RegionSelection';
import type { RegionSettingsStore } from './regionSettings';
import { ScreenMask } from './screenMask';
import type { Point } from './screenMask';

export type RegionToolMode = 'pointer' | 'rectangle' | 'lasso' | 'polygon' | 'brush' | 'wand';

/** Replace the selection, add to it, or cut out of it. */
export type RegionOp = 'replace' | 'add' | 'subtract';

export interface RegionToolCallbacks {
  targetLayer: () => Layer | undefined;
  notify: (message: string, level?: ToastLevel) => void;
}

/** Working set for the snap: everything inside the shape plus this much of a margin. */
const OUTER_BAND_SCALE = 2;
/** How far from the wand click to look for a splat to grow from. */
const WAND_PICK_PX = 24;

/**
 * Free-form region selection over individual splats.
 *
 * A shape drawn on screen is only a guess at where the object is: it says nothing about
 * depth, and no hand traces an outline exactly. So each gesture runs three stages —
 * gather what the shape covers, drop everything that is not on the front surface, then
 * let the boundary settle onto the nearest real edge in the cloud. The wand skips the
 * tracing entirely and grows an object out from one click.
 */
export class RegionTool extends EventTarget {
  private modeValue: RegionToolMode = 'pointer';
  private points: Point[] = [];
  private dragging = false;
  private op: RegionOp = 'replace';
  private brushIndex?: { layer: Layer; index: ScreenIndex; front: FrontDepth; tolerance: number };
  private readonly overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private readonly shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  private readonly cursor = document.createElementNS('http://www.w3.org/2000/svg', 'circle');

  constructor(
    private readonly viewer: Viewer,
    private readonly region: RegionSelection,
    private readonly settings: RegionSettingsStore,
    private readonly callbacks: RegionToolCallbacks,
  ) {
    super();
    this.overlay.classList.add('selection-overlay');
    this.overlay.setAttribute('aria-hidden', 'true');
    this.shape.classList.add('selection-shape');
    this.cursor.classList.add('selection-cursor');
    this.cursor.setAttribute('r', '0');
    this.overlay.append(this.shape, this.cursor);
    document.body.append(this.overlay);
    const canvas = viewer.canvasElement;
    canvas.addEventListener('pointerdown', this.onPointerDown, true);
    canvas.addEventListener('pointermove', this.onPointerMove, true);
    canvas.addEventListener('pointerup', this.onPointerUp, true);
    canvas.addEventListener('dblclick', this.onDoubleClick, true);
    window.addEventListener('keydown', this.onKeyDown);
  }

  get mode(): RegionToolMode {
    return this.modeValue;
  }

  setMode(mode: RegionToolMode): void {
    this.cancel();
    const changed = mode !== this.modeValue;
    this.modeValue = mode;
    this.cursor.setAttribute('r', '0');
    this.viewer.canvasElement.classList.toggle('region-selecting', mode !== 'pointer');
    if (changed) this.dispatchEvent(new Event('mode-changed'));
  }

  /**
   * Every method is one-shot: once a selection lands, the tool hands the pointer back so the
   * next drag orbits the camera instead of starting another shape. Reaching for the tool
   * again is one click; discovering that you cannot look at what you just selected is worse.
   */
  private revert(): void {
    if (this.modeValue !== 'pointer') this.setMode('pointer');
  }

  dispose(): void {
    const canvas = this.viewer.canvasElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown, true);
    canvas.removeEventListener('pointermove', this.onPointerMove, true);
    canvas.removeEventListener('pointerup', this.onPointerUp, true);
    canvas.removeEventListener('dblclick', this.onDoubleClick, true);
    window.removeEventListener('keydown', this.onKeyDown);
    canvas.classList.remove('region-selecting');
    this.overlay.remove();
  }

  // ---- pointer ------------------------------------------------------------------------

  private opFor(event: PointerEvent | MouseEvent): RegionOp {
    if (event.altKey) return 'subtract';
    // The brush is the tool you reach for to *fix* a selection, so it never wipes one.
    if (event.shiftKey || this.modeValue === 'brush') return 'add';
    return 'replace';
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.modeValue === 'pointer' || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.op = this.opFor(event);
    const point = { x: event.clientX, y: event.clientY };
    if (this.modeValue === 'wand') {
      this.runWand(point, this.op);
      return;
    }
    if (this.modeValue === 'polygon') {
      this.points.push(point);
      this.draw();
      return;
    }
    this.points = [point];
    this.dragging = true;
    this.viewer.canvasElement.setPointerCapture(event.pointerId);
    if (this.modeValue === 'brush') {
      this.beginBrush();
      this.paintBrush(point);
    }
    this.draw();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.modeValue === 'pointer') return;
    const point = { x: event.clientX, y: event.clientY };
    if (this.modeValue === 'brush') this.drawCursor(point);
    if (this.modeValue === 'polygon') {
      if (this.points.length) this.draw(point);
      return;
    }
    if (!this.dragging) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.modeValue === 'rectangle') this.points[1] = point;
    else this.points.push(point);
    if (this.modeValue === 'brush') this.paintBrush(point);
    this.draw();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.modeValue === 'pointer' || this.modeValue === 'polygon' || !this.dragging) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.dragging = false;
    if (this.viewer.canvasElement.hasPointerCapture(event.pointerId))
      this.viewer.canvasElement.releasePointerCapture(event.pointerId);
    if (this.modeValue === 'brush') {
      this.brushIndex = undefined;
      this.cancel();
      this.revert();
      return;
    }
    this.finish();
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    if (this.modeValue !== 'polygon') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.finish();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.modeValue === 'pointer') return;
    if (event.key === 'Escape') {
      if (this.points.length) this.cancel();
      else this.region.clear();
    }
    if (event.key === 'Enter' && this.modeValue === 'polygon') this.finish();
  };

  // ---- gestures -----------------------------------------------------------------------

  private finish(): void {
    const points = [...this.points];
    this.cancel();
    if (points.length < 2) return;
    const rect = this.viewer.canvasElement.getBoundingClientRect();
    const local = points.map((point) => ({ x: point.x - rect.left, y: point.y - rect.top }));
    const outline =
      this.modeValue === 'rectangle' ? rectangleOutline(local[0]!, local.at(-1)!) : local;
    const mask = ScreenMask.fromPolygon(outline, rect.width, rect.height);
    this.applyShape(mask, this.op);
    this.revert();
  }

  private beginBrush(): void {
    const prepared = this.prepare();
    if (prepared) this.brushIndex = prepared;
  }

  /** The brush edits the selection as it moves, so it skips the snap and gates on depth only. */
  private paintBrush(point: Point): void {
    const prepared = this.brushIndex;
    if (!prepared) return;
    const rect = this.viewer.canvasElement.getBoundingClientRect();
    const x = point.x - rect.left;
    const y = point.y - rect.top;
    const radius = this.settings.brushRadiusPx;
    const gate = this.settings.depthGate;
    const touched: number[] = [];
    prepared.index.within(x, y, radius, (splat) => {
      if (gate && !prepared.front.accepts(prepared.index, splat, prepared.tolerance)) return;
      touched.push(splat);
    });
    if (touched.length === 0) return;
    const indices = Uint32Array.from(touched);
    if (this.region.layer !== prepared.layer) this.region.replace(prepared.layer, indices);
    else if (this.op === 'subtract') this.region.subtract(indices);
    else this.region.add(indices);
  }

  private runWand(point: Point, op: RegionOp): void {
    const prepared = this.prepare();
    if (!prepared) return;
    const rect = this.viewer.canvasElement.getBoundingClientRect();
    const x = point.x - rect.left;
    const y = point.y - rect.top;
    // Indexing a big layer takes a beat and blocks the thread; say so first, and let the
    // message paint before starting (a timeout, not a frame, so a background tab still runs).
    if (!this.region.hasGraph(prepared.layer)) {
      this.callbacks.notify(`Indexing “${prepared.layer.name}” for the smart tools…`);
      window.setTimeout(() => this.floodFrom(prepared, x, y, op), 30);
      return;
    }
    this.floodFrom(prepared, x, y, op);
  }

  private floodFrom(
    prepared: { layer: Layer; index: ScreenIndex; front: FrontDepth; tolerance: number },
    x: number,
    y: number,
    op: RegionOp,
  ): void {
    const { layer, index, front, tolerance } = prepared;
    let graph;
    try {
      graph = this.region.graph(layer);
    } catch (error) {
      this.reportGraphError(error);
      return;
    }
    // Prefer the nearest splat that has neighbours: a lone floater under the cursor would
    // grow into nothing and read as the tool being broken.
    let seed = -1;
    let fallback = -1;
    let bestPixels = Infinity;
    let bestFallback = Infinity;
    index.within(x, y, WAND_PICK_PX, (splat, normalised) => {
      if (this.settings.depthGate && !front.accepts(index, splat, tolerance)) return;
      const pixels = normalised * WAND_PICK_PX;
      if (pixels < bestFallback) {
        bestFallback = pixels;
        fallback = splat;
      }
      const local = graph.localOf[splat]!;
      if (local < 0 || graph.degree[local] === 0) return;
      if (pixels < bestPixels) {
        bestPixels = pixels;
        seed = splat;
      }
    });
    if (seed < 0) seed = fallback;
    if (seed < 0) {
      this.callbacks.notify('Nothing under the cursor — click on the object.', 'warning');
      return;
    }
    const mask = geodesicFlood(
      graph,
      { colours: layer.store.colors, colourWeight: this.settings.snapStrength },
      graph.localOf[seed]!,
      this.settings.wandTolerance,
    );
    const hits: number[] = [];
    for (let node = 0; node < graph.count; node += 1)
      if (mask[node] === 1) hits.push(graph.nodes[node]!);
    this.commit(layer, Uint32Array.from(hits), op);
    this.revert();
  }

  /**
   * Turns a drawn shape into splats: everything the shape covers, minus whatever is behind
   * the front surface, with the boundary then allowed to settle onto a real edge.
   */
  private applyShape(mask: ScreenMask, op: RegionOp): void {
    if (mask.isEmpty) return;
    const prepared = this.prepare();
    if (!prepared) return;
    const { layer, index, front, tolerance } = prepared;
    const gate = this.settings.depthGate;
    const band = this.settings.bandPx;
    const count = layer.store.count;
    const inside: number[] = [];
    const working: number[] = [];
    for (let splat = 0; splat < count; splat += 1) {
      const x = index.px[splat]!;
      if (Number.isNaN(x)) continue;
      const y = index.py[splat]!;
      const distance = mask.signedDistance(x, y);
      if (distance > band * OUTER_BAND_SCALE) continue;
      if (gate && !front.accepts(index, splat, tolerance)) continue;
      if (distance <= 0) inside.push(splat);
      working.push(splat);
    }
    if (inside.length === 0) {
      this.callbacks.notify(
        gate
          ? 'Nothing on the front surface inside that shape — try turning Depth gate off.'
          : 'Nothing inside that shape.',
        'warning',
      );
      return;
    }
    let chosen: Uint32Array = Uint32Array.from(inside);
    if (this.settings.smartSnap && op !== 'subtract') {
      const snapped = this.snap(layer, mask, index, Uint32Array.from(working), band);
      if (snapped) chosen = snapped;
    }
    this.commit(layer, chosen, op);
  }

  /**
   * Competing fronts across the uncertain band: splats well inside the shape are held as
   * foreground, splats well outside as background, and everything between goes to
   * whichever side it is closer to *through the cloud* — which means across matching
   * colour, not across the gap the outline happened to cut.
   */
  private snap(
    layer: Layer,
    mask: ScreenMask,
    index: ScreenIndex,
    working: Uint32Array,
    band: number,
  ): Uint32Array | undefined {
    const foreground = new Uint8Array(working.length);
    const background = new Uint8Array(working.length);
    let foregroundCount = 0;
    let backgroundCount = 0;
    for (let local = 0; local < working.length; local += 1) {
      const splat = working[local]!;
      const distance = mask.signedDistance(index.px[splat]!, index.py[splat]!);
      if (distance < -band) {
        foreground[local] = 1;
        foregroundCount += 1;
      } else if (distance > band) {
        background[local] = 1;
        backgroundCount += 1;
      }
    }
    // With no confident side to pull from there is nothing to snap to.
    if (foregroundCount === 0 || backgroundCount === 0) return undefined;
    let graph;
    try {
      graph = buildNeighbourGraph(layer.store.centers, layer.store.count, working);
    } catch (error) {
      this.reportGraphError(error);
      return undefined;
    }
    const labels = geodesicRefine(
      graph,
      { colours: layer.store.colors, colourWeight: this.settings.snapStrength },
      foreground,
      background,
    );
    const chosen: number[] = [];
    for (let local = 0; local < graph.count; local += 1)
      if (labels[local] === 1) chosen.push(graph.nodes[local]!);
    return chosen.length > 0 ? Uint32Array.from(chosen) : undefined;
  }

  private commit(layer: Layer, indices: Uint32Array, op: RegionOp): void {
    if (this.region.layer !== layer) this.region.replace(layer, indices);
    else if (op === 'add') this.region.add(indices);
    else if (op === 'subtract') this.region.subtract(indices);
    else this.region.replace(layer, indices);
  }

  private reportGraphError(error: unknown): void {
    if (error instanceof GraphTooLargeError) this.callbacks.notify(error.message, 'warning');
    else {
      console.error(error);
      this.callbacks.notify('That selection could not be worked out.', 'error');
    }
  }

  /** Projects the target layer for this gesture and measures its front surface. */
  private prepare():
    | { layer: Layer; index: ScreenIndex; front: FrontDepth; tolerance: number }
    | undefined {
    const layer = this.callbacks.targetLayer();
    if (!layer) {
      this.callbacks.notify('Select the layer to select splats in.', 'warning');
      return undefined;
    }
    if (layer.store.count === 0) return undefined;
    const rect = this.viewer.canvasElement.getBoundingClientRect();
    const index = new ScreenIndex(layer, this.viewer, rect.width, rect.height);
    const front = new FrontDepth(index, layer.store.count, rect.width, rect.height);
    // Depths are world units but the store's radius is layer-local, so the layer's own
    // scale has to come along or the window is wrong on anything that was resized.
    layer.object.updateMatrixWorld(true);
    const scale = layer.object.getWorldScale(new Vector3());
    const worldRadius =
      layer.store.computeRobustBounds().radius * Math.max(scale.x, scale.y, scale.z);
    const tolerance = worldRadius * 2 * this.settings.depthTolerance + Number.EPSILON;
    return { layer, index, front, tolerance };
  }

  // ---- overlay ------------------------------------------------------------------------

  private cancel(): void {
    this.points = [];
    this.dragging = false;
    this.shape.removeAttribute('d');
    this.shape.removeAttribute('style');
    this.overlay.classList.remove('visible', 'brush');
  }

  private drawCursor(point: Point): void {
    this.cursor.setAttribute('cx', String(point.x));
    this.cursor.setAttribute('cy', String(point.y));
    this.cursor.setAttribute('r', String(this.settings.brushRadiusPx));
  }

  private draw(preview?: Point): void {
    const points = preview ? [...this.points, preview] : this.points;
    if (!points.length) return;
    let path: string;
    if (this.modeValue === 'rectangle' && points.length > 1) {
      const a = points[0]!;
      const b = points.at(-1)!;
      path = `M${a.x} ${a.y}H${b.x}V${b.y}H${a.x}Z`;
    } else {
      path = points.map((point, at) => `${at ? 'L' : 'M'}${point.x} ${point.y}`).join(' ');
      if (this.modeValue === 'lasso' || this.modeValue === 'polygon') path += 'Z';
    }
    this.shape.setAttribute('d', path);
    if (this.modeValue === 'brush')
      this.shape.setAttribute('style', `stroke-width:${this.settings.brushRadiusPx * 2}`);
    this.overlay.classList.add('visible');
    this.overlay.classList.toggle('brush', this.modeValue === 'brush');
  }
}

function rectangleOutline(from: Point, to: Point): Point[] {
  const left = Math.min(from.x, to.x);
  const right = Math.max(from.x, to.x);
  const top = Math.min(from.y, to.y);
  const bottom = Math.max(from.y, to.y);
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}
