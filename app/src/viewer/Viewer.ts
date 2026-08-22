import {
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
  private gridVisible = true;
  private upAxisValue: UpAxis = 'y-down';
  private renderScale = 1;
  private lastFrame = performance.now();

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
    this.resetGrid(new Vector3(), 1, -1);

    this.onFrame = (now): void => {
      const deltaSeconds = Math.min((now - this.lastFrame) / 1000, 0.1);
      this.lastFrame = now;
      this.cameraRig.update(deltaSeconds);
      this.renderer.render(this.scene, this.camera);
      frameCallback(now);
    };

    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    canvas.addEventListener('dblclick', this.onDoubleClick);
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
    this.resetGrid(bounds.center, bounds.radius, bounds.min.y);
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

  get upAxis(): UpAxis {
    return this.upAxisValue;
  }

  setUpAxis(axis: UpAxis): void {
    this.upAxisValue = axis;
    if (!this.documentValue) return;
    this.applyOrientation();
    const bounds = this.documentValue.getRobustBounds();
    this.resetGrid(bounds.center, bounds.radius, bounds.min.y);
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
    this.disposeGrid();
    this.renderer.dispose();
    window.removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
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

  private resetGrid(center: Vector3, radius: number, floorY: number): void {
    this.disposeGrid();
    this.grid = new GridHelper(radius * 4, 20, 0x52616d, 0x263139);
    this.grid.position.set(center.x, floorY, center.z);
    this.grid.visible = this.gridVisible;
    this.scene.add(this.grid);
  }

  private disposeGrid(): void {
    if (!this.grid) return;
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    const materials: Material[] = Array.isArray(this.grid.material)
      ? this.grid.material
      : [this.grid.material];
    materials.forEach((material) => material.dispose());
    this.grid = undefined;
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
    if (!this.documentValue || this.cameraRig.mode !== 'orbit') return;
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    const hit = raycaster.intersectObject(this.documentValue.mesh, false)[0];
    const point = hit?.point ?? this.findNearestProjectedPoint(pointer, 12, rect);
    if (point) this.cameraRig.retarget(point);
  };

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
