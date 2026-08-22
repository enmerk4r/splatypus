import { Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { readProject, writeProject } from '../src/io/projectFormat';
import { Document } from '../src/model/Document';
import { Layer } from '../src/model/Layer';
import { SplatStore } from '../src/model/SplatStore';
import { extrudePolygon, meshToSplats, solidBounds } from '../src/mesh/solid';
import type { SolidData } from '../src/mesh/solid';

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

/** Signed volume via the divergence theorem: positive for outward-facing triangles. */
function signedVolume(positions: Float32Array, indices: Uint32Array): number {
  let volume = 0;
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3();
  for (let t = 0; t < indices.length; t += 3) {
    a.fromArray(positions, indices[t]! * 3);
    b.fromArray(positions, indices[t + 1]! * 3);
    c.fromArray(positions, indices[t + 2]! * 3);
    volume += a.dot(new Vector3().crossVectors(b, c)) / 6;
  }
  return volume;
}

const documents: Document[] = [];
afterEach(() => documents.splice(0).forEach((document) => document.dispose()));

describe('extrudePolygon', () => {
  it('builds a capped, outward-facing box from a rectangle (either winding, either direction)', () => {
    const rect = new Float32Array([0, 0, 2, 0, 2, 1, 0, 1]); // 2 × 1 in (x, z)
    for (const [polygon, height] of [
      [rect, 0.5],
      [new Float32Array([0, 0, 0, 1, 2, 1, 2, 0]), 0.5], // reversed winding
      [rect, -0.5], // downwards
    ] as const) {
      const solid = extrudePolygon(polygon, 1, height);
      expect(solid.positions.length).toBe(8 * 3);
      expect(solid.indices.length).toBe(12 * 3); // 2 caps × 2 + 4 sides × 2
      expect(signedVolume(solid.positions, solid.indices)).toBeCloseTo(2 * 1 * 0.5, 6);
      const bounds = solidBounds(solid.positions);
      expect(bounds.min[1]).toBeCloseTo(Math.min(1, 1 + height), 6);
      expect(bounds.max[1]).toBeCloseTo(Math.max(1, 1 + height), 6);
    }
  });

  it('rejects degenerate outlines', () => {
    expect(() => extrudePolygon(new Float32Array([0, 0, 1, 1]), 0, 1)).toThrow();
  });
});

describe('meshToSplats', () => {
  it('covers the surface with flat gaussians aligned to the faces', () => {
    const solid: SolidData = {
      ...extrudePolygon(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 0, 1),
      colour: [1, 0, 0],
    };
    const splats = meshToSplats(solid, 0.1, 7);
    // Unit cube: 6 m² at ~100 samples/m².
    expect(splats.count).toBeGreaterThan(500);
    expect(splats.count).toBeLessThan(700);
    // Every centre lies on the cube surface (one coordinate at 0 or 1, others within [0,1]).
    for (let i = 0; i < splats.count; i += 1) {
      const p = [splats.centers[i * 3]!, splats.centers[i * 3 + 1]!, splats.centers[i * 3 + 2]!];
      const onFace = p.some((v) => Math.abs(v) < 1e-5 || Math.abs(v - 1) < 1e-5);
      expect(onFace).toBe(true);
      expect(p.every((v) => v > -1e-5 && v < 1 + 1e-5)).toBe(true);
      // Thin axis (scale z) is the small one.
      expect(splats.scales[i * 3 + 2]).toBeLessThan(splats.scales[i * 3]!);
      expect(splats.colors[i * 3]).toBe(1);
    }
    // Deterministic for a seed.
    expect([...meshToSplats(solid, 0.1, 7).centers.subarray(0, 9)]).toEqual([
      ...splats.centers.subarray(0, 9),
    ]);
  });
});

describe('mesh layers in projects', () => {
  it('round-trip through the project format and keep their geometry and colour', () => {
    const document = new Document('meshes');
    documents.push(document);
    const solid: SolidData = {
      ...extrudePolygon(new Float32Array([0, 0, 1, 0, 0.5, 1]), 0.2, 0.4),
      colour: [0.2, 0.4, 0.9],
    };
    const layer = new Layer({
      name: 'Duct',
      kind: 'mesh',
      sourceName: 'mesh-1',
      store: emptyStore(),
      solid,
    });
    document.addLayer(layer);
    layer.object.position.set(1, 2, 3);
    layer.object.updateMatrix();
    expect(layer.solidObject).toBeDefined();
    expect(layer.localBounds().max[1]).toBeCloseTo(0.6, 6);
    const bytes = writeProject(document, {
      upAxis: 'y-down',
      cameraPosition: [0, 0, 1],
      cameraQuaternion: [0, 0, 0, 1],
      cameraUp: [0, 1, 0],
      cameraTarget: [0, 0, 0],
      cameraMode: 'orbit',
      flySpeed: 1,
      fov: 60,
    });
    const { document: restored } = readProject(bytes);
    documents.push(restored);
    const back = restored.layers[0]!;
    expect(back.kind).toBe('mesh');
    expect(back.solid?.colour).toEqual([0.2, 0.4, 0.9]);
    expect([...back.solid!.positions]).toEqual([...solid.positions]);
    expect([...back.solid!.indices]).toEqual([...solid.indices]);
    expect(back.solid?.source?.height).toBe(0.4);
    expect(back.object.position.x).toBe(1);
  });
});
