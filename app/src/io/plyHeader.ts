export type PlyScalarType =
  | 'char'
  | 'uchar'
  | 'short'
  | 'ushort'
  | 'int'
  | 'uint'
  | 'float'
  | 'double';
export interface PlyProperty {
  name: string;
  type: PlyScalarType;
  offset: number;
  size: number;
  isList: boolean;
}
interface PlyElement {
  name: string;
  count: number;
  stride: number;
  properties: PlyProperty[];
}
export interface PlyHeader {
  format: string;
  dataOffset: number;
  vertexOffset: number;
  vertexCount: number;
  vertexStride: number;
  properties: ReadonlyMap<string, PlyProperty>;
  elements: readonly PlyElement[];
  compressed: boolean;
}

const TYPE_ALIASES: Record<string, PlyScalarType> = {
  char: 'char',
  int8: 'char',
  uchar: 'uchar',
  uint8: 'uchar',
  short: 'short',
  int16: 'short',
  ushort: 'ushort',
  uint16: 'ushort',
  int: 'int',
  int32: 'int',
  uint: 'uint',
  uint32: 'uint',
  float: 'float',
  float32: 'float',
  double: 'double',
  float64: 'double',
};
const TYPE_SIZE: Record<PlyScalarType, number> = {
  char: 1,
  uchar: 1,
  short: 2,
  ushort: 2,
  int: 4,
  uint: 4,
  float: 4,
  double: 8,
};

function headerEnd(bytes: Uint8Array): number {
  const needle = new TextEncoder().encode('end_header');
  const last = Math.min(bytes.length - needle.length, 4_000_000);
  outer: for (let offset = 0; offset <= last; offset += 1) {
    for (let index = 0; index < needle.length; index += 1)
      if (bytes[offset + index] !== needle[index]) continue outer;
    let end = offset + needle.length;
    if (bytes[end] === 13) end += 1;
    if (bytes[end] !== 10) throw new Error('Malformed PLY header');
    return end + 1;
  }
  throw new Error('PLY end_header not found');
}

export function readPlyHeader(input: Uint8Array | ArrayBuffer): PlyHeader {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dataOffset = headerEnd(bytes);
  const lines = new TextDecoder()
    .decode(bytes.subarray(0, dataOffset))
    .replaceAll('\r', '')
    .split('\n');
  if (lines[0]?.trim() !== 'ply') throw new Error('Not a PLY file');
  const elements: PlyElement[] = [];
  let format = '';
  let current: PlyElement | undefined;
  for (const sourceLine of lines.slice(1)) {
    const line = sourceLine.trim();
    if (
      !line ||
      line === 'end_header' ||
      line.startsWith('comment ') ||
      line.startsWith('obj_info ')
    )
      continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'format') {
      format = parts[1] ?? '';
      continue;
    }
    if (parts[0] === 'element') {
      current = { name: parts[1] ?? '', count: Number(parts[2]), stride: 0, properties: [] };
      if (!current.name || !Number.isSafeInteger(current.count) || current.count < 0)
        throw new Error(`Invalid PLY element line: ${line}`);
      elements.push(current);
      continue;
    }
    if (parts[0] === 'property' && current) {
      const isList = parts[1] === 'list';
      const typeName = TYPE_ALIASES[isList ? (parts[3] ?? '') : (parts[1] ?? '')];
      const name = isList ? parts[4] : parts[2];
      if (!typeName || !name) throw new Error(`Unsupported PLY property line: ${line}`);
      const property = {
        name,
        type: typeName,
        offset: current.stride,
        size: TYPE_SIZE[typeName],
        isList,
      };
      current.properties.push(property);
      if (!isList) current.stride += property.size;
    }
  }
  if (format === 'ascii') throw new Error('ASCII PLY not supported');
  if (format === 'binary_big_endian') throw new Error('big-endian PLY not supported');
  if (format !== 'binary_little_endian')
    throw new Error(`Unsupported PLY format: ${format || 'missing'}`);
  const vertex = elements.find((element) => element.name === 'vertex');
  if (!vertex) throw new Error('No vertex element found');
  if (vertex.properties.some((property) => property.isList))
    throw new Error('List properties on PLY vertices are not supported');
  let vertexOffset = dataOffset;
  for (const element of elements) {
    if (element === vertex) break;
    if (element.properties.some((property) => property.isList))
      throw new Error(`Cannot skip list element ${element.name} before vertices`);
    vertexOffset += element.count * element.stride;
  }
  const properties = new Map(vertex.properties.map((property) => [property.name, property]));
  return {
    format,
    dataOffset,
    vertexOffset,
    vertexCount: vertex.count,
    vertexStride: vertex.stride,
    properties,
    elements,
    compressed:
      elements.some((element) => element.name === 'chunk') || properties.has('packed_position'),
  };
}

export function readPlyScalar(view: DataView, offset: number, property: PlyProperty): number {
  switch (property.type) {
    case 'char':
      return view.getInt8(offset);
    case 'uchar':
      return view.getUint8(offset);
    case 'short':
      return view.getInt16(offset, true);
    case 'ushort':
      return view.getUint16(offset, true);
    case 'int':
      return view.getInt32(offset, true);
    case 'uint':
      return view.getUint32(offset, true);
    case 'float':
      return view.getFloat32(offset, true);
    case 'double':
      return view.getFloat64(offset, true);
  }
}
