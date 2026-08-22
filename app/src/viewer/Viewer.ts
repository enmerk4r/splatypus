import {
  Color,
  DirectionalLight,
  HemisphereLight,
  MOUSE,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Object3D } from 'three';
import { SparkRenderer } from '@sparkjsdev/spark';
import type { Document } from '../model/Document';
import type { ProjectViewState } from '../io/projectFormat';
import { CameraRig } from './CameraRig';
import type { AxisView, CameraMode } from './CameraRig';
import { LayerGizmo } from './LayerGizmo';
import type { TransformMode } from './LayerGizmo';
import { GridFloor } from './GridFloor';
import { CanvasInteraction } from './CanvasInteraction';

export class WebGLUnavailableError extends Error {}
export type UpAxis = 'y-down' | 'y-up' | 'z-up';
export type ToolMode =
  | 'select'
  | 'sketch'
  | 'erase'
  | 'recolor'
  | 'fade'
  | 'grab'
  | 'inflate'
  | 'measure'
  | 'polyline';
export const BRUSH_TOOLS: readonly ToolMode[] = ['recolor', 'fade', 'grab', 'inflate'];

export class Viewer extends EventTarget {
  readonly cameraRig: CameraRig;
  readonly spark: SparkRenderer;
  readonly gpuName: string;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly cameraValue = new PerspectiveCamera(60, 1, 0.01, 1000);
  private readonly gizmo: LayerGizmo;
  private readonly grid: GridFloor;
  private readonly interactions: CanvasInteraction;
  private readonly onFrame: (now: number) => void;
  private documentValue?: Document;
  private upAxisValue: UpAxis = 'y-down';
  private renderScale = 1;
  private toolValue: ToolMode = 'select';
  private cameraLockedValue = false;
  private lastFrame = performance.now();
  /** While any guard returns true (e.g. a gizmo is in use) canvas clicks/hovers are ignored. */
  private readonly interactionGuards: (() => boolean)[] = [];

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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const debugInfo = context.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = debugInfo
      ? String(context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
      : 'GPU: unknown';
    this.scene.background = new Color('#111111');
    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);
    // Lights only affect three.js meshes (mesh layers, gizmos); splats are unlit.
    this.scene.add(new HemisphereLight(0xffffff, 0x3a3f44, 1.1));
    const key = new DirectionalLight(0xffffff, 1.2);
    key.position.set(3, 6, 4);
    this.scene.add(key);
    this.cameraRig = new CameraRig(this.cameraValue, canvas);
    this.gizmo = new LayerGizmo(this.scene, this.cameraValue, canvas, this.cameraRig);
    this.grid = new GridFloor(this.scene);
    this.grid.reset(new Vector3(), 1, 0);
    this.interactions = new CanvasInteraction(this, () => this.interacting);

    this.onFrame = (now): void => {
      const deltaSeconds = Math.min((now - this.lastFrame) / 1000, 0.1);
      this.lastFrame = now;
      this.cameraRig.update(deltaSeconds);
      this.dispatchEvent(new Event('frame'));
      this.interactions.flushHover();
      this.renderer.render(this.scene, this.cameraValue);
      frameCallback(now);
    };
    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.resize();
    this.cameraValue.position.set(2, 1.2, 2);
    this.cameraValue.lookAt(0, 0, 0);
    this.renderer.setAnimationLoop(this.onFrame);
  }

  get isGridVisible(): boolean {
    return this.grid.isVisible;
  }
  get document(): Document | undefined {
    return this.documentValue;
  }
  get upAxis(): UpAxis {
    return this.upAxisValue;
  }
  get currentRenderScale(): number {
    return this.renderScale;
  }
  get tool(): ToolMode {
    return this.toolValue;
  }

  /** While locked (a stroke is being drawn) orbit controls and view shortcuts are ignored. */
  get cameraLocked(): boolean {
    return this.cameraLockedValue;
  }

  lockCamera(locked: boolean): void {
    if (locked === this.cameraLockedValue) return;
    this.cameraLockedValue = locked;
    this.cameraRig.controls.enabled = !locked && this.cameraRig.mode === 'orbit';
    this.dispatchEvent(new Event('camera-lock-changed'));
  }

  setTool(tool: ToolMode): void {
    if (tool === this.toolValue) return;
    this.toolValue = tool;
    const controls = this.cameraRig.controls;
    controls.mouseButtons.LEFT = tool === 'select' ? MOUSE.ROTATE : null;
    controls.mouseButtons.MIDDLE = MOUSE.DOLLY;
    controls.mouseButtons.RIGHT = tool === 'select' ? MOUSE.PAN : MOUSE.ROTATE;
    this.gizmo.setEnabled(tool === 'select');
    this.canvas.classList.toggle('tool-crosshair', tool !== 'select');
    this.interactions.clearHover();
    this.dispatchEvent(new Event('tool-changed'));
  }

  setDocument(document: Document, frame = true): void {
    this.clearDocument();
    this.documentValue = document;
    this.upAxisValue = document.layers[0]?.kind === 'pointcloud' ? 'z-up' : 'y-down';
    this.applyOrientation();
    this.scene.add(document.root);
    this.gizmo.setDocument(document);
    document.addEventListener('layers-changed', this.onLayersChanged);
    const bounds = document.getRobustBounds();
    this.fitGrid(bounds.radius);
    if (frame) this.cameraRig.frame(bounds);
    this.dispatchEvent(new CustomEvent('document-changed', { detail: document }));
  }

  clearDocument(): void {
    const document = this.documentValue;
    if (!document) return;
    document.removeEventListener('layers-changed', this.onLayersChanged);
    this.gizmo.setDocument();
    this.scene.remove(document.root);
    document.dispose();
    this.documentValue = undefined;
    this.dispatchEvent(new CustomEvent('document-changed', { detail: undefined }));
  }

  frame(): void {
    if (this.documentValue) this.cameraRig.frame(this.documentValue.getRobustBounds());
  }

  /** Render a single frame outside the animation loop (used by the dev console hook). */
  renderOnce(): void {
    this.onFrame(performance.now());
  }
  setView(view: AxisView): void {
    this.cameraRig.setView(view);
  }
  setCameraMode(mode: CameraMode): void {
    this.cameraRig.setMode(mode);
  }
  setTransformMode(mode: TransformMode): void {
    this.gizmo.setMode(mode);
    this.dispatchEvent(new Event('transform-mode-changed'));
  }
  get transformMode(): TransformMode {
    return this.gizmo.mode;
  }

  projectViewState(): ProjectViewState {
    return {
      upAxis: this.upAxisValue,
      cameraPosition: this.cameraValue.position.toArray(),
      cameraQuaternion: this.cameraValue.quaternion.toArray(),
      cameraUp: this.cameraValue.up.toArray(),
      cameraTarget: this.cameraRig.controls.target.toArray(),
      cameraMode: this.cameraRig.mode,
      flySpeed: this.cameraRig.flySpeed,
      fov: this.cameraValue.fov,
    };
  }

  restoreProjectViewState(state: ProjectViewState): void {
    this.setUpAxis(state.upAxis);
    this.cameraValue.position.fromArray(state.cameraPosition);
    this.cameraValue.quaternion.fromArray(state.cameraQuaternion);
    this.cameraValue.up.fromArray(state.cameraUp);
    this.setFov(state.fov);
    this.cameraRig.restore(
      state.cameraMode,
      state.flySpeed,
      new Vector3().fromArray(state.cameraTarget),
    );
  }
  setBackground(color: string): void {
    this.scene.background = new Color(color);
  }

  setGridVisible(visible: boolean): void {
    this.grid.setVisible(visible);
  }

  toggleGrid(): void {
    this.setGridVisible(!this.grid.isVisible);
    this.dispatchEvent(new Event('settings-changed'));
  }

  setUpAxis(axis: UpAxis): void {
    this.upAxisValue = axis;
    if (!this.documentValue) return;
    this.applyOrientation();
    const bounds = this.documentValue.getRobustBounds();
    this.fitGrid(bounds.radius);
    this.cameraRig.frame(bounds);
  }

  setFov(value: number): void {
    this.cameraValue.fov = value;
    this.cameraValue.updateProjectionMatrix();
  }

  setRenderScale(scale: number): void {
    this.renderScale = Math.min(2, Math.max(0.25, scale));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * this.renderScale);
    this.resize();
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.clearDocument();
    this.gizmo.dispose();
    this.interactions.dispose();
    this.cameraRig.dispose();
    this.grid.dispose();
    this.renderer.dispose();
    window.removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  get camera(): PerspectiveCamera {
    return this.cameraValue;
  }
  get canvasElement(): HTMLCanvasElement {
    return this.canvas;
  }
  /** Adds a non-document object (gizmo helper, crop box) to the scene. */
  addHelper(object: Object3D): void {
    this.scene.add(object);
  }
  removeHelper(object: Object3D): void {
    this.scene.remove(object);
  }
  /** Registers a predicate; while it returns true, canvas clicks and hovers are ignored. */
  addInteractionGuard(guard: () => boolean): () => void {
    this.interactionGuards.push(guard);
    return (): void => {
      const at = this.interactionGuards.indexOf(guard);
      if (at >= 0) this.interactionGuards.splice(at, 1);
    };
  }
  private get interacting(): boolean {
    return (
      this.toolValue !== 'select' ||
      this.gizmo.isInteracting ||
      this.interactionGuards.some((guard) => guard())
    );
  }

  private applyOrientation(): void {
    const root = this.documentValue?.root;
    if (!root) return;
    if (this.upAxisValue === 'y-down') root.quaternion.set(1, 0, 0, 0);
    else if (this.upAxisValue === 'y-up') root.quaternion.identity();
    else root.quaternion.set(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
    root.updateMatrixWorld(true);
  }

  /** The grid is a fixed world reference: always at the origin on y = 0, only its extent follows the scene. */
  private fitGrid(radius: number): void {
    this.grid.reset(new Vector3(), radius, 0);
  }

  // Only structural changes (add/merge/delete) can change the scene extent; moving a layer never moves the grid.
  private readonly onLayersChanged = (): void => {
    if (this.documentValue) this.fitGrid(this.documentValue.getRobustBounds().radius);
  };

  private readonly resize = (): void => {
    const width = Math.max(this.canvas.clientWidth, 1),
      height = Math.max(this.canvas.clientHeight, 1);
    this.renderer.setSize(width, height, false);
    this.cameraValue.aspect = width / height;
    this.cameraValue.updateProjectionMatrix();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.renderer.setAnimationLoop(null);
    else {
      this.lastFrame = performance.now();
      this.renderer.setAnimationLoop(this.onFrame);
    }
  };
}
