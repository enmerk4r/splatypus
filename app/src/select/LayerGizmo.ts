import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Viewer } from '../viewer/Viewer';
import type { SegmentLayer } from './Segments';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

/**
 * Gizmo for moving an object. Moving one is a transform on its `Object3D` — Spark
 * re-sorts and the splat data is untouched — so this needs no bake step.
 */
export class LayerGizmo extends EventTarget {
  private readonly controls: TransformControls;
  private attachedLayer?: SegmentLayer;
  private modeValue: GizmoMode = 'translate';

  constructor(private readonly viewer: Viewer) {
    super();
    this.controls = new TransformControls(viewer.activeCamera, viewer.domElement);
    this.controls.setSize(0.8);
    // Orbit and the gizmo both claim pointer drags; the gizmo wins while it is in use.
    this.controls.addEventListener('dragging-changed', this.onDraggingChanged);
    this.controls.addEventListener('objectChange', this.onObjectChange);
    viewer.attach(this.controls.getHelper());
  }

  get layer(): SegmentLayer | undefined {
    return this.attachedLayer;
  }

  get mode(): GizmoMode {
    return this.modeValue;
  }

  attach(layer: SegmentLayer | undefined): void {
    this.attachedLayer = layer;
    if (layer) this.controls.attach(layer.object);
    else this.controls.detach();
  }

  setMode(mode: GizmoMode): void {
    this.modeValue = mode;
    this.controls.setMode(mode);
  }

  dispose(): void {
    this.controls.removeEventListener('dragging-changed', this.onDraggingChanged);
    this.controls.removeEventListener('objectChange', this.onObjectChange);
    this.viewer.detach(this.controls.getHelper());
    this.controls.dispose();
  }

  private readonly onDraggingChanged = (event: { value: unknown }): void => {
    this.viewer.cameraRig.controls.enabled = !event.value;
  };

  /** Lets the inspector's position fields follow a drag instead of contradicting it. */
  private readonly onObjectChange = (): void => {
    this.dispatchEvent(new Event('transform-changed'));
  };
}
