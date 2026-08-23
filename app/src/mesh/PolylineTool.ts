import { Matrix4, Plane, Quaternion, Raycaster, Vector3 } from 'three';
import { AddLayers } from '../model/commands';
import { Layer } from '../model/Layer';
import { SplatStore } from '../model/SplatStore';
import type { ToastLevel } from '../ui/hud';
import { eventPointer, nearestProjectedPoint, pickLayer } from '../viewer/picking';
import type { Viewer } from '../viewer/Viewer';
import type { SketchOverlay } from '../sketch/SketchOverlay';
import type { ModelSettingsStore } from './settings';
import { makeFace } from './solid';

export interface PolylineToolOptions {
  overlay: SketchOverlay;
  settings: ModelSettingsStore;
  /** Linear RGB of the face to create (the SKETCH colour). */
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
 * Draws a closed outline on a horizontal construction plane (its height from the surface
 * under the first click, else the grid) and turns it into a translucent **face** layer —
 * rotate it with the gizmo, then extrude it along its normal with the arrow or the MODEL
 * panel. Shapes: freeform polyline (Enter / double-click / first point closes; Backspace
 * removes a point), rectangle (two corners), regular polygon and circle (centre + radius).
 * Ortho mode (or holding Shift) keeps polyline segments axis-aligned. `P` selects the tool.
 */
export class PolylineTool {
  private readonly canvas: HTMLCanvasElement;
  private points: Vector3[] = [];
  private plane?: Plane;
  private hover?: Vector3;
  private lastClick = 0;
  private shiftHeld = false;

  constructor(
    private readonly viewer: Viewer,
    private readonly options: PolylineToolOptions,
  ) {
    this.canvas = viewer.canvasElement;
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.viewer.addEventListener('tool-changed', this.onToolChanged);
    this.viewer.addEventListener('document-changed', this.reset);
    this.viewer.addEventListener('frame', this.draw);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  get active(): boolean {
    return this.viewer.tool === 'polyline';
  }

  /** Ortho drawing: the setting, temporarily inverted while Shift is held. */
  get ortho(): boolean {
    return this.options.settings.ortho !== this.shiftHeld;
  }

  /** Cancels the outline in progress. Returns true if there was one. */
  readonly reset = (): boolean => {
    const had = this.points.length > 0;
    this.points = [];
    this.plane = undefined;
    this.hover = undefined;
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
    window.removeEventListener('keyup', this.onKeyUp);
  }

  private readonly onToolChanged = (): void => {
    if (!this.active) {
      this.reset();
      this.options.overlay.hideCursor();
    }
  };

  /** World point on the construction plane under the pointer (plane chosen on first click). */
  private planePoint(event: PointerEvent): Vector3 | undefined {
    const rect = this.canvas.getBoundingClientRect();
    const pointer = eventPointer(event, rect);
    const raycaster = new Raycaster();
    raycaster.setFromCamera(pointer, this.viewer.camera);
    let plane = this.plane;
    if (!plane) {
      // First point: the height of whatever is under the cursor (any visible layer), else the grid.
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
    if (this.ortho && previous && this.options.settings.shape === 'polyline') {
      // Axis-aligned segments: keep the larger of the two in-plane deltas.
      const dx = point.x - previous.x,
        dz = point.z - previous.z;
      if (Math.abs(dx) >= Math.abs(dz)) point.z = previous.z;
      else point.x = previous.x;
    }
    this.plane ??= plane;
    return point;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.active || event.button !== 0 || event.altKey) return;
    if (!this.viewer.document) return;
    const now = performance.now();
    const doubleClick = now - this.lastClick < 350;
    this.lastClick = now;
    const shape = this.options.settings.shape;
    if (shape === 'polyline' && doubleClick && this.points.length >= 3) {
      this.finishPolyline();
      return;
    }
    const point = this.planePoint(event);
    if (!point) return;
    if (shape === 'polyline') {
      const first = this.points[0];
      if (first && this.points.length >= 3) {
        const a = this.project(first);
        const rect = this.canvas.getBoundingClientRect();
        if (
          a &&
          Math.hypot(a.x - (event.clientX - rect.left), a.y - (event.clientY - rect.top)) < 10
        ) {
          this.finishPolyline();
          return;
        }
      }
      this.points.push(point);
      this.hover = point.clone();
      this.draw();
      return;
    }
    // Two-click shapes: anchor, then the defining point.
    if (this.points.length === 0) {
      this.points.push(point);
      this.hover = point.clone();
      this.draw();
      return;
    }
    const outline = this.shapeOutline(this.points[0]!, point);
    if (outline.length < 3) {
      this.options.notify('Drag further to give the shape a size.', 'warning');
      return;
    }
    this.createFace(outline);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.active) return;
    const rect = this.canvas.getBoundingClientRect();
    this.options.overlay.setCursor(event.clientX - rect.left, event.clientY - rect.top, 0);
    if (this.points.length === 0) return;
    const point = this.planePoint(event);
    if (point) this.hover = point;
    this.draw();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Shift' && !this.shiftHeld) {
      this.shiftHeld = true;
      this.draw();
    }
    if (!this.active || this.points.length === 0) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (
      event.code === 'Enter' &&
      this.options.settings.shape === 'polyline' &&
      this.points.length >= 3
    ) {
      event.preventDefault();
      this.finishPolyline();
    } else if (event.code === 'Backspace') {
      event.preventDefault();
      this.points.pop();
      if (this.points.length === 0) this.reset();
      else this.draw();
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === 'Shift') {
      this.shiftHeld = false;
      this.draw();
    }
  };

  /** Outline (world points) of the two-click shapes from anchor a to pointer b. */
  private shapeOutline(a: Vector3, b: Vector3): Vector3[] {
    const shape = this.options.settings.shape;
    const y = a.y;
    if (shape === 'rectangle') {
      if (Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.z - b.z) < 1e-6) return [];
      return [
        new Vector3(a.x, y, a.z),
        new Vector3(b.x, y, a.z),
        new Vector3(b.x, y, b.z),
        new Vector3(a.x, y, b.z),
      ];
    }
    const radius = Math.hypot(b.x - a.x, b.z - a.z);
    if (radius < 1e-6) return [];
    const sides = shape === 'circle' ? 64 : this.options.settings.sides;
    const start = Math.atan2(b.z - a.z, b.x - a.x);
    return Array.from({ length: sides }, (_, i) => {
      const angle = start + (i / sides) * Math.PI * 2;
      return new Vector3(a.x + Math.cos(angle) * radius, y, a.z + Math.sin(angle) * radius);
    });
  }

  private finishPolyline(): void {
    if (this.points.length < 3) return;
    this.createFace(this.points);
  }

  /** Turns a world-space outline into a translucent face layer re-originned on its centroid. */
  private createFace(outlineWorld: Vector3[]): void {
    const document = this.viewer.document;
    if (!document) return;
    try {
      document.root.updateMatrixWorld(true);
      const toRoot = new Matrix4().copy(document.root.matrixWorld).invert();
      const rootRotation = new Quaternion();
      document.root.getWorldQuaternion(rootRotation);
      const pivot = new Vector3();
      outlineWorld.forEach((p) => pivot.add(p));
      pivot.divideScalar(outlineWorld.length).applyMatrix4(toRoot);
      const polygon = new Float32Array(outlineWorld.length * 3);
      const v = new Vector3();
      outlineWorld.forEach((p, i) => {
        v.copy(p).applyMatrix4(toRoot).sub(pivot);
        polygon[i * 3] = v.x;
        polygon[i * 3 + 1] = v.y;
        polygon[i * 3 + 2] = v.z;
      });
      // The construction plane is horizontal (world +Y); express its normal in root space.
      const normal = new Vector3(0, 1, 0)
        .applyQuaternion(rootRotation.clone().invert())
        .normalize();
      const face = {
        polygon,
        normal: [normal.x, normal.y, normal.z] as [number, number, number],
      };
      const count = document.layers.filter((layer) => layer.kind === 'mesh').length + 1;
      const layer = new Layer({
        name: `Mesh ${count}`,
        kind: 'mesh',
        store: emptyStore(),
        sourceName: `mesh-${count}`,
        solid: { ...makeFace(face), colour: this.options.colour() },
      });
      layer.object.position.copy(pivot);
      layer.object.updateMatrix();
      document.history.push(new AddLayers(document, [layer]));
      document.setSelection([layer.id]);
      this.viewer.setTool('select');
      this.options.notify(
        `${layer.name}: face with ${outlineWorld.length} points. Drag the arrow (or set a height in MODEL) to extrude; rotate it first to extrude sideways.`,
      );
    } catch (error) {
      this.options.notify(
        error instanceof Error ? error.message : 'Could not build the face.',
        'error',
      );
    }
    this.reset();
  }

  private project(point: Vector3): { x: number; y: number } | undefined {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = point.clone().project(this.viewer.camera);
    if (ndc.z > 1) return undefined;
    return { x: ((ndc.x + 1) / 2) * rect.width, y: ((1 - ndc.y) / 2) * rect.height };
  }

  /** Re-projects the outline every frame so it tracks the camera. */
  private readonly draw = (): void => {
    if (this.points.length === 0) {
      this.options.overlay.setPolyline(undefined);
      return;
    }
    const shape = this.options.settings.shape;
    let pts: Vector3[];
    let closed = false;
    if (shape === 'polyline') {
      pts = [...this.points, ...(this.hover ? [this.hover] : [])];
    } else {
      const outline = this.hover ? this.shapeOutline(this.points[0]!, this.hover) : [];
      pts = outline.length >= 3 ? outline : this.points;
      closed = outline.length >= 3;
    }
    const screen: number[] = [];
    const labels: { x: number; y: number; text: string }[] = [];
    const labelled = pts.length <= 12; // no per-segment labels on circles
    for (let i = 0; i < pts.length; i += 1) {
      const p = this.project(pts[i]!);
      if (!p) continue;
      screen.push(p.x, p.y);
      if (i > 0 && labelled) {
        const q = this.project(pts[i - 1]!);
        if (q)
          labels.push({
            x: (p.x + q.x) / 2,
            y: (p.y + q.y) / 2,
            text: format(pts[i]!.distanceTo(pts[i - 1]!)),
          });
      }
    }
    if (closed && labelled && pts.length >= 3) {
      const a = this.project(pts[0]!),
        b = this.project(pts[pts.length - 1]!);
      if (a && b)
        labels.push({
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
          text: format(pts[0]!.distanceTo(pts[pts.length - 1]!)),
        });
    }
    if (shape === 'circle' || shape === 'polygon') {
      const centre = this.project(this.points[0]!);
      const r = this.hover
        ? Math.hypot(this.hover.x - this.points[0]!.x, this.hover.z - this.points[0]!.z)
        : 0;
      if (centre && r > 0) labels.push({ x: centre.x, y: centre.y - 14, text: `r ${format(r)}` });
    }
    this.options.overlay.setPolyline({ points: screen, closed, labels });
  };
}
