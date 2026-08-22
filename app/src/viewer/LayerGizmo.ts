import { Matrix4, PerspectiveCamera, Scene, Vector3 } from 'three';
import type { Object3D } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Document } from '../model/Document';
import { previewAnisotropicScale } from '../model/anisotropic';
import type { Factor3 } from '../model/anisotropic';
import { SetLayerTransform } from '../model/commands';
import { ScaleSplats } from '../model/segmentCommands';
import type { CameraRig } from './CameraRig';

export type TransformMode = 'translate' | 'rotate' | 'scale';

export class LayerGizmo {
  private readonly controls: TransformControls;
  private document?: Document;
  private before?: Matrix4;
  /** Object scale when the drag started; stays on the object while a non-uniform drag previews. */
  private startScale = new Vector3(1, 1, 1);
  /** Non-uniform factor of the drag in progress (undefined for moves, rotations, uniform scales). */
  private pendingFactor?: Factor3;

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

  get mode(): TransformMode {
    return this.controls.getMode() as TransformMode;
  }

  /** True while the pointer is over a gizmo handle or a drag is in progress. */
  get isInteracting(): boolean {
    return this.controls.dragging || this.controls.axis !== null;
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
    this.startScale.copy(object.scale);
    this.pendingFactor = undefined;
  };

  private readonly onObjectChange = (): void => {
    const layer = this.document?.active();
    const object = this.controls.object as Object3D | undefined;
    if (!layer || !object) return;
    if (this.controls.getMode() === 'scale') {
      // TransformControls scales per axis (X/Y/Z handles), per plane (XY/YZ/XZ) or uniformly
      // (centre). Spark only renders a uniform object scale, so a non-uniform drag keeps the
      // object's scale as it was and previews the anisotropic factor in the splat data; the
      // factor is baked into the store on mouse-up (ScaleSplats).
      const factor: Factor3 = [
        object.scale.x / (this.startScale.x || 1),
        object.scale.y / (this.startScale.y || 1),
        object.scale.z / (this.startScale.z || 1),
      ];
      const uniform =
        Math.abs(factor[0] - factor[1]) < 1e-6 && Math.abs(factor[1] - factor[2]) < 1e-6;
      if (!uniform) {
        object.scale.copy(this.startScale);
        this.pendingFactor = factor;
        previewAnisotropicScale(layer, factor);
      } else {
        this.pendingFactor = undefined;
      }
    }
    object.updateMatrix();
    object.updateMatrixWorld(true);
    // No layer-changed event per drag frame: the SetLayerTransform command on mouseUp
    // notifies once, so panels/grid don't rebuild 60× per second while dragging.
  };

  private readonly onMouseUp = (): void => {
    const document = this.document;
    const layer = document?.active();
    if (!document || !layer || !this.before) return;
    const factor = this.pendingFactor;
    this.pendingFactor = undefined;
    if (factor) {
      // Non-uniform scale: the object keeps its scale; the data changes (resync drops the preview).
      layer.object.scale.copy(this.startScale);
      layer.object.updateMatrix();
      document.history.push(new ScaleSplats(document, layer.id, factor));
      this.before = undefined;
      return;
    }
    layer.object.updateMatrix();
    const after = layer.object.matrix.clone();
    if (!after.equals(this.before))
      document.history.push(new SetLayerTransform(document, layer.id, this.before, after));
    this.before = undefined;
  };
}
