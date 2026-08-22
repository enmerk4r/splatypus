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
