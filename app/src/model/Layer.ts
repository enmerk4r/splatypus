import { Object3D } from 'three';
import { SplatMesh } from '@sparkjsdev/spark';
import type { PointCloudInfo } from '../io/pointCloud';
import { syncLayer } from '../viewer/sync';
import type { SplatStore } from './SplatStore';

export type LayerKind = 'scan' | 'pointcloud' | 'sketch' | 'segment';

export interface LayerOptions {
  name: string;
  kind: LayerKind;
  store: SplatStore;
  sourceName: string;
  pointCloud?: PointCloudInfo;
  sourceBytes?: ArrayBuffer;
  id?: string;
}

export class Layer {
  readonly id: string;
  name: string;
  readonly kind: LayerKind;
  visible = true;
  locked = false;
  readonly object = new Object3D();
  dirty = true;
  pointCloud?: PointCloudInfo;
  sourceName: string;
  sourceBytes?: ArrayBuffer;
  packedToStore: Uint32Array = new Uint32Array();
  private storeValue: SplatStore;
  private meshValue = new SplatMesh({ maxSplats: 0 });
  private syncInFlight?: Promise<number>;

  constructor(options: LayerOptions) {
    this.id = options.id ?? crypto.randomUUID();
    this.name = options.name;
    this.kind = options.kind;
    this.storeValue = options.store;
    this.sourceName = options.sourceName;
    if (options.pointCloud) this.pointCloud = { ...options.pointCloud };
    if (options.sourceBytes) this.sourceBytes = options.sourceBytes;
    this.object.name = `Layer: ${this.name}`;
    void this.sync();
  }

  get store(): SplatStore {
    return this.storeValue;
  }

  get mesh(): SplatMesh {
    return this.meshValue;
  }

  replaceStore(store: SplatStore, pointCloud?: PointCloudInfo): void {
    this.storeValue = store;
    this.pointCloud = pointCloud ? { ...pointCloud } : undefined;
    this.dirty = true;
    void this.sync();
  }

  replaceMesh(mesh: SplatMesh, packedToStore: Uint32Array): void {
    this.meshValue.removeFromParent();
    this.meshValue = mesh;
    this.packedToStore = packedToStore;
    mesh.visible = this.visible;
    this.object.add(mesh);
  }

  async sync(): Promise<number> {
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = syncLayer(this).finally(() => {
      this.syncInFlight = undefined;
    });
    return this.syncInFlight;
  }

  dispose(): void {
    this.meshValue.removeFromParent();
    this.meshValue.dispose();
    this.object.removeFromParent();
  }
}
