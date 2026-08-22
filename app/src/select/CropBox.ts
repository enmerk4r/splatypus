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
import { CompositeCommand, SetSplatsAlive } from '../model/segmentCommands';
import type { Command } from '../model/history';
import type { Viewer } from '../viewer/Viewer';

export type CropMode = 'translate' | 'scale';

/**
 * A box you drag around the scene to throw away everything outside (or inside) it.
 * Applying a crop hides splats (alive = 0) through one undoable command across all
 * visible, unlocked layers; export drops hidden splats.
 *
 * The box is a unit cube carrying its size in its scale, so "is this splat inside" is one
 * matrix multiply and three comparisons against ±0.5, and the gizmo drives it directly.
 */
export class CropBox extends EventTarget {
  private box?: Mesh;
  private outline?: LineSegments;
  private controls?: TransformControls;

  constructor(private readonly viewer: Viewer) {
    super();
    viewer.addEventListener('document-changed', this.cancel);
  }

  get isActive(): boolean {
    return this.box !== undefined;
  }

  get mode(): CropMode {
    return (this.controls?.mode as CropMode | undefined) ?? 'translate';
  }

  /** True while the pointer is on the box gizmo, so canvas clicks don't change the selection. */
  get isInteracting(): boolean {
    return Boolean(this.controls && (this.controls.dragging || this.controls.axis !== null));
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
      // Faint, double-sided and depth-blind: readable from inside, never hiding the splats.
      new MeshBasicMaterial({
        color: 0xb8f34a,
        transparent: true,
        opacity: 0.05,
        depthWrite: false,
      }),
    );
    this.box.position.copy(bounds.center);
    this.box.scale.copy(size);
    this.outline = new LineSegments(
      new EdgesGeometry(this.box.geometry),
      new LineBasicMaterial({ color: 0xb8f34a, depthTest: false }),
    );
    this.box.add(this.outline);
    this.viewer.addHelper(this.box);

    this.controls = new TransformControls(this.viewer.camera, this.viewer.canvasElement);
    this.controls.setSize(0.7);
    this.controls.addEventListener('dragging-changed', this.onDragging);
    this.viewer.addHelper(this.controls.getHelper());
    this.controls.attach(this.box);
    this.dispatchEvent(new Event('crop-changed'));
  }

  /**
   * Hides everything on the wrong side of the box in every visible, unlocked layer, as a
   * single undo step. Returns how many splats were hidden.
   */
  apply(keep: 'inside' | 'outside'): number {
    const document = this.viewer.document;
    const box = this.box;
    if (!document || !box) return 0;
    box.updateMatrixWorld(true);
    const commands: Command[] = [];
    let total = 0;
    const point = new Vector3();
    for (const layer of document.layers) {
      if (!layer.visible || layer.locked) continue;
      layer.object.updateMatrixWorld(true);
      // Store centres are layer-local; this takes them straight to box-local space.
      const toBox = new Matrix4().copy(box.matrixWorld).invert().multiply(layer.object.matrixWorld);
      const doomed: number[] = [];
      const { store } = layer;
      for (let index = 0; index < store.count; index += 1) {
        if (!store.alive[index]) continue;
        point
          .set(
            store.centers[index * 3]!,
            store.centers[index * 3 + 1]!,
            store.centers[index * 3 + 2]!,
          )
          .applyMatrix4(toBox);
        const inside =
          Math.abs(point.x) <= 0.5 && Math.abs(point.y) <= 0.5 && Math.abs(point.z) <= 0.5;
        if (inside === (keep === 'outside')) doomed.push(index);
      }
      if (doomed.length) {
        commands.push(new SetSplatsAlive(document, layer.id, new Uint32Array(doomed), false));
        total += doomed.length;
      }
    }
    if (commands.length)
      document.history.push(
        new CompositeCommand(`Crop (${keep === 'inside' ? 'keep' : 'cut'} inside)`, commands),
      );
    this.dispatchEvent(new Event('crop-changed'));
    return total;
  }

  /** Puts the box away. An applied crop stays (undo it with Ctrl+Z). */
  readonly cancel = (): void => {
    if (this.controls) {
      this.controls.removeEventListener('dragging-changed', this.onDragging);
      this.controls.detach();
      this.viewer.removeHelper(this.controls.getHelper());
      this.controls.dispose();
      this.controls = undefined;
    }
    if (this.box) {
      this.viewer.removeHelper(this.box);
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
  };

  dispose(): void {
    this.viewer.removeEventListener('document-changed', this.cancel);
    this.cancel();
  }

  private readonly onDragging = (event: { value?: unknown }): void => {
    this.viewer.cameraRig.controls.enabled =
      event.value !== true && this.viewer.cameraRig.mode === 'orbit';
  };
}
