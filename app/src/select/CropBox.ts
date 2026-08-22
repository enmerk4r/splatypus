import {
  BoxGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Vector3,
} from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Viewer } from '../viewer/Viewer';

export type CropMode = 'translate' | 'scale';

/**
 * A box you drag around the scene to throw away everything outside it.
 *
 * Cropping hides splats rather than deleting them, like every other edit here, so it
 * stays undoable until export — where hidden splats are what does not get written.
 *
 * The box is a unit cube carrying its size in its scale, so "is this splat inside" is
 * one matrix multiply and three comparisons against ±0.5, and the transform gizmo can
 * drive it directly with no bookkeeping of its own.
 */
export class CropBox extends EventTarget {
  private box?: Mesh;
  private outline?: LineSegments;
  private controls?: TransformControls;
  /** Splats this crop hid, so undoing it cannot disturb anything else's hiding. */
  private hidden?: Uint32Array;

  constructor(private readonly viewer: Viewer) {
    super();
    viewer.addEventListener('document-changed', () => this.cancel());
  }

  get isActive(): boolean {
    return this.box !== undefined;
  }

  get isApplied(): boolean {
    return this.hidden !== undefined;
  }

  get mode(): CropMode {
    return (this.controls?.mode as CropMode | undefined) ?? 'translate';
  }

  setMode(mode: CropMode): void {
    this.controls?.setMode(mode);
    this.dispatchEvent(new Event('crop-changed'));
  }

  /** Shows the box, sized to the scene so the first drag is always a shrink. */
  begin(): void {
    const document = this.viewer.document;
    if (!document || this.box) return;
    const bounds = document.getRobustBounds();
    const size = bounds.max.clone().sub(bounds.min).multiplyScalar(1.02);

    this.box = new Mesh(
      new BoxGeometry(1, 1, 1),
      // Faint, double-sided and depth-blind: the box has to stay readable from inside,
      // and it must never hide the splats it is being aimed at.
      new MeshBasicMaterial({
        color: 0x4ade80,
        transparent: true,
        opacity: 0.05,
        depthWrite: false,
      }),
    );
    this.box.position.copy(bounds.center);
    this.box.scale.copy(size);
    this.outline = new LineSegments(
      new EdgesGeometry(this.box.geometry),
      new LineBasicMaterial({ color: 0x4ade80, depthTest: false }),
    );
    this.box.add(this.outline);
    this.viewer.attach(this.box);

    this.controls = new TransformControls(this.viewer.activeCamera, this.viewer.domElement);
    this.controls.setSize(0.7);
    this.controls.addEventListener('dragging-changed', this.onDragging);
    this.controls.addEventListener('objectChange', this.onChange);
    this.viewer.attach(this.controls.getHelper());
    this.controls.attach(this.box);
    this.dispatchEvent(new Event('crop-changed'));
  }

  /**
   * Hides everything on the wrong side of the box.
   *
   * Splats a layer has already taken over are skipped: they are hidden on that layer's
   * behalf, and undoing a crop must not hand them back to the scan.
   */
  apply(keep: 'inside' | 'outside', claimed: ReadonlySet<number>): number {
    const document = this.viewer.document;
    const box = this.box;
    if (!document || !box) return 0;
    this.restore();

    box.updateMatrixWorld(true);
    document.mesh.updateMatrixWorld(true);
    // Splat centres are in mesh-local space; this takes them straight to box-local,
    // where the test is a comparison against the unit cube.
    const toBox = new Matrix4().copy(box.matrixWorld).invert().multiply(document.mesh.matrixWorld);

    const doomed: number[] = [];
    const point = new Vector3();
    for (let index = 0; index < document.numSplats; index += 1) {
      if (claimed.has(index)) continue;
      point
        .set(
          document.centres[index * 3]!,
          document.centres[index * 3 + 1]!,
          document.centres[index * 3 + 2]!,
        )
        .applyMatrix4(toBox);
      const inside =
        Math.abs(point.x) <= 0.5 && Math.abs(point.y) <= 0.5 && Math.abs(point.z) <= 0.5;
      if (inside === (keep === 'outside')) doomed.push(index);
    }

    this.hidden = new Uint32Array(doomed);
    document.hide(this.hidden);
    this.dispatchEvent(new Event('crop-changed'));
    return doomed.length;
  }

  /** Brings back whatever the last crop hid. */
  restore(): void {
    if (!this.hidden) return;
    this.viewer.document?.restore(this.hidden);
    this.hidden = undefined;
    this.dispatchEvent(new Event('crop-changed'));
  }

  /** Puts the box away. The crop itself stays applied; `restore` is what undoes that. */
  cancel(): void {
    if (this.controls) {
      this.controls.removeEventListener('dragging-changed', this.onDragging);
      this.controls.removeEventListener('objectChange', this.onChange);
      this.controls.detach();
      this.viewer.detach(this.controls.getHelper());
      this.controls.dispose();
      this.controls = undefined;
    }
    if (this.box) {
      this.viewer.detach(this.box);
      this.box.geometry.dispose();
      (this.box.material as MeshBasicMaterial).dispose();
      this.box = undefined;
    }
    if (this.outline) {
      this.outline.geometry.dispose();
      (this.outline.material as LineBasicMaterial).dispose();
      this.outline = undefined;
    }
    this.dispatchEvent(new Event('crop-changed'));
  }

  dispose(): void {
    this.cancel();
  }

  private readonly onDragging = (event: { value: unknown }): void => {
    this.viewer.cameraRig.controls.enabled = !event.value;
  };

  private readonly onChange = (): void => {
    this.dispatchEvent(new Event('crop-moved'));
  };
}
