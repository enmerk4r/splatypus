import type { Document } from '../model/Document';
import type { LoadProgress } from '../io/loadSplat';

export class Hud {
  private readonly fps: HTMLElement;
  private readonly count: HTMLElement;
  private readonly file: HTMLElement;
  private readonly status: HTMLElement;
  private readonly gpu: HTMLElement;
  private readonly progressTrack: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly toastRegion: HTMLElement;
  private document?: Document;
  private frameCount = 0;
  private sampleStarted = performance.now();

  constructor(root: HTMLElement, toastRegion: HTMLElement) {
    this.fps = root.querySelector<HTMLElement>('#hud-fps')!;
    this.count = root.querySelector<HTMLElement>('#hud-count')!;
    this.file = root.querySelector<HTMLElement>('#hud-file')!;
    this.status = root.querySelector<HTMLElement>('#hud-status')!;
    this.gpu = root.querySelector<HTMLElement>('#hud-gpu')!;
    this.progressTrack = root.querySelector<HTMLElement>('#progress-track')!;
    this.progressBar = root.querySelector<HTMLElement>('#progress-bar')!;
    this.toastRegion = toastRegion;
  }

  setGpu(name: string): void {
    this.gpu.textContent = name;
    this.gpu.title = name;
  }

  tick(now: number): void {
    this.frameCount += 1;
    const elapsed = now - this.sampleStarted;
    if (elapsed < 1000) return;
    this.fps.textContent = String(Math.round((this.frameCount * 1000) / elapsed));
    this.frameCount = 0;
    this.sampleStarted = now;
  }

  setDocument(document?: Document): void {
    this.document?.removeEventListener('layers-changed', this.refreshDocument);
    this.document?.removeEventListener('layer-changed', this.refreshDocument);
    this.document?.removeEventListener('history-changed', this.onHistoryChanged);
    this.document = document;
    document?.addEventListener('layers-changed', this.refreshDocument);
    document?.addEventListener('layer-changed', this.refreshDocument);
    document?.addEventListener('history-changed', this.onHistoryChanged);
    this.refreshDocument();
  }

  setProgress(progress: LoadProgress): void {
    this.progressTrack.hidden = false;
    const determinate = progress.total !== undefined && progress.total > 0;
    this.progressTrack.classList.toggle('indeterminate', !determinate);
    if (determinate) {
      const percentage = Math.min(
        100,
        Math.round(((progress.loaded ?? 0) / progress.total!) * 100),
      );
      this.progressBar.style.width = `${percentage}%`;
      this.status.textContent = `${progress.phase === 'parsing' ? 'Parsing' : 'Loading'} ${percentage}%`;
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
    const toast = this.makeToast(message);
    window.setTimeout(() => this.dismiss(toast), 5500);
  }

  confirm(message: string, actionLabel: string): Promise<boolean> {
    return new Promise((resolve) => {
      const toast = this.makeToast(message, true);
      const actions = document.createElement('div');
      actions.className = 'toast-actions';
      const accept = document.createElement('button');
      accept.type = 'button';
      accept.textContent = actionLabel;
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      actions.append(accept, cancel);
      toast.append(actions);
      const finish = (value: boolean): void => {
        this.dismiss(toast);
        resolve(value);
      };
      accept.addEventListener('click', () => finish(true), { once: true });
      cancel.addEventListener('click', () => finish(false), { once: true });
    });
  }

  private readonly refreshDocument = (): void => {
    const current = this.document;
    this.count.textContent = current
      ? `${current.layers.length} layer${current.layers.length === 1 ? '' : 's'} · ${current.totalLive().toLocaleString()} splats${current.hiddenCount() ? ` (${current.hiddenCount().toLocaleString()} hidden)` : ''}`
      : '—';
    this.file.textContent = current?.name ?? 'No scene';
    this.file.title = current?.name ?? '';
  };

  private readonly onHistoryChanged = (event: Event): void => {
    const { action, label } = (event as CustomEvent<{ action: string; label: string }>).detail;
    if ((action === 'undo' || action === 'redo') && label)
      this.toast(`${action === 'undo' ? 'Undo' : 'Redo'}: ${label}`);
  };

  private makeToast(message: string, persistent = false): HTMLElement {
    const toast = document.createElement('div');
    toast.className = `toast${persistent ? ' toast-persistent' : ''}`;
    const text = document.createElement('span');
    text.textContent = message;
    toast.append(text);
    this.toastRegion.append(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    return toast;
  }

  private dismiss(toast: HTMLElement): void {
    toast.classList.remove('visible');
    window.setTimeout(() => toast.remove(), 250);
  }
}
