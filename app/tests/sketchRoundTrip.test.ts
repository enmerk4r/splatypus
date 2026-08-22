import { Quaternion, Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { readStandardPly } from '../src/io/plyReader';
import { writeGaussianPly } from '../src/io/plyWriter';
import { Document } from '../src/model/Document';
import { Layer } from '../src/model/Layer';
import { AddStroke } from '../src/model/sketchCommands';
import { SplatStore } from '../src/model/SplatStore';
import { localiseStroke } from '../src/sketch/bakeStroke';
import type { Stamp } from '../src/sketch/stamps';
import type { StrokeSettings } from '../src/sketch/stroke';

function emptyStore(): SplatStore {
  return new SplatStore({
    count: 0,
    centers: new Float32Array(),
    scales: new Float32Array(),
    rotations: new Float32Array(),
    opacities: new Float32Array(),
    colors: new Float32Array(),
    shDegree: 0,
  });
}

const documents: Document[] = [];
afterEach(() => documents.splice(0).forEach((document) => document.dispose()));

describe('sketch coordinate and export round trip', () => {
  it('converts world stamps through the root and layer transform, then reopens the export', () => {
    const document = new Document('sketch');
    documents.push(document);
    document.root.quaternion.set(1, 0, 0, 0);
    const layer = new Layer({
      name: 'Sketch',
      kind: 'sketch',
      sourceName: 'Sketch',
      store: emptyStore(),
    });
    layer.object.position.set(2, -1, 0.5);
    layer.object.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 3);
    layer.object.scale.setScalar(2);
    layer.object.updateMatrix();
    document.addLayer(layer);
    document.root.updateMatrixWorld(true);

    const expectedCenter = new Vector3(0.25, -0.5, 1.5);
    const expectedRotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.3);
    const worldRotation = new Quaternion();
    layer.object.getWorldQuaternion(worldRotation);
    const worldCenter = expectedCenter.clone().applyMatrix4(layer.object.matrixWorld);
    const stamp: Stamp = {
      center: worldCenter,
      scales: [0.2, 0.1, 0.04],
      quat: worldRotation.clone().multiply(expectedRotation).toArray(),
      rgb: [0.8, 0.1, 0.2],
      opacity: 0.75,
    };
    const settings: StrokeSettings = {
      preset: 'ink',
      colour: [0.8, 0.1, 0.2],
      radiusPx: 10,
      radius: 0.05,
      opacity: 1,
      pressure: true,
      placement: 'surface',
    };
    const local = localiseStroke(
      document,
      layer,
      { id: 'stroke', settings, pressures: new Float32Array([1]) },
      new Float32Array(worldCenter.toArray()),
      [stamp],
    );
    expect(new Vector3().fromArray(local.stroke.points).distanceTo(expectedCenter)).toBeLessThan(
      1e-6,
    );
    expect(new Vector3().fromArray(local.splats.centers).distanceTo(expectedCenter)).toBeLessThan(
      1e-6,
    );
    [0.1, 0.05, 0.02].forEach((value, index) =>
      expect(local.splats.scales[index]).toBeCloseTo(value, 6),
    );
    expect(
      Math.abs(new Quaternion().fromArray(local.splats.rotations).dot(expectedRotation)),
    ).toBeCloseTo(1, 6);

    document.history.push(new AddStroke(document, layer.id, local.stroke, local.splats));
    const reopened = readStandardPly(
      writeGaussianPly([{ store: layer.store, matrix: layer.object.matrix.toArray() }]),
    );
    const expectedFileCenter = expectedCenter.clone().applyMatrix4(layer.object.matrix);
    expect(
      new Vector3().fromArray(reopened.arrays.centers).distanceTo(expectedFileCenter),
    ).toBeLessThan(1e-6);
    expect([...reopened.arrays.colors]).toEqual(
      expect.arrayContaining([
        expect.closeTo(0.8, 5),
        expect.closeTo(0.1, 5),
        expect.closeTo(0.2, 5),
      ]),
    );
    expect(reopened.arrays.shDegree).toBe(0);
  });

  it('localises the first stroke before its new layer is attached', () => {
    const document = new Document('first');
    documents.push(document);
    document.root.quaternion.set(1, 0, 0, 0);
    const layer = new Layer({
      name: 'Sketch',
      kind: 'sketch',
      sourceName: 'Sketch',
      store: emptyStore(),
    });
    const world = new Vector3(1, 2, 3);
    const settings: StrokeSettings = {
      preset: 'tube',
      colour: [1, 0, 0],
      radiusPx: 10,
      radius: 0.1,
      opacity: 1,
      pressure: false,
      placement: 'depth',
    };
    const local = localiseStroke(
      document,
      layer,
      { id: 'first', settings, pressures: new Float32Array([1]) },
      new Float32Array(world.toArray()),
      [
        {
          center: world,
          scales: [0.1, 0.1, 0.1],
          quat: [0, 0, 0, 1],
          rgb: [1, 0, 0],
          opacity: 1,
        },
      ],
    );
    document.addLayer(layer);
    document.root.updateMatrixWorld(true);
    const reconstructed = new Vector3()
      .fromArray(local.splats.centers)
      .applyMatrix4(layer.object.matrixWorld);
    expect(reconstructed.distanceTo(world)).toBeLessThan(1e-6);
  });
});
