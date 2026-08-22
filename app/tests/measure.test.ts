import { Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { Document } from '../src/model/Document';
import { Layer } from '../src/model/Layer';
import { SplatStore } from '../src/model/SplatStore';
import { scaleAboutWorldPoint } from '../src/sketch/MeasureTool';

function store(): SplatStore {
  return new SplatStore({
    count: 2,
    centers: new Float32Array([0, 0, 0, 1, 0, 0]),
    scales: new Float32Array(6).fill(0.1),
    rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
    opacities: new Float32Array([1, 1]),
    colors: new Float32Array(6).fill(0.5),
    shDegree: 0,
  });
}

const documents: Document[] = [];
afterEach(() => documents.splice(0).forEach((document) => document.dispose()));

describe('scaleAboutWorldPoint', () => {
  it('keeps the pivot fixed and scales distances about it, under a rotated root', () => {
    const document = new Document('test');
    documents.push(document);
    // The up-axis flip: 180° about X, like the Y-down default.
    document.root.quaternion.set(1, 0, 0, 0);
    document.root.updateMatrixWorld(true);
    const layer = new Layer({ name: 'a', kind: 'scan', sourceName: 'a.ply', store: store() });
    document.addLayer(layer);
    layer.object.position.set(2, 0, 0);
    layer.object.updateMatrixWorld(true);
    // World positions of the two splats.
    const world = (local: Vector3): Vector3 => local.clone().applyMatrix4(layer.object.matrixWorld);
    const a = world(new Vector3(0, 0, 0));
    const b = world(new Vector3(1, 0, 0));
    expect(a.distanceTo(b)).toBeCloseTo(1, 6);

    const matrix = scaleAboutWorldPoint(layer, a, 2.5);
    layer.object.matrix.copy(matrix);
    layer.object.matrix.decompose(
      layer.object.position,
      layer.object.quaternion,
      layer.object.scale,
    );
    layer.object.updateMatrixWorld(true);
    const a2 = world(new Vector3(0, 0, 0));
    const b2 = world(new Vector3(1, 0, 0));
    expect(a2.distanceTo(a)).toBeLessThan(1e-6); // pivot stays put
    expect(a2.distanceTo(b2)).toBeCloseTo(2.5, 6);
    expect(layer.object.scale.x).toBeCloseTo(2.5, 6);
    expect(layer.object.scale.y).toBeCloseTo(2.5, 6);
  });
});
