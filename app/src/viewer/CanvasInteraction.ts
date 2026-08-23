import { MOUSE, Vector3 } from 'three';
import type { Viewer } from './Viewer';
import { eventPointer, nearestProjectedPoint, pickLayer } from './picking';
import type { LayerHit } from './picking';

/** Canvas selection/hover routing plus the sketch-mode OrbitControls button override. */
export class CanvasInteraction {
  private pointerDown?: Vector3;
  private pointerDownShift = false;
  private pointerDownInSelect = false;
  private hoverPending?: PointerEvent;
  private hoverLeft = false;
  private lastHover?: PointerEvent;

  constructor(
    private readonly viewer: Viewer,
    private readonly blocked: () => boolean,
  ) {
    const canvas = viewer.canvasElement;
    canvas.addEventListener('dblclick', this.onDoubleClick);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('pointerdown', this.onToolPointerDown, true);
    canvas.addEventListener('pointerup', this.onToolPointerEnd, true);
    canvas.addEventListener('pointercancel', this.onToolPointerEnd, true);
  }

  clearHover(): void {
    this.hoverPending = undefined;
  }

  flushHover(): void {
    if (this.hoverLeft && this.lastHover) {
      this.hoverLeft = false;
      this.viewer.dispatchEvent(
        new CustomEvent('canvas-hover', { detail: { event: this.lastHover } }),
      );
    }
    const event = this.hoverPending;
    if (!event) return;
    this.hoverPending = undefined;
    this.lastHover = event;
    const document = this.viewer.document;
    const hit: LayerHit | undefined =
      document && this.viewer.cameraRig.mode === 'orbit' && !this.blocked()
        ? pickLayer(
            document,
            this.viewer.camera,
            eventPointer(event, this.viewer.canvasElement.getBoundingClientRect()),
          )
        : undefined;
    this.viewer.dispatchEvent(new CustomEvent('canvas-hover', { detail: { event, hit } }));
  }

  dispose(): void {
    const canvas = this.viewer.canvasElement;
    canvas.removeEventListener('dblclick', this.onDoubleClick);
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    canvas.removeEventListener('pointerdown', this.onToolPointerDown, true);
    canvas.removeEventListener('pointerup', this.onToolPointerEnd, true);
    canvas.removeEventListener('pointercancel', this.onToolPointerEnd, true);
  }

  private readonly onDoubleClick = (event: MouseEvent): void => {
    const document = this.viewer.document;
    if (!document || this.viewer.cameraRig.mode !== 'orbit' || this.viewer.tool !== 'select')
      return;
    const rect = this.viewer.canvasElement.getBoundingClientRect();
    const pointer = eventPointer(event, rect);
    const hit =
      pickLayer(document, this.viewer.camera, pointer) ??
      nearestProjectedPoint(document, this.viewer.camera, pointer, rect);
    if (hit) this.viewer.cameraRig.retarget(hit.point);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointerDown = new Vector3(event.clientX, event.clientY, event.button);
    this.pointerDownShift = event.shiftKey;
    this.pointerDownInSelect = this.viewer.tool === 'select';
  };

  /** Capture phase runs before OrbitControls sees the pointer-down. */
  private readonly onToolPointerDown = (event: PointerEvent): void => {
    if (this.viewer.tool !== 'select' && event.button === 0 && event.altKey)
      this.viewer.cameraRig.controls.mouseButtons.LEFT = MOUSE.ROTATE;
  };

  private readonly onToolPointerEnd = (): void => {
    if (this.viewer.tool !== 'select') this.viewer.cameraRig.controls.mouseButtons.LEFT = null;
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.hoverPending = event.buttons === 0 ? event : undefined;
  };

  private readonly onPointerLeave = (): void => {
    this.hoverPending = undefined;
    this.hoverLeft = true;
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const start = this.pointerDown;
    const additive = event.shiftKey || this.pointerDownShift;
    const startedInSelect = this.pointerDownInSelect;
    this.pointerDown = undefined;
    this.pointerDownShift = false;
    this.pointerDownInSelect = false;
    const document = this.viewer.document;
    // A tool that finishes on pointer-down (e.g. the outline tool creating a face) may switch
    // to Select before this pointer-up: that click belongs to the tool, not to selection.
    if (
      !start ||
      !startedInSelect ||
      !document ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      this.viewer.cameraRig.mode !== 'orbit' ||
      this.blocked()
    )
      return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
    const rect = this.viewer.canvasElement.getBoundingClientRect();
    const pointer = eventPointer(event, rect);
    const hit =
      pickLayer(document, this.viewer.camera, pointer) ??
      nearestProjectedPoint(document, this.viewer.camera, pointer, rect);
    if (additive && hit) {
      const next = new Set(document.selection);
      if (next.has(hit.layer.id)) next.delete(hit.layer.id);
      else next.add(hit.layer.id);
      document.setSelection([...next]);
    } else document.setSelection(hit ? [hit.layer.id] : []);
    this.viewer.dispatchEvent(
      new CustomEvent('canvas-click', { detail: { event, hit, additive } }),
    );
  };
}
