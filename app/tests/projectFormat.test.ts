import { Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { readProject, writeProject } from '../src/io/projectFormat';
import type { ProjectViewState } from '../src/io/projectFormat';
import { Document } from '../src/model/Document';
import { Layer } from '../src/model/Layer';
import { SplatStore } from '../src/model/SplatStore';
import { GroupMap, UNASSIGNED } from '../src/splats/groups';
import type { Stroke } from '../src/sketch/stroke';

const documents: Document[] = [];
afterEach(() => documents.splice(0).forEach((document) => document.dispose()));

const view: ProjectViewState = {
  upAxis: 'z-up',
  cameraPosition: [4, 5, 6],
  cameraQuaternion: [0, 0, 0, 1],
  cameraUp: [0, 1, 0],
  cameraTarget: [1, 2, 3],
  cameraMode: 'orbit',
  flySpeed: 1.5,
  fov: 48,
};

describe('Splatypus project format', () => {
  it('round-trips editable layer, segmentation, stroke, and view state', () => {
    const document = new Document('Editable scene');
    documents.push(document);
    const stroke: Stroke = {
      id: 'stroke-1',
      settings: {
        preset: 'marker',
        colour: [0.1, 0.2, 0.3],
        radius: 0.04,
        radiusPx: 10,
        opacity: 0.75,
        pressure: true,
        placement: 'surface',
      },
      points: new Float32Array([1, 2, 3, 4, 5, 6]),
      pressures: new Float32Array([0.5, 1]),
      range: [0, 2],
    };
    const groups = GroupMap.fromIds(new Uint32Array([0, UNASSIGNED]), {
      numSplats: 2,
      numGroups: 1,
      source: 'test',
      groups: [{ id: 0, name: 'Seat', count: 1, colour: '#ff0000' }],
    });
    const layer = new Layer({
      id: 'layer-1',
      name: 'Editable layer',
      kind: 'sketch',
      sourceName: 'source.ply',
      sourceBytes: new Uint8Array([7, 8, 9]).buffer,
      groups,
      strokes: [stroke],
      store: new SplatStore(
        {
          count: 2,
          centers: new Float32Array([1, 2, 3, 4, 5, 6]),
          scales: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
          rotations: new Float32Array([0, 0, 0, 1, 0.1, 0.2, 0.3, 0.9]),
          opacities: new Float32Array([0.8, 0.4]),
          colors: new Float32Array([1, 0, 0, 0, 1, 0]),
          shDegree: 1,
          shRest: new Float32Array(18).map((_, index) => index / 10),
        },
        new Uint8Array([1, 0]),
      ),
    });
    layer.visible = false;
    layer.locked = true;
    layer.object.position.set(2, 3, 4);
    layer.object.rotateY(0.25);
    layer.object.scale.setScalar(1.5);
    layer.object.updateMatrix();
    document.addLayer(layer);
    document.setSelection([layer.id]);
    document.setSolo(layer.id);

    const restored = readProject(writeProject(document, view));
    documents.push(restored.document);
    expect(restored.view).toEqual(view);
    expect(restored.document.name).toBe('Editable scene');
    expect([...restored.document.selection]).toEqual(['layer-1']);
    expect(restored.document.solo).toBe('layer-1');
    expect(restored.document.history.canUndo()).toBe(false);

    const copy = restored.document.layers[0]!;
    expect(copy.id).toBe('layer-1');
    expect(copy.name).toBe('Editable layer');
    expect(copy.kind).toBe('sketch');
    expect(copy.visible).toBe(false);
    expect(copy.locked).toBe(true);
    expect(copy.object.position.distanceTo(new Vector3(2, 3, 4))).toBeLessThan(1e-6);
    expect(copy.object.scale.x).toBeCloseTo(1.5);
    expect([...copy.store.alive]).toEqual([1, 0]);
    expect([...copy.store.centers]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(copy.store.shDegree).toBe(1);
    expect(copy.store.shRest?.length).toBe(18);
    expect([...copy.groups!.ids]).toEqual([0, UNASSIGNED]);
    expect(copy.groups!.info(0).name).toBe('Seat');
    expect(copy.strokes).toHaveLength(1);
    expect([...copy.strokes[0]!.points]).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...copy.strokes[0]!.pressures]).toEqual([0.5, 1]);
    expect([...new Uint8Array(copy.sourceBytes!)]).toEqual([7, 8, 9]);
  });

  it('rejects files without the project header', () => {
    expect(() => readProject(new Uint8Array([1, 2, 3]).buffer)).toThrow(
      'file header is not recognised',
    );
  });
});
