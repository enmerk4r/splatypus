import type { MaskImage } from './maskLift';

/**
 * The 2D half of the selection, drawn over the canvas: the mask SAM proposed, plus the
 * clicks that produced it.
 *
 * Showing the 2D mask before it is lifted is what makes the tool correctable — the user
 * can see that SAM grabbed the wall as well as the chair and place a negative click, rather
 * than committing and wondering why the split came out wrong.
 */
export class MaskOverlay {
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private mask?: MaskImage;
  private points: { x: number; y: number; positive: boolean }[] = [];

  constructor(private readonly host: HTMLCanvasElement) {
    this.canvas.className = 'mask-overlay';
    this.canvas.setAttribute('aria-hidden', 'true');
    document.body.append(this.canvas);
    this.context = this.canvas.getContext('2d')!;
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  setMask(mask: MaskImage | undefined): void {
    this.mask = mask;
    this.draw();
  }

  setPoints(points: readonly { x: number; y: number; positive: boolean }[]): void {
    this.points = [...points];
    this.draw();
  }

  clear(): void {
    this.mask = undefined;
    this.points = [];
    this.draw();
  }

  setVisible(visible: boolean): void {
    this.canvas.style.display = visible ? '' : 'none';
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
    this.canvas.remove();
  }

  private readonly resize = (): void => {
    const rect = this.host.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    Object.assign(this.canvas.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    this.draw();
  };

  private draw(): void {
    const { width, height } = this.canvas;
    this.context.clearRect(0, 0, width, height);
    if (this.mask) this.drawMask(this.mask, width, height);
    this.drawPoints(width / Math.max(this.host.clientWidth, 1));
  }

  /**
   * The mask arrives at the captured frame's resolution, which is rarely the canvas
   * resolution — so it is painted into an offscreen bitmap at its own size and let the
   * 2D context scale it. `imageSmoothingEnabled = false` keeps the boundary honest instead
   * of feathering it into something that looks more confident than it is.
   */
  private drawMask(mask: MaskImage, width: number, height: number): void {
    const image = this.context.createImageData(mask.width, mask.height);
    for (let pixel = 0; pixel < mask.width * mask.height; pixel += 1) {
      if (!mask.data[pixel]) continue;
      const at = pixel * 4;
      image.data[at] = 184;
      image.data[at + 1] = 243;
      image.data[at + 2] = 74;
      image.data[at + 3] = 90;
    }
    const scratch = document.createElement('canvas');
    scratch.width = mask.width;
    scratch.height = mask.height;
    scratch.getContext('2d')!.putImageData(image, 0, 0);
    this.context.imageSmoothingEnabled = false;
    this.context.drawImage(scratch, 0, 0, width, height);
  }

  private drawPoints(ratio: number): void {
    for (const point of this.points) {
      const x = point.x * ratio;
      const y = point.y * ratio;
      const radius = 6 * ratio;
      this.context.beginPath();
      this.context.arc(x, y, radius, 0, Math.PI * 2);
      this.context.fillStyle = point.positive ? '#b8f34a' : '#ff6b6b';
      this.context.fill();
      this.context.lineWidth = 2 * ratio;
      this.context.strokeStyle = '#101418';
      this.context.stroke();
      // A minus bar marks the negative clicks, so the two kinds stay distinguishable
      // for anyone who cannot rely on the colour difference.
      if (!point.positive) {
        this.context.beginPath();
        this.context.moveTo(x - radius * 0.5, y);
        this.context.lineTo(x + radius * 0.5, y);
        this.context.strokeStyle = '#101418';
        this.context.stroke();
      }
    }
  }
}
