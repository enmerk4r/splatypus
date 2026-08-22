import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Viewer } from '../viewer/Viewer';
import type { SegmentLayer } from './Segments';

/**
 * Gizmo for moving a split segment. Moving a layer is a transform on its `Object3D` —
 * Spark re-sorts and the splat data is untouched — so this needs no bake step.
 */
export class LayerGizmo {
  private readonly controls: TransformControls;
  private attachedLayer?: SegmentLayer;

  constructor(private readonly viewer: Viewer) {
    this.controls = new TransformControls(viewer.activeCamera, viewer.domElement);
    this.controls.setSize(0.8);
    // Orbit and the gizmo both claim pointer drags; the gizmo wins while it is in use.
    this.controls.addEventListener('dragging-changed', this.onDraggingChanged);
    viewer.attach(this.controls.getHelper());
  }

  get layer(): SegmentLayer | undefined {
    return this.attachedLayer;
  }

  attach(layer: SegmentLayer | undefined): void {
    this.attachedLayer = layer;
    if (layer) this.controls.attach(layer.mesh);
    else this.controls.detach();
  }

  setMode(mode: 'translate' | 'rotate' | 'scale'): void {
    this.controls.setMode(mode);
  }

  dispose(): void {
    this.controls.removeEventListener('dragging-changed', this.onDraggingChanged);
    this.viewer.detach(this.controls.getHelper());
    this.controls.dispose();
  }

  private readonly onDraggingChanged = (event: { value: unknown }): void => {
    this.viewer.cameraRig.controls.enabled = !event.value;
  };
}
