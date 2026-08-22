import type { Segmentation } from './Segmentation';
import type { Viewer } from '../viewer/Viewer';

export type ScreenSelectionMode = 'pointer' | 'rectangle' | 'lasso' | 'polygon' | 'brush';

interface Point {
  x: number;
  y: number;
}

const distanceToSegment = (point: Point, from: Point, to: Point): number => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  const amount = lengthSquared
    ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared))
    : 0;
  return Math.hypot(point.x - (from.x + dx * amount), point.y - (from.y + dy * amount));
};

const insidePolygon = (point: Point, polygon: readonly Point[]): boolean => {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index]!;
    const b = polygon[previous]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1) + a.x
    )
      inside = !inside;
  }
  return inside;
};

export class ScreenSelection {
  private modeValue: ScreenSelectionMode = 'pointer';
  private points: Point[] = [];
  private dragging = false;
  private additive = false;
  private readonly overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private readonly shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');

  constructor(
    private readonly viewer: Viewer,
    private readonly segmentation: Segmentation,
  ) {
    this.overlay.classList.add('selection-overlay');
    this.overlay.setAttribute('aria-hidden', 'true');
    this.shape.classList.add('selection-shape');
    this.overlay.append(this.shape);
    document.body.append(this.overlay);
    const canvas = viewer.canvasElement;
    canvas.addEventListener('pointerdown', this.onPointerDown, true);
    canvas.addEventListener('pointermove', this.onPointerMove, true);
    canvas.addEventListener('pointerup', this.onPointerUp, true);
    canvas.addEventListener('dblclick', this.onDoubleClick, true);
    window.addEventListener('keydown', this.onKeyDown);
  }

  get mode(): ScreenSelectionMode {
    return this.modeValue;
  }

  setMode(mode: ScreenSelectionMode): void {
    this.cancel();
    this.modeValue = mode;
    this.viewer.canvasElement.classList.toggle('region-selecting', mode !== 'pointer');
  }

  dispose(): void {
    const canvas = this.viewer.canvasElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown, true);
    canvas.removeEventListener('pointermove', this.onPointerMove, true);
    canvas.removeEventListener('pointerup', this.onPointerUp, true);
    canvas.removeEventListener('dblclick', this.onDoubleClick, true);
    window.removeEventListener('keydown', this.onKeyDown);
    canvas.classList.remove('region-selecting');
    this.overlay.remove();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.modeValue === 'pointer' || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.additive = event.shiftKey;
    const point = { x: event.clientX, y: event.clientY };
    if (this.modeValue === 'polygon') {
      this.points.push(point);
      this.draw(false);
      return;
    }
    this.points = [point];
    this.dragging = true;
    this.viewer.canvasElement.setPointerCapture(event.pointerId);
    this.draw(false);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.modeValue === 'pointer') return;
    if (this.modeValue === 'polygon') {
      if (this.points.length) this.draw(false, { x: event.clientX, y: event.clientY });
      return;
    }
    if (!this.dragging) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const point = { x: event.clientX, y: event.clientY };
    if (this.modeValue === 'rectangle') this.points[1] = point;
    else this.points.push(point);
    this.draw(false);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.modeValue === 'pointer' || this.modeValue === 'polygon' || !this.dragging) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.dragging = false;
    if (this.viewer.canvasElement.hasPointerCapture(event.pointerId))
      this.viewer.canvasElement.releasePointerCapture(event.pointerId);
    this.finish();
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    if (this.modeValue !== 'polygon') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.finish();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.modeValue === 'pointer') return;
    if (event.key === 'Escape') this.cancel();
    if (event.key === 'Enter' && this.modeValue === 'polygon') this.finish();
  };

  private finish(): void {
    const points = [...this.points];
    if (points.length < 2) {
      this.cancel();
      return;
    }
    if (this.modeValue === 'rectangle') {
      const from = points[0]!;
      const to = points.at(-1)!;
      const left = Math.min(from.x, to.x);
      const right = Math.max(from.x, to.x);
      const top = Math.min(from.y, to.y);
      const bottom = Math.max(from.y, to.y);
      this.segmentation.selectProjected(
        (x, y) => x >= left && x <= right && y >= top && y <= bottom,
        this.additive,
      );
    } else if (this.modeValue === 'brush') {
      const radius = 18;
      this.segmentation.selectProjected(
        (x, y) =>
          points.some((point, index) =>
            index ? distanceToSegment({ x, y }, points[index - 1]!, point) <= radius : false,
          ),
        this.additive,
      );
    } else {
      this.segmentation.selectProjected((x, y) => insidePolygon({ x, y }, points), this.additive);
    }
    this.cancel();
  }

  private cancel(): void {
    this.points = [];
    this.dragging = false;
    this.shape.removeAttribute('d');
    this.overlay.classList.remove('visible', 'brush');
  }

  private draw(close: boolean, preview?: Point): void {
    const points = preview ? [...this.points, preview] : this.points;
    if (!points.length) return;
    let path: string;
    if (this.modeValue === 'rectangle' && points.length > 1) {
      const a = points[0]!;
      const b = points.at(-1)!;
      path = `M${a.x} ${a.y}H${b.x}V${b.y}H${a.x}Z`;
    } else {
      path = points.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' ');
      if (close) path += 'Z';
    }
    this.shape.setAttribute('d', path);
    this.overlay.classList.add('visible');
    this.overlay.classList.toggle('brush', this.modeValue === 'brush');
  }
}
