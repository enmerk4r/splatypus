import { Matrix4, Vector3 } from 'three';
import type { Document } from '../model/Document';
import type { Layer } from '../model/Layer';
import { SetLayerTransform } from '../model/commands';
import type { ToastLevel } from '../ui/hud';
import { eventPointer, nearestProjectedPoint, pickLayer } from '../viewer/picking';
import type { Viewer } from '../viewer/Viewer';
import type { SketchOverlay } from './SketchOverlay';

export interface MeasureToolOptions {
  overlay: SketchOverlay;
  /** Popover form with `input[name=distance]`, a submit and a cancel button. */
  popover: HTMLFormElement;
  notify: (message: string, level?: ToastLevel) => void;
}

/**
 * Layer matrix (parent-local) after a uniform scale by `factor` about a world point.
 * The parent (document root) is rotation-only, so the pivot is taken into its space.
 */
export function scaleAboutWorldPoint(layer: Layer, pivotWorld: Vector3, factor: number): Matrix4 {
  const parent = layer.object.parent;
  const pivot = pivotWorld.clone();
  if (parent) {
    parent.updateMatrixWorld(true);
    pivot.applyMatrix4(new Matrix4().copy(parent.matrixWorld).invert());
  }
  layer.object.updateMatrix();
  return new Matrix4()
    .makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new Matrix4().makeScale(factor, factor, factor))
    .multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z))
    .multiply(layer.object.matrix);
}

function format(metres: number): string {
  if (metres < 0.01) return `${(metres * 1000).toFixed(1)} mm`;
  if (metres < 1) return `${(metres * 100).toFixed(1)} cm`;
  return `${metres.toFixed(3)} m`;
}

/**
 * Measure / scale-to-reference: click two points on the active layer, read the distance,
 * type the real one, and the layer is scaled uniformly about the first point so the two
 * points are that far apart (one undoable transform). `M` selects the tool; Esc resets.
 */
export class MeasureTool {
  private readonly canvas: HTMLCanvasElement;
  private layer?: Layer;
  private a?: Vector3;
  private b?: Vector3;
  private hover?: Vector3;
  /** The splat under the pointer right now — what a click would pick; drawn as a snap marker. */
  private snap?: Vector3;
  private readonly input: HTMLInputElement;

  constructor(
    private readonly viewer: Viewer,
    private readonly options: MeasureToolOptions,
  ) {
    this.canvas = viewer.canvasElement;
    this.input = options.popover.querySelector<HTMLInputElement>('input[name=distance]')!;
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.viewer.addEventListener('tool-changed', this.onToolChanged);
    this.viewer.addEventListener('document-changed', this.reset);
    this.viewer.addEventListener('frame', this.draw);
    options.popover.addEventListener('submit', this.onSubmit);
    options.popover.querySelector('button[type=button]')?.addEventListener('click', this.reset);
  }

  get active(): boolean {
    return this.viewer.tool === 'measure';
  }

  /** Clears the points and hides the popover. Returns true if there was anything to clear. */
  readonly reset = (): boolean => {
    const had = Boolean(this.a);
    this.a = this.b = this.hover = this.snap = undefined;
    this.layer = undefined;
    this.options.popover.hidden = true;
    this.options.overlay.setMeasure(undefined);
    this.options.overlay.setSnap(undefined);
    return had;
  };

  dispose(): void {
    this.reset();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.viewer.removeEventListener('tool-changed', this.onToolChanged);
    this.viewer.removeEventListener('document-changed', this.reset);
    this.viewer.removeEventListener('frame', this.draw);
    this.options.popover.removeEventListener('submit', this.onSubmit);
  }

  private readonly onToolChanged = (): void => {
    if (!this.active) {
      this.reset();
      this.options.overlay.hideCursor();
      this.options.overlay.setSnap(undefined);
    }
  };

  /** The layer a click would measure, without the warning `target` raises (used on hover). */
  private candidate(document: Document): Layer | undefined {
    const layer =
      this.layer ??
      document.active() ??
      (document.layers.length === 1 ? document.layers[0] : undefined);
    return layer && !layer.locked ? layer : undefined;
  }

  private target(document: Document): Layer | undefined {
    const layer =
      document.active() ?? (document.layers.length === 1 ? document.layers[0] : undefined);
    if (!layer) {
      this.options.notify(
        'Select the layer to measure (the tool scales the active layer).',
        'warning',
      );
      return undefined;
    }
    if (layer.locked) {
      this.options.notify(`“${layer.name}” is locked.`, 'warning');
      return undefined;
    }
    return layer;
  }

  private pick(event: PointerEvent, layer: Layer): Vector3 | undefined {
    const document = this.viewer.document;
    if (!document) return undefined;
    const rect = this.canvas.getBoundingClientRect();
    const pointer = eventPointer(event, rect);
    const only = (candidate: Layer): boolean => candidate === layer;
    const hit =
      pickLayer(document, this.viewer.camera, pointer, only) ??
      nearestProjectedPoint(document, this.viewer.camera, pointer, rect, 18, only);
    return hit?.point.clone();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.active || event.button !== 0 || event.altKey) return;
    const document = this.viewer.document;
    if (!document) return;
    if (!this.options.popover.hidden) return; // waiting for the dimension
    const layer = this.layer ?? this.target(document);
    if (!layer) return;
    const point = this.pick(event, layer);
    if (!point) {
      this.options.notify('Nothing on the active layer under the cursor.', 'warning');
      return;
    }
    if (!this.a) {
      this.layer = layer;
      this.a = point;
      this.hover = point.clone();
      this.draw();
      return;
    }
    this.b = point;
    const measured = this.a.distanceTo(this.b);
    if (measured <= 1e-9) {
      this.options.notify('Pick two different points.', 'warning');
      this.b = undefined;
      return;
    }
    this.draw();
    this.input.value = measured.toFixed(3);
    this.options.popover.hidden = false;
    this.positionPopover();
    this.input.focus();
    this.input.select();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.active) return;
    const rect = this.canvas.getBoundingClientRect();
    this.options.overlay.setCursor(event.clientX - rect.left, event.clientY - rect.top, 0);
    const document = this.viewer.document;
    if (!document || this.b) return;
    const layer = this.candidate(document);
    if (!layer) return;
    // Follow the surface under the pointer so the live readout measures real geometry, and
    // mark the splat that would be picked so "is it snapping?" never has to be guessed.
    const point = this.pick(event, layer);
    this.snap = point;
    if (point && this.a) this.hover = point;
    this.draw();
  };

  private readonly onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    const document = this.viewer.document;
    const layer = this.layer;
    if (!document || !layer || !this.a || !this.b) return;
    const measured = this.a.distanceTo(this.b);
    const target = Number(this.input.value);
    if (!Number.isFinite(target) || target <= 0) {
      this.options.notify('Enter the real distance in metres.', 'warning');
      return;
    }
    const factor = target / measured;
    layer.object.updateMatrix();
    const before = layer.object.matrix.clone();
    const after = scaleAboutWorldPoint(layer, this.a, factor);
    try {
      document.history.push(new SetLayerTransform(document, layer.id, before, after));
      this.options.notify(
        `Scaled “${layer.name}” ×${factor.toFixed(4)} (${format(measured)} → ${format(target)}).`,
      );
    } catch (error) {
      this.options.notify(
        error instanceof Error ? error.message : 'Could not scale the layer.',
        'error',
      );
    }
    this.reset();
  };

  private project(point: Vector3): { x: number; y: number } | undefined {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = point.clone().project(this.viewer.camera);
    if (ndc.z > 1) return undefined;
    return { x: ((ndc.x + 1) / 2) * rect.width, y: ((1 - ndc.y) / 2) * rect.height };
  }

  private positionPopover(): void {
    if (!this.a || !this.b) return;
    const a = this.project(this.a);
    const b = this.project(this.b);
    if (!a || !b) return;
    const rect = this.canvas.getBoundingClientRect();
    const popover = this.options.popover;
    const x = Math.min(Math.max((a.x + b.x) / 2 - 120, 8), rect.width - 248);
    const y = Math.min(Math.max((a.y + b.y) / 2 + 18, 8), rect.height - 60);
    popover.style.left = `${rect.left + x}px`;
    popover.style.top = `${rect.top + y}px`;
  }

  /** Re-projects the measurement and snap marker every frame so they track the camera. */
  private readonly draw = (): void => {
    const snap = this.snap && !this.b ? this.project(this.snap) : undefined;
    this.options.overlay.setSnap(snap);
    if (!this.a) return;
    const end = this.b ?? this.hover;
    const a = this.project(this.a);
    const b = end ? this.project(end) : undefined;
    if (!a || !b || !end) {
      this.options.overlay.setMeasure(undefined);
      return;
    }
    this.options.overlay.setMeasure({
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      label: format(this.a.distanceTo(end)),
      fixed: Boolean(this.b),
    });
    if (this.b && !this.options.popover.hidden) this.positionPopover();
  };
}
