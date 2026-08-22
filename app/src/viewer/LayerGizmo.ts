import { Matrix4, PerspectiveCamera, Scene, Vector3 } from 'three';
import type { Object3D } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Document } from '../model/Document';
import { SetLayerTransform } from '../model/commands';
import type { CameraRig } from './CameraRig';

export type TransformMode = 'translate' | 'rotate' | 'scale';

export class LayerGizmo {
  private readonly controls: TransformControls;
  private document?: Document;
  private before?: Matrix4;
  private previousScale = new Vector3(1, 1, 1);

  constructor(
    scene: Scene,
    camera: PerspectiveCamera,
    canvas: HTMLCanvasElement,
    private readonly cameraRig: CameraRig,
  ) {
    this.controls = new TransformControls(camera, canvas);
    this.controls.setSize(0.75);
    scene.add(this.controls.getHelper());
    this.controls.addEventListener('dragging-changed', this.onDraggingChanged);
    this.controls.addEventListener('mouseDown', this.onMouseDown);
    this.controls.addEventListener('objectChange', this.onObjectChange);
    this.controls.addEventListener('mouseUp', this.onMouseUp);
  }

  setDocument(document?: Document): void {
    this.document?.removeEventListener('selection-changed', this.syncAttachment);
    this.document?.removeEventListener('layer-changed', this.syncAttachment);
    this.document = document;
    document?.addEventListener('selection-changed', this.syncAttachment);
    document?.addEventListener('layer-changed', this.syncAttachment);
    this.syncAttachment();
  }

  setMode(mode: TransformMode): void {
    this.controls.setMode(mode);
  }

  dispose(): void {
    this.setDocument();
    this.controls.removeEventListener('dragging-changed', this.onDraggingChanged);
    this.controls.removeEventListener('mouseDown', this.onMouseDown);
    this.controls.removeEventListener('objectChange', this.onObjectChange);
    this.controls.removeEventListener('mouseUp', this.onMouseUp);
    this.controls.getHelper().removeFromParent();
    this.controls.dispose();
  }

  private readonly syncAttachment = (): void => {
    const document = this.document;
    const layer = document?.selection.size === 1 ? document.active() : undefined;
    if (layer && !layer.locked) this.controls.attach(layer.object);
    else this.controls.detach();
  };

  private readonly onDraggingChanged = (event: { value?: unknown }): void => {
    this.cameraRig.controls.enabled = event.value !== true && this.cameraRig.mode === 'orbit';
  };

  private readonly onMouseDown = (): void => {
    const object = this.controls.object as Object3D | undefined;
    if (!object) return;
    object.updateMatrix();
    this.before = object.matrix.clone();
    this.previousScale.copy(object.scale);
  };

  private readonly onObjectChange = (): void => {
    const layer = this.document?.active();
    const object = this.controls.object as Object3D | undefined;
    if (!layer || !object) return;
    if (this.controls.getMode() === 'scale') {
      const values = [object.scale.x, object.scale.y, object.scale.z];
      const previous = [this.previousScale.x, this.previousScale.y, this.previousScale.z];
      let changedAxis = 0;
      for (let axis = 1; axis < 3; axis += 1)
        if (
          Math.abs((values[axis] ?? 1) - (previous[axis] ?? 1)) >
          Math.abs((values[changedAxis] ?? 1) - (previous[changedAxis] ?? 1))
        )
          changedAxis = axis;
      const uniform = Math.max(1e-5, Math.abs(values[changedAxis] ?? 1));
      object.scale.setScalar(uniform);
      this.previousScale.setScalar(uniform);
    }
    object.updateMatrix();
    object.updateMatrixWorld(true);
    this.document?.notifyLayerChanged(layer.id);
  };

  private readonly onMouseUp = (): void => {
    const document = this.document;
    const layer = document?.active();
    if (!document || !layer || !this.before) return;
    layer.object.updateMatrix();
    const after = layer.object.matrix.clone();
    if (!after.equals(this.before))
      document.history.push(new SetLayerTransform(document, layer.id, this.before, after));
    this.before = undefined;
  };
}
