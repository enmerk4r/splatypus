import type { SplatMesh } from '@sparkjsdev/spark';
import type { PointCloudInfo } from '../io/pointCloud';
import { rescalePointCloud } from '../io/pointCloud';
import type { RobustBounds } from './framing';
import { getRobustBounds } from './framing';

export type DocumentKind = 'splat' | 'pointcloud';

export class SplatDocument {
  readonly mesh: SplatMesh;
  readonly name: string;
  readonly byteLength: number;
  readonly kind: DocumentKind;
  /** Source bytes, retained for point clouds so the point budget can be changed. */
  readonly bytes?: ArrayBuffer;
  readonly pointCloud?: PointCloudInfo;
  private boundsCache?: RobustBounds;

  constructor(
    mesh: SplatMesh,
    name: string,
    byteLength: number,
    kind: DocumentKind = 'splat',
    extra: { bytes?: ArrayBuffer; pointCloud?: PointCloudInfo } = {},
  ) {
    this.mesh = mesh;
    this.name = name;
    this.byteLength = byteLength;
    this.kind = kind;
    if (extra.bytes) this.bytes = extra.bytes;
    if (extra.pointCloud) this.pointCloud = extra.pointCloud;
  }

  get numSplats(): number {
    return this.mesh.numSplats;
  }

  get pointScale(): number | undefined {
    return this.pointCloud?.pointScale;
  }

  /** Current point radius relative to the load-time estimate (point clouds only). */
  get pointSizeMul(): number | undefined {
    const info = this.pointCloud;
    if (!info || info.basePointScale <= 0) return undefined;
    return info.pointScale / info.basePointScale;
  }

  /** Point clouds only: change the per-point radius in place. */
  setPointScale(scale: number): void {
    if (this.kind !== 'pointcloud' || !this.pointCloud) return;
    this.pointCloud.pointScale = scale;
    rescalePointCloud(this.mesh, scale);
  }

  getRobustBounds(): RobustBounds {
    // Bounds are in world space and depend on the mesh orientation; recompute when it changes.
    const key = this.mesh.quaternion.toArray().join(',');
    if (!this.boundsCache || this.boundsKey !== key) {
      this.boundsCache = getRobustBounds(this.mesh);
      this.boundsKey = key;
    }
    return this.boundsCache;
  }
  private boundsKey = '';

  dispose(): void {
    this.mesh.dispose();
  }
}
