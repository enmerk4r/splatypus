import { Box3, Group, Vector3 } from 'three';
import type { Layer } from './Layer';
import { History } from './history';
import type { RobustBounds } from '../viewer/framing';

export class Document extends EventTarget {
  readonly root = new Group();
  readonly history = new History();
  name: string;
  private layerValues: Layer[] = [];
  private selectionValue = new Set<string>();
  private soloValue?: string;

  constructor(name = 'Untitled') {
    super();
    this.name = name;
    this.root.name = 'Splatypus document';
    this.history.addEventListener('history-changed', this.forwardHistory);
  }

  get layers(): readonly Layer[] {
    return this.layerValues;
  }

  get selection(): ReadonlySet<string> {
    return this.selectionValue;
  }

  addLayer(layer: Layer, index = this.layerValues.length): void {
    if (this.getLayer(layer.id)) return;
    const target = Math.max(0, Math.min(index, this.layerValues.length));
    this.layerValues.splice(target, 0, layer);
    this.syncRootOrder();
    this.dispatchEvent(new Event('layers-changed'));
  }

  removeLayer(id: string): Layer | undefined {
    const index = this.layerValues.findIndex((layer) => layer.id === id);
    if (index < 0) return undefined;
    const [layer] = this.layerValues.splice(index, 1);
    layer?.object.removeFromParent();
    if (this.selectionValue.delete(id)) this.dispatchEvent(new Event('selection-changed'));
    this.dispatchEvent(new Event('layers-changed'));
    return layer;
  }

  moveLayer(id: string, index: number): void {
    const from = this.layerValues.findIndex((layer) => layer.id === id);
    if (from < 0) return;
    const [layer] = this.layerValues.splice(from, 1);
    if (!layer) return;
    const target = Math.max(0, Math.min(index, this.layerValues.length));
    this.layerValues.splice(target, 0, layer);
    this.syncRootOrder();
    this.dispatchEvent(new Event('layers-changed'));
  }

  getLayer(id: string): Layer | undefined {
    return this.layerValues.find((layer) => layer.id === id);
  }

  setSelection(ids: string[]): void {
    const next = new Set(ids.filter((id) => this.getLayer(id)));
    if (
      next.size === this.selectionValue.size &&
      [...next].every((id) => this.selectionValue.has(id))
    )
      return;
    this.selectionValue = next;
    this.dispatchEvent(new Event('selection-changed'));
  }

  active(): Layer | undefined {
    const ids = [...this.selectionValue];
    return ids.length ? this.getLayer(ids[ids.length - 1] ?? '') : undefined;
  }

  totalLive(): number {
    return this.layerValues.reduce((sum, layer) => sum + layer.store.liveCount(), 0);
  }

  hiddenCount(): number {
    return this.layerValues.reduce(
      (sum, layer) => sum + (layer.visible ? 0 : layer.store.liveCount()),
      0,
    );
  }

  getRobustBounds(): RobustBounds {
    this.root.updateMatrixWorld(true);
    const bounds = new Box3();
    let hasVisible = false;
    const corner = new Vector3();
    for (const layer of this.layerValues) {
      if (!layer.visible || layer.store.liveCount() === 0) continue;
      layer.object.updateMatrixWorld(true);
      const local = layer.store.computeRobustBounds();
      for (const x of [local.min[0], local.max[0]])
        for (const y of [local.min[1], local.max[1]])
          for (const z of [local.min[2], local.max[2]])
            bounds.expandByPoint(corner.set(x, y, z).applyMatrix4(layer.object.matrixWorld));
      hasVisible = true;
    }
    if (!hasVisible)
      return {
        min: new Vector3(-1, -1, -1),
        max: new Vector3(1, 1, 1),
        center: new Vector3(),
        radius: 1,
      };
    const center = bounds.getCenter(new Vector3());
    return {
      min: bounds.min.clone(),
      max: bounds.max.clone(),
      center,
      radius: Math.max(bounds.getSize(new Vector3()).length() / 2, 0.01),
    };
  }

  /** Id of the layer shown alone (everything else hidden), or undefined. View state, not undoable. */
  get solo(): string | undefined {
    return this.soloValue;
  }

  setSolo(id: string | undefined): void {
    this.soloValue = id && this.getLayer(id) ? id : undefined;
    this.applySolo();
    this.dispatchEvent(new Event('layers-changed'));
  }

  /** Mesh visibility = layer.visible unless a solo is active. Re-applied after structure changes. */
  applySolo(): void {
    if (this.soloValue && !this.getLayer(this.soloValue)) this.soloValue = undefined;
    for (const layer of this.layerValues)
      layer.mesh.visible =
        layer.visible && (this.soloValue === undefined || layer.id === this.soloValue);
  }

  notifyLayerChanged(id: string): void {
    this.dispatchEvent(new CustomEvent('layer-changed', { detail: { id } }));
  }

  dispose(): void {
    this.history.removeEventListener('history-changed', this.forwardHistory);
    this.history.clear();
    this.layerValues.forEach((layer) => layer.dispose());
    this.layerValues = [];
    this.root.removeFromParent();
  }

  private syncRootOrder(): void {
    this.root.clear();
    this.layerValues.forEach((layer) => this.root.add(layer.object));
    this.applySolo();
  }

  private readonly forwardHistory = (event: Event): void => {
    this.dispatchEvent(
      new CustomEvent('history-changed', {
        detail: (event as CustomEvent<unknown>).detail,
      }),
    );
  };
}
