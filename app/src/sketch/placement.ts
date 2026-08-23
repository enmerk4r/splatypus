import { Plane, Raycaster, Vector2, Vector3 } from 'three';
import type { Viewer } from '../viewer/Viewer';
import type { DepthGrid } from './depthGrid';
import { DepthGrid as DepthGridClass } from './depthGrid';
import type { PlacementMode } from './stroke';

export interface PointerPosition {
  clientX: number;
  clientY: number;
}

export interface PlacementState {
  /** Brush radius in screen pixels (world radius follows the sample's depth). */
  radiusPx: number;
  /** Camera direction fixed at pointer-down; it is the depth-lock plane normal. */
  viewDir: Vector3;
  /** Screen-space depth image built at pointer-down (surface mode). */
  depthGrid?: DepthGrid;
  first?: Vector3;
  previous?: Vector3;
}

export interface PlacedPoint {
  point: Vector3;
  /** View depth of the point (metres along the camera's forward axis). */
  depth: number;
  /** Brush radius at that depth, in world units. */
  radius: number;
}

function ndcFor(viewer: Viewer, event: PointerPosition): Vector2 {
  const rect = viewer.canvasElement.getBoundingClientRect();
  return new Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
}

function rayFor(viewer: Viewer, event: PointerPosition): Raycaster {
  const raycaster = new Raycaster();
  raycaster.setFromCamera(ndcFor(viewer, event), viewer.camera);
  return raycaster;
}

/**
 * A gaussian reads as roughly 2σ wide on screen, so a brush circle of R pixels maps to
 * σ = R/2 pixels: the stroke then looks as thick as the cursor ring.
 */
export const SIGMA_PER_CURSOR_RADIUS = 0.5;

/** World units covered by one screen pixel at a given view depth. */
export function worldPerPixel(viewer: Viewer, depth: number): number {
  const rect = viewer.canvasElement.getBoundingClientRect();
  const fov = (viewer.camera.fov * Math.PI) / 180;
  return (2 * Math.max(depth, 1e-6) * Math.tan(fov / 2)) / Math.max(rect.height, 1);
}

export function viewDepthOf(viewer: Viewer, point: Vector3): number {
  const forward = viewer.camera.getWorldDirection(new Vector3());
  return point.clone().sub(viewer.camera.getWorldPosition(new Vector3())).dot(forward);
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

/** Surface hit from the depth grid (no raycast): the nearest splat depth around the pixel. */
function surfacePoint(
  viewer: Viewer,
  event: PointerPosition,
  grid: DepthGrid,
): Vector3 | undefined {
  const rect = viewer.canvasElement.getBoundingClientRect();
  const depth = grid.depthAt(event.clientX - rect.left, event.clientY - rect.top);
  if (depth === undefined) return undefined;
  const ndc = ndcFor(viewer, event);
  return DepthGridClass.pointAtDepth(viewer.camera, ndc.x, ndc.y, depth);
}

/**
 * Maps a smoothed screen sample to a world-space sketch point and advances placement state.
 * Surface mode reads the pointer-down depth image; depth-lock and plane modes intersect rays
 * with a plane. Nothing here raycasts Spark meshes, so it is cheap enough per pointer event.
 */
export function placePoint(
  viewer: Viewer,
  event: PointerPosition,
  mode: PlacementMode,
  state: PlacementState,
): PlacedPoint | undefined {
  let point: Vector3 | undefined;
  let onSurface = false;
  if (mode === 'plane') {
    const result = new Vector3();
    // The work plane when the user has set one, else the horizontal ground plane it
    // defaults to — an untouched work plane is that same plane, so this is one path.
    const plane = viewer.workPlane.enabled
      ? viewer.workPlane.plane()
      : new Plane(new Vector3(0, 1, 0), 0);
    point = rayFor(viewer, event).ray.intersectPlane(plane, result) ?? undefined;
  } else if (mode === 'depth' && state.first) {
    point = intersectViewPlane(viewer, event, state.first, state.viewDir);
  } else {
    const hit = state.depthGrid ? surfacePoint(viewer, event, state.depthGrid) : undefined;
    if (hit) {
      point = hit;
      onSurface = true;
    } else if (mode === 'surface' && state.previous) {
      // Crossing a gap: stay at the previous sample's depth.
      point = intersectViewPlane(viewer, event, state.previous, state.viewDir);
    } else {
      point = defaultDepthPoint(viewer, event, state.viewDir);
    }
  }
  if (!point) return undefined;
  const depth = Math.max(viewDepthOf(viewer, point), viewer.camera.near);
  const radius = state.radiusPx * SIGMA_PER_CURSOR_RADIUS * worldPerPixel(viewer, depth);
  if (onSurface) {
    // Sit on the surface, not inside it: half the ribbon would otherwise be occluded.
    const toward = viewer.camera.position.clone().sub(point).normalize();
    point.addScaledVector(toward, radius * 0.6);
  }
  state.first ??= point.clone();
  state.previous = point.clone();
  return { point, depth, radius };
}
