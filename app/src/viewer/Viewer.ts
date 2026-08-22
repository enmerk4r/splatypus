import { Color, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import type { Object3D } from 'three';
import { SparkRenderer } from '@sparkjsdev/spark';
import type { Document } from '../model/Document';
import { CameraRig } from './CameraRig';
import type { AxisView, CameraMode } from './CameraRig';
import { LayerGizmo } from './LayerGizmo';
import type { TransformMode } from './LayerGizmo';
import { eventPointer, nearestProjectedPoint, pickLayer } from './picking';
import type { LayerHit } from './picking';
import { GridFloor } from './GridFloor';

export class WebGLUnavailableError extends Error {}
export type UpAxis = 'y-down' | 'y-up' | 'z-up';

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
  private readonly onFrame: (now: number) => void;
  private documentValue?: Document;
  private upAxisValue: UpAxis = 'y-down';
  private renderScale = 1;
  private lastFrame = performance.now();
  private pointerDown?: Vector3;
  /** Latest pointer move, coalesced to one hover raycast per frame. */
  private hoverPending?: PointerEvent;
  private hoverLeft = false;
  private lastHover?: PointerEvent;
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
    this.cameraRig = new CameraRig(this.cameraValue, canvas);
    this.gizmo = new LayerGizmo(this.scene, this.cameraValue, canvas, this.cameraRig);
    this.grid = new GridFloor(this.scene);
    this.grid.reset(new Vector3(), 1, 0);

    this.onFrame = (now): void => {
      const deltaSeconds = Math.min((now - this.lastFrame) / 1000, 0.1);
      this.lastFrame = now;
      this.cameraRig.update(deltaSeconds);
      this.flushHover();
      this.renderer.render(this.scene, this.cameraValue);
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
    this.cameraRig.dispose();
    this.grid.dispose();
    this.renderer.dispose();
    window.removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
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
    return this.gizmo.isInteracting || this.interactionGuards.some((guard) => guard());
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

  private readonly onDoubleClick = (event: MouseEvent): void => {
    const document = this.documentValue;
    if (!document || this.cameraRig.mode !== 'orbit') return;
    const rect = this.canvas.getBoundingClientRect();
    const pointer = eventPointer(event, rect);
    const hit =
      pickLayer(document, this.cameraValue, pointer) ??
      nearestProjectedPoint(document, this.cameraValue, pointer, rect);
    if (hit) this.cameraRig.retarget(hit.point);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointerDown = new Vector3(event.clientX, event.clientY, event.button);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    // Buttons down means an orbit or gizmo drag, not a hover.
    this.hoverPending = event.buttons === 0 ? event : undefined;
  };

  private readonly onPointerLeave = (): void => {
    this.hoverPending = undefined;
    this.hoverLeft = true;
  };

  /** Runs at most one hover raycast per frame and reports it as `canvas-hover` {event, hit?}. */
  private flushHover(): void {
    if (this.hoverLeft && this.lastHover) {
      this.hoverLeft = false;
      this.dispatchEvent(new CustomEvent('canvas-hover', { detail: { event: this.lastHover } }));
    }
    const event = this.hoverPending;
    if (!event) return;
    this.hoverPending = undefined;
    this.lastHover = event;
    const document = this.documentValue;
    const hit: LayerHit | undefined =
      document && this.cameraRig.mode === 'orbit' && !this.interacting
        ? pickLayer(
            document,
            this.cameraValue,
            eventPointer(event, this.canvas.getBoundingClientRect()),
          )
        : undefined;
    this.dispatchEvent(new CustomEvent('canvas-hover', { detail: { event, hit } }));
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    const start = this.pointerDown;
    this.pointerDown = undefined;
    const document = this.documentValue;
    if (
      !start ||
      !document ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      this.cameraRig.mode !== 'orbit' ||
      this.interacting // a click on a gizmo handle must not change the selection
    )
      return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
    const rect = this.canvas.getBoundingClientRect();
    const pointer = eventPointer(event, rect);
    // Spark's raycast misses sparse point clouds (the ray slips between tiny gaussians), so fall
    // back to the nearest projected centre within a few pixels — same as double-click retargeting.
    const hit =
      pickLayer(document, this.cameraValue, pointer) ??
      nearestProjectedPoint(document, this.cameraValue, pointer, rect);
    document.setSelection(hit ? [hit.layer.id] : []);
    this.dispatchEvent(new CustomEvent('canvas-click', { detail: { event, hit } }));
  };
}
