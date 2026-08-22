import { Matrix4 } from 'three';
import { Document } from '../model/Document';
import { Layer } from '../model/Layer';
import type { LayerKind } from '../model/Layer';
import { SplatStore } from '../model/SplatStore';
import type { ShDegree } from '../model/SplatStore';
import { GroupMap } from '../splats/groups';
import type { GroupsMeta } from '../splats/groups';
import type { Stroke, StrokeSettings } from '../sketch/stroke';
import type { PointCloudInfo } from './pointCloud';

const MAGIC = new TextEncoder().encode('SPLATYPUS_PROJECT\n');
const VERSION = 1;

export interface ProjectViewState {
  upAxis: 'y-down' | 'y-up' | 'z-up';
  cameraPosition: [number, number, number];
  cameraQuaternion: [number, number, number, number];
  cameraUp: [number, number, number];
  cameraTarget: [number, number, number];
  cameraMode: 'orbit' | 'fly';
  flySpeed: number;
  fov: number;
}

interface BinaryRef {
  offset: number;
  bytes: number;
}

interface StoredStroke {
  id: string;
  settings: StrokeSettings;
  points: BinaryRef;
  pressures: BinaryRef;
  range: [number, number];
  erased?: boolean;
}

interface StoredLayer {
  id: string;
  name: string;
  kind: LayerKind;
  sourceName: string;
  visible: boolean;
  locked: boolean;
  matrix: number[];
  count: number;
  shDegree: ShDegree;
  centers: BinaryRef;
  scales: BinaryRef;
  rotations: BinaryRef;
  opacities: BinaryRef;
  colors: BinaryRef;
  alive: BinaryRef;
  shRest?: BinaryRef;
  sourceBytes?: BinaryRef;
  pointCloud?: PointCloudInfo;
  groups?: { meta: GroupsMeta; ids: BinaryRef };
  strokes?: StoredStroke[];
}

interface ProjectManifest {
  format: 'splatypus-project';
  version: 1;
  document: {
    name: string;
    selection: string[];
    solo?: string;
  };
  view: ProjectViewState;
  layers: StoredLayer[];
}

class PayloadBuilder {
  readonly parts: Uint8Array[] = [];
  bytes = 0;

  add(view: ArrayBufferView): BinaryRef {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const ref = { offset: this.bytes, bytes: bytes.byteLength };
    this.parts.push(bytes);
    this.bytes += bytes.byteLength;
    return ref;
  }

  write(target: Uint8Array, offset: number): void {
    for (const part of this.parts) {
      target.set(part, offset);
      offset += part.byteLength;
    }
  }
}

function storedStroke(stroke: Stroke, payload: PayloadBuilder): StoredStroke {
  return {
    id: stroke.id,
    settings: {
      ...stroke.settings,
      colour: [...stroke.settings.colour],
    },
    points: payload.add(stroke.points),
    pressures: payload.add(stroke.pressures),
    range: [...stroke.range],
    ...(stroke.erased ? { erased: true } : {}),
  };
}

/** Serialises the editable model without flattening layer transforms or dead splats. */
export function writeProject(document: Document, view: ProjectViewState): ArrayBuffer {
  const payload = new PayloadBuilder();
  const layers = document.layers.map((layer): StoredLayer => {
    layer.object.updateMatrix();
    const store = layer.store;
    return {
      id: layer.id,
      name: layer.name,
      kind: layer.kind,
      sourceName: layer.sourceName,
      visible: layer.visible,
      locked: layer.locked,
      matrix: layer.object.matrix.toArray(),
      count: store.count,
      shDegree: store.shDegree,
      centers: payload.add(store.centers),
      scales: payload.add(store.scales),
      rotations: payload.add(store.rotations),
      opacities: payload.add(store.opacities),
      colors: payload.add(store.colors),
      alive: payload.add(store.alive),
      ...(store.shRest ? { shRest: payload.add(store.shRest) } : {}),
      ...(layer.sourceBytes ? { sourceBytes: payload.add(new Uint8Array(layer.sourceBytes)) } : {}),
      ...(layer.pointCloud ? { pointCloud: { ...layer.pointCloud } } : {}),
      ...(layer.groups
        ? { groups: { meta: layer.groups.meta, ids: payload.add(layer.groups.ids) } }
        : {}),
      ...(layer.strokes.length
        ? { strokes: layer.strokes.map((stroke) => storedStroke(stroke, payload)) }
        : {}),
    };
  });
  const manifest: ProjectManifest = {
    format: 'splatypus-project',
    version: VERSION,
    document: {
      name: document.name,
      selection: [...document.selection],
      ...(document.solo ? { solo: document.solo } : {}),
    },
    view,
    layers,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const headerBytes = MAGIC.byteLength + 4;
  const result = new Uint8Array(headerBytes + manifestBytes.byteLength + payload.bytes);
  result.set(MAGIC, 0);
  new DataView(result.buffer).setUint32(MAGIC.byteLength, manifestBytes.byteLength, true);
  result.set(manifestBytes, headerBytes);
  payload.write(result, headerBytes + manifestBytes.byteLength);
  return result.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function projectError(message: string): Error {
  return new Error(`Couldn't open the Splatypus project: ${message}`);
}

function refBytes(bytes: Uint8Array, payloadStart: number, ref: BinaryRef): ArrayBuffer {
  if (
    !Number.isInteger(ref.offset) ||
    !Number.isInteger(ref.bytes) ||
    ref.offset < 0 ||
    ref.bytes < 0 ||
    payloadStart + ref.offset + ref.bytes > bytes.byteLength
  )
    throw projectError('a binary payload is out of range.');
  return bytes.slice(payloadStart + ref.offset, payloadStart + ref.offset + ref.bytes).buffer;
}

function floats(bytes: Uint8Array, payloadStart: number, ref: BinaryRef): Float32Array {
  if (ref.bytes % 4 !== 0) throw projectError('a float payload is misaligned.');
  return new Float32Array(refBytes(bytes, payloadStart, ref));
}

function uints(bytes: Uint8Array, payloadStart: number, ref: BinaryRef): Uint32Array {
  if (ref.bytes % 4 !== 0) throw projectError('an integer payload is misaligned.');
  return new Uint32Array(refBytes(bytes, payloadStart, ref));
}

function strokeFromStored(stored: StoredStroke, bytes: Uint8Array, payloadStart: number): Stroke {
  return {
    id: stored.id,
    settings: {
      ...stored.settings,
      colour: [...stored.settings.colour],
    },
    points: floats(bytes, payloadStart, stored.points),
    pressures: floats(bytes, payloadStart, stored.pressures),
    range: [...stored.range],
    ...(stored.erased ? { erased: true } : {}),
  };
}

/** Reconstructs a full editable document. Undo/redo intentionally starts empty. */
export function readProject(buffer: ArrayBuffer): {
  document: Document;
  view: ProjectViewState;
} {
  const bytes = new Uint8Array(buffer);
  if (
    bytes.byteLength < MAGIC.byteLength + 4 ||
    !MAGIC.every((value, index) => bytes[index] === value)
  )
    throw projectError('the file header is not recognised.');
  const manifestLength = new DataView(buffer).getUint32(MAGIC.byteLength, true);
  const manifestStart = MAGIC.byteLength + 4;
  const payloadStart = manifestStart + manifestLength;
  if (payloadStart > bytes.byteLength) throw projectError('the manifest is truncated.');
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder().decode(bytes.subarray(manifestStart, payloadStart)),
    ) as unknown;
  } catch (error) {
    throw projectError(
      `the manifest is invalid (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (
    !isRecord(decoded) ||
    decoded.format !== 'splatypus-project' ||
    decoded.version !== VERSION ||
    !Array.isArray(decoded.layers) ||
    !isRecord(decoded.document) ||
    typeof decoded.document.name !== 'string' ||
    !Array.isArray(decoded.document.selection) ||
    !isRecord(decoded.view)
  )
    throw projectError('the project version is unsupported.');
  const manifest = decoded as unknown as ProjectManifest;

  const document = new Document(manifest.document.name);
  try {
    for (const stored of manifest.layers) {
      const store = new SplatStore(
        {
          count: stored.count,
          centers: floats(bytes, payloadStart, stored.centers),
          scales: floats(bytes, payloadStart, stored.scales),
          rotations: floats(bytes, payloadStart, stored.rotations),
          opacities: floats(bytes, payloadStart, stored.opacities),
          colors: floats(bytes, payloadStart, stored.colors),
          shDegree: stored.shDegree,
          ...(stored.shRest ? { shRest: floats(bytes, payloadStart, stored.shRest) } : {}),
        },
        new Uint8Array(refBytes(bytes, payloadStart, stored.alive)),
      );
      const groups = stored.groups
        ? GroupMap.fromIds(uints(bytes, payloadStart, stored.groups.ids), stored.groups.meta)
        : undefined;
      const layer = new Layer({
        id: stored.id,
        name: stored.name,
        kind: stored.kind,
        sourceName: stored.sourceName,
        store,
        ...(stored.pointCloud ? { pointCloud: stored.pointCloud } : {}),
        ...(stored.sourceBytes
          ? { sourceBytes: refBytes(bytes, payloadStart, stored.sourceBytes) }
          : {}),
        ...(groups ? { groups } : {}),
        ...(stored.strokes
          ? {
              strokes: stored.strokes.map((stroke) =>
                strokeFromStored(stroke, bytes, payloadStart),
              ),
            }
          : {}),
      });
      layer.visible = stored.visible;
      layer.locked = stored.locked;
      layer.mesh.visible = stored.visible;
      const matrix = new Matrix4().fromArray(stored.matrix);
      matrix.decompose(layer.object.position, layer.object.quaternion, layer.object.scale);
      layer.object.updateMatrix();
      document.addLayer(layer);
    }
    document.setSelection(manifest.document.selection);
    document.setSolo(manifest.document.solo);
    document.history.clear();
    return { document, view: manifest.view };
  } catch (error) {
    document.dispose();
    if (error instanceof Error && error.message.startsWith("Couldn't open")) throw error;
    throw projectError(error instanceof Error ? error.message : String(error));
  }
}

export function isProjectFileName(name: string): boolean {
  return /\.splatypus$/i.test(name);
}
