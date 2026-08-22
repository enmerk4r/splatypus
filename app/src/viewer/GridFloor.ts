import { GridHelper, Material, Scene, Vector3 } from 'three';

export class GridFloor {
  private grid?: GridHelper;
  private visible = true;
  constructor(private readonly scene: Scene) {}

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.grid) this.grid.visible = visible;
  }

  reset(center: Vector3, radius: number, floorY: number): void {
    this.disposeGrid();
    this.grid = new GridHelper(radius * 4, 20, 0x52616d, 0x263139);
    this.grid.position.set(center.x, floorY, center.z);
    this.grid.visible = this.visible;
    this.scene.add(this.grid);
  }

  dispose(): void {
    this.disposeGrid();
  }

  private disposeGrid(): void {
    if (!this.grid) return;
    this.grid.removeFromParent();
    this.grid.geometry.dispose();
    const materials: Material[] = Array.isArray(this.grid.material)
      ? this.grid.material
      : [this.grid.material];
    materials.forEach((material) => material.dispose());
    this.grid = undefined;
  }
}
