import { Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { readProject, writeProject } from '../src/io/projectFormat';
import { Document } from '../src/model/Document';
import { Layer } from '../src/model/Layer';
import { SetSolid } from '../src/model/meshCommands';
import { ScaleSplats } from '../src/model/segmentCommands';
import { SplatStore } from '../src/model/SplatStore';
import {
  extrudeFace,
  extrudePolygon,
  faceCentroid,
  makeFace,
  meshToSplats,
  pendingExtrusion,
  scaleSolid,
  signedVolume,
  solidBounds,
} from '../src/mesh/solid';
import type { FaceData, SolidData } from '../src/mesh/solid';

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

describe('extrudePolygon / extrudeFace', () => {
  it('builds a capped, outward-facing box from a rectangle (either winding, either direction)', () => {
    const rect = new Float32Array([0, 0, 2, 0, 2, 1, 0, 1]); // 2 × 1 in (x, z)
    for (const [polygon, height] of [
      [rect, 0.5],
      [new Float32Array([0, 0, 0, 1, 2, 1, 2, 0]), 0.5], // reversed winding
      [rect, -0.5], // downwards
    ] as const) {
      const solid = extrudePolygon(polygon, 1, height);
      expect(solid.positions.length).toBe(8 * 3);
      expect(solid.indices.length).toBe(12 * 3);
      expect(signedVolume(solid.positions, solid.indices)).toBeCloseTo(2 * 1 * 0.5, 6);
      const bounds = solidBounds(solid.positions);
      expect(bounds.min[1]).toBeCloseTo(Math.min(1, 1 + height), 6);
      expect(bounds.max[1]).toBeCloseTo(Math.max(1, 1 + height), 6);
    }
  });

  it('extrudes along an arbitrary face normal (a tilted face) and stays outward-facing', () => {
    // A unit square in the plane x + y + z = 0 (normal (1,1,1)/√3).
    const normal = new Vector3(1, 1, 1).normalize();
    const u = new Vector3(1, -1, 0).normalize();
    const v = new Vector3().crossVectors(normal, u).normalize();
    const corners = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ].map(([a, b]) => new Vector3().addScaledVector(u, a!).addScaledVector(v, b!));
    const face: FaceData = {
      polygon: Float32Array.from(corners.flatMap((p) => [p.x, p.y, p.z])),
      normal: [normal.x, normal.y, normal.z],
    };
    const solid = extrudeFace(face, 0.25);
    expect(signedVolume(solid.positions, solid.indices)).toBeCloseTo(0.25, 6);
    // Top ring = base ring + 0.25 × normal.
    for (let i = 0; i < 4; i += 1)
      for (let k = 0; k < 3; k += 1)
        expect(solid.positions[(4 + i) * 3 + k]! - solid.positions[i * 3 + k]!).toBeCloseTo(
          0.25 * face.normal[k]!,
          6,
        );
    expect(solid.source?.height).toBe(0.25);
    expect(faceCentroid(face).length()).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('makes a flat face mesh that keeps its outline and normal', () => {
    const face: FaceData = {
      polygon: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1]),
      normal: [0, 1, 0],
    };
    const flat = makeFace(face);
    expect(flat.indices.length).toBe(3);
    expect(flat.face?.normal).toEqual([0, 1, 0]);
    expect(flat.positions.length).toBe(9);
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
    expect(splats.count).toBeGreaterThan(500);
    expect(splats.count).toBeLessThan(700);
    for (let i = 0; i < splats.count; i += 1) {
      const p = [splats.centers[i * 3]!, splats.centers[i * 3 + 1]!, splats.centers[i * 3 + 2]!];
      const onFace = p.some((v) => Math.abs(v) < 1e-5 || Math.abs(v - 1) < 1e-5);
      expect(onFace).toBe(true);
      expect(p.every((v) => v > -1e-5 && v < 1 + 1e-5)).toBe(true);
      expect(splats.scales[i * 3 + 2]).toBeLessThan(splats.scales[i * 3]!);
      expect(splats.colors[i * 3]).toBe(1);
    }
    expect([...meshToSplats(solid, 0.1, 7).centers.subarray(0, 9)]).toEqual([
      ...splats.centers.subarray(0, 9),
    ]);
  });
});

describe('mesh layers', () => {
  it('round-trip through the project format (face and extruded) and extrude undoably', () => {
    const document = new Document('meshes');
    documents.push(document);
    const face: FaceData = {
      polygon: new Float32Array([0, 0, 0, 1, 0, 0, 0.5, 0, 1]),
      normal: [0, 1, 0],
    };
    const layer = new Layer({
      name: 'Duct',
      kind: 'mesh',
      sourceName: 'mesh-1',
      store: emptyStore(),
      solid: { ...makeFace(face), colour: [0.2, 0.4, 0.9] },
    });
    document.addLayer(layer);
    layer.object.position.set(1, 2, 3);
    layer.object.updateMatrix();
    expect(layer.solid?.face).toBeDefined();

    document.history.push(
      new SetSolid(
        document,
        layer.id,
        { ...extrudeFace(face, 0.4), colour: [0.2, 0.4, 0.9] },
        'Extrude',
      ),
    );
    expect(layer.solid?.face).toBeUndefined();
    expect(layer.localBounds().max[1]).toBeCloseTo(0.4, 6);
    document.history.undo();
    expect(layer.solid?.face).toBeDefined();
    document.history.redo();

    const view = {
      upAxis: 'y-down' as const,
      cameraPosition: [0, 0, 1] as [number, number, number],
      cameraQuaternion: [0, 0, 0, 1] as [number, number, number, number],
      cameraUp: [0, 1, 0] as [number, number, number],
      cameraTarget: [0, 0, 0] as [number, number, number],
      cameraMode: 'orbit' as const,
      flySpeed: 1,
      fov: 60,
    };
    const { document: restored } = readProject(writeProject(document, view));
    documents.push(restored);
    const back = restored.layers[0]!;
    expect(back.kind).toBe('mesh');
    expect(back.solid?.colour).toEqual([0.2, 0.4, 0.9]);
    expect([...back.solid!.positions]).toEqual([...layer.solid!.positions]);
    expect(back.solid?.source?.height).toBe(0.4);
    expect(back.solid?.source?.face.normal).toEqual([0, 1, 0]);
    expect(back.object.position.x).toBe(1);

    // A plain face survives too.
    const faceLayer = new Layer({
      name: 'Face',
      kind: 'mesh',
      sourceName: 'mesh-2',
      store: emptyStore(),
      solid: { ...makeFace(face), colour: [1, 1, 1] },
    });
    document.addLayer(faceLayer);
    const again = readProject(writeProject(document, view)).document;
    documents.push(again);
    expect(again.layers[1]?.solid?.face?.normal).toEqual([0, 1, 0]);

    // A pulled-but-unconfirmed extrusion keeps its face and pending height across save/load.
    faceLayer.setSolid({ ...pendingExtrusion(face, 0.25), colour: [1, 1, 1] });
    expect(faceLayer.solid?.face).toBeDefined();
    expect(faceLayer.solid?.faceHeight).toBe(0.25);
    expect(faceLayer.localBounds().max[1]).toBeCloseTo(0.25, 6);
    const pending = readProject(writeProject(document, view)).document;
    documents.push(pending);
    expect(pending.layers[1]?.solid?.faceHeight).toBe(0.25);
    expect(pending.layers[1]?.solid?.face?.polygon.length).toBe(9);
    // ~0 flattens again.
    expect(pendingExtrusion(face, 0).faceHeight).toBeUndefined();
    expect(pendingExtrusion(face, 0).positions.length).toBe(9);
  });

  it('scales solids per axis: faces stay editable, meshes get their vertices scaled', () => {
    const square: FaceData = {
      polygon: new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
      normal: [0, 1, 0],
    };
    // A flat face: outline scaled, still a face, normal unchanged for an in-plane scale.
    const face = scaleSolid({ ...makeFace(square), colour: [1, 0, 0] }, [2, 1, 0.5]);
    expect(face.face).toBeDefined();
    expect(solidBounds(face.positions).max).toEqual([2, 0, 0.5]);
    expect(face.face?.normal).toEqual([0, 1, 0]);
    // A pending extrusion: rebuilt from the scaled outline with the height scaled along the normal.
    const pending = scaleSolid({ ...pendingExtrusion(square, 0.5), colour: [1, 0, 0] }, [1, 3, 1]);
    expect(pending.faceHeight).toBeCloseTo(1.5, 6);
    expect(solidBounds(pending.positions).max[1]).toBeCloseTo(1.5, 6);
    // A confirmed mesh: vertices scaled, volume scales with the product, still outward.
    const box = { ...extrudeFace(square, 1), colour: [1, 0, 0] as [number, number, number] };
    const scaled = scaleSolid(box, [2, 1, 3]);
    expect(signedVolume(scaled.positions, scaled.indices)).toBeCloseTo(4 * 6, 5);
    expect(scaled.source).toBeUndefined();
    const uniform = scaleSolid(box, [2, 2, 2]);
    expect(uniform.source?.height).toBeCloseTo(2, 6);
    expect(signedVolume(uniform.positions, uniform.indices)).toBeCloseTo(32, 5);
    // A mirroring scale keeps faces outward.
    const mirrored = scaleSolid(box, [-1, 1, 1]);
    expect(signedVolume(mirrored.positions, mirrored.indices)).toBeCloseTo(4, 5);
    // A tilted face: the normal follows the inverse transpose.
    const tilted = scaleSolid(
      {
        ...makeFace({
          polygon: new Float32Array([0, 0, 0, 1, -1, 0, 1, -1, 1, 0, 0, 1]),
          normal: [Math.SQRT1_2, Math.SQRT1_2, 0],
        }),
        colour: [1, 0, 0],
      },
      [2, 1, 1],
    );
    const n = tilted.face!.normal;
    // Points (2,0,0)-(2,-1,0): edge direction (2,-1,0) must be perpendicular to the normal.
    expect(n[0] * 2 + n[1] * -1).toBeCloseTo(0, 6);
  });

  it('ScaleSplats bakes a non-uniform scale into a mesh layer undoably', () => {
    const document = new Document('meshes');
    documents.push(document);
    const square: FaceData = {
      polygon: new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
      normal: [0, 1, 0],
    };
    const layer = new Layer({
      name: 'Box',
      kind: 'mesh',
      sourceName: 'mesh-1',
      store: emptyStore(),
      solid: { ...extrudeFace(square, 1), colour: [0, 1, 0] },
    });
    document.addLayer(layer);
    document.history.push(new ScaleSplats(document, layer.id, [2, 1, 1]));
    expect(layer.localBounds().max[0]).toBeCloseTo(2, 6);
    expect(layer.localBounds().max[2]).toBeCloseTo(1, 6);
    document.history.undo();
    expect(layer.localBounds().max[0]).toBeCloseTo(1, 6);
    document.history.redo();
    expect(layer.localBounds().max[0]).toBeCloseTo(2, 6);
  });
});
