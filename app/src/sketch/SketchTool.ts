import { Vector3 } from 'three';
import type { Document } from '../model/Document';
import { LockedLayerError } from '../model/history';
import { firstStrokeCommand, resolveSketchTarget } from '../model/sketchCommands';
import type { SketchTarget } from '../model/sketchCommands';
import type { ToastLevel } from '../ui/hud';
import type { Viewer } from '../viewer/Viewer';
import { localiseStroke, makeWorldStamps } from './bakeStroke';
import { DepthGrid } from './depthGrid';
import { placePoint } from './placement';
import type { PlacementState } from './placement';
import { PRESETS } from './presets';
import { EraseBrush } from './EraseBrush';
import type { SketchOverlay } from './SketchOverlay';
import { StrokePreview } from './StrokePreview';
import { resample, resamplePressures, resampleVectors } from './stroke';
import type { ScreenPoint, StrokeSettings } from './stroke';

interface DrawSession {
  kind: 'draw';
  pointerId: number;
  document: Document;
  target: SketchTarget;
  id: string;
  settings: StrokeSettings;
  placement: PlacementState;
  preview: StrokePreview;
  ema?: ScreenPoint;
  accepted?: ScreenPoint;
  points: number[];
  pressures: number[];
  radii: number[];
  views: number[];
}

interface EraseSession {
  kind: 'erase';
  pointerId: number;
  document: Document;
  brush: EraseBrush;
}

type Session = DrawSession | EraseSession;

export interface SketchToolOptions {
  settings: () => StrokeSettings;
  /** CSS colour of the current brush, for the screen-space overlay. */
  colourCss: () => string;
  overlay: SketchOverlay;
  notify: (message: string, level?: ToastLevel) => void;
}

function pointerPressure(event: PointerEvent): number {
  return event.pointerType === 'mouse' ? 1 : Math.min(1, Math.max(0, event.pressure));
}

function coalescedEvents(event: PointerEvent): PointerEvent[] {
  const candidate = event as unknown as { getCoalescedEvents?: () => PointerEvent[] };
  const coalesced = candidate.getCoalescedEvents?.() ?? [];
  return coalesced.length > 0 ? coalesced : [event];
}

/**
 * Sketch/erase pointer tool. While a stroke is drawn the camera is locked and the stroke is
 * shown immediately in screen space (overlay) plus a cheap 3D preview; placement uses a
 * depth image built once at pointer-down, so no per-sample raycasts. On release the stroke
 * is resampled, stamped, committed as an undoable command, and the camera unlocks.
 */
export class SketchTool {
  private readonly canvas: HTMLCanvasElement;
  private session?: Session;
  private flyWarningShown = false;
  /** Depth image reused across strokes while the camera and scene stay put. */
  private depthCache?: { key: string; grid: DepthGrid };

  constructor(
    private readonly viewer: Viewer,
    private readonly options: SketchToolOptions,
  ) {
    this.canvas = viewer.canvasElement;
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerEnd);
    this.canvas.addEventListener('pointercancel', this.onPointerEnd);
    this.canvas.addEventListener('lostpointercapture', this.onPointerEnd);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.viewer.addEventListener('tool-changed', this.onToolChanged);
  }

  get isDrawing(): boolean {
    return this.session?.kind === 'draw';
  }

  cancelStroke(): boolean {
    const session = this.session;
    if (!session) return false;
    this.session = undefined;
    if (session.kind === 'draw') {
      session.preview.dispose();
      if (session.target.isNew) session.target.layer.dispose();
    } else {
      session.brush.cancel();
    }
    this.options.overlay.endStroke();
    this.viewer.lockCamera(false);
    this.release(session.pointerId);
    return true;
  }

  dispose(): void {
    this.cancelStroke();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerEnd);
    this.canvas.removeEventListener('pointercancel', this.onPointerEnd);
    this.canvas.removeEventListener('lostpointercapture', this.onPointerEnd);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.viewer.removeEventListener('tool-changed', this.onToolChanged);
  }

  private readonly onToolChanged = (): void => {
    this.cancelStroke();
    if (this.viewer.tool === 'select') this.options.overlay.hideCursor();
  };

  private readonly onPointerLeave = (): void => this.options.overlay.hideCursor();

  private updateCursor(event: PointerEvent): void {
    if (this.viewer.tool === 'select') return;
    const rect = this.canvas.getBoundingClientRect();
    this.options.overlay.setCursor(
      event.clientX - rect.left,
      event.clientY - rect.top,
      this.options.settings().radiusPx,
    );
  }

  private depthGridFor(document: Document): DepthGrid {
    const rect = this.canvas.getBoundingClientRect();
    const camera = this.viewer.camera;
    camera.updateMatrixWorld(true);
    const key = [
      ...camera.matrixWorld.elements.map((value) => value.toFixed(5)),
      camera.fov,
      rect.width,
      rect.height,
      document.layers
        .map((layer) => `${layer.id}:${layer.visible}:${layer.store.liveCount()}`)
        .join(','),
    ].join('|');
    if (this.depthCache?.key !== key) {
      const started = performance.now();
      const grid = DepthGrid.build(document, camera, rect.width, rect.height);
      this.depthCache = { key, grid };
      console.info(`Sketch depth image built in ${(performance.now() - started).toFixed(0)} ms`);
    }
    return this.depthCache.grid;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.updateCursor(event);
    if (this.viewer.tool === 'select' || event.button !== 0 || event.altKey || this.session) return;
    if (this.viewer.cameraRig.mode !== 'orbit') {
      if (!this.flyWarningShown) {
        this.options.notify('Switch to orbit mode (Tab) before drawing.', 'warning');
        this.flyWarningShown = true;
      }
      return;
    }
    const document = this.viewer.document;
    if (!document) return;
    this.flyWarningShown = false;
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers (tests/automation) have no capture; drawing still works.
    }
    if (this.viewer.tool === 'erase') {
      const brush = EraseBrush.begin(
        this.viewer,
        document,
        this.options.settings().radiusPx,
        this.options.notify,
      );
      if (!brush) return;
      // The screen index assumes a fixed camera for the whole gesture.
      this.viewer.lockCamera(true);
      this.session = { kind: 'erase', pointerId: event.pointerId, document, brush };
      this.eraseAt(event);
      return;
    }
    const settings = this.options.settings();
    const viewDir = this.viewer.camera.getWorldDirection(new Vector3());
    const id = crypto.randomUUID();
    // Lock the view for the whole stroke: placement, preview and the overlay all assume a fixed camera.
    this.viewer.lockCamera(true);
    this.session = {
      kind: 'draw',
      pointerId: event.pointerId,
      document,
      target: resolveSketchTarget(document),
      id,
      settings,
      placement: {
        radiusPx: settings.radiusPx,
        viewDir: viewDir.clone(),
        ...(settings.placement === 'surface' ? { depthGrid: this.depthGridFor(document) } : {}),
      },
      preview: new StrokePreview(this.viewer, settings, id),
      points: [],
      pressures: [],
      radii: [],
      views: [],
    };
    this.options.overlay.beginStroke(
      this.options.colourCss(),
      settings.radiusPx,
      PRESETS[settings.preset].opacity * settings.opacity,
    );
    this.acceptDraw(event, true);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.updateCursor(event);
    const session = this.session;
    if (!session || event.pointerId !== session.pointerId) return;
    const samples = coalescedEvents(event);
    if (session.kind === 'erase') samples.forEach((sample) => this.eraseAt(sample));
    else samples.forEach((sample) => this.acceptDraw(sample));
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    const session = this.session;
    if (!session || event.pointerId !== session.pointerId) return;
    if (event.type === 'pointerup') {
      if (session.kind === 'draw') this.acceptDraw(event);
      else this.eraseAt(event);
    }
    this.session = undefined;
    if (session.kind === 'draw') this.finishDraw(session);
    else this.finishErase(session);
    this.release(session.pointerId);
  };

  private acceptDraw(event: PointerEvent, force = false): void {
    const session = this.session;
    if (session?.kind !== 'draw') return;
    const raw = { x: event.clientX, y: event.clientY, pressure: pointerPressure(event) };
    const previous = session.ema;
    const point = previous
      ? {
          x: previous.x + (raw.x - previous.x) * 0.5,
          y: previous.y + (raw.y - previous.y) * 0.5,
          pressure: previous.pressure + (raw.pressure - previous.pressure) * 0.5,
        }
      : raw;
    session.ema = point;
    if (
      !force &&
      session.accepted &&
      Math.hypot(point.x - session.accepted.x, point.y - session.accepted.y) < 1.5
    )
      return;
    const placed = placePoint(
      this.viewer,
      { clientX: point.x, clientY: point.y },
      session.settings.placement,
      session.placement,
    );
    if (!placed) return;
    session.accepted = point;
    // The world radius of the first sample defines the stroke's spacing and stored size.
    if (session.points.length === 0) session.settings.radius = placed.radius;
    const rect = this.canvas.getBoundingClientRect();
    this.options.overlay.addPoint(
      point.x - rect.left,
      point.y - rect.top,
      session.settings.pressure ? 0.4 + 0.6 * point.pressure : 1,
    );
    const viewDir = session.placement.viewDir;
    session.preview.appendPoint(placed.point, point.pressure, viewDir, placed.radius);
    session.points.push(placed.point.x, placed.point.y, placed.point.z);
    session.pressures.push(point.pressure);
    session.radii.push(placed.radius);
    session.views.push(viewDir.x, viewDir.y, viewDir.z);
  }

  private finishDraw(session: DrawSession): void {
    session.preview.dispose();
    this.options.overlay.endStroke();
    try {
      if (this.viewer.document !== session.document || session.points.length === 0) {
        if (session.target.isNew) session.target.layer.dispose();
        return;
      }
      const path = new Float32Array(session.points);
      const spacing =
        PRESETS[session.settings.preset].spacing * Math.max(session.settings.radius, 1e-6);
      const sampled = resample(path, spacing);
      const pressures = resamplePressures(
        path,
        new Float32Array(session.pressures),
        sampled.points,
      );
      const radii = resamplePressures(path, new Float32Array(session.radii), sampled.points);
      const viewDirs = resampleVectors(path, new Float32Array(session.views), sampled.points);
      const stamps = makeWorldStamps(
        sampled.points,
        sampled.tangents,
        pressures,
        session.settings,
        viewDirs,
        session.id,
        radii,
      );
      const baked = localiseStroke(
        session.document,
        session.target.layer,
        { id: session.id, settings: session.settings, pressures },
        sampled.points,
        stamps,
      );
      session.document.history.push(
        firstStrokeCommand(session.document, session.target, baked.stroke, baked.splats),
      );
      session.document.setSelection([session.target.layer.id]);
    } catch (error) {
      if (session.target.isNew && !session.document.getLayer(session.target.layer.id))
        session.target.layer.dispose();
      this.report(error);
    } finally {
      this.viewer.lockCamera(false);
    }
  }

  private eraseAt(event: PointerEvent): void {
    const session = this.session;
    if (session?.kind !== 'erase') return;
    const rect = this.canvas.getBoundingClientRect();
    session.brush.moveTo(event.clientX - rect.left, event.clientY - rect.top);
  }

  private finishErase(session: EraseSession): void {
    try {
      if (this.viewer.document === session.document) session.brush.finish();
      else session.brush.cancel();
    } catch (error) {
      this.report(error);
    } finally {
      this.viewer.lockCamera(false);
    }
  }

  private release(pointerId: number): void {
    try {
      if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
    } catch {
      // Synthetic pointers (tests/automation) have no capture.
    }
  }

  private report(error: unknown): void {
    const locked = error instanceof LockedLayerError;
    this.options.notify(
      error instanceof Error ? error.message : 'The sketch action failed.',
      locked ? 'warning' : 'error',
    );
    if (!locked) console.error(error);
  }
}
