import { Euler, PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { RobustBounds } from './framing';

export type CameraMode = 'orbit' | 'fly';
export type AxisView = 'front' | 'right' | 'top';

export class CameraRig extends EventTarget {
  readonly controls: OrbitControls;
  private readonly camera: PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly keys = new Set<string>();
  private modeValue: CameraMode = 'orbit';
  private radius = 1;
  private speedMultiplier = 1;
  private dragging = false;
  private yaw = 0;
  private pitch = 0;
  private targetTween?: { from: Vector3; to: Vector3; started: number };

  constructor(camera: PerspectiveCamera, canvas: HTMLCanvasElement) {
    super();
    this.camera = camera;
    this.canvas = canvas;
    this.controls = new OrbitControls(camera, canvas);
    this.controls.enableDamping = true;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  get mode(): CameraMode {
    return this.modeValue;
  }

  get flySpeed(): number {
    return this.speedMultiplier;
  }

  setMode(mode: CameraMode): void {
    if (mode === this.modeValue) return;
    this.modeValue = mode;
    this.controls.enabled = mode === 'orbit';
    this.keys.clear();
    this.dragging = false;
    if (mode === 'fly') {
      const rotation = new Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.pitch = rotation.x;
      this.yaw = rotation.y;
    } else {
      const distance = Math.max(this.camera.position.distanceTo(this.controls.target), this.radius);
      const direction = this.camera.getWorldDirection(new Vector3());
      this.controls.target.copy(this.camera.position).addScaledVector(direction, distance);
      this.controls.update();
    }
    this.dispatchEvent(new Event('mode-changed'));
  }

  toggleMode(): void {
    this.setMode(this.modeValue === 'orbit' ? 'fly' : 'orbit');
  }

  setFlySpeed(value: number): void {
    this.speedMultiplier = Math.min(20, Math.max(0.05, value));
    this.dispatchEvent(new Event('speed-changed'));
  }

  frame(bounds: RobustBounds): void {
    this.radius = bounds.radius;
    const offset = new Vector3(1, 0.6, 1).normalize().multiplyScalar(bounds.radius * 2.2);
    this.camera.position.copy(bounds.center).add(offset);
    this.camera.near = Math.max(bounds.radius / 1000, 0.0001);
    this.camera.far = Math.max(bounds.radius * 100, this.camera.near + 1);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(bounds.center);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(bounds.center);
    this.syncFlyRotation();
    this.controls.update();
  }

  setView(view: AxisView): void {
    const target = this.controls.target.clone();
    const distance = Math.max(this.camera.position.distanceTo(target), this.radius * 2.2);
    const directions: Record<AxisView, Vector3> = {
      front: new Vector3(0, 0, 1),
      right: new Vector3(1, 0, 0),
      top: new Vector3(0, 1, 0),
    };
    this.camera.up.set(0, 1, 0);
    if (view === 'top') this.camera.up.set(0, 0, -1);
    this.camera.position.copy(target).addScaledVector(directions[view], distance);
    this.camera.lookAt(target);
    this.syncFlyRotation();
    this.controls.update();
  }

  retarget(point: Vector3): void {
    this.targetTween = {
      from: this.controls.target.clone(),
      to: point.clone(),
      started: performance.now(),
    };
  }

  update(deltaSeconds: number): void {
    if (this.targetTween && this.modeValue === 'orbit') {
      const elapsed = (performance.now() - this.targetTween.started) / 250;
      const t = Math.min(1, elapsed);
      const eased = 1 - (1 - t) ** 3;
      this.controls.target.lerpVectors(this.targetTween.from, this.targetTween.to, eased);
      if (t === 1) this.targetTween = undefined;
    }

    if (this.modeValue === 'orbit') {
      this.controls.update();
      return;
    }

    const movement = new Vector3();
    const forward = this.camera.getWorldDirection(new Vector3());
    const right = new Vector3().crossVectors(forward, this.camera.up).normalize();
    if (this.keys.has('KeyW')) movement.add(forward);
    if (this.keys.has('KeyS')) movement.sub(forward);
    if (this.keys.has('KeyD')) movement.add(right);
    if (this.keys.has('KeyA')) movement.sub(right);
    if (this.keys.has('KeyE')) movement.y += 1;
    if (this.keys.has('KeyQ')) movement.y -= 1;
    if (movement.lengthSq() === 0) return;
    const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 4 : 1;
    const speed = this.radius * 0.35 * this.speedMultiplier * boost;
    this.camera.position.addScaledVector(movement.normalize(), speed * deltaSeconds);
  }

  dispose(): void {
    this.controls.dispose();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.modeValue !== 'fly' || event.button !== 0) return;
    this.dragging = true;
    this.canvas.setPointerCapture(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.modeValue !== 'fly' || !this.dragging) return;
    this.yaw -= event.movementX * 0.0025;
    this.pitch = Math.max(
      -Math.PI / 2 + 0.01,
      Math.min(Math.PI / 2 - 0.01, this.pitch - event.movementY * 0.0025),
    );
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.dragging = false;
    if (this.canvas.hasPointerCapture(event.pointerId))
      this.canvas.releasePointerCapture(event.pointerId);
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (this.modeValue !== 'fly') return;
    event.preventDefault();
    this.setFlySpeed(this.speedMultiplier * Math.exp(-event.deltaY * 0.001));
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement
    )
      return;
    if (event.code === 'Escape' && this.modeValue === 'fly') this.setMode('orbit');
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly onBlur = (): void => this.keys.clear();

  private syncFlyRotation(): void {
    const rotation = new Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.pitch = rotation.x;
    this.yaw = rotation.y;
  }
}
