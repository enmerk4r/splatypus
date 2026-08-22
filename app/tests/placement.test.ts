import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { placePoint } from '../src/sketch/placement';
import type { PlacementState } from '../src/sketch/placement';
import type { Viewer } from '../src/viewer/Viewer';

function fixture(): { viewer: Viewer; state: PlacementState } {
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 1, 1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const viewer = {
    camera,
    document: undefined,
    canvasElement: {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    },
    cameraRig: { controls: { target: new Vector3(0, 0, 0) } },
  } as unknown as Viewer;
  return {
    viewer,
    state: { radiusPx: 10, viewDir: camera.getWorldDirection(new Vector3()) },
  };
}

describe('stroke placement', () => {
  it('intersects the world ground plane', () => {
    const { viewer, state } = fixture();
    const point = placePoint(viewer, { clientX: 50, clientY: 50 }, 'plane', state)?.point;
    expect(point?.distanceTo(new Vector3(0, 0, 0))).toBeLessThan(1e-6);
  });

  it('uses orbit-target distance when depth lock begins in the void', () => {
    const { viewer, state } = fixture();
    const point = placePoint(viewer, { clientX: 50, clientY: 50 }, 'depth', state)?.point;
    expect(point?.distanceTo(new Vector3(0, 0, 0))).toBeLessThan(1e-6);
    expect(state.first?.distanceTo(point!)).toBeLessThan(1e-6);
  });

  it('continues a surface stroke at its previous depth across a gap', () => {
    const { viewer, state } = fixture();
    const previous = new Vector3(0, 0, 0);
    state.previous = previous.clone();
    const point = placePoint(viewer, { clientX: 50, clientY: 50 }, 'surface', state)?.point;
    expect(point?.distanceTo(previous)).toBeLessThan(1e-6);
  });
});
