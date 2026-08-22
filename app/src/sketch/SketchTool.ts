import { Vector3 } from 'three';
import type { Document } from '../model/Document';
import { LockedLayerError } from '../model/history';
import { firstStrokeCommand, resolveSketchTarget } from '../model/sketchCommands';
import type { SketchTarget } from '../model/sketchCommands';
import type { ToastLevel } from '../ui/hud';
import type { Viewer } from '../viewer/Viewer';
import { localiseStroke, makeWorldStamps } from './bakeStroke';
import { placePoint } from './placement';
import type { PlacementState } from './placement';
import { PRESETS } from './presets';
import { StrokeEraser } from './StrokeEraser';
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
  viewDir: Vector3;
  placement: PlacementState;
  preview: StrokePreview;
  ema?: ScreenPoint;
  accepted?: ScreenPoint;
  points: number[];
  pressures: number[];
  views: number[];
}

interface EraseSession {
  kind: 'erase';
  pointerId: number;
  document: Document;
  eraser: StrokeEraser;
}

type Session = DrawSession | EraseSession;

export interface SketchToolOptions {
  settings: () => StrokeSettings;
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

export class SketchTool {
  private readonly canvas: HTMLCanvasElement;
  private session?: Session;
  private flyWarningShown = false;

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
    }
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
    this.viewer.removeEventListener('tool-changed', this.onToolChanged);
  }

  private readonly onToolChanged = (): void => void this.cancelStroke();

  private readonly onPointerDown = (event: PointerEvent): void => {
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
    this.canvas.setPointerCapture(event.pointerId);
    if (this.viewer.tool === 'erase') {
      this.session = {
        kind: 'erase',
        pointerId: event.pointerId,
        document,
        eraser: new StrokeEraser(this.viewer, document, this.options.notify),
      };
      this.session.eraser.collect(event);
      return;
    }
    const settings = this.options.settings();
    const viewDir = this.viewer.camera.getWorldDirection(new Vector3());
    const id = crypto.randomUUID();
    this.session = {
      kind: 'draw',
      pointerId: event.pointerId,
      document,
      target: resolveSketchTarget(document),
      id,
      settings,
      viewDir,
      placement: { radius: settings.radius, viewDir: viewDir.clone() },
      preview: new StrokePreview(this.viewer, settings, id),
      points: [],
      pressures: [],
      views: [],
    };
    this.acceptDraw(event, true);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const session = this.session;
    if (!session || event.pointerId !== session.pointerId) return;
    const samples = coalescedEvents(event);
    if (session.kind === 'erase') samples.forEach((sample) => session.eraser.collect(sample));
    else samples.forEach((sample) => this.acceptDraw(sample));
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    const session = this.session;
    if (!session || event.pointerId !== session.pointerId) return;
    if (event.type === 'pointerup') {
      if (session.kind === 'draw') this.acceptDraw(event);
      else session.eraser.collect(event);
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
    const world = placePoint(
      this.viewer,
      { clientX: point.x, clientY: point.y },
      session.settings.placement,
      session.placement,
    );
    if (!world) return;
    session.accepted = point;
    const viewDir = this.viewer.camera.getWorldDirection(new Vector3());
    session.preview.appendPoint(world, point.pressure, viewDir);
    session.points.push(world.x, world.y, world.z);
    session.pressures.push(point.pressure);
    session.views.push(viewDir.x, viewDir.y, viewDir.z);
  }

  private finishDraw(session: DrawSession): void {
    session.preview.dispose();
    if (this.viewer.document !== session.document || session.points.length === 0) {
      if (session.target.isNew) session.target.layer.dispose();
      return;
    }
    try {
      const path = new Float32Array(session.points);
      const sampled = resample(
        path,
        PRESETS[session.settings.preset].spacing * session.settings.radius,
      );
      const pressures = resamplePressures(
        path,
        new Float32Array(session.pressures),
        sampled.points,
      );
      const viewDirs = resampleVectors(path, new Float32Array(session.views), sampled.points);
      const stamps = makeWorldStamps(
        sampled.points,
        sampled.tangents,
        pressures,
        session.settings,
        viewDirs,
        session.id,
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
    }
  }

  private finishErase(session: EraseSession): void {
    if (this.viewer.document !== session.document) return;
    try {
      session.eraser.finish();
    } catch (error) {
      this.report(error);
    }
  }

  private release(pointerId: number): void {
    if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
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
