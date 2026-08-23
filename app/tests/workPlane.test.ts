import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkPlane } from '../src/viewer/WorkPlane';
import type { CameraRig } from '../src/viewer/CameraRig';

// TransformControls needs a real DOM and a renderer; the plane maths does not. Stub it so
// the geometry stays testable headlessly.
vi.mock('three/addons/controls/TransformControls.js', () => {
  class FakeTransformControls {
    dragging = false;
    axis: string | null = null;
    enabled = false;
    object?: unknown;
    private modeValue = 'translate';
    private readonly helper = {
      visible: false,
      removeFromParent: (): void => {
        /* no-op */
      },
    };
    getHelper(): { visible: boolean; removeFromParent: () => void } {
      return this.helper;
    }
    getMode(): string {
      return this.modeValue;
    }
    setMode(mode: string): void {
      this.modeValue = mode;
    }
    setSize(): void {
      /* no-op */
    }
    attach(object: unknown): void {
      this.object = object;
    }
    detach(): void {
      this.object = undefined;
    }
    addEventListener(): void {
      /* no-op */
    }
    removeEventListener(): void {
      /* no-op */
    }
    dispose(): void {
      /* no-op */
    }
  }
  return { TransformControls: FakeTransformControls };
});

const rig = { controls: { enabled: true }, mode: 'orbit' } as unknown as CameraRig;
const planes: WorkPlane[] = [];
afterEach(() => planes.splice(0).forEach((plane) => plane.dispose()));

function make(): WorkPlane {
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  // The canvas only reaches TransformControls, which is stubbed above, so a stand-in
  // keeps this runnable in the node environment the rest of the suite uses.
  const plane = new WorkPlane(new Scene(), camera, {} as HTMLCanvasElement, rig);
  planes.push(plane);
  return plane;
}

describe('WorkPlane defaults', () => {
  it('starts as exactly the horizontal ground plane the tools used before', () => {
    const plane = make();
    expect(plane.normal().toArray()).toEqual([0, 1, 0]);
    expect(plane.origin().toArray()).toEqual([0, 0, 0]);
    // Signed distance of a point 3 above the origin is 3.
    expect(plane.plane().distanceToPoint(new Vector3(0, 3, 0))).toBeCloseTo(3, 6);
  });

  it('is off until asked for, so nothing changes by default', () => {
    const plane = make();
    expect(plane.enabled).toBe(false);
    expect(plane.editing).toBe(false);
  });

  it('will not start editing while disabled', () => {
    const plane = make();
    plane.setEditing(true);
    expect(plane.editing).toBe(false);
    plane.setEnabled(true);
    plane.setEditing(true);
    expect(plane.editing).toBe(true);
    // Hiding the plane must also put the gizmo away.
    plane.setEnabled(false);
    expect(plane.editing).toBe(false);
  });
});

describe('WorkPlane presets', () => {
  it('points the normal down each world axis', () => {
    const plane = make();
    plane.setPreset('front');
    expect(plane.normal().z).toBeCloseTo(1, 6);
    expect(plane.normal().y).toBeCloseTo(0, 6);

    plane.setPreset('side');
    expect(plane.normal().x).toBeCloseTo(1, 6);
    expect(plane.normal().y).toBeCloseTo(0, 6);

    plane.setPreset('ground');
    expect(plane.normal().y).toBeCloseTo(1, 6);
  });

  it('keeps the origin when changing orientation', () => {
    const plane = make();
    plane.moveTo(new Vector3(1, 2, 3));
    plane.setPreset('front');
    expect(plane.origin().toArray()).toEqual([1, 2, 3]);
  });

  it('faces the camera on alignToView', () => {
    const plane = make();
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    plane.alignToView(camera);
    // Camera looks down -Z, so the plane it faces has normal +Z.
    expect(plane.normal().z).toBeCloseTo(1, 5);
  });

  it('lays onto a given surface normal and point', () => {
    const plane = make();
    plane.alignTo(new Vector3(0, 0, 1), new Vector3(0, 0, 4));
    expect(plane.normal().z).toBeCloseTo(1, 6);
    // A point on the plane is at zero distance; one in front is positive.
    expect(plane.plane().distanceToPoint(new Vector3(9, 9, 4))).toBeCloseTo(0, 5);
    expect(plane.plane().distanceToPoint(new Vector3(0, 0, 6))).toBeCloseTo(2, 5);
  });

  it('ignores a degenerate normal rather than producing NaN', () => {
    const plane = make();
    plane.setPreset('front');
    plane.alignTo(new Vector3(0, 0, 0));
    expect(plane.normal().z).toBeCloseTo(1, 6);
    expect(Number.isNaN(plane.normal().x)).toBe(false);
  });

  it('resets to the origin and the horizontal', () => {
    const plane = make();
    plane.moveTo(new Vector3(4, 5, 6));
    plane.setPreset('side');
    plane.reset();
    expect(plane.origin().toArray()).toEqual([0, 0, 0]);
    expect(plane.normal().toArray()).toEqual([0, 1, 0]);
  });
});

describe('WorkPlane raycast', () => {
  it('hits the plane in front of the camera', () => {
    const plane = make();
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 5, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    // Centre of the screen, straight down onto the ground plane. Landing *on* the plane is
    // the assertion that matters; x and z carry a little slop because looking straight down
    // is degenerate for three.js's default-up lookAt, which nudges the camera to resolve it.
    const hit = plane.raycast({ x: 0, y: 0 }, camera);
    expect(hit).toBeDefined();
    expect(hit!.y).toBeCloseTo(0, 5);
    expect(hit!.x).toBeCloseTo(0, 2);
    expect(hit!.z).toBeCloseTo(0, 2);
  });

  it('follows the plane when it moves', () => {
    const plane = make();
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 5, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    plane.moveTo(new Vector3(0, 2, 0));
    expect(plane.raycast({ x: 0, y: 0 }, camera)!.y).toBeCloseTo(2, 5);
  });

  it('misses when the ray runs parallel to the plane', () => {
    const plane = make();
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    // Above the ground plane, looking along it rather than at it. The camera must be off
    // the plane: a ray lying *in* the plane is coplanar, and three.js answers that with
    // the ray origin rather than a miss.
    camera.position.set(0, 3, 5);
    camera.lookAt(0, 3, 0);
    camera.updateMatrixWorld(true);
    expect(plane.raycast({ x: 0, y: 0 }, camera)).toBeUndefined();
  });
});
