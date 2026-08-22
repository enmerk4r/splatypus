import { Plane, Raycaster, Vector2, Vector3 } from 'three';
import type { Viewer } from '../viewer/Viewer';
import { nearestProjectedPoint, pickLayer } from '../viewer/picking';
import type { PlacementMode } from './stroke';

export interface PointerPosition {
  clientX: number;
  clientY: number;
}

export interface PlacementState {
  radius: number;
  /** Camera direction fixed at pointer-down; it is the depth-lock plane normal. */
  viewDir: Vector3;
  first?: Vector3;
  previous?: Vector3;
}

function rayFor(viewer: Viewer, event: PointerPosition): Raycaster {
  const rect = viewer.canvasElement.getBoundingClientRect();
  const pointer = new Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new Raycaster();
  raycaster.setFromCamera(pointer, viewer.camera);
  return raycaster;
}

function sceneHit(viewer: Viewer, event: PointerPosition): Vector3 | undefined {
  const document = viewer.document;
  if (!document) return undefined;
  const rect = viewer.canvasElement.getBoundingClientRect();
  const pointer = new Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  return (
    pickLayer(document, viewer.camera, pointer) ??
    nearestProjectedPoint(document, viewer.camera, pointer, rect, 18)
  )?.point.clone();
}

function intersectViewPlane(
  viewer: Viewer,
  event: PointerPosition,
  point: Vector3,
  normal: Vector3,
): Vector3 | undefined {
  const result = new Vector3();
  return (
    rayFor(viewer, event).ray.intersectPlane(
      new Plane().setFromNormalAndCoplanarPoint(normal, point),
      result,
    ) ?? undefined
  );
}

function defaultDepthPoint(
  viewer: Viewer,
  event: PointerPosition,
  normal: Vector3,
): Vector3 | undefined {
  const distance = Math.max(
    viewer.camera.position.distanceTo(viewer.cameraRig.controls.target),
    viewer.camera.near * 2,
  );
  const anchor = viewer.camera.position.clone().addScaledVector(normal, distance);
  return intersectViewPlane(viewer, event, anchor, normal);
}

function biasTowardCamera(viewer: Viewer, point: Vector3, radius: number): Vector3 {
  const toward = viewer.camera.position.clone().sub(point).normalize();
  return point.addScaledVector(toward, radius * 0.6);
}

/** Maps a smoothed screen sample to a world-space sketch point and advances placement state. */
export function placePoint(
  viewer: Viewer,
  event: PointerPosition,
  mode: PlacementMode,
  state: PlacementState,
): Vector3 | undefined {
  let point: Vector3 | undefined;
  if (mode === 'plane') {
    const result = new Vector3();
    point =
      rayFor(viewer, event).ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), result) ??
      undefined;
  } else if (mode === 'depth' && state.first) {
    point = intersectViewPlane(viewer, event, state.first, state.viewDir);
  } else if (mode === 'surface') {
    const hit = sceneHit(viewer, event);
    if (hit) point = biasTowardCamera(viewer, hit, state.radius);
    else if (state.previous)
      point = intersectViewPlane(
        viewer,
        event,
        state.previous,
        viewer.camera.getWorldDirection(new Vector3()),
      );
    else point = defaultDepthPoint(viewer, event, state.viewDir);
  } else {
    const hit = sceneHit(viewer, event);
    point = hit
      ? biasTowardCamera(viewer, hit, state.radius)
      : defaultDepthPoint(viewer, event, state.viewDir);
  }
  if (!point) return undefined;
  state.first ??= point.clone();
  state.previous = point.clone();
  return point;
}
