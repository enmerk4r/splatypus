import { PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';
import type { Document } from '../model/Document';
import type { Layer } from '../model/Layer';

export interface LayerHit {
  layer: Layer;
  point: Vector3;
  distance: number;
}

export function eventPointer(event: MouseEvent | PointerEvent, rect: DOMRect): Vector2 {
  return new Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
}

export function pickLayer(
  document: Document,
  camera: PerspectiveCamera,
  pointer: Vector2,
  accept: (layer: Layer) => boolean = () => true,
): LayerHit | undefined {
  document.root.updateMatrixWorld(true);
  const raycaster = new Raycaster();
  raycaster.setFromCamera(pointer, camera);
  let best: LayerHit | undefined;
  for (const layer of document.layers) {
    if (!layer.visible || !accept(layer)) continue;
    const hit =
      raycaster.intersectObject(layer.mesh, false)[0] ??
      (layer.solidObject ? raycaster.intersectObject(layer.solidObject, false)[0] : undefined);
    if (hit && (!best || hit.distance < best.distance))
      best = { layer, point: hit.point, distance: hit.distance };
  }
  return best;
}

export function nearestProjectedPoint(
  document: Document,
  camera: PerspectiveCamera,
  pointer: Vector2,
  rect: DOMRect,
  maxPixels = 12,
  accept: (layer: Layer) => boolean = () => true,
): LayerHit | undefined {
  document.root.updateMatrixWorld(true);
  const projected = new Vector3();
  const world = new Vector3();
  let bestPixels = maxPixels;
  let best: LayerHit | undefined;
  for (const layer of document.layers) {
    if (!layer.visible || !accept(layer)) continue;
    layer.object.updateMatrixWorld(true);
    const stride = Math.max(1, Math.ceil(layer.store.count / 200_000));
    for (let index = 0; index < layer.store.count; index += stride) {
      if (!layer.store.alive[index]) continue;
      world.fromArray(layer.store.centers, index * 3).applyMatrix4(layer.object.matrixWorld);
      projected.copy(world).project(camera);
      if (projected.z < -1 || projected.z > 1) continue;
      const pixels = Math.hypot(
        (projected.x - pointer.x) * rect.width * 0.5,
        (projected.y - pointer.y) * rect.height * 0.5,
      );
      if (pixels < bestPixels) {
        bestPixels = pixels;
        best = { layer, point: world.clone(), distance: camera.position.distanceTo(world) };
      }
    }
  }
  return best;
}
