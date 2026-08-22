import type { SplatMesh } from '@sparkjsdev/spark';
import type { RobustBounds } from './framing';
import { getRobustBounds } from './framing';

export class SplatDocument {
  readonly mesh: SplatMesh;
  readonly name: string;
  readonly byteLength: number;

  constructor(mesh: SplatMesh, name: string, byteLength: number) {
    this.mesh = mesh;
    this.name = name;
    this.byteLength = byteLength;
  }

  get numSplats(): number {
    return this.mesh.numSplats;
  }

  getRobustBounds(): RobustBounds {
    return getRobustBounds(this.mesh);
  }

  dispose(): void {
    this.mesh.dispose();
  }
}
