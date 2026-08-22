import { Matrix4, Object3D, PerspectiveCamera, Scene, Vector3 } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Document } from '../model/Document';
import type { Layer } from '../model/Layer';
import { previewAnisotropicScale } from '../model/anisotropic';
import type { Factor3 } from '../model/anisotropic';
import { SetLayerTransform } from '../model/commands';
import { CompositeCommand, ScaleSplats } from '../model/segmentCommands';
import type { CameraRig } from './CameraRig';

export type TransformMode = 'translate' | 'rotate' | 'scale';

export class LayerGizmo {
  private readonly controls: TransformControls;
  /** Shared transform origin used when several layers are selected. */
  private readonly pivot = new Object3D();
  private document?: Document;
  private before?: Matrix4;
  private pivotBefore?: Matrix4;
  private multiBefore?: Map<string, Matrix4>;
  private multiLayers: Layer[] = [];
  private multiSignature = '';
  /** Object scale when the drag started; stays on the object while a non-uniform drag previews. */
  private startScale = new Vector3(1, 1, 1);
  /** Non-uniform factor of the drag in progress (undefined for moves, rotations, uniform scales). */
  private pendingFactor?: Factor3;
  private enabledValue = true;

  constructor(
    scene: Scene,
    camera: PerspectiveCamera,
    canvas: HTMLCanvasElement,
    private readonly cameraRig: CameraRig,
  ) {
    this.controls = new TransformControls(camera, canvas);
    this.controls.setSize(0.75);
    this.pivot.name = 'Selected layers pivot';
    scene.add(this.pivot);
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

  setEnabled(enabled: boolean): void {
    this.enabledValue = enabled;
    this.controls.enabled = enabled;
    this.controls.getHelper().visible = enabled;
    this.syncAttachment();
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
    this.pivot.removeFromParent();
    this.controls.dispose();
  }

  private readonly syncAttachment = (): void => {
    const document = this.document;
    if (!this.enabledValue) {
      this.multiLayers = [];
      this.multiSignature = '';
      this.controls.detach();
      return;
    }
    const layers = document
      ? [...document.selection]
          .map((id) => document.getLayer(id))
          .filter((layer): layer is Layer => Boolean(layer))
      : [];
    if (layers.length === 1 && !layers[0]!.locked) {
      const layer = layers[0]!;
      this.multiLayers = [];
      this.multiSignature = '';
      // Every newly selected editable layer starts ready to move. Rotate and scale are
      // temporary tools; there is no separate Move button competing with Select.
      if (this.controls.object !== layer.object) this.controls.setMode('translate');
      this.controls.attach(layer.object);
    } else if (layers.length > 1 && layers.every((layer) => !layer.locked)) {
      const signature = layers.map((layer) => layer.id).join('|');
      if (
        this.controls.object !== this.pivot ||
        signature !== this.multiSignature ||
        !this.controls.dragging
      ) {
        const centre = new Vector3();
        const position = new Vector3();
        layers.forEach((layer) => centre.add(layer.object.getWorldPosition(position)));
        centre.divideScalar(layers.length);
        this.pivot.position.copy(centre);
        this.pivot.quaternion.identity();
        this.pivot.scale.setScalar(1);
        this.pivot.updateMatrix();
        this.pivot.updateMatrixWorld(true);
      }
      this.multiLayers = layers;
      this.multiSignature = signature;
      this.controls.setMode('translate');
      this.controls.attach(this.pivot);
    } else {
      this.multiLayers = [];
      this.multiSignature = '';
      this.controls.detach();
    }
  };

  private readonly onDraggingChanged = (event: { value?: unknown }): void => {
    this.cameraRig.controls.enabled = event.value !== true && this.cameraRig.mode === 'orbit';
  };

  private readonly onMouseDown = (): void => {
    const object = this.controls.object as Object3D | undefined;
    if (!object) return;
    object.updateMatrix();
    if (object === this.pivot) {
      this.pivotBefore = object.matrix.clone();
      this.multiBefore = new Map(
        this.multiLayers.map((layer) => [layer.id, layer.object.matrix.clone()]),
      );
      return;
    }
    this.before = object.matrix.clone();
    this.startScale.copy(object.scale);
    this.pendingFactor = undefined;
  };

  private readonly onObjectChange = (): void => {
    const layer = this.document?.active();
    const object = this.controls.object as Object3D | undefined;
    if (!object) return;
    if (object === this.pivot && this.pivotBefore && this.multiBefore) {
      object.updateMatrix();
      const delta = new Matrix4().multiplyMatrices(
        object.matrix,
        this.pivotBefore.clone().invert(),
      );
      for (const selected of this.multiLayers) {
        const start = this.multiBefore.get(selected.id);
        if (!start) continue;
        selected.object.matrix.multiplyMatrices(delta, start);
        selected.object.matrix.decompose(
          selected.object.position,
          selected.object.quaternion,
          selected.object.scale,
        );
        selected.object.updateMatrixWorld(true);
      }
      return;
    }
    if (!layer) return;
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
    if (!document) return;
    if (this.controls.object === this.pivot && this.multiBefore) {
      const commands = this.multiLayers.flatMap((selected) => {
        const before = this.multiBefore?.get(selected.id);
        selected.object.updateMatrix();
        const after = selected.object.matrix.clone();
        return before && !after.equals(before)
          ? [new SetLayerTransform(document, selected.id, before, after)]
          : [];
      });
      this.multiBefore = undefined;
      this.pivotBefore = undefined;
      if (commands.length)
        document.history.push(new CompositeCommand(`Move ${commands.length} layers`, commands));
      return;
    }
    if (!layer || !this.before) return;
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
