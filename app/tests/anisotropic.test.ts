import { Matrix3, Quaternion, Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { bakeAnisotropicScale, eigenSymmetric3 } from '../src/model/anisotropic';
import { Document } from '../src/model/Document';
import { Layer } from '../src/model/Layer';
import { ScaleSplats } from '../src/model/segmentCommands';
import { SplatStore } from '../src/model/SplatStore';

/** Covariance R diag(s²) Rᵀ of a splat, in layer space. */
function covariance(q: Quaternion, s: Vector3): Matrix3 {
  const rot = new Matrix3();
  const x = q.x,
    y = q.y,
    z = q.z,
    w = q.w;
  rot.set(
    1 - 2 * (y * y + z * z),
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    2 * (x * y + w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z - w * x),
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    1 - 2 * (x * x + y * y),
  );
  const d = new Matrix3().set(s.x * s.x, 0, 0, 0, s.y * s.y, 0, 0, 0, s.z * s.z);
  return rot.clone().multiply(d).multiply(rot.clone().transpose());
}

function store(q: Quaternion, s: Vector3): SplatStore {
  return new SplatStore({
    count: 1,
    centers: new Float32Array([1, 2, 3]),
    scales: new Float32Array([s.x, s.y, s.z]),
    rotations: new Float32Array([q.x, q.y, q.z, q.w]),
    opacities: new Float32Array([1]),
    colors: new Float32Array([0.5, 0.5, 0.5]),
    shDegree: 0,
  });
}

describe('eigenSymmetric3', () => {
  it('diagonalises a symmetric matrix with orthonormal, right-handed eigenvectors', () => {
    const m = [4, 1, 0.5, 1, 3, 0.2, 0.5, 0.2, 2];
    const { values, vectors } = eigenSymmetric3(m);
    const v = new Matrix3().fromArray(vectors).transpose(); // fromArray is column-major
    expect(v.determinant()).toBeCloseTo(1, 6);
    // V diag(λ) Vᵀ must reproduce M.
    const d = new Matrix3().set(values[0]!, 0, 0, 0, values[1]!, 0, 0, 0, values[2]!);
    const back = v.clone().multiply(d).multiply(v.clone().transpose());
    back.transpose(); // to row-major for comparison with m
    back.elements.forEach((value, at) => expect(value).toBeCloseTo(m[at]!, 6));
  });
});

describe('bakeAnisotropicScale', () => {
  it('scales centres and preserves the covariance F Σ F of a rotated splat', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 1, 0).normalize(), 0.7);
    const s = new Vector3(0.3, 0.1, 0.05);
    const data = store(q, s);
    const factor = [2, 1, 0.5] as const;
    const expected = (() => {
      const f = new Matrix3().set(factor[0], 0, 0, 0, factor[1], 0, 0, 0, factor[2]);
      return f.clone().multiply(covariance(q, s)).multiply(f);
    })();
    bakeAnisotropicScale(data, factor);
    expect([...data.centers]).toEqual([2, 2, 1.5]);
    const q2 = new Quaternion(
      data.rotations[0],
      data.rotations[1],
      data.rotations[2],
      data.rotations[3],
    );
    const s2 = new Vector3(data.scales[0], data.scales[1], data.scales[2]);
    const actual = covariance(q2, s2);
    actual.elements.forEach((value, at) => expect(value).toBeCloseTo(expected.elements[at]!, 5));
  });
});

describe('ScaleSplats', () => {
  const documents: Document[] = [];
  afterEach(() => documents.splice(0).forEach((document) => document.dispose()));

  it('is exactly undoable', () => {
    const document = new Document('test');
    documents.push(document);
    const layer = new Layer({
      name: 'a',
      kind: 'scan',
      sourceName: 'a.ply',
      store: store(new Quaternion(0, 0, 0, 1), new Vector3(0.2, 0.2, 0.2)),
    });
    document.addLayer(layer);
    const before = [...layer.store.centers, ...layer.store.scales, ...layer.store.rotations];
    document.history.push(new ScaleSplats(document, layer.id, [3, 1, 1]));
    expect(layer.store.centers[0]).toBeCloseTo(3);
    expect(Math.max(...layer.store.scales)).toBeCloseTo(0.6, 5);
    document.history.undo();
    expect([...layer.store.centers, ...layer.store.scales, ...layer.store.rotations]).toEqual(
      before,
    );
  });
});
