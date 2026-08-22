import {
  AxesHelper,
  Color,
  GridHelper,
  Material,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Object3D } from 'three';
import { SparkRenderer } from '@sparkjsdev/spark';
import { CameraRig } from './CameraRig';
import type { AxisView, CameraMode } from './CameraRig';
import type { SplatDocument } from './SplatDocument';

export class WebGLUnavailableError extends Error {}

/** Which axis points up in the file. 3DGS training output is Y-down; LiDAR/CloudCompare scans are usually Z-up. */
export type UpAxis = 'y-down' | 'y-up' | 'z-up';

export class Viewer extends EventTarget {
  readonly cameraRig: CameraRig;
  readonly spark: SparkRenderer;
  /** Unmasked GPU renderer string when the browser exposes it (e.g. to spot an iGPU). */
  readonly gpuName: string;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(60, 1, 0.01, 1000);
  private readonly onFrame: (now: number) => void;
  private documentValue?: SplatDocument;
  private grid?: GridHelper;
  private axes?: AxesHelper;
  private gridVisible = true;
  private axesVisible = true;
  private upAxisValue: UpAxis = 'y-down';
  private renderScale = 1;
  private lastFrame = performance.now();
  /** Where the pointer went down, so an orbit drag is not mistaken for a click. */
  private pointerDown?: { x: number; y: number; time: number };
  /** Latest pointer move, coalesced to one hover test per frame. The test raycasts the
   *  whole cloud, and pointermove fires several times per frame on a trackpad. */
  private hoverPending?: PointerEvent;
  private hoverLeft = false;

  constructor(canvas: HTMLCanvasElement, frameCallback: (now: number) => void) {
    super();
    this.canvas = canvas;
    const context = canvas.getContext('webgl2', {
      antialias: false,
      powerPreference: 'high-performance',
    });
    if (!context) throw new WebGLUnavailableError('WebGL 2 is unavailable');

    this.renderer = new WebGLRenderer({
      canvas,
      context,
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * this.renderScale);
    const debugInfo = context.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = debugInfo
      ? String(context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
      : 'GPU: unknown';
    this.scene.background = new Color('#111111');
    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);
    this.cameraRig = new CameraRig(this.camera, canvas);
    this.resetHelpers(new Vector3(), 1, -1);

    this.onFrame = (now): void => {
      const deltaSeconds = Math.min((now - this.lastFrame) / 1000, 0.1);
      this.lastFrame = now;
      this.cameraRig.update(deltaSeconds);
      this.flushHover();
      this.renderer.render(this.scene, this.camera);
      frameCallback(now);
    };

    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    canvas.addEventListener('dblclick', this.onDoubleClick);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.resize();
    this.camera.position.set(2, 1.2, 2);
    this.camera.lookAt(0, 0, 0);
    this.renderer.setAnimationLoop(this.onFrame);
  }

  get isGridVisible(): boolean {
    return this.gridVisible;
  }

  get document(): SplatDocument | undefined {
    return this.documentValue;
  }

  setDocument(document: SplatDocument): void {
    this.clearDocument();
    this.documentValue = document;
    // Scans (RGB point clouds) are almost always Z-up; 3DGS output is Y-down. Users can override.
    this.upAxisValue = document.kind === 'pointcloud' ? 'z-up' : 'y-down';
    this.applyOrientation();
    this.scene.add(document.mesh);
    const bounds = document.getRobustBounds();
    this.resetHelpers(bounds.center, bounds.radius, bounds.min.y);
    this.cameraRig.frame(bounds);
    this.dispatchEvent(new CustomEvent('document-changed', { detail: document }));
  }

  clearDocument(): void {
    if (!this.documentValue) return;
    this.scene.remove(this.documentValue.mesh);
    this.documentValue.dispose();
    this.documentValue = undefined;
    this.dispatchEvent(new CustomEvent('document-changed', { detail: undefined }));
  }

  frame(): void {
    if (this.documentValue) this.cameraRig.frame(this.documentValue.getRobustBounds());
  }

  setView(view: AxisView): void {
    this.cameraRig.setView(view);
  }

  setCameraMode(mode: CameraMode): void {
    this.cameraRig.setMode(mode);
  }

  setBackground(color: string): void {
    this.scene.background = new Color(color);
  }

  setGridVisible(visible: boolean): void {
    this.gridVisible = visible;
    if (this.grid) this.grid.visible = visible;
  }

  toggleGrid(): void {
    this.setGridVisible(!this.gridVisible);
    this.dispatchEvent(new Event('settings-changed'));
  }

  setAxesVisible(visible: boolean): void {
    this.axesVisible = visible;
    if (this.axes) this.axes.visible = visible;
  }

  get upAxis(): UpAxis {
    return this.upAxisValue;
  }

  setUpAxis(axis: UpAxis): void {
    this.upAxisValue = axis;
    if (!this.documentValue) return;
    this.applyOrientation();
    const bounds = this.documentValue.getRobustBounds();
    this.resetHelpers(bounds.center, bounds.radius, bounds.min.y);
    this.cameraRig.frame(bounds);
  }

  setFov(value: number): void {
    this.camera.fov = value;
    this.camera.updateProjectionMatrix();
  }

  get currentRenderScale(): number {
    return this.renderScale;
  }

  /** Fraction of device resolution to render at; the cheapest lever for fill-rate-bound scenes. */
  setRenderScale(scale: number): void {
    this.renderScale = Math.min(2, Math.max(0.25, scale));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * this.renderScale);
    this.resize();
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.clearDocument();
    this.cameraRig.dispose();
    this.disposeHelpers();
    this.renderer.dispose();
    window.removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
  }

  get activeCamera(): PerspectiveCamera {
    return this.camera;
  }

  get domElement(): HTMLCanvasElement {
    return this.canvas;
  }

  /** Adds a segment layer (or a gizmo) to the scene alongside the loaded document. */
  attach(object: Object3D): void {
    this.scene.add(object);
  }

  detach(object: Object3D): void {
    this.scene.remove(object);
  }

  private applyOrientation(): void {
    if (!this.documentValue) return;
    // Only the mesh transform changes; file coordinates are preserved for later export.
    const mesh = this.documentValue.mesh;
    switch (this.upAxisValue) {
      case 'y-down':
        mesh.quaternion.set(1, 0, 0, 0); // 180° about X
        break;
      case 'y-up':
        mesh.quaternion.set(0, 0, 0, 1);
        break;
      case 'z-up':
        mesh.quaternion.set(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // −90° about X: Z → Y
        break;
    }
    mesh.updateMatrixWorld(true);
  }

  private resetHelpers(center: Vector3, radius: number, floorY: number): void {
    this.disposeHelpers();
    this.grid = new GridHelper(radius * 4, 20, 0x52616d, 0x263139);
    this.grid.position.set(center.x, floorY, center.z);
    this.grid.visible = this.gridVisible;
    this.scene.add(this.grid);
    this.axes = new AxesHelper(radius);
    this.axes.position.copy(center);
    this.axes.visible = this.axesVisible;
    this.scene.add(this.axes);
  }

  private disposeHelpers(): void {
    for (const helper of [this.grid, this.axes]) {
      if (!helper) continue;
      this.scene.remove(helper);
      helper.geometry.dispose();
      const materials: Material[] = Array.isArray(helper.material)
        ? helper.material
        : [helper.material];
      materials.forEach((material) => material.dispose());
    }
    this.grid = undefined;
    this.axes = undefined;
  }

  private readonly resize = (): void => {
    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) {
      this.renderer.setAnimationLoop(null);
    } else {
      this.lastFrame = performance.now();
      this.renderer.setAnimationLoop(this.onFrame);
    }
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    const point = this.pointAt(event);
    if (point) this.cameraRig.retarget(point);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointerDown = { x: event.clientX, y: event.clientY, time: performance.now() };
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    // Buttons down means an orbit or a gizmo drag, not a hover.
    this.hoverPending = event.buttons === 0 ? event : undefined;
  };

  private readonly onPointerLeave = (): void => {
    this.hoverPending = undefined;
    this.hoverLeft = true;
  };

  /** Runs the pending hover test once per frame, on the frame's own budget. */
  private flushHover(): void {
    if (this.hoverLeft && this.lastHover) {
      this.hoverLeft = false;
      this.dispatchEvent(new CustomEvent('canvas-hover', { detail: { event: this.lastHover } }));
    }
    const event = this.hoverPending;
    if (!event) return;
    this.hoverPending = undefined;
    this.lastHover = event;
    this.dispatchEvent(
      new CustomEvent('canvas-hover', { detail: { event, point: this.hitAt(event) } }),
    );
  }
  private lastHover?: PointerEvent;

  private readonly onPointerUp = (event: PointerEvent): void => {
    const down = this.pointerDown;
    this.pointerDown = undefined;
    if (!down || event.button !== 0) return;
    // An orbit drag ends in a pointerup too; only a short, still press is a click.
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (moved > 4 || performance.now() - down.time > 500) return;
    this.dispatchEvent(new CustomEvent('canvas-click', { detail: { event } }));
  };

  /** Raycaster through the pointer, or undefined when picking is not active. */
  raycasterFor(event: MouseEvent): Raycaster | undefined {
    if (!this.documentValue || this.cameraRig.mode !== 'orbit') return undefined;
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    return raycaster;
  }

  /**
   * Surface point under the pointer using the raycast alone. `pointAt` falls back to a
   * nearest-centre search that walks the cloud; this runs every frame, so it does not.
   */
  hitAt(event: MouseEvent): Vector3 | undefined {
    const raycaster = this.raycasterFor(event);
    if (!raycaster || !this.documentValue) return undefined;
    return raycaster.intersectObject(this.documentValue.mesh, false)[0]?.point;
  }

  /**
   * Surface point under the pointer. Spark's raycast walks the gaussians properly, but
   * a fuzzy cloud can be missed entirely, so a screen-space nearest-centre search backs
   * it up.
   */
  pointAt(event: MouseEvent): Vector3 | undefined {
    const raycaster = this.raycasterFor(event);
    if (!raycaster || !this.documentValue) return undefined;
    const hit = raycaster.intersectObject(this.documentValue.mesh, false)[0];
    if (hit) return hit.point;
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    return this.findNearestProjectedPoint(pointer, 12, rect);
  }

  private findNearestProjectedPoint(
    pointer: Vector2,
    maxPixels: number,
    rect: DOMRect,
  ): Vector3 | undefined {
    if (!this.documentValue) return undefined;
    const mesh = this.documentValue.mesh;
    mesh.updateWorldMatrix(true, false);
    const stride = Math.max(1, Math.ceil(mesh.numSplats / 200_000));
    const projected = new Vector3();
    const world = new Vector3();
    let bestDistance = maxPixels;
    let best: Vector3 | undefined;
    mesh.forEachSplat((index, center) => {
      if (index % stride !== 0) return;
      world.copy(center).applyMatrix4(mesh.matrixWorld);
      projected.copy(world).project(this.camera);
      if (projected.z < -1 || projected.z > 1) return;
      const distance = Math.hypot(
        (projected.x - pointer.x) * rect.width * 0.5,
        (projected.y - pointer.y) * rect.height * 0.5,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = world.clone();
      }
    });
    return best;
  }
}
