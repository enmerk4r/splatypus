import type { LoadProgress } from '../io/loadSplat';
import type { SplatDocument } from '../viewer/SplatDocument';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return 'size unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent] ?? 'B'}`;
}

export class Hud {
  private readonly fps: HTMLElement;
  private readonly count: HTMLElement;
  private readonly file: HTMLElement;
  private readonly status: HTMLElement;
  private readonly progressTrack: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly toastRegion: HTMLElement;
  private frameCount = 0;
  private sampleStarted = performance.now();

  constructor(root: HTMLElement, toastRegion: HTMLElement) {
    this.fps = root.querySelector<HTMLElement>('#hud-fps')!;
    this.count = root.querySelector<HTMLElement>('#hud-count')!;
    this.file = root.querySelector<HTMLElement>('#hud-file')!;
    this.status = root.querySelector<HTMLElement>('#hud-status')!;
    this.progressTrack = root.querySelector<HTMLElement>('#progress-track')!;
    this.progressBar = root.querySelector<HTMLElement>('#progress-bar')!;
    this.toastRegion = toastRegion;
  }

  tick(now: number): void {
    this.frameCount += 1;
    const elapsed = now - this.sampleStarted;
    if (elapsed < 1000) return;
    this.fps.textContent = String(Math.round((this.frameCount * 1000) / elapsed));
    this.frameCount = 0;
    this.sampleStarted = now;
  }

  setDocument(document?: SplatDocument): void {
    this.count.textContent = document ? document.numSplats.toLocaleString() : '—';
    this.file.textContent = document
      ? `${document.name} · ${formatBytes(document.byteLength)}`
      : 'No scene';
    this.file.title = document?.name ?? '';
  }

  setProgress(progress: LoadProgress): void {
    this.progressTrack.hidden = false;
    const determinate =
      progress.phase === 'loading' && progress.total !== undefined && progress.total > 0;
    this.progressTrack.classList.toggle('indeterminate', !determinate);
    if (determinate) {
      const percentage = Math.min(
        100,
        Math.round(((progress.loaded ?? 0) / progress.total!) * 100),
      );
      this.progressBar.style.width = `${percentage}%`;
      this.status.textContent = `Loading ${percentage}%`;
    } else {
      this.progressBar.style.width = '';
      this.status.textContent = progress.phase === 'parsing' ? 'Parsing…' : 'Loading…';
    }
  }

  setReady(): void {
    this.status.textContent = 'Ready';
    this.progressTrack.hidden = true;
    this.progressTrack.classList.remove('indeterminate');
  }

  setError(): void {
    this.status.textContent = 'Error';
    this.progressTrack.hidden = true;
  }

  toast(message: string): void {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    this.toastRegion.append(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    window.setTimeout(() => {
      toast.classList.remove('visible');
      window.setTimeout(() => toast.remove(), 250);
    }, 5500);
  }
}
