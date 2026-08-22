import { Matrix4, Plane, Raycaster, Vector3 } from 'three';
import { AddLayers } from '../model/commands';
import { Layer } from '../model/Layer';
import { SplatStore } from '../model/SplatStore';
import type { ToastLevel } from '../ui/hud';
import { eventPointer, nearestProjectedPoint, pickLayer } from '../viewer/picking';
import type { Viewer } from '../viewer/Viewer';
import type { SketchOverlay } from '../sketch/SketchOverlay';
import { extrudePolygon } from './solid';

export interface PolylineToolOptions {
  overlay: SketchOverlay;
  /** Popover form with `input[name=height]`, a submit and a cancel button. */
  popover: HTMLFormElement;
  /** Linear RGB of the mesh to create (the SKETCH colour). */
  colour: () => [number, number, number];
  notify: (message: string, level?: ToastLevel) => void;
}

function emptyStore(): SplatStore {
  return new SplatStore({
    count: 0,
    centers: new Float32Array(),
    scales: new Float32Array(),
    rotations: new Float32Array(),
    opacities: new Float32Array(),
    colors: new Float32Array(),
    shDegree: 0,
  });
}

function format(metres: number): string {
  if (metres < 0.01) return `${(metres * 1000).toFixed(0)} mm`;
  if (metres < 1) return `${(metres * 100).toFixed(1)} cm`;
  return `${metres.toFixed(2)} m`;
}

/**
 * Polyline → capped extrusion. Click points on a horizontal construction plane (its height
 * comes from the surface under the first click, or the grid when nothing is hit); segment
 * lengths are shown live; Shift snaps to 45° steps; close with a double-click, Enter, or a
 * click on the first point; then type the extrusion height. The result is a `mesh` layer
 * (one undo step). `P` selects the tool; Esc cancels.
 */
export class PolylineTool {
  private readonly canvas: HTMLCanvasElement;
  /** World-space points of the outline in progress. */
  private points: Vector3[] = [];
  private plane?: Plane;
  private hover?: Vector3;
  private closed = false;
  private lastClick = 0;
  private readonly input: HTMLInputElement;

  constructor(
    private readonly viewer: Viewer,
    private readonly options: PolylineToolOptions,
  ) {
    this.canvas = viewer.canvasElement;
    this.input = options.popover.querySelector<HTMLInputElement>('input[name=height]')!;
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.viewer.addEventListener('tool-changed', this.onToolChanged);
    this.viewer.addEventListener('document-changed', this.reset);
    this.viewer.addEventListener('frame', this.draw);
    window.addEventListener('keydown', this.onKeyDown);
    options.popover.addEventListener('submit', this.onSubmit);
    options.popover.querySelector('button[type=button]')?.addEventListener('click', this.reset);
  }

  get active(): boolean {
    return this.viewer.tool === 'polyline';
  }

  /** Cancels the outline in progress. Returns true if there was one. */
  readonly reset = (): boolean => {
    const had = this.points.length > 0;
    this.points = [];
    this.plane = undefined;
    this.hover = undefined;
    this.closed = false;
    this.options.popover.hidden = true;
    this.options.overlay.setPolyline(undefined);
    return had;
  };

  dispose(): void {
    this.reset();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.viewer.removeEventListener('tool-changed', this.onToolChanged);
    this.viewer.removeEventListener('document-changed', this.reset);
    this.viewer.removeEventListener('frame', this.draw);
    window.removeEventListener('keydown', this.onKeyDown);
    this.options.popover.removeEventListener('submit', this.onSubmit);
  }

  private readonly onToolChanged = (): void => {
    if (!this.active) {
      this.reset();
      this.options.overlay.hideCursor();
    }
  };

  /** World point on the construction plane under the pointer (plane chosen on first click). */
  private planePoint(event: PointerEvent, shift: boolean): Vector3 | undefined {
    const rect = this.canvas.getBoundingClientRect();
    const pointer = eventPointer(event, rect);
    const raycaster = new Raycaster();
    raycaster.setFromCamera(pointer, this.viewer.camera);
    let plane = this.plane;
    if (!plane) {
      // First point: take the height of whatever is under the cursor (any visible layer), else the grid.
      const document = this.viewer.document;
      const hit = document
        ? (pickLayer(document, this.viewer.camera, pointer) ??
          nearestProjectedPoint(document, this.viewer.camera, pointer, rect, 18))
        : undefined;
      plane = new Plane(new Vector3(0, 1, 0), -(hit?.point.y ?? 0));
    }
    const point = raycaster.ray.intersectPlane(plane, new Vector3());
    if (!point) return undefined;
    const previous = this.points.at(-1);
    if (shift && previous) {
      // Snap the segment direction to 45° steps in the plane.
      const dx = point.x - previous.x,
        dz = point.z - previous.z;
      const length = Math.hypot(dx, dz);
      if (length > 1e-9) {
        const angle = Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) * (Math.PI / 4);
        point.set(
          previous.x + Math.cos(angle) * length,
          point.y,
          previous.z + Math.sin(angle) * length,
        );
      }
    }
    this.plane ??= plane;
    return point;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.active || event.button !== 0 || event.altKey) return;
    if (!this.viewer.document) return;
    if (!this.options.popover.hidden || this.closed) return;
    const now = performance.now();
    const doubleClick = now - this.lastClick < 350;
    this.lastClick = now;
    if (doubleClick && this.points.length >= 3) {
      this.close();
      return;
    }
    const point = this.planePoint(event, event.shiftKey);
    if (!point) return;
    // Clicking the first point again closes the outline.
    const first = this.points[0];
    if (first && this.points.length >= 3) {
      const a = this.project(first);
      const rect = this.canvas.getBoundingClientRect();
      if (
        a &&
        Math.hypot(a.x - (event.clientX - rect.left), a.y - (event.clientY - rect.top)) < 10
      ) {
        this.close();
        return;
      }
    }
    this.points.push(point);
    this.hover = point.clone();
    this.draw();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.active) return;
    const rect = this.canvas.getBoundingClientRect();
    this.options.overlay.setCursor(event.clientX - rect.left, event.clientY - rect.top, 0);
    if (this.points.length === 0 || this.closed) return;
    const point = this.planePoint(event, event.shiftKey);
    if (point) this.hover = point;
    this.draw();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.active || this.points.length === 0) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (event.code === 'Enter' && !this.closed && this.points.length >= 3) {
      event.preventDefault();
      this.close();
    } else if (event.code === 'Backspace' && !this.closed) {
      event.preventDefault();
      this.points.pop();
      if (this.points.length === 0) this.reset();
      else this.draw();
    }
  };

  private close(): void {
    this.closed = true;
    this.hover = undefined;
    this.draw();
    this.input.value = this.input.value || '0.3';
    this.options.popover.hidden = false;
    this.positionPopover();
    this.input.focus();
    this.input.select();
  }

  private readonly onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    const document = this.viewer.document;
    if (!document || !this.closed || this.points.length < 3) return;
    const height = Number(this.input.value);
    if (!Number.isFinite(height) || height === 0) {
      this.options.notify('Enter a non-zero height in metres.', 'warning');
      return;
    }
    try {
      // Geometry is authored in world space; store it in root-local space so the new layer
      // sits at identity under the document root (which carries the up-axis flip).
      document.root.updateMatrixWorld(true);
      const toRoot = new Matrix4().copy(document.root.matrixWorld).invert();
      const polygon = new Float32Array(this.points.length * 2);
      this.points.forEach((p, i) => {
        polygon[i * 2] = p.x;
        polygon[i * 2 + 1] = p.z;
      });
      const world = extrudePolygon(polygon, this.points[0]!.y, height);
      // Re-origin the layer on the outline's centroid (base plane) so the gizmo sits on the
      // object and rotation spins it about itself; the root is rotation-only, so local =
      // toRoot(world) − toRoot(pivot).
      const pivot = new Vector3();
      this.points.forEach((p) => pivot.add(p));
      pivot.divideScalar(this.points.length).applyMatrix4(toRoot);
      const n = this.points.length;
      const local = new Float32Array(world.positions.length);
      const v = new Vector3();
      for (let i = 0; i < world.positions.length; i += 3) {
        v.fromArray(world.positions, i).applyMatrix4(toRoot).sub(pivot);
        local[i] = v.x;
        local[i + 1] = v.y;
        local[i + 2] = v.z;
      }
      // Authoring source in layer-local terms: bottom ring (x, z), its y, and the signed height.
      const localPolygon = new Float32Array(n * 2);
      for (let i = 0; i < n; i += 1) {
        localPolygon[i * 2] = local[i * 3]!;
        localPolygon[i * 2 + 1] = local[i * 3 + 2]!;
      }
      const baseY = local[1]!;
      const localHeight = local[n * 3 + 1]! - baseY;
      const count = document.layers.filter((layer) => layer.kind === 'mesh').length + 1;
      const layer = new Layer({
        name: `Mesh ${count}`,
        kind: 'mesh',
        store: emptyStore(),
        sourceName: `mesh-${count}`,
        solid: {
          positions: local,
          indices: world.indices,
          colour: this.options.colour(),
          source: { kind: 'extrude', polygon: localPolygon, baseY, height: localHeight },
        },
      });
      layer.object.position.copy(pivot);
      layer.object.updateMatrix();
      document.history.push(new AddLayers(document, [layer]));
      document.setSelection([layer.id]);
      this.options.notify(
        `${layer.name}: ${this.points.length} sides, ${format(Math.abs(height))} tall.`,
      );
    } catch (error) {
      this.options.notify(
        error instanceof Error ? error.message : 'Could not build the mesh.',
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
    const last = this.points.at(-1);
    const p = last ? this.project(last) : undefined;
    if (!p) return;
    const rect = this.canvas.getBoundingClientRect();
    const popover = this.options.popover;
    popover.style.left = `${rect.left + Math.min(Math.max(p.x - 120, 8), rect.width - 248)}px`;
    popover.style.top = `${rect.top + Math.min(Math.max(p.y + 18, 8), rect.height - 60)}px`;
  }

  /** Re-projects the outline every frame so it tracks the camera. */
  private readonly draw = (): void => {
    if (this.points.length === 0) {
      this.options.overlay.setPolyline(undefined);
      return;
    }
    const pts = this.closed ? this.points : [...this.points, ...(this.hover ? [this.hover] : [])];
    const screen: number[] = [];
    const labels: { x: number; y: number; text: string }[] = [];
    for (let i = 0; i < pts.length; i += 1) {
      const p = this.project(pts[i]!);
      if (!p) continue;
      screen.push(p.x, p.y);
      if (i > 0) {
        const q = this.project(pts[i - 1]!);
        if (q)
          labels.push({
            x: (p.x + q.x) / 2,
            y: (p.y + q.y) / 2,
            text: format(pts[i]!.distanceTo(pts[i - 1]!)),
          });
      }
    }
    if (this.closed && pts.length >= 3) {
      const a = this.project(pts[0]!),
        b = this.project(pts[pts.length - 1]!);
      if (a && b)
        labels.push({
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
          text: format(pts[0]!.distanceTo(pts[pts.length - 1]!)),
        });
    }
    this.options.overlay.setPolyline({ points: screen, closed: this.closed, labels });
    if (!this.options.popover.hidden) this.positionPopover();
  };
}
