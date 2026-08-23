import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  GridHelper,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Plane,
  Quaternion,
  Raycaster,
  Vector3,
} from 'three';
import type { PerspectiveCamera, Scene } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { CameraRig } from './CameraRig';

export type WorkPlanePreset = 'ground' | 'front' | 'side';
export type WorkPlaneMode = 'translate' | 'rotate';

/**
 * A construction plane you can move and rotate, so drawing is not stuck on the horizontal.
 *
 * Sketching tools need to answer "where in 3D is this pixel?", and a plane is the only
 * answer that stays put while the camera moves. Until now that plane was always horizontal
 * — fine for a floor plan, useless for drawing on a wall or a sloped roof.
 *
 * The plane's normal is the object's local **+Y**, so an untouched work plane is exactly
 * the horizontal ground plane the tools used before. That keeps the default behaviour
 * identical and makes `GridHelper` (which lies in XZ) the natural visual.
 *
 * Events: `changed` — pose, visibility or mode.
 */
export class WorkPlane extends EventTarget {
  readonly object = new Object3D();
  private readonly controls: TransformControls;
  private readonly visual = new Object3D();
  private readonly grid: GridHelper;
  private readonly quad: Mesh;
  private readonly outline: LineSegments;
  private enabledValue = false;
  private editingValue = false;
  private sizeValue = 1;

  constructor(
    scene: Scene,
    camera: PerspectiveCamera,
    canvas: HTMLCanvasElement,
    private readonly cameraRig: CameraRig,
  ) {
    super();
    this.object.name = 'Work plane';
    scene.add(this.object);
    this.object.add(this.visual);

    this.grid = new GridHelper(1, 10, 0x7fd4ff, 0x2c4a5c);
    // A translucent quad makes the plane readable edge-on, where a wireframe grid
    // collapses to a line and stops telling you which way it faces.
    this.quad = new Mesh(
      unitQuadXZ(),
      new MeshBasicMaterial({
        color: 0x7fd4ff,
        transparent: true,
        opacity: 0.06,
        side: DoubleSide,
        depthWrite: false,
      }),
    );
    this.outline = new LineSegments(
      unitOutlineXZ(),
      new LineBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.55 }),
    );
    this.visual.add(this.grid, this.quad, this.outline);
    this.visual.visible = false;

    this.controls = new TransformControls(camera, canvas);
    this.controls.setSize(0.7);
    this.controls.setMode('translate');
    this.controls.enabled = false;
    this.controls.getHelper().visible = false;
    scene.add(this.controls.getHelper());
    this.controls.addEventListener('dragging-changed', this.onDraggingChanged);
    this.controls.addEventListener('objectChange', this.onObjectChange);
  }

  /** True when tools should snap to this plane instead of their own default. */
  get enabled(): boolean {
    return this.enabledValue;
  }
  /** True while the gizmo is up and the plane can be dragged. */
  get editing(): boolean {
    return this.editingValue;
  }
  get mode(): WorkPlaneMode {
    return this.controls.getMode() as WorkPlaneMode;
  }
  /** True while the pointer is on a gizmo handle — canvas tools must stand down. */
  get isInteracting(): boolean {
    return this.editingValue && (this.controls.dragging || this.controls.axis !== null);
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabledValue) return;
    this.enabledValue = enabled;
    this.visual.visible = enabled;
    if (!enabled) this.setEditing(false);
    this.dispatchEvent(new Event('changed'));
  }

  setEditing(editing: boolean): void {
    const next = editing && this.enabledValue;
    if (next === this.editingValue) return;
    this.editingValue = next;
    this.controls.enabled = next;
    this.controls.getHelper().visible = next;
    if (next) this.controls.attach(this.object);
    else this.controls.detach();
    this.dispatchEvent(new Event('changed'));
  }

  setMode(mode: WorkPlaneMode): void {
    if (mode === this.controls.getMode()) return;
    this.controls.setMode(mode);
    this.dispatchEvent(new Event('changed'));
  }

  /**
   * Sizes the visual to the scene so the grid is neither a speck nor a horizon. The plane
   * itself is infinite; this only affects what is drawn.
   */
  resize(radius: number): void {
    this.sizeValue = Math.max(radius * 2, 1e-3);
    this.visual.scale.setScalar(this.sizeValue);
  }

  /** Moves the plane to a point without changing its orientation. */
  moveTo(point: Vector3): void {
    this.object.position.copy(point);
    this.object.updateMatrixWorld(true);
    this.dispatchEvent(new Event('changed'));
  }

  /** One of the three axis-aligned planes, keeping the current origin. */
  setPreset(preset: WorkPlanePreset): void {
    // Rotations take the grid's own +Y normal onto each world axis.
    const rotation =
      preset === 'front'
        ? new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2) // normal → +Z
        : preset === 'side'
          ? new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2) // normal → +X
          : new Quaternion();
    this.object.quaternion.copy(rotation);
    this.object.updateMatrixWorld(true);
    this.dispatchEvent(new Event('changed'));
  }

  /** Faces the plane at the camera — the "draw on the screen" plane. */
  alignToView(camera: PerspectiveCamera): void {
    const normal = camera.getWorldDirection(new Vector3()).negate();
    this.setNormal(normal);
  }

  /** Lays the plane on a surface: `normal` faces out, `point` sets the origin. */
  alignTo(normal: Vector3, point?: Vector3): void {
    if (point) this.object.position.copy(point);
    this.setNormal(normal);
  }

  /** Back to the horizontal plane through the origin. */
  reset(): void {
    this.object.position.set(0, 0, 0);
    this.object.quaternion.identity();
    this.object.updateMatrixWorld(true);
    this.dispatchEvent(new Event('changed'));
  }

  /** World-space plane, for ray intersection. */
  plane(target = new Plane()): Plane {
    this.object.updateMatrixWorld(true);
    return target.setFromNormalAndCoplanarPoint(this.normal(), this.origin());
  }

  /** World-space normal (the object's local +Y). */
  normal(target = new Vector3()): Vector3 {
    this.object.updateMatrixWorld(true);
    return target.set(0, 1, 0).applyQuaternion(this.object.quaternion).normalize();
  }

  /** World-space origin. */
  origin(target = new Vector3()): Vector3 {
    this.object.updateMatrixWorld(true);
    return target.setFromMatrixPosition(this.object.matrixWorld);
  }

  /** Where a pointer ray meets the plane, or undefined when it is edge-on. */
  raycast(
    pointer: { x: number; y: number },
    camera: PerspectiveCamera,
    target = new Vector3(),
  ): Vector3 | undefined {
    const raycaster = new Raycaster();
    raycaster.setFromCamera(pointer as never, camera);
    return raycaster.ray.intersectPlane(this.plane(), target) ?? undefined;
  }

  dispose(): void {
    this.controls.removeEventListener('dragging-changed', this.onDraggingChanged);
    this.controls.removeEventListener('objectChange', this.onObjectChange);
    this.controls.detach();
    this.controls.getHelper().removeFromParent();
    this.controls.dispose();
    this.object.removeFromParent();
    this.grid.geometry.dispose();
    disposeMaterial(this.grid);
    this.quad.geometry.dispose();
    disposeMaterial(this.quad);
    this.outline.geometry.dispose();
    disposeMaterial(this.outline);
  }

  private setNormal(normal: Vector3): void {
    const target = normal.clone().normalize();
    if (target.lengthSq() < 1e-12) return;
    this.object.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), target);
    this.object.updateMatrixWorld(true);
    this.dispatchEvent(new Event('changed'));
  }

  private readonly onDraggingChanged = (event: { value?: unknown }): void => {
    // The orbit controls must let go while a handle is being dragged, exactly as they do
    // for the layer gizmo.
    this.cameraRig.controls.enabled = event.value !== true && this.cameraRig.mode === 'orbit';
  };

  private readonly onObjectChange = (): void => {
    this.dispatchEvent(new Event('changed'));
  };
}

function unitQuadXZ(): BufferGeometry {
  const geometry = new BufferGeometry();
  const h = 0.5;
  geometry.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([-h, 0, -h, h, 0, -h, h, 0, h, -h, 0, -h, h, 0, h, -h, 0, h]),
      3,
    ),
  );
  return geometry;
}

function unitOutlineXZ(): BufferGeometry {
  const geometry = new BufferGeometry();
  const h = 0.5;
  geometry.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([
        -h,
        0,
        -h,
        h,
        0,
        -h,
        h,
        0,
        -h,
        h,
        0,
        h,
        h,
        0,
        h,
        -h,
        0,
        h,
        -h,
        0,
        h,
        -h,
        0,
        -h,
      ]),
      3,
    ),
  );
  return geometry;
}

function disposeMaterial(object: { material: unknown }): void {
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of materials) (material as { dispose?: () => void } | undefined)?.dispose?.();
}
