import {
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Raycaster,
  Vector3,
} from 'three';
import type { Document } from '../model/Document';
import type { Layer } from '../model/Layer';
import { SetSolid } from '../model/meshCommands';
import type { ToastLevel } from '../ui/hud';
import { eventPointer } from '../viewer/picking';
import type { Viewer } from '../viewer/Viewer';
import { extrudeFace, faceCentroid } from './solid';
import type { FaceData, SolidData } from './solid';

export interface ExtrudeGizmoOptions {
  notify: (message: string, level?: ToastLevel) => void;
}

const UP = new Vector3(0, 1, 0);

/**
 * An arrow sprouting from the centroid of the selected **face** along its normal. Drag the
 * head to extrude by eye (live preview, committed on release as one undo step); the MODEL
 * panel's height field does the same numerically. Extrusions are always along the face
 * normal, so rotate the face first to extrude sideways.
 * Events: `target-changed`, `preview` ({height} while dragging, {height: undefined} after).
 */
export class ExtrudeGizmo extends EventTarget {
  private readonly group = new Group();
  private readonly shaft: Mesh;
  private readonly head: Mesh;
  private document?: Document;
  private layer?: Layer;
  private face?: FaceData;
  private drag?: {
    origin: Vector3;
    axis: Vector3;
    startOffset: number;
    height: number;
    original: SolidData;
  };

  constructor(
    private readonly viewer: Viewer,
    private readonly options: ExtrudeGizmoOptions,
  ) {
    super();
    const material = new MeshBasicMaterial({
      color: 0xb8f34a,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });
    this.shaft = new Mesh(new CylinderGeometry(1, 1, 1, 12), material);
    this.head = new Mesh(new ConeGeometry(1, 1, 16), material);
    this.group.add(this.shaft, this.head);
    this.group.renderOrder = 999;
    this.group.visible = false;
    viewer.addHelper(this.group);
    viewer.addEventListener('document-changed', this.onDocumentChanged);
    viewer.addEventListener('tool-changed', this.refresh);
    viewer.addEventListener('frame', this.update);
    viewer.canvasElement.addEventListener('pointerdown', this.onPointerDown, true);
    viewer.canvasElement.addEventListener('pointermove', this.onPointerMove, true);
    viewer.canvasElement.addEventListener('pointerup', this.onPointerUp, true);
    viewer.canvasElement.addEventListener('pointercancel', this.onPointerUp, true);
    viewer.addInteractionGuard(() => this.drag !== undefined);
    this.onDocumentChanged();
  }

  /** The face layer the arrow is attached to, if any. */
  get target(): Layer | undefined {
    return this.layer;
  }

  get isDragging(): boolean {
    return this.drag !== undefined;
  }

  /** Extrudes the attached face numerically (same command as a drag). */
  extrudeBy(height: number): boolean {
    const document = this.document;
    const layer = this.layer;
    const face = this.face;
    if (!document || !layer || !face) return false;
    if (!Number.isFinite(height) || Math.abs(height) < 1e-6) {
      this.options.notify('Enter a non-zero height.', 'warning');
      return false;
    }
    this.commit(document, layer, face, height);
    return true;
  }

  dispose(): void {
    this.viewer.removeEventListener('document-changed', this.onDocumentChanged);
    this.viewer.removeEventListener('tool-changed', this.refresh);
    this.viewer.removeEventListener('frame', this.update);
    this.viewer.canvasElement.removeEventListener('pointerdown', this.onPointerDown, true);
    this.viewer.canvasElement.removeEventListener('pointermove', this.onPointerMove, true);
    this.viewer.canvasElement.removeEventListener('pointerup', this.onPointerUp, true);
    this.viewer.canvasElement.removeEventListener('pointercancel', this.onPointerUp, true);
    this.unsubscribe();
    this.viewer.removeHelper(this.group);
  }

  private unsubscribe(): void {
    this.document?.removeEventListener('selection-changed', this.refresh);
    this.document?.removeEventListener('layers-changed', this.refresh);
    this.document?.removeEventListener('layer-changed', this.refresh);
  }

  private readonly onDocumentChanged = (): void => {
    this.unsubscribe();
    this.document = this.viewer.document;
    this.document?.addEventListener('selection-changed', this.refresh);
    this.document?.addEventListener('layers-changed', this.refresh);
    this.document?.addEventListener('layer-changed', this.refresh);
    this.refresh();
  };

  /** Attach to the selected layer when it is a single unlocked face; hide otherwise. */
  private readonly refresh = (): void => {
    if (this.drag) return;
    const document = this.document;
    const active = document && document.selection.size === 1 ? document.active() : undefined;
    const solid = active?.solid;
    if (active && solid?.face && !active.locked && this.viewer.tool === 'select') {
      this.layer = active;
      this.face = solid.face;
      this.group.visible = true;
    } else {
      this.layer = undefined;
      this.face = undefined;
      this.group.visible = false;
    }
    this.dispatchEvent(new Event('target-changed'));
  };

  /** World origin/axis of the arrow. */
  private axisWorld(): { origin: Vector3; axis: Vector3 } | undefined {
    const layer = this.layer;
    const face = this.face;
    if (!layer || !face) return undefined;
    layer.object.updateMatrixWorld(true);
    const origin = faceCentroid(face).applyMatrix4(layer.object.matrixWorld);
    const rotation = new Quaternion();
    layer.object.getWorldQuaternion(rotation);
    const axis = new Vector3(...face.normal).normalize().applyQuaternion(rotation).normalize();
    return { origin, axis };
  }

  /** Sizes and places the arrow every frame (constant on-screen size, like the gizmo). */
  private readonly update = (): void => {
    if (!this.group.visible) return;
    const axisWorld = this.axisWorld();
    if (!axisWorld) return;
    const { origin, axis } = axisWorld;
    const length = Math.max(origin.distanceTo(this.viewer.camera.position) * 0.22, 1e-3);
    const radius = length * 0.035;
    this.group.position.copy(origin);
    this.group.quaternion.setFromUnitVectors(UP, axis);
    this.shaft.scale.set(radius, length * 0.8, radius);
    this.shaft.position.set(0, length * 0.4, 0);
    this.head.scale.set(radius * 3.5, length * 0.25, radius * 3.5);
    this.head.position.set(0, length * 0.925, 0);
  };

  private hitsArrow(event: PointerEvent): boolean {
    if (!this.group.visible) return false;
    const rect = this.viewer.canvasElement.getBoundingClientRect();
    const raycaster = new Raycaster();
    raycaster.setFromCamera(eventPointer(event, rect), this.viewer.camera);
    this.group.updateMatrixWorld(true);
    return raycaster.intersectObjects([this.head, this.shaft], false).length > 0;
  }

  /** Offset along the arrow axis of the axis point closest to the pointer ray. */
  private axisOffset(event: PointerEvent, origin: Vector3, axis: Vector3): number {
    const rect = this.viewer.canvasElement.getBoundingClientRect();
    const raycaster = new Raycaster();
    raycaster.setFromCamera(eventPointer(event, rect), this.viewer.camera);
    const ro = raycaster.ray.origin,
      rd = raycaster.ray.direction;
    const w = new Vector3().subVectors(origin, ro);
    const a = axis.dot(axis),
      b = axis.dot(rd),
      c = rd.dot(rd);
    const d = axis.dot(w),
      e = rd.dot(w);
    const denominator = a * c - b * b;
    if (Math.abs(denominator) < 1e-9) return 0;
    return (b * e - c * d) / denominator;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.drag || !this.layer?.solid || !this.face) return;
    if (this.viewer.tool !== 'select' || !this.hitsArrow(event)) return;
    const axisWorld = this.axisWorld();
    if (!axisWorld) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    this.viewer.lockCamera(true);
    this.drag = {
      origin: axisWorld.origin,
      axis: axisWorld.axis,
      startOffset: this.axisOffset(event, axisWorld.origin, axisWorld.axis),
      height: 0,
      original: this.layer.solid,
    };
    try {
      this.viewer.canvasElement.setPointerCapture(event.pointerId);
    } catch {
      // synthetic pointers have no capture
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    const layer = this.layer;
    const face = this.face;
    if (!drag || !layer || !face) return;
    event.stopImmediatePropagation();
    const offset = this.axisOffset(event, drag.origin, drag.axis) - drag.startOffset;
    const scale = layer.object.getWorldScale(new Vector3());
    drag.height = offset / ((scale.x + scale.y + scale.z) / 3 || 1);
    // Live preview; `face` stays set so the gizmo keeps treating the layer as a face.
    layer.setSolid(
      Math.abs(drag.height) > 1e-6
        ? { ...extrudeFace(face, drag.height), colour: drag.original.colour, face }
        : drag.original,
    );
    this.dispatchEvent(new CustomEvent('preview', { detail: { height: drag.height } }));
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    event.stopImmediatePropagation();
    this.drag = undefined;
    this.viewer.lockCamera(false);
    try {
      this.viewer.canvasElement.releasePointerCapture(event.pointerId);
    } catch {
      // synthetic pointers
    }
    const document = this.document;
    const layer = this.layer;
    const face = this.face;
    if (!document || !layer || !face) return;
    // Restore the plain face, then commit through a command so undo brings the face back.
    layer.setSolid(drag.original);
    if (Math.abs(drag.height) > 1e-6) this.commit(document, layer, face, drag.height);
    this.dispatchEvent(new CustomEvent('preview', { detail: { height: undefined } }));
  };

  private commit(document: Document, layer: Layer, face: FaceData, height: number): void {
    const colour = layer.solid?.colour ?? [1, 0, 0];
    try {
      document.history.push(
        new SetSolid(
          document,
          layer.id,
          { ...extrudeFace(face, height), colour },
          `Extrude ${layer.name} ${height >= 0 ? '+' : '−'}${Math.abs(height).toFixed(3)} m`,
        ),
      );
      this.options.notify(
        `Extruded “${layer.name}” by ${Math.abs(height).toFixed(3)} m along its normal.`,
      );
    } catch (error) {
      this.options.notify(error instanceof Error ? error.message : 'Could not extrude.', 'error');
    }
    this.refresh();
  }
}
