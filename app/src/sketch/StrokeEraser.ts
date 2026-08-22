import { Matrix4 } from 'three';
import type { Document } from '../model/Document';
import { EraseStrokes } from '../model/sketchCommands';
import { CompositeCommand } from '../model/segmentCommands';
import type { ToastLevel } from '../ui/hud';
import { eventPointer, nearestProjectedPoint, pickLayer } from '../viewer/picking';
import type { Viewer } from '../viewer/Viewer';

/** Collects a click/drag gesture and commits all touched vector strokes as one undo step. */
export class StrokeEraser {
  private readonly strokes = new Map<string, Set<string>>();
  private warned = false;

  constructor(
    private readonly viewer: Viewer,
    private readonly document: Document,
    private readonly notify: (message: string, level?: ToastLevel) => void,
  ) {}

  collect(event: PointerEvent): void {
    const rect = this.viewer.canvasElement.getBoundingClientRect();
    const ndc = eventPointer(event, rect);
    const hit =
      pickLayer(this.document, this.viewer.camera, ndc, (layer) => layer.kind === 'sketch') ??
      nearestProjectedPoint(
        this.document,
        this.viewer.camera,
        ndc,
        rect,
        18,
        (layer) => layer.kind === 'sketch',
      );
    if (!hit) {
      const other =
        pickLayer(this.document, this.viewer.camera, ndc) ??
        nearestProjectedPoint(this.document, this.viewer.camera, ndc, rect, 18);
      if (other && !this.warned) {
        this.notify('Not a sketch layer', 'warning');
        this.warned = true;
      }
      return;
    }
    if (hit.layer.locked) {
      if (!this.warned) {
        this.notify('Unlock the sketch layer before erasing.', 'warning');
        this.warned = true;
      }
      return;
    }
    hit.layer.object.updateMatrixWorld(true);
    const local = hit.point
      .clone()
      .applyMatrix4(new Matrix4().copy(hit.layer.object.matrixWorld).invert());
    const index = hit.layer.pickSplat(local);
    if (index < 0) return;
    const stroke = hit.layer.strokes.find(
      (item) => !item.erased && index >= item.range[0] && index < item.range[0] + item.range[1],
    );
    if (!stroke) return;
    const ids = this.strokes.get(hit.layer.id) ?? new Set<string>();
    ids.add(stroke.id);
    this.strokes.set(hit.layer.id, ids);
  }

  finish(): void {
    if (this.strokes.size === 0) return;
    const count = [...this.strokes.values()].reduce((sum, ids) => sum + ids.size, 0);
    const commands = [...this.strokes].map(
      ([layerId, ids]) => new EraseStrokes(this.document, layerId, [...ids]),
    );
    this.document.history.push(
      commands.length === 1
        ? commands[0]!
        : new CompositeCommand(`Erase ${count} strokes`, commands),
    );
  }
}
