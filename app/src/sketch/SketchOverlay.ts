/**
 * 2D canvas laid over the viewer: the brush cursor (a circle in screen pixels) and the
 * stroke in progress, drawn immediately in screen space so the user sees ink under the
 * pointer while the 3D splats are being placed/committed.
 */
export class SketchOverlay {
  private readonly context: CanvasRenderingContext2D;
  private cursor?: { x: number; y: number; radius: number };
  private stroke?: { colour: string; radius: number; opacity: number; points: number[] };
  private measure?: {
    ax: number;
    ay: number;
    bx: number;
    by: number;
    label: string;
    fixed: boolean;
  };
  private polyline?: {
    points: number[];
    closed: boolean;
    labels: { x: number; y: number; text: string }[];
  };
  private badge?: { x: number; y: number; text: string; accent?: boolean };
  private frame = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly viewerCanvas: HTMLCanvasElement,
  ) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D canvas unavailable');
    this.context = context;
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  /** Canvas-relative pixels. */
  setCursor(x: number, y: number, radius: number): void {
    this.cursor = { x, y, radius };
    this.schedule();
  }

  hideCursor(): void {
    this.cursor = undefined;
    this.schedule();
  }

  beginStroke(colour: string, radius: number, opacity: number): void {
    this.stroke = { colour, radius, opacity, points: [] };
    this.schedule();
  }

  /** Canvas-relative pixels plus pressure 0..1 (line width follows pressure). */
  addPoint(x: number, y: number, pressure = 1): void {
    if (!this.stroke) return;
    this.stroke.points.push(x, y, pressure);
    this.schedule();
  }

  endStroke(): void {
    this.stroke = undefined;
    this.schedule();
  }

  /** An outline in progress (canvas-relative xy pairs) with per-segment labels; undefined clears it. */
  setPolyline(polyline?: {
    points: number[];
    closed: boolean;
    labels: { x: number; y: number; text: string }[];
  }): void {
    this.polyline = polyline;
    this.schedule();
  }

  /** A floating readout (typed dimension, gizmo angle…) at a canvas-relative point; undefined clears it. */
  setBadge(badge?: { x: number; y: number; text: string; accent?: boolean }): void {
    this.badge = badge;
    this.schedule();
  }

  /** A measurement line between two canvas-relative points with a label; undefined clears it. */
  setMeasure(measure?: {
    ax: number;
    ay: number;
    bx: number;
    by: number;
    label: string;
    fixed: boolean;
  }): void {
    this.measure = measure;
    this.schedule();
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
    if (this.frame) cancelAnimationFrame(this.frame);
  }

  private schedule(): void {
    // rAF is paused in hidden tabs; fall back to an immediate draw there.
    if (document.hidden) this.draw();
    else if (!this.frame)
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.draw();
      });
  }

  private readonly resize = (): void => {
    const rect = this.viewerCanvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.draw();
  };

  private draw(): void {
    const ctx = this.context;
    const { width, height } = this.canvas;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.restore();
    const stroke = this.stroke;
    if (stroke && stroke.points.length >= 3) {
      ctx.save();
      ctx.globalAlpha = Math.max(0.15, Math.min(1, stroke.opacity));
      ctx.strokeStyle = stroke.colour;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const pts = stroke.points;
      if (pts.length === 3) {
        ctx.beginPath();
        ctx.arc(pts[0]!, pts[1]!, Math.max(1, stroke.radius * (pts[2] ?? 1)), 0, Math.PI * 2);
        ctx.fillStyle = stroke.colour;
        ctx.fill();
      } else {
        // One segment per pair so pressure can vary the width along the stroke.
        for (let at = 3; at < pts.length; at += 3) {
          ctx.beginPath();
          ctx.lineWidth = Math.max(1, 2 * stroke.radius * (pts[at + 2] ?? 1));
          ctx.moveTo(pts[at - 3]!, pts[at - 2]!);
          ctx.lineTo(pts[at]!, pts[at + 1]!);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
    const polyline = this.polyline;
    if (polyline && polyline.points.length >= 2) {
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const pts = polyline.points;
      ctx.beginPath();
      ctx.moveTo(pts[0]!, pts[1]!);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
      if (polyline.closed) ctx.closePath();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = polyline.closed ? '#b8f34a' : 'rgba(255,255,255,0.95)';
      ctx.stroke();
      if (polyline.closed) {
        ctx.fillStyle = 'rgba(184,243,74,0.12)';
        ctx.fill();
      }
      for (let i = 0; i < pts.length; i += 2) {
        ctx.beginPath();
        ctx.arc(pts[i]!, pts[i + 1]!, i === 0 ? 5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#b8f34a' : '#ffffff';
        ctx.fill();
      }
      ctx.font = '600 11px SFMono-Regular, Consolas, monospace';
      ctx.textBaseline = 'middle';
      for (const label of polyline.labels) {
        const width = ctx.measureText(label.text).width + 10;
        ctx.fillStyle = 'rgba(15,18,17,0.85)';
        ctx.fillRect(label.x - width / 2, label.y - 9, width, 16);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(label.text, label.x - width / 2 + 5, label.y);
      }
      ctx.restore();
    }
    const measure = this.measure;
    if (measure) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.moveTo(measure.ax, measure.ay);
      ctx.lineTo(measure.bx, measure.by);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = measure.fixed ? '#b8f34a' : 'rgba(255,255,255,0.9)';
      ctx.stroke();
      for (const [x, y] of [
        [measure.ax, measure.ay],
        [measure.bx, measure.by],
      ] as const) {
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = measure.fixed ? '#b8f34a' : '#ffffff';
        ctx.fill();
      }
      ctx.font = '600 12px SFMono-Regular, Consolas, monospace';
      const width = ctx.measureText(measure.label).width + 12;
      const lx = (measure.ax + measure.bx) / 2 - width / 2;
      const ly = (measure.ay + measure.by) / 2 - 22;
      ctx.fillStyle = 'rgba(15,18,17,0.9)';
      ctx.fillRect(lx, ly, width, 18);
      ctx.fillStyle = measure.fixed ? '#b8f34a' : '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(measure.label, lx + 6, ly + 9);
      ctx.restore();
    }
    const badge = this.badge;
    if (badge) {
      ctx.save();
      ctx.font = '600 12px SFMono-Regular, Consolas, monospace';
      const width = ctx.measureText(badge.text).width + 12;
      const bx = Math.min(Math.max(badge.x, 4), this.canvas.clientWidth - width - 4);
      const by = Math.max(badge.y, 4);
      ctx.fillStyle = 'rgba(15,18,17,0.9)';
      ctx.fillRect(bx, by, width, 20);
      ctx.strokeStyle = badge.accent ? '#b8f34a' : 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, width - 1, 19);
      ctx.fillStyle = badge.accent ? '#b8f34a' : '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(badge.text, bx + 6, by + 10);
      ctx.restore();
    }
    const cursor = this.cursor;
    if (cursor && cursor.radius <= 1) {
      // Crosshair for picking tools.
      ctx.save();
      ctx.lineWidth = 1;
      for (const [colour, offset] of [
        ['rgba(0,0,0,0.6)', 1],
        ['rgba(255,255,255,0.95)', 0],
      ] as const) {
        ctx.strokeStyle = colour;
        ctx.beginPath();
        ctx.moveTo(cursor.x - 10, cursor.y + offset);
        ctx.lineTo(cursor.x + 10, cursor.y + offset);
        ctx.moveTo(cursor.x + offset, cursor.y - 10);
        ctx.lineTo(cursor.x + offset, cursor.y + 10);
        ctx.stroke();
      }
      ctx.restore();
    } else if (cursor) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, Math.max(1, cursor.radius), 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, Math.max(1, cursor.radius) + 1, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.stroke();
      ctx.restore();
    }
  }
}
