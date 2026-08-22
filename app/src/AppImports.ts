import { Document } from './model/Document';
import { AddLayers, SetPointBudget } from './model/commands';
import { SplatStore } from './model/SplatStore';
import { decodeFile } from './io/decode';
import { loadSplat } from './io/loadSplat';
import type { LoadOptions, SplatSource } from './io/loadSplat';
import type { Hud } from './ui/hud';
import type { Viewer } from './viewer/Viewer';
import { LOD_ABOVE_SPLATS } from './viewer/sync';

type Loaded = Awaited<ReturnType<typeof loadSplat>>;

export class AppImports {
  private sequence = 0;
  constructor(
    private readonly viewer: Viewer,
    private readonly hud: Hud,
    private readonly emptyState: HTMLElement,
  ) {}

  async open(source: SplatSource, options: LoadOptions = {}): Promise<void> {
    if (!(await this.allowReplace())) return;
    const sequence = ++this.sequence;
    this.emptyState.classList.add('loading');
    this.hud.setProgress({ phase: 'loading' });
    try {
      const loaded = await loadSplat(
        source,
        (progress) => {
          if (sequence === this.sequence) this.hud.setProgress(progress);
        },
        options,
      );
      if (sequence !== this.sequence) {
        loaded.layer.dispose();
        return;
      }
      const next = new Document(loaded.name);
      next.addLayer(loaded.layer);
      next.setSelection([loaded.layer.id]);
      next.history.clear();
      this.viewer.setDocument(next);
      this.emptyState.hidden = true;
      this.hud.setReady();
      this.showLoadNotes(loaded);
    } catch (error) {
      if (sequence !== this.sequence) return;
      console.error(error);
      this.hud.setError();
      this.hud.toast(error instanceof Error ? error.message : 'The splat could not be opened.');
      this.emptyState.hidden = Boolean(this.viewer.document);
    } finally {
      if (sequence === this.sequence) this.emptyState.classList.remove('loading');
    }
  }

  async add(files: File[]): Promise<void> {
    const sequence = ++this.sequence;
    const hadDocument = Boolean(this.viewer.document);
    this.hud.setProgress({ phase: 'loading' });
    const loaded: Loaded[] = [];
    try {
      for (const file of files)
        loaded.push(
          await loadSplat({ kind: 'file', file }, (progress) => {
            if (sequence === this.sequence) this.hud.setProgress(progress);
          }),
        );
      if (sequence !== this.sequence) {
        loaded.forEach(({ layer }) => layer.dispose());
        return;
      }
      let model = this.viewer.document;
      let added = loaded;
      if (!model) {
        const first = loaded[0];
        if (!first) return;
        model = new Document(first.name);
        model.addLayer(first.layer);
        added = loaded.slice(1);
        this.viewer.setDocument(model);
      }
      if (added.length)
        model.history.push(
          new AddLayers(
            model,
            added.map(({ layer }) => layer),
          ),
        );
      model.setSelection(loaded.map(({ layer }) => layer.id));
      this.emptyState.hidden = true;
      this.hud.setReady();
      loaded.forEach((item) => this.showLoadNotes(item));
      if (hadDocument)
        this.hud.toast(
          `Added ${loaded.length === 1 ? loaded[0]?.layer.name : `${loaded.length} layers`} · press F to frame.`,
        );
    } catch (error) {
      loaded.forEach(({ layer }) => layer.dispose());
      console.error(error);
      this.hud.setError();
      this.hud.toast(error instanceof Error ? error.message : 'Could not add those files.');
    }
  }

  async changePointBudget(layerId: string, budget: number): Promise<void> {
    const model = this.viewer.document;
    const layer = model?.getLayer(layerId);
    if (!model || !layer?.pointCloud || !layer.sourceBytes) return;
    if (layer.locked) {
      this.hud.toast('Unlock the layer before editing it.');
      return;
    }
    this.hud.setProgress({ phase: 'parsing' });
    try {
      const decoded = await decodeFile(
        layer.sourceBytes,
        layer.sourceName,
        {
          pointBudget: budget,
          pointSizeMul: layer.pointCloud.pointScale / layer.pointCloud.basePointScale,
        },
        (progress) => this.hud.setProgress(progress),
      );
      if (!decoded.pointCloud || this.viewer.document !== model || !model.getLayer(layerId)) return;
      model.history.push(
        new SetPointBudget(
          model,
          layerId,
          { store: layer.store, info: layer.pointCloud },
          { store: new SplatStore(decoded.arrays), info: decoded.pointCloud },
        ),
      );
      await layer.sync();
      this.hud.setReady();
    } catch (error) {
      console.error(error);
      this.hud.setError();
      this.hud.toast(error instanceof Error ? error.message : 'Could not change the point budget.');
    }
  }

  private async allowReplace(): Promise<boolean> {
    if (!this.viewer.document?.history.canUndo()) return true;
    return this.hud.confirm('Replace scene? You have unsaved changes.', 'Replace');
  }

  private showLoadNotes(loaded: Loaded): void {
    console.info(
      `Decoded ${loaded.layer.store.liveCount().toLocaleString()} splats in ${loaded.decodeMs.toFixed(0)} ms; synced in ${loaded.syncMs.toFixed(0)} ms.`,
    );
    if (loaded.lossy)
      this.hud.toast(`Imported with ${loaded.lossy}; export preserves the decoded values.`);
    loaded.warnings.forEach((warning) => this.hud.toast(warning));
    const info = loaded.layer.pointCloud;
    if (info?.stride && info.stride > 1)
      this.hud.toast(
        `RGB point cloud: showing ${info.keptPoints.toLocaleString()} of ${info.sourcePoints.toLocaleString()} points.`,
      );
    else if (info) this.hud.toast('RGB point cloud: point size estimated from spacing.');
    else if (loaded.layer.store.liveCount() >= LOD_ABOVE_SPLATS)
      this.hud.toast('Large scene: a level-of-detail tree was built from the CPU store.');
  }
}
